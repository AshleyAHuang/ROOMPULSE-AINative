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
    typeof payload.endedAt === "number" && Number.isFinite(payload.endedAt)
      ? payload.endedAt
      : undefined;
  const updatedAt =
    typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)
      ? payload.updatedAt
      : undefined;
  const state =
    isPersistedMeetingState(payload.state) ? payload.state : undefined;

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
    isFiniteNumber(value.lastHeartbeatAt) &&
    isFiniteNumber(value.nextHeartbeatAt) &&
    isFiniteNumber(value.meetingStartedAt) &&
    isFiniteNumber(value.heartbeatCount) &&
    typeof value.isPaused === "boolean" &&
    (value.activeAgendaItemId === null ||
      typeof value.activeAgendaItemId === "string") &&
    isFiniteNumber(value.updatedAt) &&
    (value.endedAt === undefined ||
      value.endedAt === null ||
      isFiniteNumber(value.endedAt))
  );
}

function isMeeting(value: unknown): boolean {
  if (!isRecord(value)) return false;

  return (
    typeof value.title === "string" &&
    typeof value.goal === "string" &&
    typeof value.context === "string" &&
    Array.isArray(value.agenda) &&
    value.agenda.every(isAgendaItem) &&
    isFiniteNumber(value.expectedParticipants) &&
    Array.isArray(value.participants) &&
    value.participants.every(isParticipant) &&
    isFiniteNumber(value.heartbeatIntervalSeconds)
  );
}

function isAgendaItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.done === "boolean"
  );
}

function isParticipant(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.role === undefined || typeof value.role === "string")
  );
}

function isTranscriptLine(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.speakerId === "string" &&
    typeof value.speakerLabel === "string" &&
    typeof value.text === "string" &&
    isFiniteNumber(value.timestamp) &&
    isTranscriptSource(value.source) &&
    isFiniteNumber(value.confidence)
  );
}

function isTranscriptSource(value: unknown): boolean {
  return value === "speech" || value === "simulated" || value === "manual";
}

function isReviewVersion(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isFiniteNumber(value.timestamp) &&
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
    isFiniteNumber(value.timestamp) &&
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

function isMeetingNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === "Meeting log not found";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
