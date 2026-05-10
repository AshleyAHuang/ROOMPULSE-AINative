import { NextResponse } from "next/server";
import {
  readMeetingLog,
  updateMeetingLogState,
  type MeetingStatus,
  type PersistedMeetingState
} from "@/lib/meeting-log-store";

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
      { status: 500 }
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
    isRecord(value.meeting) &&
    Array.isArray(value.transcript) &&
    typeof value.reviewMarkdown === "string" &&
    Array.isArray(value.reviewVersions) &&
    typeof value.currentReviewVersionId === "string" &&
    Array.isArray(value.timeline) &&
    typeof value.lastHeartbeatAt === "number" &&
    typeof value.nextHeartbeatAt === "number" &&
    typeof value.meetingStartedAt === "number" &&
    typeof value.heartbeatCount === "number" &&
    typeof value.isPaused === "boolean" &&
    typeof value.updatedAt === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
