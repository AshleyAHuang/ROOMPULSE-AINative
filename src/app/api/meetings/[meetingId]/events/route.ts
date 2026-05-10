import { NextResponse } from "next/server";
import { appendMeetingLogEvent } from "@/lib/meeting-log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    meetingId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { meetingId } = await context.params;
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!isLogEventPayload(payload)) {
    return NextResponse.json({ error: "Invalid log event payload" }, { status: 400 });
  }

  try {
    const event = await appendMeetingLogEvent(meetingId, {
      type: payload.type,
      timestamp: payload.timestamp,
      payload: payload.payload
    });
    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Meeting event log failed" },
      { status: isMeetingNotFound(error) ? 404 : 500 }
    );
  }
}

function isLogEventPayload(value: unknown): value is {
  type: string;
  timestamp: number;
  payload: unknown;
} {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    value.type.length > 0 &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    "payload" in value &&
    isValidEventPayload(value.type, value.payload)
  );
}

function isValidEventPayload(type: string, payload: unknown): boolean {
  if (type === "transcript_line") {
    return isRecord(payload) && isTranscriptLine(payload.line);
  }

  if (type === "heartbeat_output") {
    return (
      isRecord(payload) &&
      (payload.reviewVersionId === undefined ||
        typeof payload.reviewVersionId === "string") &&
      isRecord(payload.output) &&
      typeof payload.output.reviewMarkdown === "string"
    );
  }

  if (type === "review_initialized") {
    return isRecord(payload) && isReviewVersion(payload.reviewVersion);
  }

  if (type === "review_restored") {
    return isRecord(payload) && isReviewVersion(payload.restoredVersion);
  }

  if (type === "meeting_pause_toggled") {
    return isRecord(payload) && typeof payload.paused === "boolean";
  }

  if (type === "meeting_ended") {
    return isRecord(payload) && isFiniteNumber(payload.endedAt);
  }

  return true;
}

function isTranscriptLine(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.speakerId) &&
    isNonEmptyString(value.speakerLabel) &&
    typeof value.text === "string" &&
    isFiniteNumber(value.timestamp) &&
    (value.source === "speech" ||
      value.source === "simulated" ||
      value.source === "manual") &&
    isConfidence(value.confidence)
  );
}

function isReviewVersion(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isFiniteNumber(value.timestamp) &&
    typeof value.markdown === "string" &&
    typeof value.summary === "string" &&
    (value.source === "pi" ||
      value.source === "openrouter" ||
      value.source === "local-fallback" ||
      value.source === "initial" ||
      value.source === "restored")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
