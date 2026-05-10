import { NextResponse } from "next/server";
import {
  readMeetingLog,
  updateMeetingLogState,
  type MeetingStatus,
  type PersistedMeetingState
} from "@/lib/meeting-log-store";
import {
  MAX_AGENDA_ITEMS,
  MAX_EXPECTED_PARTICIPANTS,
  MAX_FACILITATOR_CARD_TEXT_LENGTH,
  MAX_FACILITATOR_OUTPUT_CARDS,
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_FACILITATOR_OUTPUT_UI_ACTIONS,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH,
  MAX_PARTICIPANT_ENTRIES,
  MIN_HEARTBEAT_INTERVAL_SECONDS
} from "@/lib/facilitator";
import { isSafeSpeakerLabel } from "@/lib/speaker-tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60 * 1000;

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
    isValidTimestamp(payload.endedAt)
      ? payload.endedAt
      : undefined;
  const updatedAt =
    isValidTimestamp(payload.updatedAt)
      ? payload.updatedAt
      : undefined;
  const state =
    isPersistedMeetingState(payload.state) ? payload.state : undefined;

  if (
    ("endedAt" in payload &&
      payload.endedAt !== null &&
      endedAt === undefined) ||
    ("updatedAt" in payload && updatedAt === undefined)
  ) {
    return NextResponse.json({ error: "Invalid meeting timestamp" }, { status: 400 });
  }

  if (
    ("status" in payload && status === undefined) ||
    ("isPaused" in payload && typeof payload.isPaused !== "boolean") ||
    ("state" in payload && state === undefined)
  ) {
    return NextResponse.json({ error: "Invalid meeting state payload" }, { status: 400 });
  }

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
      { status: stateUpdateErrorStatus(error) }
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
  if (
    !isRecord(value) ||
    meetingStatus(value.status) === undefined ||
    !isMeeting(value.meeting) ||
    !Array.isArray(value.transcript) ||
    !value.transcript.every(isTranscriptLine) ||
    !hasUniqueRecordIds(value.transcript) ||
    !isBoundedString(value.reviewMarkdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH) ||
    !Array.isArray(value.reviewVersions) ||
    !value.reviewVersions.every(isReviewVersion) ||
    !hasUniqueRecordIds(value.reviewVersions) ||
    !isNonEmptyString(value.currentReviewVersionId) ||
    !Array.isArray(value.timeline) ||
    !value.timeline.every(isTimelineEntry) ||
    !hasUniqueRecordIds(value.timeline) ||
    !isValidTimestamp(value.lastHeartbeatAt) ||
    !isValidTimestamp(value.nextHeartbeatAt) ||
    !isValidTimestamp(value.meetingStartedAt) ||
    !isIntegerAtLeast(value.heartbeatCount, 0) ||
    typeof value.isPaused !== "boolean" ||
    (value.currentOutput !== null && !isFacilitatorOutput(value.currentOutput)) ||
    (value.activeAgendaItemId !== null &&
      !isNonEmptyString(value.activeAgendaItemId)) ||
    !isValidTimestamp(value.updatedAt) ||
    (value.endedAt !== undefined &&
      value.endedAt !== null &&
      !isValidTimestamp(value.endedAt))
  ) {
    return false;
  }

  return isChronologicallyCoherentState(value as unknown as PersistedMeetingState);
}

function isChronologicallyCoherentState(
  state: PersistedMeetingState
): boolean {
  const updatedAt = state.updatedAt;
  return (
    state.meetingStartedAt <= updatedAt &&
    state.lastHeartbeatAt <= updatedAt &&
    (state.endedAt === undefined ||
      state.endedAt === null ||
      state.endedAt <= updatedAt) &&
    state.transcript.every((line) => line.timestamp <= updatedAt) &&
    state.reviewVersions.every((version) => version.timestamp <= updatedAt) &&
    (state.reviewVersions.length === 0 ||
      state.reviewVersions.some(
        (version) => version.id === state.currentReviewVersionId
      )) &&
    state.timeline.every((entry) => entry.timestamp <= updatedAt)
  );
}

function isMeeting(value: unknown): boolean {
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

function hasUniqueRecordIds(items: unknown[]): boolean {
  const ids = items.map((item) =>
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
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.speakerId) &&
    isSafeSpeakerLabel(value.speakerLabel) &&
    typeof value.text === "string" &&
    isValidTimestamp(value.timestamp) &&
    isTranscriptSource(value.source) &&
    isConfidence(value.confidence)
  );
}

function isTranscriptSource(value: unknown): boolean {
  return value === "speech" || value === "simulated" || value === "manual";
}

function isReviewVersion(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isValidTimestamp(value.timestamp) &&
    isReviewSource(value.source) &&
    isBoundedString(value.markdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH) &&
    isBoundedString(value.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
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
    isNonEmptyString(value.id) &&
    isValidTimestamp(value.timestamp) &&
    isReviewSource(value.source) &&
    Array.isArray(value.cards) &&
    value.cards.length <= MAX_FACILITATOR_OUTPUT_CARDS &&
    value.cards.every(isFacilitatorCard) &&
    hasUniqueRecordIds(value.cards) &&
    isBoundedString(value.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    (value.reviewMarkdown === undefined ||
      isBoundedString(
        value.reviewMarkdown,
        MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
      )) &&
    (value.reminder === undefined ||
      value.reminder === null ||
      isBoundedString(value.reminder, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH))
  );
}

function isFacilitatorOutput(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFacilitatorSource(value.source) &&
    Array.isArray(value.cards) &&
    value.cards.length <= MAX_FACILITATOR_OUTPUT_CARDS &&
    value.cards.every(isFacilitatorCard) &&
    hasUniqueRecordIds(value.cards) &&
    isBoundedString(value.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isBoundedString(value.nextHeartbeatHint, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isBoundedString(value.reviewMarkdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH) &&
    Array.isArray(value.agendaActions) &&
    value.agendaActions.length <= MAX_AGENDA_ITEMS &&
    value.agendaActions.every(isAgendaAction) &&
    Array.isArray(value.uiActions) &&
    value.uiActions.length <= MAX_FACILITATOR_OUTPUT_UI_ACTIONS &&
    value.uiActions.every(isUiAction) &&
    (value.ephemeralReminder === null ||
      isBoundedString(value.ephemeralReminder, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)) &&
    (value.adapterNotice === undefined ||
      isBoundedString(value.adapterNotice, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH))
  );
}

function isFacilitatorSource(value: unknown): boolean {
  return value === "pi" || value === "openrouter" || value === "local-fallback";
}

function isFacilitatorCard(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isFacilitatorCardKind(value.kind) &&
    isBoundedNonEmptyString(value.title, MAX_FACILITATOR_CARD_TEXT_LENGTH) &&
    isBoundedString(value.body, MAX_FACILITATOR_CARD_TEXT_LENGTH) &&
    (value.priority === "low" ||
      value.priority === "medium" ||
      value.priority === "high")
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

function isKnownUiTool(value: unknown): value is string {
  return (
    value === "add_agenda_item" ||
    value === "set_agenda_item" ||
    value === "delete_agenda_item" ||
    value === "send_room_reminder" ||
    value === "update_review_document"
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isFacilitatorCardKind(value: unknown): boolean {
  return (
    value === "heartbeat" ||
    value === "participation" ||
    value === "risk" ||
    value === "agenda" ||
    value === "decision" ||
    value === "action" ||
    value === "drift" ||
    value === "reminder"
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

function isMeetingNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === "Meeting log not found";
}

function isInvalidMeetingState(error: unknown): boolean {
  return error instanceof Error && error.message === "Invalid meeting state payload";
}

function stateUpdateErrorStatus(error: unknown): number {
  if (isMeetingNotFound(error)) return 404;
  if (isInvalidMeetingState(error)) return 400;
  return 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
