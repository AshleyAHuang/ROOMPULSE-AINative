import { createParticipationStatus, type ParticipationStatus } from "./speaker-tracker";

export type TranscriptSource = "speech" | "simulated" | "manual";

export interface MeetingParticipant {
  name: string;
  role?: string;
}

export interface AgendaItem {
  id: string;
  title: string;
  done: boolean;
}

export interface MeetingConfig {
  title: string;
  goal: string;
  context: string;
  agenda: AgendaItem[];
  expectedParticipants: number;
  participants: MeetingParticipant[];
  heartbeatIntervalSeconds: number;
}

export interface TranscriptLine {
  id: string;
  speakerId: string;
  speakerLabel: string;
  text: string;
  timestamp: number;
  source: TranscriptSource;
  confidence: number;
}

export type FacilitatorCardKind =
  | "heartbeat"
  | "participation"
  | "risk"
  | "agenda"
  | "decision"
  | "action"
  | "drift"
  | "reminder";

export interface FacilitatorCard {
  id: string;
  kind: FacilitatorCardKind;
  title: string;
  body: string;
  priority: "low" | "medium" | "high";
}

export interface TimelineEntry {
  id: string;
  timestamp: number;
  source: FacilitatorOutput["source"];
  cards: FacilitatorCard[];
  summary: string;
  reviewMarkdown?: string;
  reminder?: string | null;
}

export interface AgendaProgress {
  total: number;
  completed: number;
  active: AgendaItem | null;
}

export interface ReviewVersion {
  id: string;
  timestamp: number;
  source: FacilitatorOutput["source"] | "initial" | "restored";
  markdown: string;
  summary: string;
}

export interface AgendaAction {
  itemId: string;
  done: boolean;
  reason: string;
}

export type UiToolName =
  | "add_agenda_item"
  | "set_agenda_item"
  | "delete_agenda_item"
  | "send_room_reminder"
  | "update_review_document";

export interface UiToolDefinition {
  name: UiToolName;
  label: string;
  description: string;
  parameters: Record<string, string>;
  confirmationRequired?: boolean;
}

export interface UiAction {
  tool: UiToolName;
  parameters: Record<string, unknown>;
  reason: string;
}

export interface HeartbeatRuntimeState {
  meetingStartedAt: number;
  meetingElapsedSeconds: number;
  isPaused: boolean;
  heartbeatCount: number;
}

export interface HeartbeatInput {
  meeting: MeetingConfig;
  transcript: TranscriptLine[];
  transcriptDelta: TranscriptLine[];
  participation: ParticipationStatus;
  agendaProgress: AgendaProgress;
  priorInterventions: TimelineEntry[];
  priorReminders: { timestamp: number; message: string; source: TimelineEntry["source"] }[];
  currentReviewMarkdown: string;
  reviewVersions: ReviewVersion[];
  uiTools: UiToolDefinition[];
  runtime: HeartbeatRuntimeState;
  now: number;
}

export interface FacilitatorOutput {
  source: "pi" | "local-fallback";
  cards: FacilitatorCard[];
  summary: string;
  nextHeartbeatHint: string;
  reviewMarkdown: string;
  agendaActions: AgendaAction[];
  uiActions: UiAction[];
  ephemeralReminder: string | null;
  adapterNotice?: string;
}

export interface CreateHeartbeatInputArgs {
  meeting: MeetingConfig;
  transcript: TranscriptLine[];
  observedSpeakerLabels: string[];
  lastHeartbeatAt: number;
  now: number;
  priorInterventions: TimelineEntry[];
  currentReviewMarkdown?: string;
  reviewVersions?: ReviewVersion[];
  meetingStartedAt?: number;
  isPaused?: boolean;
  heartbeatCount?: number;
}

export function createHeartbeatInput({
  meeting,
  transcript,
  observedSpeakerLabels,
  lastHeartbeatAt,
  now,
  priorInterventions,
  currentReviewMarkdown,
  reviewVersions,
  meetingStartedAt,
  isPaused,
  heartbeatCount
}: CreateHeartbeatInputArgs): HeartbeatInput {
  const startedAt = meetingStartedAt ?? now;

  return {
    meeting,
    transcript,
    transcriptDelta: transcript.filter(
      (line) => line.timestamp > lastHeartbeatAt && line.timestamp <= now
    ),
    participation: createParticipationStatus(
      meeting.expectedParticipants,
      observedSpeakerLabels
    ),
    agendaProgress: getAgendaProgress(meeting.agenda),
    priorInterventions,
    priorReminders: priorInterventions
      .filter((entry) => typeof entry.reminder === "string" && entry.reminder.trim())
      .map((entry) => ({
        timestamp: entry.timestamp,
        message: entry.reminder as string,
        source: entry.source
      })),
    currentReviewMarkdown:
      currentReviewMarkdown ?? createInitialReviewMarkdown(meeting),
    reviewVersions: reviewVersions ?? [],
    uiTools: createUiToolDefinitions(meeting),
    runtime: {
      meetingStartedAt: startedAt,
      meetingElapsedSeconds: Math.max(0, Math.floor((now - startedAt) / 1000)),
      isPaused: isPaused ?? false,
      heartbeatCount: heartbeatCount ?? priorInterventions.length
    },
    now
  };
}

export async function runLocalFacilitation(
  input: HeartbeatInput
): Promise<FacilitatorOutput> {
  const agendaActions = applyAgendaCoverage(input.meeting.agenda, input.transcript)
    .filter((item, index) => item.done !== input.meeting.agenda[index]?.done)
    .map((item) => ({
      itemId: item.id,
      done: item.done,
      reason:
        "Transcript clearly indicates this agenda item was covered. Review and untick if the room disagrees."
    }));
  const cards: FacilitatorCard[] = [
    {
      id: createCardId(input.now, "heartbeat"),
      kind: "heartbeat",
      title: "Heartbeat check",
      body: buildHeartbeatBody(input),
      priority: "medium"
    }
  ];

  if (input.participation.needsNudge && input.participation.reminder) {
    cards.push({
      id: createCardId(input.now, "participation"),
      kind: "participation",
      title: "Open the floor",
      body: input.participation.reminder,
      priority: "high"
    });
  }

  const transcriptText = input.transcriptDelta
    .map((line) => line.text)
    .join(" ")
    .toLowerCase();
  const allTranscriptText = input.transcript
    .map((line) => line.text)
    .join(" ")
    .toLowerCase();
  const combinedText = [transcriptText, allTranscriptText].join(" ");

  if (/\b(risk|concern|blocked|blocker|tight|unresolved|issue)\b/.test(combinedText)) {
    cards.push({
      id: createCardId(input.now, "risk"),
      kind: "risk",
      title: "Name the risk",
      body:
        "A risk or unresolved concern is active in the room. Clarify owner, impact, and the next concrete mitigation.",
      priority: "high"
    });
  }

  if (/\b(decide|decision|owner|owners|who owns|accountable)\b/.test(combinedText)) {
    cards.push({
      id: createCardId(input.now, "decision"),
      kind: "decision",
      title: "Capture the decision",
      body:
        "The room is circling an ownership decision. State the proposed owner and ask for explicit agreement.",
      priority: "medium"
    });
  }

  if (/\b(swag|parking lot|later|side topic|off track|unrelated)\b/.test(combinedText)) {
    cards.push({
      id: createCardId(input.now, "drift"),
      kind: "drift",
      title: "Check agenda drift",
      body:
        "A side topic may be pulling attention away from the goal. Park it unless it changes the current decision.",
      priority: "medium"
    });
  }

  const activeAgenda = input.agendaProgress.active;
  const fallbackAgendaActions = inferAgendaActions(input, combinedText);
  const mergedAgendaActions = mergeAgendaActions([
    ...agendaActions,
    ...fallbackAgendaActions
  ]);
  if (activeAgenda) {
    cards.push({
      id: createCardId(input.now, "agenda"),
      kind: "agenda",
      title: "Agenda focus",
      body: `Current focus: ${activeAgenda.title}. Keep the room moving toward "${input.meeting.goal}".`,
      priority: "low"
    });
  }

  return {
    source: "local-fallback",
    cards: cards.slice(0, 5),
    summary: `${input.meeting.title}: ${cards.length} facilitator cues generated from ${input.transcriptDelta.length} new transcript ${input.transcriptDelta.length === 1 ? "line" : "lines"}.`,
    nextHeartbeatHint: activeAgenda
      ? `Next check should revisit "${activeAgenda.title}".`
      : "Next check should confirm whether the meeting goal is complete.",
    reviewMarkdown: buildReviewMarkdown(input, cards, mergedAgendaActions),
    agendaActions: mergedAgendaActions,
    uiActions: buildLocalUiActions(input, mergedAgendaActions, cards),
    ephemeralReminder: selectEphemeralReminder(input, cards)
  };
}

export function createUiToolDefinitions(
  meeting: MeetingConfig
): UiToolDefinition[] {
  const agendaHint =
    meeting.agenda.length > 0
      ? meeting.agenda.map((item) => item.id).join(", ")
      : "no agenda item ids yet";

  return [
    {
      name: "update_review_document",
      label: "Update review document",
      description:
        "Replace the live markdown review document with the complete non-destructive revision for this heartbeat.",
      parameters: {
        markdown: "complete markdown document",
        summary: "short version summary"
      }
    },
    {
      name: "add_agenda_item",
      label: "Add agenda item",
      description:
        "Add a visible agenda item when the room creates a new live agenda obligation.",
      parameters: {
        title: "agenda item title",
        reason: "short visible reason"
      }
    },
    {
      name: "set_agenda_item",
      label: "Set agenda item",
      description:
        "Check or uncheck a visible agenda item when the transcript clearly supports the change.",
      parameters: {
        itemId: `agenda item id. Available ids: ${agendaHint}`,
        done: "boolean agenda completion state",
        reason: "short visible reason"
      }
    },
    {
      name: "delete_agenda_item",
      label: "Delete agenda item",
      description:
        "Remove a visible agenda item only when the room explicitly drops or merges it.",
      parameters: {
        itemId: `agenda item id. Available ids: ${agendaHint}`,
        reason: "short visible reason"
      }
    },
    {
      name: "send_room_reminder",
      label: "Send room reminder",
      description:
        "Show one quiet, ephemeral reminder snackbar/dock message for this heartbeat.",
      parameters: {
        message: "one concise room-facing reminder",
        tone: "info, warning, or urgent"
      }
    }
  ];
}

export function getAgendaProgress(agenda: AgendaItem[]): AgendaProgress {
  const completed = agenda.filter((item) => item.done).length;
  const active = agenda.find((item) => !item.done) ?? null;

  return {
    total: agenda.length,
    completed,
    active
  };
}

/**
 * Auto-check agenda items that the room has clearly covered.
 *
 * Heuristic:
 * - Tokenize each item's title, dropping stopwords and supporting simple
 *   singular/plural variants.
 * - Mark an item done when coverage language appears near its title terms:
 *   "that covers launch risks", "done with owners", "checked off the goal".
 * - Also mark prior items done when the room clearly moves to a later item or
 *   wraps after discussing the current item.
 */
export function applyAgendaCoverage(
  agenda: AgendaItem[],
  transcript: TranscriptLine[]
): AgendaItem[] {
  if (agenda.length === 0 || transcript.length === 0) {
    return agenda;
  }

  const tokenRegexes = agenda.map((item) => tokenizeTitle(item.title));
  const lastHit = new Array<number>(agenda.length).fill(-Infinity);
  const explicitlyCovered = new Array<boolean>(agenda.length).fill(false);
  let wrapupTime = -Infinity;

  for (const line of transcript) {
    const text = line.text;
    if (AGENDA_WRAPUP_REGEX.test(text) && line.timestamp > wrapupTime) {
      wrapupTime = line.timestamp;
    }

    for (let index = 0; index < agenda.length; index += 1) {
      const matched = tokenRegexes[index].some((regex) => regex.test(text));
      if (matched && line.timestamp > lastHit[index]) {
        lastHit[index] = line.timestamp;
      }
      if (matched && isCoverageCueForItem(text, tokenRegexes[index])) {
        explicitlyCovered[index] = true;
      }
    }
  }

  let changed = false;
  const next = agenda.map((item, index) => {
    if (item.done) return item;
    if (explicitlyCovered[index]) {
      changed = true;
      return { ...item, done: true };
    }
    if (lastHit[index] === -Infinity) return item;

    for (let laterIndex = index + 1; laterIndex < agenda.length; laterIndex += 1) {
      if (!agenda[laterIndex].done && lastHit[laterIndex] > lastHit[index]) {
        changed = true;
        return { ...item, done: true };
      }
    }

    if (wrapupTime > lastHit[index]) {
      changed = true;
      return { ...item, done: true };
    }

    return item;
  });

  return changed ? next : agenda;
}

const AGENDA_STOPWORDS = new Set([
  "and",
  "the",
  "a",
  "an",
  "of",
  "or",
  "in",
  "on",
  "to",
  "for",
  "with",
  "is",
  "are",
  "be",
  "by",
  "at",
  "from",
  "as",
  "that",
  "this",
  "we",
  "our",
  "us",
  "you",
  "your",
  "they",
  "their",
  "it",
  "its"
]);

const AGENDA_WRAPUP_REGEX =
  /\b(anything\s+else|that'?s\s+(it|all|done|covered)|we'?re\s+(done|good|set|all\s+set)|let'?s\s+(wrap|move\s+on)|wrap(ping|ped)?\s+up|moving\s+on|next\s+(item|topic|one|up)|all\s+set)\b/i;

const AGENDA_COVERAGE_REGEX =
  /\b(covered|covers|complete(?:d)?|done\s+with|finished|handled|resolved|closed|checked\s+off|signed\s+off|wrapped\s+up|that'?s\s+(done|covered|complete)|we'?re\s+(good|set|done)\s+on)\b/i;

const AGENDA_COVERAGE_GLOBAL_REGEX =
  /\b(covered|covers|complete(?:d)?|done\s+with|finished|handled|resolved|closed|checked\s+off|signed\s+off|wrapped\s+up|that'?s\s+(done|covered|complete)|we'?re\s+(good|set|done)\s+on)\b/gi;

const NEGATED_COVERAGE_REGEX =
  /\b(not|not\s+yet|haven'?t|hasn'?t|isn'?t|aren'?t|still\s+need\s+to|need\s+to\s+still)\b.{0,32}\b(cover(?:ed)?|complete(?:d)?|done|finish(?:ed)?|handle(?:d)?|resolve(?:d)?|close(?:d)?)\b/i;

function isCoverageCueForItem(text: string, itemTokens: RegExp[]): boolean {
  if (
    !AGENDA_COVERAGE_REGEX.test(text) ||
    NEGATED_COVERAGE_REGEX.test(text)
  ) {
    return false;
  }

  const tokenMatches = itemTokens
    .map((token) => text.search(token))
    .filter((index) => index >= 0);
  if (tokenMatches.length === 0) {
    return false;
  }

  const coverageMatches = Array.from(text.matchAll(AGENDA_COVERAGE_GLOBAL_REGEX));
  return coverageMatches.some((match) =>
    tokenMatches.some((tokenIndex) => Math.abs((match.index ?? 0) - tokenIndex) <= 32)
  );
}

function tokenizeTitle(title: string): RegExp[] {
  const seen = new Set<string>();
  const regexes: RegExp[] = [];
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z\s']/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !AGENDA_STOPWORDS.has(token));

  for (const token of tokens) {
    const stem =
      token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
    if (seen.has(stem)) continue;
    seen.add(stem);
    regexes.push(new RegExp(`\\b${escapeRegex(stem)}s?\\b`, "i"));
  }

  return regexes;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHeartbeatBody(input: HeartbeatInput): string {
  const deltaCount = input.transcriptDelta.length;
  const speakerCount = input.participation.observed;
  const expected = input.participation.expected;

  return `${deltaCount} new transcript ${deltaCount === 1 ? "line" : "lines"} since the last pulse. ${speakerCount} of ${expected} expected speakers have been heard.`;
}

function createCardId(timestamp: number, suffix: string): string {
  return `${timestamp}-${suffix}`;
}

export function createInitialReviewMarkdown(meeting: MeetingConfig): string {
  const agendaLines = meeting.agenda
    .map((item) => `- [${item.done ? "x" : " "}] ${item.title}`)
    .join("\n");
  const participants =
    meeting.participants.length > 0
      ? meeting.participants
          .map((participant) =>
            participant.role
              ? `- ${participant.name} - ${participant.role}`
              : `- ${participant.name}`
          )
          .join("\n")
      : "- Speaker clusters will appear as people speak.";

  return [
    `# ${meeting.title}`,
    "",
    `**Goal:** ${meeting.goal}`,
    "",
    "## Meeting Context",
    meeting.context || "_No additional context provided._",
    "",
    "## Agenda",
    agendaLines || "- [ ] Open discussion",
    "",
    "## Participants",
    participants,
    "",
    "## Live Review",
    "_RoomPulse will revise this document every heartbeat. Removed or superseded claims should be struck through, not deleted._"
  ].join("\n");
}

function buildReviewMarkdown(
  input: HeartbeatInput,
  cards: FacilitatorCard[],
  agendaActions: AgendaAction[]
): string {
  const pulseTitle = `### Heartbeat ${input.runtime.heartbeatCount + 1} - ${formatElapsed(input.runtime.meetingElapsedSeconds)}`;
  const transcriptDigest =
    input.transcriptDelta.length > 0
      ? input.transcriptDelta
          .slice(-4)
          .map((line) => `- **${line.speakerLabel}:** ${line.text}`)
          .join("\n")
      : "- _No new transcript lines since the last heartbeat._";
  const cueLines = cards
    .map((card) => `- **${card.title}:** ${card.body}`)
    .join("\n");
  const agendaLines =
    agendaActions.length > 0
      ? agendaActions
          .map(
            (action) =>
              `- ${action.done ? "Checked" : "Unchecked"} agenda item \`${action.itemId}\`: ${action.reason}`
          )
          .join("\n")
      : "- No agenda status changes proposed.";

  return [
    input.currentReviewMarkdown,
    "",
    pulseTitle,
    "",
    "#### Transcript Delta",
    transcriptDigest,
    "",
    "#### Facilitation Review",
    cueLines,
    "",
    "#### Agenda Updates",
    agendaLines
  ].join("\n");
}

function inferAgendaActions(
  input: HeartbeatInput,
  combinedText: string
): AgendaAction[] {
  const active = input.agendaProgress.active;
  if (!active) {
    return [];
  }

  const completionSignal =
    /\b(done|finished|complete|completed|resolved|settled|agreed|decided)\b/.test(
      combinedText
    );
  if (!completionSignal) {
    return [];
  }

  return [
    {
      itemId: active.id,
      done: true,
      reason:
        "Transcript suggests the active agenda item reached a conclusion. Review and untick if the room disagrees."
    }
  ];
}

function mergeAgendaActions(actions: AgendaAction[]): AgendaAction[] {
  const byItem = new Map<string, AgendaAction>();
  for (const action of actions) {
    byItem.set(action.itemId, action);
  }
  return Array.from(byItem.values());
}

function selectEphemeralReminder(
  input: HeartbeatInput,
  cards: FacilitatorCard[]
): string | null {
  const highPriority = cards.find((card) => card.priority === "high");
  if (highPriority) {
    return highPriority.body;
  }

  if (input.participation.needsNudge && input.participation.reminder) {
    return input.participation.reminder;
  }

  if (
    input.runtime.meetingElapsedSeconds > 0 &&
    input.runtime.meetingElapsedSeconds % 900 < input.meeting.heartbeatIntervalSeconds
  ) {
    return "Time check: if this item is still open, try to reach a conclusion before the next pulse.";
  }

  return null;
}

function buildLocalUiActions(
  input: HeartbeatInput,
  agendaActions: AgendaAction[],
  cards: FacilitatorCard[]
): UiAction[] {
  const actions: UiAction[] = agendaActions.map((action) => ({
    tool: "set_agenda_item",
    parameters: {
      itemId: action.itemId,
      done: action.done
    },
    reason: action.reason
  }));

  const reminder = selectEphemeralReminder(input, cards);
  if (reminder) {
    actions.push({
      tool: "send_room_reminder",
      parameters: {
        message: reminder,
        tone: cards.some((card) => card.priority === "high") ? "urgent" : "info"
      },
      reason: "Local facilitator generated the current heartbeat reminder."
    });
  }

  return actions;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
