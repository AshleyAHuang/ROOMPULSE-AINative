import { NextResponse } from "next/server";
import {
  MAX_EXPECTED_PARTICIPANTS,
  type MeetingConfig
} from "@/lib/facilitator";
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
            : "Initial review document failed",
        piRequired: process.env.ROOMPULSE_REQUIRE_PI === "1"
      },
      { status: 500 }
    );
  }
}

function isMeeting(value: unknown): value is MeetingConfig {
  if (!isRecord(value)) return false;

  return (
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.goal) &&
    typeof value.context === "string" &&
    Array.isArray(value.agenda) &&
    value.agenda.every(isAgendaItem) &&
    isIntegerInRange(value.expectedParticipants, 1, MAX_EXPECTED_PARTICIPANTS) &&
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIntegerAtLeast(value: unknown, min: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= min
  );
}

function isIntegerInRange(
  value: unknown,
  min: number,
  max: number
): value is number {
  return isIntegerAtLeast(value, min) && value <= max;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
