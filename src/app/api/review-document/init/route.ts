import { NextResponse } from "next/server";
import type { MeetingConfig } from "@/lib/facilitator";
import { runPiInitialReviewDocument } from "@/lib/pi-adapter";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!isRecord(payload) || !isMeeting(payload.meeting)) {
    return NextResponse.json(
      { error: "Invalid meeting payload" },
      { status: 400 }
    );
  }

  try {
    const document = await runPiInitialReviewDocument(payload.meeting);
    return NextResponse.json(document);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Initial review document failed"
      },
      { status: 500 }
    );
  }
}

function isMeeting(value: unknown): value is MeetingConfig {
  if (!isRecord(value)) return false;

  return (
    typeof value.title === "string" &&
    typeof value.goal === "string" &&
    typeof value.context === "string" &&
    Array.isArray(value.agenda) &&
    value.agenda.every(isAgendaItem) &&
    typeof value.expectedParticipants === "number" &&
    Number.isFinite(value.expectedParticipants) &&
    Array.isArray(value.participants) &&
    value.participants.every(isParticipant) &&
    typeof value.heartbeatIntervalSeconds === "number" &&
    Number.isFinite(value.heartbeatIntervalSeconds)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
