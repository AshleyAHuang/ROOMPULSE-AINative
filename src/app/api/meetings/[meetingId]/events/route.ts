import { NextResponse } from "next/server";
import { appendMeetingLogEvent } from "@/lib/meeting-log-store";
import {
  MAX_AGENDA_ITEMS,
  MAX_EXPECTED_PARTICIPANTS,
  MAX_FACILITATOR_CARD_TEXT_LENGTH,
  MAX_FACILITATOR_OUTPUT_CARDS,
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_FACILITATOR_OUTPUT_UI_ACTIONS,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MAX_HEARTBEAT_INPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH,
  MAX_PARTICIPANT_ENTRIES,
  MIN_HEARTBEAT_INTERVAL_SECONDS,
  compactMeetingForAdapter,
  type MeetingConfig
} from "@/lib/facilitator";
import { isSafeSpeakerLabel } from "@/lib/speaker-tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60 * 1000;
const KNOWN_EVENT_TYPES = new Set([
  "agenda_item_added",
  "agenda_item_deleted",
  "agenda_manual_update",
  "heartbeat_interval_changed",
  "heartbeat_output",
  "meeting_ended",
  "meeting_pause_toggled",
  "meeting_started",
  "review_initialization_failed",
  "review_initialized",
  "review_restored",
  "scripted_demo_started",
  "transcript_line"
]);

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
  const eventPayload = normalizeEventPayload(payload.type, payload.payload);
  if (eventPayload === null) {
    return NextResponse.json({ error: "Invalid log event payload" }, { status: 400 });
  }

  try {
    const event = await appendMeetingLogEvent(meetingId, {
      type: payload.type,
      timestamp: payload.timestamp,
      payload: eventPayload
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
    isEventType(value.type) &&
    isValidTimestamp(value.timestamp) &&
    "payload" in value &&
    isValidEventPayload(value.type, value.payload)
  );
}

function isValidEventPayload(type: string, payload: unknown): boolean {
  if (type === "transcript_line") {
    return isRecord(payload) && isTranscriptLine(payload.line);
  }

  if (type === "meeting_started") {
    return isRecord(payload) && isMeeting(payload.meeting);
  }

  if (type === "scripted_demo_started") {
    return (
      isRecord(payload) &&
      isIntegerInRange(payload.durationMs, 0, MAX_HEARTBEAT_INTERVAL_SECONDS * 1000) &&
      isIntegerInRange(payload.beats, 0, MAX_HEARTBEAT_INPUT_TEXT_LENGTH)
    );
  }

  if (type === "heartbeat_output") {
    return (
      isRecord(payload) &&
      (payload.reviewVersionId === undefined ||
        isBoundedNonEmptyString(
          payload.reviewVersionId,
          MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
        )) &&
      isHeartbeatOutput(payload.output)
    );
  }

  if (type === "review_initialized") {
    return isRecord(payload) && isReviewVersion(payload.reviewVersion);
  }

  if (type === "review_restored") {
    return (
      isRecord(payload) &&
      isReviewVersion(payload.restoredVersion) &&
      (payload.sourceVersionId === undefined ||
        isBoundedNonEmptyString(
          payload.sourceVersionId,
          MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
        ))
    );
  }

  if (type === "review_initialization_failed") {
    return isRecord(payload) && isBoundedString(payload.message, Infinity);
  }

  if (type === "agenda_manual_update") {
    return (
      isRecord(payload) &&
      isBoundedNonEmptyString(payload.itemId, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
      typeof payload.done === "boolean"
    );
  }

  if (type === "agenda_item_added" || type === "agenda_item_deleted") {
    return (
      isRecord(payload) &&
      isAgendaItem(payload.item) &&
      (payload.reason === undefined ||
        isBoundedString(payload.reason, Infinity))
    );
  }

  if (type === "heartbeat_interval_changed") {
    return (
      isRecord(payload) &&
      isIntegerInRange(
        payload.seconds,
        MIN_HEARTBEAT_INTERVAL_SECONDS,
        MAX_HEARTBEAT_INTERVAL_SECONDS
      )
    );
  }

  if (type === "meeting_pause_toggled") {
    return isRecord(payload) && typeof payload.paused === "boolean";
  }

  if (type === "meeting_ended") {
    return isRecord(payload) && isValidTimestamp(payload.endedAt);
  }

  return true;
}

function normalizeEventPayload(type: string, payload: unknown): unknown | null {
  if (!isValidEventPayload(type, payload)) {
    return null;
  }

  if (type === "transcript_line" && isRecord(payload)) {
    const line = normalizeTranscriptLine(payload.line);
    return line ? { line } : null;
  }

  if (type === "meeting_started" && isRecord(payload) && isMeeting(payload.meeting)) {
    return {
      meeting: compactMeetingForAdapter(payload.meeting),
      ...(isBoundedString(payload.mode, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
        ? { mode: payload.mode }
        : {})
    };
  }

  if (type === "scripted_demo_started" && isRecord(payload)) {
    return {
      durationMs: payload.durationMs,
      beats: payload.beats
    };
  }

  if (type === "heartbeat_output" && isRecord(payload)) {
    const output = normalizeHeartbeatOutput(payload.output);
    return output
      ? {
          ...(payload.reviewVersionId === undefined
            ? {}
            : { reviewVersionId: payload.reviewVersionId }),
          output
        }
      : null;
  }

  if (type === "review_initialized" && isRecord(payload)) {
    const reviewVersion = normalizeReviewVersion(payload.reviewVersion);
    return reviewVersion ? { reviewVersion } : null;
  }

  if (type === "review_restored" && isRecord(payload)) {
    const restoredVersion = normalizeReviewVersion(payload.restoredVersion);
    return restoredVersion
      ? {
          restoredVersion,
          ...(payload.sourceVersionId === undefined
            ? {}
            : { sourceVersionId: payload.sourceVersionId })
        }
      : null;
  }

  if (type === "review_initialization_failed" && isRecord(payload)) {
    return {
      message: capString(String(payload.message), MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
    };
  }

  if (type === "agenda_manual_update" && isRecord(payload)) {
    return {
      itemId: payload.itemId,
      done: payload.done
    };
  }

  if (
    (type === "agenda_item_added" || type === "agenda_item_deleted") &&
    isRecord(payload)
  ) {
    const item = normalizeAgendaItem(payload.item);
    return item
      ? {
          item,
          reason:
            typeof payload.reason === "string"
              ? capString(payload.reason, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
              : ""
        }
      : null;
  }

  if (type === "heartbeat_interval_changed" && isRecord(payload)) {
    return { seconds: payload.seconds };
  }

  if (type === "meeting_pause_toggled" && isRecord(payload)) {
    return { paused: payload.paused };
  }

  if (type === "meeting_ended" && isRecord(payload)) {
    return { endedAt: payload.endedAt };
  }

  return null;
}

function normalizeTranscriptLine(value: unknown): unknown | null {
  if (!isRecord(value) || !isTranscriptLine(value)) return null;

  return {
    id: value.id,
    speakerId: value.speakerId,
    speakerLabel: value.speakerLabel,
    text: value.text,
    timestamp: value.timestamp,
    source: value.source,
    confidence: value.confidence
  };
}

function normalizeReviewVersion(value: unknown): unknown | null {
  if (!isRecord(value) || !isReviewVersion(value)) return null;

  return {
    id: value.id,
    timestamp: value.timestamp,
    source: value.source,
    markdown: value.markdown,
    summary: value.summary
  };
}

function normalizeHeartbeatOutput(value: unknown): unknown | null {
  if (!isRecord(value) || !isHeartbeatOutput(value)) return null;

  return {
    source: value.source,
    ...(Array.isArray(value.cards)
      ? { cards: value.cards.map(normalizeFacilitatorCard).filter(Boolean) }
      : {}),
    summary: value.summary,
    ...(value.nextHeartbeatHint === undefined
      ? {}
      : { nextHeartbeatHint: value.nextHeartbeatHint }),
    reviewMarkdown: value.reviewMarkdown,
    ...(Array.isArray(value.agendaActions)
      ? {
          agendaActions: value.agendaActions
            .map(normalizeAgendaAction)
            .filter(Boolean)
        }
      : {}),
    ...(Array.isArray(value.uiActions)
      ? { uiActions: value.uiActions.map(normalizeUiAction).filter(Boolean) }
      : {}),
    ...(value.ephemeralReminder === undefined
      ? {}
      : { ephemeralReminder: value.ephemeralReminder }),
    ...(value.adapterNotice === undefined
      ? {}
      : { adapterNotice: value.adapterNotice })
  };
}

function normalizeFacilitatorCard(value: unknown): unknown | null {
  if (!isRecord(value) || !isFacilitatorCard(value)) return null;

  return {
    id: value.id,
    kind: value.kind,
    title: value.title,
    body: value.body,
    priority: value.priority
  };
}

function normalizeAgendaAction(value: unknown): unknown | null {
  if (!isRecord(value) || !isAgendaAction(value)) return null;

  return {
    itemId: value.itemId,
    done: value.done,
    reason: value.reason
  };
}

function normalizeUiAction(value: unknown): unknown | null {
  if (!isRecord(value) || !isUiAction(value) || !isRecord(value.parameters)) {
    return null;
  }

  return {
    tool: value.tool,
    parameters: { ...value.parameters },
    reason: value.reason
  };
}

function normalizeAgendaItem(value: unknown): unknown | null {
  if (!isRecord(value) || !isAgendaItem(value)) return null;

  return {
    id: capString(String(value.id), MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    title: capString(String(value.title), MAX_HEARTBEAT_INPUT_TEXT_LENGTH),
    done: value.done
  };
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

function isTranscriptLine(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedNonEmptyString(value.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isBoundedNonEmptyString(value.speakerId, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isSafeSpeakerLabel(value.speakerLabel) &&
    isBoundedString(value.text, MAX_HEARTBEAT_INPUT_TEXT_LENGTH) &&
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
    isBoundedNonEmptyString(value.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isValidTimestamp(value.timestamp) &&
    isBoundedString(value.markdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH) &&
    isBoundedString(value.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
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
      (Array.isArray(value.cards) &&
        value.cards.length <= MAX_FACILITATOR_OUTPUT_CARDS &&
        value.cards.every(isFacilitatorCard))) &&
    isBoundedString(value.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    (value.nextHeartbeatHint === undefined ||
      isBoundedString(value.nextHeartbeatHint, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)) &&
    isBoundedString(value.reviewMarkdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH) &&
    (value.agendaActions === undefined ||
      (Array.isArray(value.agendaActions) &&
        value.agendaActions.length <= MAX_AGENDA_ITEMS &&
        value.agendaActions.every(isAgendaAction))) &&
    (value.uiActions === undefined ||
      (Array.isArray(value.uiActions) &&
        value.uiActions.length <= MAX_FACILITATOR_OUTPUT_UI_ACTIONS &&
        value.uiActions.every(isUiAction))) &&
    (value.ephemeralReminder === undefined ||
      value.ephemeralReminder === null ||
      isBoundedString(value.ephemeralReminder, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)) &&
    (value.adapterNotice === undefined ||
      isBoundedString(value.adapterNotice, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH))
  );
}

function isAgendaAction(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedNonEmptyString(value.itemId, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    typeof value.done === "boolean" &&
    isBoundedNonEmptyString(value.reason, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
  );
}

function isUiAction(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isKnownUiTool(value.tool) ||
    !isRecord(value.parameters) ||
    !isBoundedNonEmptyString(value.reason, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
  ) {
    return false;
  }

  if (value.tool === "add_agenda_item") {
    return (
      hasOnlyKeys(value.parameters, ["title"]) &&
      isBoundedNonEmptyString(
        value.parameters.title,
        MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
      )
    );
  }

  if (value.tool === "set_agenda_item") {
    return (
      hasOnlyKeys(value.parameters, ["done", "itemId"]) &&
      isBoundedNonEmptyString(
        value.parameters.itemId,
        MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
      ) &&
      typeof value.parameters.done === "boolean"
    );
  }

  if (value.tool === "delete_agenda_item") {
    return (
      hasOnlyKeys(value.parameters, ["itemId"]) &&
      isBoundedNonEmptyString(
        value.parameters.itemId,
        MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
      )
    );
  }

  if (value.tool === "send_room_reminder") {
    return (
      hasOnlyKeys(value.parameters, ["message", "tone"]) &&
      isBoundedNonEmptyString(
        value.parameters.message,
        MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
      ) &&
      (value.parameters.tone === undefined ||
        isBoundedString(value.parameters.tone, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH))
    );
  }

  if (value.tool === "update_review_document") {
    return (
      hasOnlyKeys(value.parameters, ["markdown", "summary"]) &&
      isBoundedNonEmptyString(
        value.parameters.markdown,
        MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
      ) &&
      (value.parameters.summary === undefined ||
        isBoundedString(value.parameters.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH))
    );
  }

  return false;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
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
    isBoundedNonEmptyString(value.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    (value.kind === "heartbeat" ||
      value.kind === "participation" ||
      value.kind === "risk" ||
      value.kind === "agenda" ||
      value.kind === "decision" ||
      value.kind === "action" ||
      value.kind === "drift" ||
      value.kind === "reminder") &&
    isBoundedNonEmptyString(value.title, MAX_FACILITATOR_CARD_TEXT_LENGTH) &&
    isBoundedString(value.body, MAX_FACILITATOR_CARD_TEXT_LENGTH) &&
    (value.priority === "low" ||
      value.priority === "medium" ||
      value.priority === "high")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerAtLeast(value: unknown, min: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= min;
}

function isIntegerInRange(
  value: unknown,
  min: number,
  max: number
): value is number {
  return isIntegerAtLeast(value, min) && value <= max;
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

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isBoundedNonEmptyString(
  value: unknown,
  maxLength: number
): value is string {
  return isBoundedString(value, maxLength) && value.trim().length > 0;
}

function capString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function isEventType(value: unknown): value is string {
  return typeof value === "string" && KNOWN_EVENT_TYPES.has(value);
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
