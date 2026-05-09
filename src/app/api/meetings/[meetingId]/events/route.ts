import { NextResponse } from "next/server";
import { appendMeetingLogEvent } from "@/lib/meeting-log-store";

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
      { status: 500 }
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
    "payload" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
