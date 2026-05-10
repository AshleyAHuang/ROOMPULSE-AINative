import { NextResponse } from "next/server";
import {
  readMeetingLog,
  updateMeetingLogState,
  type MeetingStatus,
  type PersistedMeetingState
} from "@/lib/meeting-log-store";

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
    (typeof payload.endedAt === "number" && endedAt === undefined) ||
    (typeof payload.updatedAt === "number" && updatedAt === undefined)
  ) {
    return NextResponse.json({ error: "Invalid meeting timestamp" }, { status: 400 });
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
  return (
    isRecord(value) &&
    meetingStatus(value.status) !== undefined &&
    isMeeting(value.meeting) &&
    Array.isArray(value.transcript) &&
    value.transcript.every(isTranscriptLine) &&
    typeof value.reviewMarkdown === "string" &&
    Array.isArray(value.reviewVersions) &&
    value.reviewVersions.every(isReviewVersion) &&
    typeof value.currentReviewVersionId === "string" &&
    Array.isArray(value.timeline) &&
    value.timeline.every(isTimelineEntry) &&
    isValidTimestamp(value.lastHeartbeatAt) &&
    isValidTimestamp(value.nextHeartbeatAt) &&
    isValidTimestamp(value.meetingStartedAt) &&
    isFiniteNumber(value.heartbeatCount) &&
    typeof value.isPaused === "boolean" &&
    (value.activeAgendaItemId === null ||
      typeof value.activeAgendaItemId === "string") &&
    isValidTimestamp(value.updatedAt) &&
    (value.endedAt === undefined ||
      value.endedAt === null ||
      isValidTimestamp(value.endedAt))
  );
}

function isMeeting(value: unknown): boolean {
  if (!isRecord(value)) return false;

  return (
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.goal) &&
    typeof value.context === "string" &&
    Array.isArray(value.agenda) &&
    value.agenda.every(isAgendaItem) &&
    isIntegerAtLeast(value.expectedParticipants, 1) &&
    Array.isArray(value.participants) &&
    value.participants.every(isParticipant) &&
    isIntegerAtLeast(value.heartbeatIntervalSeconds, 15)
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
    typeof value.id === "string" &&
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
    typeof value.id === "string" &&
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
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    (value.priority === "low" ||
      value.priority === "medium" ||
      value.priority === "high")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function isIntegerAtLeast(value: unknown, min: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= min;
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
