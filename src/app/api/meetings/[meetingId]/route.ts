import { NextResponse } from "next/server";
import {
  readMeetingLog,
  updateMeetingLogState,
  type MeetingStatus,
  type PersistedMeetingState
} from "@/lib/meeting-log-store";
import {
  MAX_AGENDA_ITEMS,
  MAX_EXPECTED_PARTICIPANTS,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MAX_PARTICIPANT_ENTRIES,
  MIN_HEARTBEAT_INTERVAL_SECONDS
} from "@/lib/facilitator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    meetingId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { meetingId } = await context.params;

  try {
    const meeting = await readMeetingLog(meetingId);
    return NextResponse.json(meeting);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Meeting log not found" },
      { status: 404 }
    );
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const { meetingId } = await context.params;
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!isRecord(payload)) {
    return NextResponse.json({ error: "Invalid meeting state payload" }, { status: 400 });
  }

  const status = meetingStatus(payload.status);
  const isPaused =
    typeof payload.isPaused === "boolean" ? payload.isPaused : undefined;
  const endedAt =
    isValidTimestamp(payload.endedAt)
      ? payload.endedAt
      : undefined;
  const updatedAt =
    isValidTimestamp(payload.updatedAt)
      ? payload.updatedAt
      : undefined;
  const state =
    isPersistedMeetingState(payload.state) ? payload.state : undefined;

  if (
    ("endedAt" in payload &&
      payload.endedAt !== null &&
      endedAt === undefined) ||
    ("updatedAt" in payload && updatedAt === undefined)
  ) {
    return NextResponse.json({ error: "Invalid meeting timestamp" }, { status: 400 });
  }

  if (
    ("status" in payload && status === undefined) ||
    ("isPaused" in payload && typeof payload.isPaused !== "boolean") ||
    ("state" in payload && state === undefined)
  ) {
    return NextResponse.json({ error: "Invalid meeting state payload" }, { status: 400 });
  }

  if (
    status === undefined &&
    isPaused === undefined &&
    endedAt === undefined &&
    updatedAt === undefined &&
    state === undefined
  ) {
    return NextResponse.json({ error: "Invalid meeting state payload" }, { status: 400 });
  }

  try {
    const metadata = await updateMeetingLogState(meetingId, {
      status,
      isPaused,
      endedAt,
      updatedAt,
      state
    });
    return NextResponse.json(metadata);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Meeting state update failed" },
      { status: isMeetingNotFound(error) ? 404 : 500 }
    );
  }
}

function meetingStatus(value: unknown): MeetingStatus | undefined {
  if (value === "active" || value === "paused" || value === "ended") {
    return value;
  }
  return undefined;
}

function isPersistedMeetingState(value: unknown): value is PersistedMeetingState {
  if (
    !isRecord(value) ||
    meetingStatus(value.status) === undefined ||
    !isMeeting(value.meeting) ||
    !Array.isArray(value.transcript) ||
    !value.transcript.every(isTranscriptLine) ||
    typeof value.reviewMarkdown !== "string" ||
    !Array.isArray(value.reviewVersions) ||
    !value.reviewVersions.every(isReviewVersion) ||
    !isNonEmptyString(value.currentReviewVersionId) ||
    !Array.isArray(value.timeline) ||
    !value.timeline.every(isTimelineEntry) ||
    !isValidTimestamp(value.lastHeartbeatAt) ||
    !isValidTimestamp(value.nextHeartbeatAt) ||
    !isValidTimestamp(value.meetingStartedAt) ||
    !isIntegerAtLeast(value.heartbeatCount, 0) ||
    typeof value.isPaused !== "boolean" ||
    (value.activeAgendaItemId !== null &&
      !isNonEmptyString(value.activeAgendaItemId)) ||
    !isValidTimestamp(value.updatedAt) ||
    (value.endedAt !== undefined &&
      value.endedAt !== null &&
      !isValidTimestamp(value.endedAt))
  ) {
    return false;
  }

  return isChronologicallyCoherentState(value as unknown as PersistedMeetingState);
}

function isChronologicallyCoherentState(
  state: PersistedMeetingState
): boolean {
  const updatedAt = state.updatedAt;
  return (
    state.meetingStartedAt <= updatedAt &&
    state.lastHeartbeatAt <= updatedAt &&
    (state.endedAt === undefined ||
      state.endedAt === null ||
      state.endedAt <= updatedAt) &&
    state.transcript.every((line) => line.timestamp <= updatedAt) &&
    state.reviewVersions.every((version) => version.timestamp <= updatedAt) &&
    (state.reviewVersions.length === 0 ||
      state.reviewVersions.some(
        (version) => version.id === state.currentReviewVersionId
      )) &&
    state.timeline.every((entry) => entry.timestamp <= updatedAt)
  );
}

function isMeeting(value: unknown): boolean {
  if (!isRecord(value)) return false;

  return (
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.goal) &&
    typeof value.context === "string" &&
    Array.isArray(value.agenda) &&
    value.agenda.length <= MAX_AGENDA_ITEMS &&
    value.agenda.every(isAgendaItem) &&
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

function isReviewVersion(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isValidTimestamp(value.timestamp) &&
    isReviewSource(value.source) &&
    typeof value.markdown === "string" &&
    typeof value.summary === "string"
  );
}

function isReviewSource(value: unknown): boolean {
  return (
    value === "pi" ||
    value === "openrouter" ||
    value === "local-fallback" ||
    value === "initial" ||
    value === "restored"
  );
}

function isTimelineEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isValidTimestamp(value.timestamp) &&
    isReviewSource(value.source) &&
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    value >= 0 &&
    Number.isSafeInteger(value) &&
    !Number.isNaN(new Date(value).getTime())
  );
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

function isConfidence(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isMeetingNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === "Meeting log not found";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
