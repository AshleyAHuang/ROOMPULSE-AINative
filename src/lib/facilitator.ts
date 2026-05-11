import {
  createParticipationStatus,
  normalizeSpeakerLabel,
  type ParticipationStatus
} from "./speaker-tracker";

export type TranscriptSource = "speech" | "simulated" | "manual";

export const MAX_AGENDA_ITEMS = 30;
export const MAX_EXPECTED_PARTICIPANTS = 24;
export const MAX_PARTICIPANT_ENTRIES = MAX_EXPECTED_PARTICIPANTS;
export const MIN_HEARTBEAT_INTERVAL_SECONDS = 15;
export const MAX_HEARTBEAT_INTERVAL_SECONDS = 3_600;
export const MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES = 40;
export const MAX_HEARTBEAT_TRANSCRIPT_DELTA_LINES = 80;
export const MAX_HEARTBEAT_HISTORY_ITEMS = 6;
export const MAX_HEARTBEAT_REVIEW_VERSIONS = 4;
export const MAX_HEARTBEAT_INPUT_TEXT_LENGTH = 1_000;
export const MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH = 4_000;
export const MAX_FACILITATOR_OUTPUT_CARDS = 5;
export const MAX_FACILITATOR_OUTPUT_UI_ACTIONS = 8;
export const MAX_FACILITATOR_CARD_TEXT_LENGTH = 280;
export const MAX_FACILITATOR_OUTPUT_TEXT_LENGTH = 500;
const HEARTBEAT_REVIEW_COMPACTION_MARKER =
  "\n\n[RoomPulse omitted middle review content for heartbeat latency. Preserve the visible document structure and keep the next version compact.]\n\n";

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
  source: "pi" | "openrouter" | "local-fallback";
  cards: FacilitatorCard[];
  summary: string;
  nextHeartbeatHint: string;
  reviewMarkdown: string;
  agendaActions: AgendaAction[];
  uiActions: UiAction[];
  ephemeralReminder: string | null;
  adapterNotice?: string;
}

export function capFacilitatorOutput(
  output: FacilitatorOutput
): FacilitatorOutput {
  const rawOutput = (isRecord(output) ? output : {}) as Record<string, unknown>;
  const adapterNotice =
    typeof rawOutput.adapterNotice === "string"
      ? capText(rawOutput.adapterNotice, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
      : undefined;

  return {
    source: isFacilitatorSource(rawOutput.source)
      ? rawOutput.source
      : "local-fallback",
    cards: capCards(Array.isArray(rawOutput.cards) ? rawOutput.cards : []),
    summary: capOutputText(rawOutput.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    nextHeartbeatHint: capOutputText(
      rawOutput.nextHeartbeatHint,
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    ),
    reviewMarkdown: capOutputText(
      rawOutput.reviewMarkdown,
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    ),
    agendaActions: capAgendaActions(
      Array.isArray(rawOutput.agendaActions) ? rawOutput.agendaActions : []
    ),
    uiActions: capUiActions(
      Array.isArray(rawOutput.uiActions) ? rawOutput.uiActions : []
    ),
    ephemeralReminder:
      typeof rawOutput.ephemeralReminder === "string"
        ? capText(rawOutput.ephemeralReminder, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
        : null,
    ...(adapterNotice === undefined ? {} : { adapterNotice })
  };
}

function isFacilitatorSource(
  value: unknown
): value is FacilitatorOutput["source"] {
  return value === "pi" || value === "openrouter" || value === "local-fallback";
}

function capOutputText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? capText(value, maxLength) : "";
}

function capCards(cards: unknown[]): FacilitatorCard[] {
  const cappedCards = cards
    .filter(isRuntimeFacilitatorCard)
    .slice(0, MAX_FACILITATOR_OUTPUT_CARDS);
  const originalIds = new Set(cappedCards.map((card) => card.id.trim()));
  const usedIds = new Set<string>();

  return cappedCards.map((card, index) => {
    const baseId =
      capText(card.id.trim(), MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) ||
      `card-${index + 1}`;
    const id = usedIds.has(baseId)
      ? uniqueDerivedCardId(baseId, usedIds, originalIds)
      : baseId;
    usedIds.add(id);

    return {
      id,
      kind: card.kind,
      title: capText(card.title, MAX_FACILITATOR_CARD_TEXT_LENGTH),
      body: capText(card.body, MAX_FACILITATOR_CARD_TEXT_LENGTH),
      priority: card.priority
    };
  });
}

function isRuntimeFacilitatorCard(value: unknown): value is FacilitatorCard {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isFacilitatorCardKind(value.kind) &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    isFacilitatorCardPriority(value.priority)
  );
}

function isFacilitatorCardKind(value: unknown): value is FacilitatorCardKind {
  return (
    value === "heartbeat" ||
    value === "participation" ||
    value === "risk" ||
    value === "agenda" ||
    value === "decision" ||
    value === "action" ||
    value === "drift" ||
    value === "reminder"
  );
}

function isFacilitatorCardPriority(
  value: unknown
): value is FacilitatorCard["priority"] {
  return value === "low" || value === "medium" || value === "high";
}

function uniqueDerivedCardId(
  baseId: string,
  usedIds: Set<string>,
  originalIds: Set<string>
): string {
  let suffix = 2;
  let candidate = `${baseId}-${suffix}`;
  while (usedIds.has(candidate) || originalIds.has(candidate)) {
    suffix += 1;
    candidate = `${baseId}-${suffix}`;
  }
  return candidate;
}

function capAgendaActions(actions: unknown[]): AgendaAction[] {
  const order: string[] = [];
  const byItem = new Map<string, AgendaAction>();

  for (const action of actions) {
    if (!isRecord(action) || typeof action.done !== "boolean") {
      continue;
    }
    const itemId = cappedStringParam(action.itemId);
    const reason = cappedStringParam(action.reason);
    if (!itemId || reason === undefined) {
      continue;
    }
    if (!byItem.has(itemId)) {
      order.push(itemId);
    }
    byItem.set(itemId, {
      itemId,
      done: action.done,
      reason
    });
  }

  return order
    .map((itemId) => byItem.get(itemId))
    .filter((action): action is AgendaAction => Boolean(action))
    .slice(0, MAX_AGENDA_ITEMS);
}

export function capUiActions(actions: unknown[]): UiAction[] {
  const normalizedActions = actions
    .map(capUiActionText)
    .filter((action): action is UiAction => Boolean(action));
  if (normalizedActions.length <= MAX_FACILITATOR_OUTPUT_UI_ACTIONS) {
    return normalizedActions;
  }

  const reviewAction = [...normalizedActions]
    .reverse()
    .find((action) => action.tool === "update_review_document");
  if (!reviewAction) {
    return normalizedActions.slice(0, MAX_FACILITATOR_OUTPUT_UI_ACTIONS);
  }

  return [
    reviewAction,
    ...normalizedActions
      .filter((action) => action.tool !== "update_review_document")
      .slice(0, MAX_FACILITATOR_OUTPUT_UI_ACTIONS - 1)
  ];
}

function capUiActionText(action: unknown): UiAction | null {
  if (
    !isRecord(action) ||
    !isKnownUiTool(action.tool) ||
    !isRecord(action.parameters)
  ) {
    return null;
  }

  const parameters: Record<string, unknown> = {};
  if (action.tool === "send_room_reminder") {
    const message = cappedStringParam(action.parameters.message);
    const tone = cappedStringParam(action.parameters.tone);
    if (message === undefined) return null;
    parameters.message = message;
    if (tone !== undefined) {
      parameters.tone = tone;
    }
  }
  if (action.tool === "add_agenda_item") {
    const title = cappedStringParam(action.parameters.title);
    if (title === undefined) return null;
    parameters.title = title;
  }
  if (action.tool === "set_agenda_item" || action.tool === "delete_agenda_item") {
    const itemId = cappedStringParam(action.parameters.itemId);
    if (itemId === undefined) return null;
    parameters.itemId = itemId;
    if (action.tool === "set_agenda_item") {
      if (typeof action.parameters.done !== "boolean") return null;
      parameters.done = action.parameters.done;
    }
  }
  if (action.tool === "update_review_document") {
    if (typeof action.parameters.markdown !== "string") return null;
    parameters.markdown = capText(
      action.parameters.markdown,
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    );
    const summary = cappedStringParam(action.parameters.summary);
    if (summary !== undefined) {
      parameters.summary = summary;
    }
  }

  return {
    tool: action.tool,
    parameters,
    reason: cappedStringParam(action.reason) ?? ""
  };
}

function isKnownUiTool(tool: unknown): tool is UiToolName {
  return (
    tool === "add_agenda_item" ||
    tool === "set_agenda_item" ||
    tool === "delete_agenda_item" ||
    tool === "send_room_reminder" ||
    tool === "update_review_document"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cappedStringParam(value: unknown): string | undefined {
  return typeof value === "string"
    ? capText(value, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
    : undefined;
}

function capText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function compactMiddleText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const available = Math.max(
    0,
    maxLength - HEARTBEAT_REVIEW_COMPACTION_MARKER.length
  );
  const headLength = Math.ceil(available * 0.55);
  const tailLength = Math.max(0, available - headLength);
  return `${text.slice(0, headLength).trimEnd()}${HEARTBEAT_REVIEW_COMPACTION_MARKER}${text
    .slice(text.length - tailLength)
    .trimStart()}`;
}

export function compactReviewMarkdownForHeartbeat(markdown: string): string {
  return compactMiddleText(markdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH);
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
  const compactMeeting = compactMeetingForAdapter(meeting);
  const compactTranscript = compactTranscriptForHeartbeat(
    transcript,
    lastHeartbeatAt,
    now
  );
  const compactPriorInterventions = compactTimelineHistory(priorInterventions);
  const compactReviewVersions = compactReviewHistory(reviewVersions ?? []);
  const compactReviewMarkdown = compactReviewMarkdownForHeartbeat(
    currentReviewMarkdown ?? createInitialReviewMarkdown(compactMeeting)
  );

  return {
    meeting: compactMeeting,
    transcript: compactTranscript,
    transcriptDelta: compactTranscript.filter(
      (line) => line.timestamp > lastHeartbeatAt && line.timestamp <= now
    ),
    participation: createParticipationStatus(
      compactMeeting.expectedParticipants,
      observedSpeakerLabels
    ),
    agendaProgress: getAgendaProgress(compactMeeting.agenda),
    priorInterventions: compactPriorInterventions,
    priorReminders: compactPriorInterventions
      .filter((entry) => typeof entry.reminder === "string" && entry.reminder.trim())
      .map((entry) => ({
        timestamp: entry.timestamp,
        message: entry.reminder as string,
        source: entry.source
      })),
    currentReviewMarkdown: compactReviewMarkdown,
    reviewVersions: compactReviewVersions,
    uiTools: createUiToolDefinitions(compactMeeting),
    runtime: {
      meetingStartedAt: startedAt,
      meetingElapsedSeconds: Math.max(0, Math.floor((now - startedAt) / 1000)),
      isPaused: isPaused ?? false,
      heartbeatCount: heartbeatCount ?? priorInterventions.length
    },
    now
  };
}

export function compactMeetingForAdapter(meeting: MeetingConfig): MeetingConfig {
  return {
    title: capText(meeting.title, MAX_HEARTBEAT_INPUT_TEXT_LENGTH),
    goal: capText(meeting.goal, MAX_HEARTBEAT_INPUT_TEXT_LENGTH),
    context: capText(meeting.context, MAX_HEARTBEAT_INPUT_TEXT_LENGTH),
    agenda: meeting.agenda.map((item) => ({
      id: capText(item.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
      title: capText(item.title, MAX_HEARTBEAT_INPUT_TEXT_LENGTH),
      done: item.done
    })),
    participants: meeting.participants.map((participant) => ({
      name: capText(participant.name, MAX_HEARTBEAT_INPUT_TEXT_LENGTH),
      ...(participant.role === undefined
        ? {}
        : { role: capText(participant.role, MAX_HEARTBEAT_INPUT_TEXT_LENGTH) })
    })),
    expectedParticipants: meeting.expectedParticipants,
    heartbeatIntervalSeconds: meeting.heartbeatIntervalSeconds
  };
}

function compactTranscriptForHeartbeat(
  transcript: TranscriptLine[],
  lastHeartbeatAt: number,
  now: number
): TranscriptLine[] {
  const usableTranscript = transcript
    .filter((line) => line.timestamp <= now)
    .map(normalizeTranscriptLineForHeartbeat);
  const contextBeforeHeartbeat = usableTranscript
    .filter((line) => line.timestamp <= lastHeartbeatAt)
    .slice(-MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES);
  const freshDelta = usableTranscript
    .filter((line) => line.timestamp > lastHeartbeatAt)
    .slice(-MAX_HEARTBEAT_TRANSCRIPT_DELTA_LINES);
  const byId = new Map<string, TranscriptLine>();

  for (const line of [...contextBeforeHeartbeat, ...freshDelta]) {
    byId.set(line.id, line);
  }

  return Array.from(byId.values()).sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id)
  );
}

function normalizeTranscriptLineForHeartbeat(line: TranscriptLine): TranscriptLine {
  const speakerLabel = normalizeSpeakerLabel(line.speakerLabel) ?? "Speaker 1";
  return {
    id: capText(line.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    speakerId: capText(line.speakerId, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    speakerLabel,
    text: capText(line.text, MAX_HEARTBEAT_INPUT_TEXT_LENGTH),
    timestamp: line.timestamp,
    source: line.source,
    confidence: line.confidence
  };
}

function compactTimelineHistory(
  priorInterventions: TimelineEntry[]
): TimelineEntry[] {
  return [...priorInterventions]
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp || right.id.localeCompare(left.id)
    )
    .slice(0, MAX_HEARTBEAT_HISTORY_ITEMS)
    .map(capTimelineEntry);
}

function capTimelineEntry(entry: TimelineEntry): TimelineEntry {
  return {
    id: capText(entry.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    timestamp: entry.timestamp,
    source: entry.source,
    cards: capCards(entry.cards),
    summary: capText(entry.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    reminder:
      entry.reminder === undefined || entry.reminder === null
        ? entry.reminder
        : capText(entry.reminder, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    reviewMarkdown:
      entry.reviewMarkdown === undefined
        ? undefined
        : compactMiddleText(
            entry.reviewMarkdown,
            MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
          )
  };
}

function compactReviewHistory(reviewVersions: ReviewVersion[]): ReviewVersion[] {
  return [...reviewVersions]
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp || right.id.localeCompare(left.id)
    )
    .slice(0, MAX_HEARTBEAT_REVIEW_VERSIONS)
    .map((version) => ({
      id: capText(version.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
      timestamp: version.timestamp,
      source: version.source,
      markdown: compactMiddleText(
        version.markdown,
        MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
      ),
      summary: capText(version.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
    }));
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

  return capFacilitatorOutput({
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
  });
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
        "Replace the live markdown review document with the complete non-destructive revision for this heartbeat, editing every relevant section in place.",
      parameters: {
        markdown:
          "complete markdown document; preserve resolved or removed material with Markdown strikethrough instead of deleting it",
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
    "_RoomPulse revises the full document every heartbeat. Removed, resolved, merged, or superseded meeting content should be struck through, not deleted._"
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
    visibleReviewMarkdown(input.currentReviewMarkdown),
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

function visibleReviewMarkdown(markdown: string): string {
  return markdown.replace(HEARTBEAT_REVIEW_COMPACTION_MARKER, "\n\n...\n\n");
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
  const activeTitleTokens = tokenizeTitle(active.title);
  if (
    activeTitleTokens.length === 0 ||
    !isCoverageCueForItem(combinedText, activeTitleTokens)
  ) {
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
