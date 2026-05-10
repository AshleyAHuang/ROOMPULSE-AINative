import { NextResponse } from "next/server";
import { appendMeetingLogEvent } from "@/lib/meeting-log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60 * 1000;

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
      { status: eventWriteErrorStatus(error) }
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
    isValidTimestamp(value.timestamp) &&
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
        isNonEmptyString(payload.reviewVersionId)) &&
      isHeartbeatOutput(payload.output)
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
    return isRecord(payload) && isValidTimestamp(payload.endedAt);
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
    isValidTimestamp(value.timestamp) &&
    (value.source === "speech" ||
      value.source === "simulated" ||
      value.source === "manual") &&
    isConfidence(value.confidence)
  );
}

function isReviewVersion(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isValidTimestamp(value.timestamp) &&
    typeof value.markdown === "string" &&
    typeof value.summary === "string" &&
    (value.source === "pi" ||
      value.source === "openrouter" ||
      value.source === "local-fallback" ||
      value.source === "initial" ||
      value.source === "restored")
  );
}

function isHeartbeatOutput(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.source === "pi" ||
      value.source === "openrouter" ||
      value.source === "local-fallback") &&
    (value.cards === undefined ||
      (Array.isArray(value.cards) && value.cards.every(isFacilitatorCard))) &&
    typeof value.summary === "string" &&
    (value.nextHeartbeatHint === undefined ||
      typeof value.nextHeartbeatHint === "string") &&
    typeof value.reviewMarkdown === "string" &&
    (value.agendaActions === undefined ||
      (Array.isArray(value.agendaActions) &&
        value.agendaActions.every(isAgendaAction))) &&
    (value.uiActions === undefined ||
      (Array.isArray(value.uiActions) && value.uiActions.every(isUiAction))) &&
    (value.ephemeralReminder === undefined ||
      value.ephemeralReminder === null ||
      typeof value.ephemeralReminder === "string")
  );
}

function isAgendaAction(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.itemId) &&
    typeof value.done === "boolean" &&
    isNonEmptyString(value.reason)
  );
}

function isUiAction(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isKnownUiTool(value.tool) ||
    !isRecord(value.parameters) ||
    !isNonEmptyString(value.reason)
  ) {
    return false;
  }

  if (value.tool === "add_agenda_item") {
    return isNonEmptyString(value.parameters.title);
  }

  if (value.tool === "set_agenda_item") {
    return (
      isNonEmptyString(value.parameters.itemId) &&
      typeof value.parameters.done === "boolean"
    );
  }

  if (value.tool === "delete_agenda_item") {
    return isNonEmptyString(value.parameters.itemId);
  }

  if (value.tool === "send_room_reminder") {
    return (
      isNonEmptyString(value.parameters.message) &&
      (value.parameters.tone === undefined ||
        typeof value.parameters.tone === "string")
    );
  }

  if (value.tool === "update_review_document") {
    return (
      isNonEmptyString(value.parameters.markdown) &&
      (value.parameters.summary === undefined ||
        typeof value.parameters.summary === "string")
    );
  }

  return false;
}

function isKnownUiTool(value: unknown): value is string {
  return (
    value === "add_agenda_item" ||
    value === "set_agenda_item" ||
    value === "delete_agenda_item" ||
    value === "send_room_reminder" ||
    value === "update_review_document"
  );
}

function isFacilitatorCard(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    (value.kind === "heartbeat" ||
      value.kind === "participation" ||
      value.kind === "risk" ||
      value.kind === "agenda" ||
      value.kind === "decision" ||
      value.kind === "action" ||
      value.kind === "drift" ||
      value.kind === "reminder") &&
    isNonEmptyString(value.title) &&
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
    value >= 0 &&
    Number.isSafeInteger(value) &&
    !Number.isNaN(new Date(value).getTime()) &&
    value <= Date.now() + MAX_TIMESTAMP_FUTURE_SKEW_MS
  );
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

function eventWriteErrorStatus(error: unknown): number {
  if (isMeetingNotFound(error)) {
    return 404;
  }
  if (error instanceof Error && error.message === "Meeting log has ended") {
    return 409;
  }
  return 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
