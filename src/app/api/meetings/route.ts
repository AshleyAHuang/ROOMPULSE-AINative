import { NextResponse } from "next/server";
import {
  createMeetingLog,
  listMeetingLogs
} from "@/lib/meeting-log-store";
import {
  MAX_AGENDA_ITEMS,
  MAX_EXPECTED_PARTICIPANTS,
  MAX_PARTICIPANT_ENTRIES,
  type MeetingConfig
} from "@/lib/facilitator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const meetings = await listMeetingLogs();
  return NextResponse.json({ meetings });
}

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!isRecord(payload) || !isMeeting(payload.meeting)) {
    return NextResponse.json({ error: "Invalid meeting payload" }, { status: 400 });
  }

  try {
    if (
      "startedAt" in payload &&
      (typeof payload.startedAt !== "number" ||
        !isValidTimestamp(payload.startedAt))
    ) {
      return NextResponse.json(
        { error: "Invalid meeting timestamp" },
        { status: 400 }
      );
    }
    const startedAt =
      typeof payload.startedAt === "number" ? payload.startedAt : Date.now();
    const metadata = await createMeetingLog(payload.meeting, startedAt);
    return NextResponse.json(metadata, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Meeting log failed" },
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
    value.agenda.length <= MAX_AGENDA_ITEMS &&
    value.agenda.every(isAgendaItem) &&
    isIntegerInRange(value.expectedParticipants, 1, MAX_EXPECTED_PARTICIPANTS) &&
    Array.isArray(value.participants) &&
    value.participants.length <= MAX_PARTICIPANT_ENTRIES &&
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function isValidTimestamp(value: number): boolean {
  return (
    value >= 0 &&
    Number.isSafeInteger(value) &&
    !Number.isNaN(new Date(value).getTime())
  );
}
