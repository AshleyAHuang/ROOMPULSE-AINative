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
}

export interface AgendaProgress {
  total: number;
  completed: number;
  active: AgendaItem | null;
}

export interface HeartbeatInput {
  meeting: MeetingConfig;
  transcript: TranscriptLine[];
  transcriptDelta: TranscriptLine[];
  participation: ParticipationStatus;
  agendaProgress: AgendaProgress;
  priorInterventions: TimelineEntry[];
  now: number;
}

export interface FacilitatorOutput {
  source: "pi" | "local-fallback";
  cards: FacilitatorCard[];
  summary: string;
  nextHeartbeatHint: string;
  adapterNotice?: string;
}

export interface CreateHeartbeatInputArgs {
  meeting: MeetingConfig;
  transcript: TranscriptLine[];
  observedSpeakerLabels: string[];
  lastHeartbeatAt: number;
  now: number;
  priorInterventions: TimelineEntry[];
}

export function createHeartbeatInput({
  meeting,
  transcript,
  observedSpeakerLabels,
  lastHeartbeatAt,
  now,
  priorInterventions
}: CreateHeartbeatInputArgs): HeartbeatInput {
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
      : "Next check should confirm whether the meeting goal is complete."
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
