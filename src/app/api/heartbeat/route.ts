import { NextResponse } from "next/server";
import {
  MAX_AGENDA_ITEMS,
  MAX_EXPECTED_PARTICIPANTS,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MAX_PARTICIPANT_ENTRIES,
  MIN_HEARTBEAT_INTERVAL_SECONDS,
  createHeartbeatInput,
  type CreateHeartbeatInputArgs
} from "@/lib/facilitator";
import { runPiHeartbeat } from "@/lib/pi-adapter";

export const runtime = "nodejs";

const MAX_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60 * 1000;

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON payload"
      },
      { status: 400 }
    );
  }

  if (!isHeartbeatPayload(payload)) {
    return NextResponse.json(
      {
        error: "Invalid heartbeat payload"
      },
      { status: 400 }
    );
  }

  try {
    const input = createHeartbeatInput(payload);
    const output = await runPiHeartbeat(input);

    return NextResponse.json(output);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Heartbeat failed",
        piRequired: process.env.ROOMPULSE_REQUIRE_PI === "1"
      },
      { status: 500 }
    );
  }
}

function isHeartbeatPayload(value: unknown): value is CreateHeartbeatInputArgs {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isValidTimestamp(value.lastHeartbeatAt) ||
    !isValidTimestamp(value.now) ||
    value.now < value.lastHeartbeatAt
  ) {
    return false;
  }
  const now = value.now;

  return (
    isMeeting(value.meeting) &&
    Array.isArray(value.transcript) &&
    value.transcript.every(
      (line) => isTranscriptLine(line) && line.timestamp <= now
    ) &&
    Array.isArray(value.observedSpeakerLabels) &&
    value.observedSpeakerLabels.every(isNonEmptyString) &&
    Array.isArray(value.priorInterventions) &&
    value.priorInterventions.every(
      (entry) => isTimelineEntry(entry) && entry.timestamp <= now
    ) &&
    (value.currentReviewMarkdown === undefined ||
      typeof value.currentReviewMarkdown === "string") &&
    (value.reviewVersions === undefined ||
      (Array.isArray(value.reviewVersions) &&
        value.reviewVersions.every(
          (version) => isReviewVersion(version) && version.timestamp <= now
        ))) &&
    (value.meetingStartedAt === undefined ||
      (isValidTimestamp(value.meetingStartedAt) &&
        value.meetingStartedAt <= now)) &&
    (value.isPaused === undefined || typeof value.isPaused === "boolean") &&
    (value.heartbeatCount === undefined ||
      isIntegerAtLeast(value.heartbeatCount, 0))
  );
}

function isMeeting(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.goal) &&
    typeof value.context === "string" &&
    Array.isArray(value.agenda) &&
    value.agenda.length <= MAX_AGENDA_ITEMS &&
    value.agenda.every(isAgendaItem) &&
    hasUniqueAgendaIds(value.agenda) &&
    isIntegerInRange(value.expectedParticipants, 1, MAX_EXPECTED_PARTICIPANTS) &&
    Array.isArray(value.participants) &&
    value.participants.length <= MAX_PARTICIPANT_ENTRIES &&
    value.participants.every(isParticipant) &&
    isIntegerInRange(
      value.heartbeatIntervalSeconds,
      MIN_HEARTBEAT_INTERVAL_SECONDS,
      MAX_HEARTBEAT_INTERVAL_SECONDS
    )
  );
}

function isAgendaItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    typeof value.done === "boolean"
  );
}

function hasUniqueAgendaIds(agenda: unknown[]): boolean {
  const ids = agenda.map((item) =>
    isRecord(item) && typeof item.id === "string" ? item.id.trim() : ""
  );
  return new Set(ids).size === ids.length;
}

function isParticipant(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    (value.role === undefined || typeof value.role === "string")
  );
}

function isTranscriptLine(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.speakerId) &&
    isNonEmptyString(value.speakerLabel) &&
    typeof value.text === "string" &&
    isValidTimestamp(value.timestamp) &&
    isTranscriptSource(value.source) &&
    isConfidence(value.confidence)
  );
}

function isTranscriptSource(value: unknown): boolean {
  return value === "speech" || value === "simulated" || value === "manual";
}

function isTimelineEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isValidTimestamp(value.timestamp) &&
    (value.source === "pi" ||
      value.source === "openrouter" ||
      value.source === "local-fallback") &&
    Array.isArray(value.cards) &&
    value.cards.every(isFacilitatorCard) &&
    typeof value.summary === "string" &&
    (value.reviewMarkdown === undefined ||
      typeof value.reviewMarkdown === "string") &&
    (value.reminder === undefined ||
      value.reminder === null ||
      typeof value.reminder === "string")
  );
}

function isFacilitatorCard(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isFacilitatorCardKind(value.kind) &&
    isNonEmptyString(value.title) &&
    typeof value.body === "string" &&
    (value.priority === "low" ||
      value.priority === "medium" ||
      value.priority === "high")
  );
}

function isReviewVersion(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isValidTimestamp(value.timestamp) &&
    (value.source === "pi" ||
      value.source === "openrouter" ||
      value.source === "local-fallback" ||
      value.source === "initial" ||
      value.source === "restored") &&
    typeof value.markdown === "string" &&
    typeof value.summary === "string"
  );
}

function isFacilitatorCardKind(value: unknown): boolean {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerAtLeast(value: unknown, min: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= min;
}

function isIntegerInRange(
  value: unknown,
  min: number,
  max: number
): value is number {
  return isIntegerAtLeast(value, min) && value <= max;
}

function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    value >= 0 &&
    Number.isSafeInteger(value) &&
    !Number.isNaN(new Date(value).getTime()) &&
    value <= Date.now() + MAX_TIMESTAMP_FUTURE_SKEW_MS
  );
}

function isConfidence(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
