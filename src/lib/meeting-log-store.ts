import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
  type FacilitatorOutput,
  type MeetingConfig,
  type ReviewVersion,
  type TimelineEntry,
  type TranscriptLine
} from "./facilitator";
import { isSafeSpeakerLabel } from "./speaker-tracker";

export type MeetingStatus = "active" | "paused" | "ended";

export interface PersistedMeetingState {
  status: MeetingStatus;
  meeting: MeetingConfig;
  transcript: TranscriptLine[];
  reviewMarkdown: string;
  reviewVersions: ReviewVersion[];
  currentReviewVersionId: string;
  timeline: TimelineEntry[];
  lastHeartbeatAt: number;
  nextHeartbeatAt: number;
  meetingStartedAt: number;
  heartbeatCount: number;
  isPaused: boolean;
  currentOutput: unknown;
  activeAgendaItemId: string | null;
  updatedAt: number;
  endedAt?: number | null;
}

export interface MeetingLogMetadata {
  id: string;
  title: string;
  goal: string;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  status: MeetingStatus;
  isPaused: boolean;
  eventCount: number;
  meeting: MeetingConfig;
  state: PersistedMeetingState | null;
  latestReviewMarkdown: string;
  latestReviewVersionId: string | null;
}

export interface MeetingLogEvent {
  id: string;
  type: string;
  timestamp: number;
  payload: unknown;
}

export interface MeetingLogSnapshot {
  metadata: MeetingLogMetadata;
  events: MeetingLogEvent[];
  transcript: TranscriptLine[];
  reviewVersions: ReviewVersion[];
}

export interface MeetingStateUpdate {
  status?: MeetingStatus;
  isPaused?: boolean;
  endedAt?: number | null;
  updatedAt?: number;
  state?: PersistedMeetingState;
}

interface DatabaseCache {
  path: string;
  db: DatabaseSync;
}

interface MeetingRow {
  id: string;
  title: string;
  goal: string;
  started_at: number;
  updated_at: number;
  ended_at: number | null;
  status: string;
  is_paused: number;
  event_count: number;
  meeting_json: string;
  state_json: string | null;
  latest_review_markdown: string | null;
  latest_review_version_id: string | null;
}

interface EventRow {
  id: string;
  type: string;
  timestamp: number;
  payload_json: string;
}

interface TranscriptRow {
  id: string;
  speaker_id: string;
  speaker_label: string;
  text: string;
  timestamp: number;
  source: string;
  confidence: number;
}

interface ReviewVersionRow {
  id: string;
  timestamp: number;
  source: string;
  markdown: string;
  summary: string;
}

let cache: DatabaseCache | null = null;
const MAX_EVENT_PAYLOAD_STRING_LENGTH = MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH;
const MAX_EVENT_PAYLOAD_ARRAY_ITEMS = 80;
const MAX_EVENT_PAYLOAD_OBJECT_KEYS = 40;
const MAX_EVENT_PAYLOAD_DEPTH = 8;

export async function createMeetingLog(
  meeting: MeetingConfig,
  startedAt = Date.now()
): Promise<MeetingLogMetadata> {
  const db = getDatabase();
  const compactMeeting = compactMeetingForAdapter(meeting);
  const id = createMeetingId(startedAt, compactMeeting.title);

  db.prepare(
    `INSERT INTO meeting_sessions (
      id,
      title,
      goal,
      started_at,
      updated_at,
      ended_at,
      status,
      is_paused,
      event_count,
      meeting_json,
      state_json,
      latest_review_markdown,
      latest_review_version_id
    ) VALUES (?, ?, ?, ?, ?, NULL, 'active', 0, 0, ?, NULL, '', NULL)`
  ).run(
    id,
    compactMeeting.title,
    compactMeeting.goal,
    startedAt,
    startedAt,
    toJson(compactMeeting)
  );

  return readMeetingMetadata(id);
}

export async function appendMeetingLogEvent(
  meetingId: string,
  event: Omit<MeetingLogEvent, "id">
): Promise<MeetingLogEvent> {
  const db = getDatabase();
  assertMeetingExists(db, meetingId);
  assertMeetingAcceptsEvent(db, meetingId);

  const logEvent: MeetingLogEvent = {
    id: randomUUID(),
    type: event.type,
    timestamp: event.timestamp,
    payload: event.payload
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO meeting_events (
        id,
        meeting_id,
        type,
        timestamp,
        payload_json
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      logEvent.id,
      meetingId,
      logEvent.type,
      logEvent.timestamp,
      toJson(logEvent.payload)
    );

    db.prepare(
      `UPDATE meeting_sessions
        SET updated_at = MAX(updated_at, ?),
            event_count = event_count + 1
        WHERE id = ?`
    ).run(logEvent.timestamp, meetingId);

    materializeEvent(db, meetingId, logEvent);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return logEvent;
}

export async function updateMeetingLogState(
  meetingId: string,
  update: MeetingStateUpdate
): Promise<MeetingLogMetadata> {
  const db = getDatabase();
  assertMeetingExists(db, meetingId);

  const updatedAt = update.updatedAt ?? Date.now();
  const existing = db
    .prepare("SELECT status, ended_at FROM meeting_sessions WHERE id = ?")
    .get(meetingId) as unknown as Pick<MeetingRow, "status" | "ended_at">;
  const wasEnded =
    existing.status === "ended" || typeof existing.ended_at === "number";
  const requestedEnded =
    update.status === "ended" ||
    update.state?.status === "ended" ||
    typeof update.endedAt === "number" ||
    typeof update.state?.endedAt === "number";
  const effectiveEndedAt = wasEnded
    ? existing.ended_at ?? updatedAt
    : requestedEnded
      ? update.endedAt ?? update.state?.endedAt ?? updatedAt
      : update.endedAt ?? update.state?.endedAt;
  const state =
    update.state && (wasEnded || requestedEnded)
      ? {
          ...update.state,
          status: "ended" as const,
          isPaused: true,
          endedAt: effectiveEndedAt ?? updatedAt,
          updatedAt
        }
      : update.state;
  const mergedState = state
    ? mergeStateWithMaterializedRows(db, meetingId, state)
    : state;
  if (mergedState && !isPersistedMeetingState(mergedState)) {
    throw new Error("Invalid meeting state payload");
  }
  const compactState = mergedState
    ? compactPersistedStateMeeting(mergedState)
    : mergedState;
  const requestedStatus = update.status ?? state?.status;
  const requestedIsPaused = update.isPaused ?? state?.isPaused;
  const status =
    wasEnded || requestedEnded
      ? "ended"
      : requestedStatus ??
        (typeof requestedIsPaused === "boolean"
          ? requestedIsPaused
            ? "paused"
            : "active"
          : undefined);
  const isPaused =
    wasEnded || requestedEnded
      ? true
      : requestedIsPaused ??
        (requestedStatus === "paused"
          ? true
          : requestedStatus === "active"
            ? false
            : undefined);
  const endedAt = effectiveEndedAt;
  const meeting = compactState?.meeting;
  const latestReviewMarkdown = compactState?.reviewMarkdown;
  const latestReviewVersionId = compactState?.currentReviewVersionId;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE meeting_sessions
        SET updated_at = MAX(updated_at, ?),
            ended_at = COALESCE(?, ended_at),
            status = COALESCE(?, status),
            is_paused = COALESCE(?, is_paused),
            meeting_json = COALESCE(?, meeting_json),
            title = COALESCE(?, title),
            goal = COALESCE(?, goal),
            state_json = COALESCE(?, state_json),
            latest_review_markdown = COALESCE(?, latest_review_markdown),
            latest_review_version_id = COALESCE(?, latest_review_version_id)
        WHERE id = ?`
    ).run(
      updatedAt,
      endedAt ?? null,
      status ?? null,
      typeof isPaused === "boolean" ? (isPaused ? 1 : 0) : null,
      meeting ? toJson(meeting) : null,
      meeting?.title ?? null,
      meeting?.goal ?? null,
      compactState ? toJson(compactState) : null,
      latestReviewMarkdown ?? null,
      latestReviewVersionId ?? null,
      meetingId
    );

    if (compactState) {
      for (const line of compactState.transcript) {
        upsertTranscriptLine(db, meetingId, line);
      }
      for (const version of compactState.reviewVersions) {
        upsertReviewVersion(db, meetingId, version);
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return readMeetingMetadata(meetingId);
}

export async function listMeetingLogs(): Promise<MeetingLogMetadata[]> {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT *
        FROM meeting_sessions
        ORDER BY updated_at DESC, started_at DESC`
    )
    .all() as unknown as MeetingRow[];

  return rows.map(rowToMetadata);
}

export async function readMeetingLog(
  meetingId: string
): Promise<MeetingLogSnapshot> {
  const metadata = await readMeetingMetadata(meetingId);
  const db = getDatabase();
  const eventRows = db
    .prepare(
      `SELECT id, type, timestamp, payload_json
        FROM meeting_events
        WHERE meeting_id = ?
        ORDER BY timestamp ASC, rowid ASC`
    )
    .all(meetingId) as unknown as EventRow[];

  return {
    metadata,
    events: eventRows
      .map(eventFromRow)
      .filter((event): event is MeetingLogEvent => event !== null),
    transcript: readTranscriptLines(db, meetingId),
    reviewVersions: readReviewVersions(db, meetingId)
  };
}

export async function readMeetingMetadata(
  meetingId: string
): Promise<MeetingLogMetadata> {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM meeting_sessions WHERE id = ?")
    .get(meetingId) as unknown as MeetingRow | undefined;

  if (!row) {
    throw new Error("Meeting log not found");
  }

  return rowToMetadata(row);
}

function getDatabase(): DatabaseSync {
  const path = databasePath();

  if (cache?.path === path) {
    return cache.db;
  }

  if (cache) {
    cache.db.close();
  }

  mkdirSync(dirname(path), { recursive: true });
  const DatabaseSyncCtor = loadDatabaseSync();
  const db = new DatabaseSyncCtor(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
      is_paused INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      meeting_json TEXT NOT NULL,
      state_json TEXT,
      latest_review_markdown TEXT,
      latest_review_version_id TEXT
    );

    CREATE TABLE IF NOT EXISTS meeting_events (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transcript_lines (
      id TEXT NOT NULL,
      meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
      speaker_id TEXT NOT NULL,
      speaker_label TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      PRIMARY KEY (meeting_id, id)
    );

    CREATE TABLE IF NOT EXISTS review_versions (
      id TEXT NOT NULL,
      meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL,
      source TEXT NOT NULL,
      markdown TEXT NOT NULL,
      summary TEXT NOT NULL,
      PRIMARY KEY (meeting_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_meeting_events_meeting_time
      ON meeting_events(meeting_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_transcript_lines_meeting_time
      ON transcript_lines(meeting_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_review_versions_meeting_time
      ON review_versions(meeting_id, timestamp DESC);
  `);
  migrateLegacySchema(db);

  cache = { path, db };
  return db;
}

function migrateLegacySchema(db: DatabaseSync): void {
  ensureColumn(db, "meeting_sessions", "ended_at", "INTEGER");
  ensureColumn(
    db,
    "meeting_sessions",
    "status",
    "TEXT NOT NULL DEFAULT 'active'"
  );
  ensureColumn(
    db,
    "meeting_sessions",
    "is_paused",
    "INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    db,
    "meeting_sessions",
    "event_count",
    "INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(db, "meeting_sessions", "state_json", "TEXT");
  ensureColumn(db, "meeting_sessions", "latest_review_markdown", "TEXT");
  ensureColumn(db, "meeting_sessions", "latest_review_version_id", "TEXT");
  ensureColumn(db, "transcript_lines", "source", "TEXT NOT NULL DEFAULT 'speech'");
  ensureColumn(db, "transcript_lines", "confidence", "REAL NOT NULL DEFAULT 1.0");
  ensureColumn(db, "review_versions", "source", "TEXT NOT NULL DEFAULT 'pi'");
  ensureColumn(db, "review_versions", "summary", "TEXT NOT NULL DEFAULT ''");
  backfillLegacyMaterializedMetadata(db);
}

function backfillLegacyMaterializedMetadata(db: DatabaseSync): void {
  db.exec(`
    UPDATE meeting_sessions
      SET event_count = (
        SELECT COUNT(*)
          FROM meeting_events
          WHERE meeting_events.meeting_id = meeting_sessions.id
      )
      WHERE event_count = 0
        AND EXISTS (
          SELECT 1
            FROM meeting_events
            WHERE meeting_events.meeting_id = meeting_sessions.id
        );

    UPDATE meeting_sessions
      SET latest_review_version_id = (
            SELECT id
              FROM review_versions
              WHERE review_versions.meeting_id = meeting_sessions.id
              ORDER BY timestamp DESC, rowid DESC
              LIMIT 1
          ),
          latest_review_markdown = (
            SELECT markdown
              FROM review_versions
              WHERE review_versions.meeting_id = meeting_sessions.id
              ORDER BY timestamp DESC, rowid DESC
              LIMIT 1
          )
      WHERE latest_review_version_id IS NULL
        AND EXISTS (
          SELECT 1
            FROM review_versions
            WHERE review_versions.meeting_id = meeting_sessions.id
        );
  `);
}

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string
): void {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

type DatabaseSyncConstructor = new (path: string) => DatabaseSync;

function loadDatabaseSync(): DatabaseSyncConstructor {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: string) => unknown)
    | undefined;
  const sqlite = getBuiltinModule?.("node:sqlite") as
    | {
        DatabaseSync?: DatabaseSyncConstructor;
      }
    | undefined;

  if (!sqlite?.DatabaseSync) {
    throw new Error(
      "node:sqlite is unavailable. Run RoomPulse with Node.js 24 or newer."
    );
  }

  return sqlite.DatabaseSync;
}

function databasePath(): string {
  if (process.env.ROOMPULSE_DB_PATH) {
    return process.env.ROOMPULSE_DB_PATH;
  }

  if (process.env.NODE_ENV === "test" && process.env.ROOMPULSE_LOG_DIR) {
    return join(process.env.ROOMPULSE_LOG_DIR, "roompulse.sqlite");
  }

  return join(process.cwd(), ".roompulse", "roompulse.sqlite");
}

function createMeetingId(startedAt: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "meeting";
  return `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${slug}-${randomUUID().slice(0, 8)}`;
}

function assertMeetingExists(db: DatabaseSync, meetingId: string): void {
  const row = db
    .prepare("SELECT id FROM meeting_sessions WHERE id = ?")
    .get(meetingId) as unknown as { id: string } | undefined;
  if (!row) {
    throw new Error("Meeting log not found");
  }
}

function assertMeetingAcceptsEvent(db: DatabaseSync, meetingId: string): void {
  const row = db
    .prepare("SELECT status, ended_at FROM meeting_sessions WHERE id = ?")
    .get(meetingId) as unknown as
    | Pick<MeetingRow, "status" | "ended_at">
    | undefined;
  if (row?.status === "ended" || typeof row?.ended_at === "number") {
    throw new Error("Meeting log has ended");
  }
}

function rowToMetadata(row: MeetingRow): MeetingLogMetadata {
  const fallback = compactMeetingForAdapter(fallbackMeeting(row.title, row.goal));
  const meeting = parseMeetingJson(row.meeting_json, fallback);
  const state = parsePersistedStateJson(row.state_json);
  return {
    id: row.id,
    title: meeting.title,
    goal: meeting.goal,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    status: normalizeStatus(row.status),
    isPaused: row.is_paused === 1,
    eventCount: row.event_count,
    meeting,
    state,
    latestReviewMarkdown: capText(
      row.latest_review_markdown ?? "",
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    ),
    latestReviewVersionId:
      row.latest_review_version_id === null
        ? null
        : capText(
            row.latest_review_version_id,
            MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
          )
  };
}

function materializeEvent(
  db: DatabaseSync,
  meetingId: string,
  event: MeetingLogEvent
): void {
  if (event.type === "transcript_line") {
    const line = lineFromPayload(event.payload);
    if (line) {
      insertTranscriptLineIfAbsent(db, meetingId, line);
    }
    return;
  }

  if (event.type === "heartbeat_output") {
    const version = reviewVersionFromHeartbeatPayload(event.payload, event.timestamp);
    if (version && insertReviewVersionIfAbsent(db, meetingId, version)) {
      updateLatestReview(db, meetingId, version);
    }
    return;
  }

  if (event.type === "review_initialized") {
    const version = reviewVersionFromInitializedPayload(event.payload);
    if (version && insertReviewVersionIfAbsent(db, meetingId, version)) {
      updateLatestReview(db, meetingId, version);
    }
    return;
  }

  if (event.type === "review_restored") {
    const version = reviewVersionFromRestorePayload(event.payload);
    if (version && insertReviewVersionIfAbsent(db, meetingId, version)) {
      updateLatestReview(db, meetingId, version);
    }
    return;
  }

  if (event.type === "meeting_pause_toggled") {
    const paused = pausedFromPayload(event.payload);
    if (paused !== null) {
      db.prepare(
        `UPDATE meeting_sessions
          SET status = CASE WHEN status = 'ended' THEN status ELSE ? END,
              is_paused = ?
          WHERE id = ?`
      ).run(paused ? "paused" : "active", paused ? 1 : 0, meetingId);
    }
    return;
  }

  if (event.type === "meeting_ended") {
    const endedAt = endedAtFromPayload(event.payload) ?? event.timestamp;
    db.prepare(
      `UPDATE meeting_sessions
        SET status = 'ended',
            is_paused = 1,
            ended_at = COALESCE(ended_at, ?)
        WHERE id = ?`
    ).run(endedAt, meetingId);
  }
}

function upsertTranscriptLine(
  db: DatabaseSync,
  meetingId: string,
  line: TranscriptLine
): void {
  db.prepare(
    `INSERT OR REPLACE INTO transcript_lines (
      id,
      meeting_id,
      speaker_id,
      speaker_label,
      text,
      timestamp,
      source,
      confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    line.id,
    meetingId,
    line.speakerId,
    line.speakerLabel,
    line.text,
    line.timestamp,
    line.source,
    line.confidence
  );
}

function insertTranscriptLineIfAbsent(
  db: DatabaseSync,
  meetingId: string,
  line: TranscriptLine
): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO transcript_lines (
      id,
      meeting_id,
      speaker_id,
      speaker_label,
      text,
      timestamp,
      source,
      confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    line.id,
    meetingId,
    line.speakerId,
    line.speakerLabel,
    line.text,
    line.timestamp,
    line.source,
    line.confidence
  ) as unknown as { changes: number };
  return result.changes > 0;
}

function upsertReviewVersion(
  db: DatabaseSync,
  meetingId: string,
  version: ReviewVersion
): void {
  db.prepare(
    `INSERT OR REPLACE INTO review_versions (
      id,
      meeting_id,
      timestamp,
      source,
      markdown,
      summary
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    version.id,
    meetingId,
    version.timestamp,
    version.source,
    version.markdown,
    version.summary
  );
}

function insertReviewVersionIfAbsent(
  db: DatabaseSync,
  meetingId: string,
  version: ReviewVersion
): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO review_versions (
      id,
      meeting_id,
      timestamp,
      source,
      markdown,
      summary
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    version.id,
    meetingId,
    version.timestamp,
    version.source,
    version.markdown,
    version.summary
  ) as unknown as { changes: number };
  return result.changes > 0;
}

function updateLatestReview(
  db: DatabaseSync,
  meetingId: string,
  version: ReviewVersion
): void {
  const current = db
    .prepare(
      `SELECT rv.timestamp
        FROM review_versions rv
        JOIN meeting_sessions ms
          ON ms.latest_review_version_id = rv.id
          AND ms.id = rv.meeting_id
        WHERE ms.id = ?`
    )
    .get(meetingId) as unknown as { timestamp: number } | undefined;
  if (current && current.timestamp > version.timestamp) {
    return;
  }

  db.prepare(
    `UPDATE meeting_sessions
      SET latest_review_markdown = ?,
          latest_review_version_id = ?
      WHERE id = ?`
  ).run(version.markdown, version.id, meetingId);
}

function readTranscriptLines(
  db: DatabaseSync,
  meetingId: string
): TranscriptLine[] {
  const rows = db
    .prepare(
      `SELECT id, speaker_id, speaker_label, text, timestamp, source, confidence
        FROM transcript_lines
        WHERE meeting_id = ?
        ORDER BY timestamp ASC, rowid ASC`
    )
    .all(meetingId) as unknown as TranscriptRow[];

  return rows
    .map(transcriptLineFromRow)
    .filter((line): line is TranscriptLine => line !== null);
}

function readReviewVersions(
  db: DatabaseSync,
  meetingId: string
): ReviewVersion[] {
  const rows = db
    .prepare(
      `SELECT id, timestamp, source, markdown, summary
        FROM review_versions
        WHERE meeting_id = ?
        ORDER BY timestamp DESC, rowid DESC`
    )
    .all(meetingId) as unknown as ReviewVersionRow[];

  return rows
    .map(reviewVersionFromRow)
    .filter((version): version is ReviewVersion => version !== null);
}

function transcriptLineFromRow(row: TranscriptRow): TranscriptLine | null {
  if (
    !isBoundedNonEmptyString(row.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) ||
    !isBoundedNonEmptyString(
      row.speaker_id,
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    ) ||
    !isSafeSpeakerLabel(row.speaker_label) ||
    !isBoundedString(row.text, MAX_HEARTBEAT_INPUT_TEXT_LENGTH) ||
    !isValidTimestamp(row.timestamp) ||
    !isTranscriptSource(row.source) ||
    !isConfidence(row.confidence)
  ) {
    return null;
  }

  return {
    id: row.id,
    speakerId: row.speaker_id,
    speakerLabel: row.speaker_label,
    text: row.text,
    timestamp: row.timestamp,
    source: row.source,
    confidence: row.confidence
  };
}

function reviewVersionFromRow(row: ReviewVersionRow): ReviewVersion | null {
  if (
    !isBoundedNonEmptyString(row.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) ||
    !isValidTimestamp(row.timestamp) ||
    !isReviewSource(row.source) ||
    !isBoundedString(row.markdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH) ||
    !isBoundedString(row.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
  ) {
    return null;
  }

  return {
    id: row.id,
    timestamp: row.timestamp,
    source: row.source,
    markdown: row.markdown,
    summary: row.summary
  };
}

function eventFromRow(row: EventRow): MeetingLogEvent | null {
  if (
    !isBoundedNonEmptyString(row.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) ||
    !isBoundedNonEmptyString(row.type, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) ||
    !isValidTimestamp(row.timestamp)
  ) {
    return null;
  }

  return {
    id: row.id,
    type: row.type,
    timestamp: row.timestamp,
    payload: compactEventPayload(row.type, parseJson(row.payload_json, null))
  };
}

function compactEventPayload(type: string, payload: unknown): unknown {
  if (type === "transcript_line" && isRecord(payload) && isRecord(payload.line)) {
    return {
      ...(compactJsonPayload(payload) as Record<string, unknown>),
      line: compactEventTranscriptLine(payload.line)
    };
  }

  return compactJsonPayload(payload);
}

function compactEventTranscriptLine(
  value: Record<string, unknown>
): Record<string, unknown> {
  return {
    id:
      typeof value.id === "string"
        ? capText(value.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
        : "",
    speakerId:
      typeof value.speakerId === "string"
        ? capText(value.speakerId, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
        : "",
    speakerLabel: isSafeSpeakerLabel(value.speakerLabel)
      ? value.speakerLabel
      : "Speaker 1",
    text:
      typeof value.text === "string"
        ? capText(value.text, MAX_HEARTBEAT_INPUT_TEXT_LENGTH)
        : "",
    timestamp: isValidTimestamp(value.timestamp) ? value.timestamp : 0,
    source: isTranscriptSource(value.source) ? value.source : "speech",
    confidence: isConfidence(value.confidence) ? value.confidence : 1
  };
}

function compactJsonPayload(value: unknown, depth = 0): unknown {
  if (depth >= MAX_EVENT_PAYLOAD_DEPTH) {
    return null;
  }
  if (typeof value === "string") {
    return capText(value, MAX_EVENT_PAYLOAD_STRING_LENGTH);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_EVENT_PAYLOAD_ARRAY_ITEMS)
      .map((item) => compactJsonPayload(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_EVENT_PAYLOAD_OBJECT_KEYS)
        .map(([key, item]) => [
          capText(key, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
          compactJsonPayload(item, depth + 1)
        ])
    );
  }

  return null;
}

function mergeStateWithMaterializedRows(
  db: DatabaseSync,
  meetingId: string,
  state: PersistedMeetingState
): PersistedMeetingState {
  const transcript = mergeTranscriptLines(state.transcript, readTranscriptLines(db, meetingId));
  const reviewVersions = mergeReviewVersions(
    state.reviewVersions,
    readReviewVersions(db, meetingId)
  );
  const currentReview = reviewVersions[0] ?? null;

  return {
    ...state,
    transcript,
    reviewVersions,
    currentReviewVersionId: currentReview?.id ?? state.currentReviewVersionId,
    reviewMarkdown: currentReview?.markdown ?? state.reviewMarkdown
  };
}

function compactPersistedStateMeeting(
  state: PersistedMeetingState
): PersistedMeetingState {
  return {
    status: state.status,
    meeting: compactMeetingForStorage(state.meeting),
    transcript: state.transcript.map(compactTranscriptLine),
    reviewMarkdown: capText(
      state.reviewMarkdown,
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    ),
    reviewVersions: state.reviewVersions.map(compactReviewVersion),
    currentReviewVersionId: capText(
      state.currentReviewVersionId,
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    ),
    timeline: state.timeline.map(compactTimelineEntry),
    lastHeartbeatAt: state.lastHeartbeatAt,
    nextHeartbeatAt: state.nextHeartbeatAt,
    meetingStartedAt: state.meetingStartedAt,
    heartbeatCount: state.heartbeatCount,
    isPaused: state.isPaused,
    currentOutput:
      state.currentOutput === null
        ? null
        : compactFacilitatorOutput(state.currentOutput as FacilitatorOutput),
    activeAgendaItemId:
      state.activeAgendaItemId === null
        ? null
        : capText(state.activeAgendaItemId, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    updatedAt: state.updatedAt,
    ...(state.endedAt === undefined ? {} : { endedAt: state.endedAt })
  };
}

function compactMeetingForStorage(meeting: MeetingConfig): MeetingConfig {
  const compactMeeting = compactMeetingForAdapter(meeting);

  return {
    title: compactMeeting.title,
    goal: compactMeeting.goal,
    context: compactMeeting.context,
    agenda: compactMeeting.agenda.map((item) => ({
      id: capText(item.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
      title: item.title,
      done: item.done
    })),
    expectedParticipants: compactMeeting.expectedParticipants,
    participants: compactMeeting.participants.map((participant) => ({
      name: participant.name,
      ...(participant.role === undefined ? {} : { role: participant.role })
    })),
    heartbeatIntervalSeconds: compactMeeting.heartbeatIntervalSeconds
  };
}

function compactTranscriptLine(line: TranscriptLine): TranscriptLine {
  return {
    id: capText(line.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    speakerId: capText(line.speakerId, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    speakerLabel: line.speakerLabel,
    text: capText(line.text, MAX_HEARTBEAT_INPUT_TEXT_LENGTH),
    timestamp: line.timestamp,
    source: line.source,
    confidence: line.confidence
  };
}

function compactReviewVersion(version: ReviewVersion): ReviewVersion {
  return {
    id: capText(version.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    timestamp: version.timestamp,
    source: version.source,
    markdown: capText(version.markdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH),
    summary: capText(version.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
  };
}

function compactTimelineEntry(entry: TimelineEntry): TimelineEntry {
  return {
    id: capText(entry.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    timestamp: entry.timestamp,
    source: entry.source,
    cards: entry.cards.map(compactFacilitatorCard),
    summary: capText(entry.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    ...(entry.reviewMarkdown === undefined
      ? {}
      : {
          reviewMarkdown: capText(
            entry.reviewMarkdown,
            MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
          )
        }),
    ...(entry.reminder === undefined
      ? {}
      : {
          reminder:
            entry.reminder === null
              ? null
              : capText(entry.reminder, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
        })
  };
}

function compactFacilitatorOutput(output: FacilitatorOutput): FacilitatorOutput {
  return {
    source: output.source,
    cards: output.cards.map(compactFacilitatorCard),
    summary: capText(output.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    nextHeartbeatHint: capText(
      output.nextHeartbeatHint,
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    ),
    reviewMarkdown: capText(
      output.reviewMarkdown,
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    ),
    agendaActions: output.agendaActions.map(compactAgendaAction),
    uiActions: output.uiActions.map(compactUiAction),
    ephemeralReminder:
      output.ephemeralReminder === null
        ? null
        : capText(output.ephemeralReminder, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    ...(output.adapterNotice === undefined
      ? {}
      : {
          adapterNotice: capText(
            output.adapterNotice,
            MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
          )
        })
  };
}

function compactFacilitatorCard(
  card: FacilitatorOutput["cards"][number]
): FacilitatorOutput["cards"][number] {
  return {
    id: capText(card.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    kind: card.kind,
    title: capText(card.title, MAX_FACILITATOR_CARD_TEXT_LENGTH),
    body: capText(card.body, MAX_FACILITATOR_CARD_TEXT_LENGTH),
    priority: card.priority
  };
}

function compactAgendaAction(
  action: FacilitatorOutput["agendaActions"][number]
): FacilitatorOutput["agendaActions"][number] {
  return {
    itemId: capText(action.itemId, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
    done: action.done,
    reason: capText(action.reason, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
  };
}

function compactUiAction(
  action: FacilitatorOutput["uiActions"][number]
): FacilitatorOutput["uiActions"][number] {
  return {
    tool: action.tool,
    parameters: { ...action.parameters },
    reason: capText(action.reason, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
  };
}

function mergeTranscriptLines(
  stateLines: TranscriptLine[],
  storedLines: TranscriptLine[]
): TranscriptLine[] {
  const byId = new Map<string, TranscriptLine>();
  for (const line of [...stateLines, ...storedLines]) {
    byId.set(line.id, line);
  }
  return Array.from(byId.values()).sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id)
  );
}

function mergeReviewVersions(
  stateVersions: ReviewVersion[],
  storedVersions: ReviewVersion[]
): ReviewVersion[] {
  const byId = new Map<string, ReviewVersion>();
  for (const version of [...stateVersions, ...storedVersions]) {
    byId.set(version.id, version);
  }
  return Array.from(byId.values()).sort(
    (left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id)
  );
}

function lineFromPayload(payload: unknown): TranscriptLine | null {
  if (!isRecord(payload) || !isRecord(payload.line)) return null;
  const line = payload.line;
  if (
    !isBoundedNonEmptyString(line.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) ||
    !isBoundedNonEmptyString(
      line.speakerId,
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    ) ||
    !isSafeSpeakerLabel(line.speakerLabel) ||
    !isBoundedString(line.text, MAX_HEARTBEAT_INPUT_TEXT_LENGTH) ||
    !isValidTimestamp(line.timestamp) ||
    !isTranscriptSource(line.source) ||
    !isConfidence(line.confidence)
  ) {
    return null;
  }
  return {
    id: line.id,
    speakerId: line.speakerId,
    speakerLabel: line.speakerLabel,
    text: line.text,
    timestamp: line.timestamp,
    source: line.source,
    confidence: line.confidence
  };
}

function reviewVersionFromHeartbeatPayload(
  payload: unknown,
  timestamp: number
): ReviewVersion | null {
  if (!isRecord(payload) || !isRecord(payload.output)) return null;
  const output = payload.output;
  if (
    !isBoundedString(
      output.reviewMarkdown,
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    )
  ) {
    return null;
  }
  const summary =
    typeof output.summary === "string" ? output.summary : "Heartbeat update.";
  if (!isBoundedString(summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)) return null;

  return {
    id:
      isBoundedNonEmptyString(
        payload.reviewVersionId,
        MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
      )
        ? payload.reviewVersionId
        : `${timestamp}-review`,
    timestamp,
    source: normalizeReviewSource(output.source),
    markdown: output.reviewMarkdown,
    summary
  };
}

function reviewVersionFromRestorePayload(payload: unknown): ReviewVersion | null {
  if (!isRecord(payload) || !isRecord(payload.restoredVersion)) return null;
  const version = payload.restoredVersion;
  if (
    !isBoundedNonEmptyString(version.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) ||
    !isValidTimestamp(version.timestamp) ||
    !isReviewSource(version.source) ||
    !isBoundedString(version.markdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH) ||
    !isBoundedString(version.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
  ) {
    return null;
  }

  return {
    id: version.id,
    timestamp: version.timestamp,
    source: version.source,
    markdown: version.markdown,
    summary: version.summary
  };
}

function reviewVersionFromInitializedPayload(
  payload: unknown
): ReviewVersion | null {
  if (!isRecord(payload) || !isRecord(payload.reviewVersion)) return null;
  const version = payload.reviewVersion;
  if (
    !isBoundedNonEmptyString(version.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) ||
    !isValidTimestamp(version.timestamp) ||
    !isReviewSource(version.source) ||
    !isBoundedString(version.markdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH) ||
    !isBoundedString(version.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
  ) {
    return null;
  }

  return {
    id: version.id,
    timestamp: version.timestamp,
    source: version.source,
    markdown: version.markdown,
    summary: version.summary
  };
}

function pausedFromPayload(payload: unknown): boolean | null {
  if (!isRecord(payload) || typeof payload.paused !== "boolean") return null;
  return payload.paused;
}

function endedAtFromPayload(payload: unknown): number | null {
  if (!isRecord(payload) || !isValidTimestamp(payload.endedAt)) return null;
  return payload.endedAt;
}

function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    value >= 0 &&
    Number.isSafeInteger(value) &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function normalizeStatus(value: string): MeetingStatus {
  if (value === "paused" || value === "ended") return value;
  return "active";
}

function normalizeReviewSource(value: unknown): ReviewVersion["source"] {
  if (
    value === "pi" ||
    value === "openrouter" ||
    value === "local-fallback" ||
    value === "initial" ||
    value === "restored"
  ) {
    return value;
  }
  return "local-fallback";
}

function isReviewSource(value: unknown): value is ReviewVersion["source"] {
  return (
    value === "pi" ||
    value === "openrouter" ||
    value === "local-fallback" ||
    value === "initial" ||
    value === "restored"
  );
}

function isTranscriptSource(value: unknown): value is TranscriptLine["source"] {
  return value === "speech" || value === "simulated" || value === "manual";
}

function isConfidence(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function capText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function isBoundedNonEmptyString(
  value: unknown,
  maxLength: number
): value is string {
  return isBoundedString(value, maxLength) && value.trim().length > 0;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseMeetingJson(raw: string | null, fallback: MeetingConfig): MeetingConfig {
  const parsed = parseJson<unknown>(raw, null);
  return isMeetingConfig(parsed) ? compactMeetingForAdapter(parsed) : fallback;
}

function parsePersistedStateJson(raw: string | null): PersistedMeetingState | null {
  const parsed = parseJson<unknown>(raw, null);
  return isPersistedMeetingState(parsed)
    ? compactPersistedStateMeeting(parsed)
    : null;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function fallbackMeeting(title: string, goal: string): MeetingConfig {
  return {
    title,
    goal,
    context: "",
    agenda: [],
    expectedParticipants: 1,
    participants: [],
    heartbeatIntervalSeconds: 45
  };
}

function isPersistedMeetingState(value: unknown): value is PersistedMeetingState {
  if (
    !isRecord(value) ||
    !isMeetingStatus(value.status) ||
    !isMeetingConfig(value.meeting) ||
    !Array.isArray(value.transcript) ||
    !value.transcript.every(isTranscriptLine) ||
    !hasUniqueRecordIds(value.transcript) ||
    !isBoundedString(value.reviewMarkdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH) ||
    !Array.isArray(value.reviewVersions) ||
    value.reviewVersions.length === 0 ||
    !value.reviewVersions.every(isReviewVersion) ||
    !hasUniqueRecordIds(value.reviewVersions) ||
    !isBoundedNonEmptyString(
      value.currentReviewVersionId,
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    ) ||
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
      !isBoundedNonEmptyString(
        value.activeAgendaItemId,
        MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
      )) ||
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
    state.reviewVersions.some(
      (version) => version.id === state.currentReviewVersionId
    ) &&
    state.timeline.every((entry) => entry.timestamp <= updatedAt)
  );
}

function isMeetingConfig(value: unknown): value is MeetingConfig {
  return (
    isRecord(value) &&
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

function isMeetingStatus(value: unknown): value is MeetingStatus {
  return value === "active" || value === "paused" || value === "ended";
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

function isTranscriptLine(value: unknown): value is TranscriptLine {
  return (
    isRecord(value) &&
    isBoundedNonEmptyString(value.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isBoundedNonEmptyString(value.speakerId, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isSafeSpeakerLabel(value.speakerLabel) &&
    isBoundedString(value.text, MAX_HEARTBEAT_INPUT_TEXT_LENGTH) &&
    isValidTimestamp(value.timestamp) &&
    isTranscriptSource(value.source) &&
    isConfidence(value.confidence)
  );
}

function isReviewVersion(value: unknown): value is ReviewVersion {
  return (
    isRecord(value) &&
    isBoundedNonEmptyString(value.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isValidTimestamp(value.timestamp) &&
    isReviewSource(value.source) &&
    isBoundedString(value.markdown, MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH) &&
    isBoundedString(value.summary, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
  );
}

function isTimelineEntry(value: unknown): value is TimelineEntry {
  return (
    isRecord(value) &&
    isBoundedNonEmptyString(value.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
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
    isBoundedNonEmptyString(value.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isFacilitatorCardKind(value.kind) &&
    isBoundedNonEmptyString(value.title, MAX_FACILITATOR_CARD_TEXT_LENGTH) &&
    isBoundedNonEmptyString(value.body, MAX_FACILITATOR_CARD_TEXT_LENGTH) &&
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
