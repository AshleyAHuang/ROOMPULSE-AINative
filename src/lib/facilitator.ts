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
  currentReviewMarkdown: string;
  reviewVersions: ReviewVersion[];
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
    currentReviewMarkdown:
      currentReviewMarkdown ?? createInitialReviewMarkdown(meeting),
    reviewVersions: reviewVersions ?? [],
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
  const agendaActions = inferAgendaActions(input, combinedText);
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
      ? `Next check should revisit ${activeAgenda.title}.`
      : "Next check should confirm whether the meeting goal is complete.",
    reviewMarkdown: buildReviewMarkdown(input, cards, agendaActions),
    agendaActions,
    ephemeralReminder: selectEphemeralReminder(input, cards)
  };
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

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
