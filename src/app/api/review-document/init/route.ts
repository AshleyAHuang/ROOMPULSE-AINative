import { NextResponse } from "next/server";
import {
  MAX_AGENDA_ITEMS,
  MAX_EXPECTED_PARTICIPANTS,
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH,
  MAX_PARTICIPANT_ENTRIES,
  MIN_HEARTBEAT_INTERVAL_SECONDS,
  compactMeetingForAdapter,
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
    const document = await runPiInitialReviewDocument(
      compactMeetingForAdapter(payload.meeting)
    );
    return NextResponse.json({
      ...document,
      markdown: capText(document.markdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH),
      summary: capText(document.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
      adapterNotice:
        document.adapterNotice === undefined
          ? undefined
          : capText(document.adapterNotice, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
    });
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
    isBoundedNonEmptyString(value.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
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

function isBoundedNonEmptyString(
  value: unknown,
  maxLength: number
): value is string {
  return isNonEmptyString(value) && value.length <= maxLength;
}

function capText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
