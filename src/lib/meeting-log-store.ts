import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  MeetingConfig,
  ReviewVersion,
  TimelineEntry,
  TranscriptLine
} from "./facilitator";

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

export async function createMeetingLog(
  meeting: MeetingConfig,
  startedAt = Date.now()
): Promise<MeetingLogMetadata> {
  const db = getDatabase();
  const id = createMeetingId(startedAt, meeting.title);

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
  ).run(id, meeting.title, meeting.goal, startedAt, startedAt, toJson(meeting));

  return readMeetingMetadata(id);
}

export async function appendMeetingLogEvent(
  meetingId: string,
  event: Omit<MeetingLogEvent, "id">
): Promise<MeetingLogEvent> {
  const db = getDatabase();
  assertMeetingExists(db, meetingId);

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
    ? existing.ended_at
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
  const status = wasEnded || requestedEnded ? "ended" : update.status ?? state?.status;
  const isPaused =
    wasEnded || requestedEnded ? true : update.isPaused ?? state?.isPaused;
  const endedAt = effectiveEndedAt;
  const meeting = state?.meeting;
  const latestReviewMarkdown = state?.reviewMarkdown;
  const latestReviewVersionId = state?.currentReviewVersionId;

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
      state ? toJson(state) : null,
      latestReviewMarkdown ?? null,
      latestReviewVersionId ?? null,
      meetingId
    );

    if (state) {
      for (const line of state.transcript) {
        upsertTranscriptLine(db, meetingId, line);
      }
      for (const version of state.reviewVersions) {
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
    events: eventRows.map((row) => ({
      id: row.id,
      type: row.type,
      timestamp: row.timestamp,
      payload: parseJson(row.payload_json, null)
    })),
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

  cache = { path, db };
  return db;
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

function rowToMetadata(row: MeetingRow): MeetingLogMetadata {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    status: normalizeStatus(row.status),
    isPaused: row.is_paused === 1,
    eventCount: row.event_count,
    meeting: parseJson(row.meeting_json, fallbackMeeting(row.title, row.goal)),
    state: parseJson(row.state_json, null),
    latestReviewMarkdown: row.latest_review_markdown ?? "",
    latestReviewVersionId: row.latest_review_version_id
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
      upsertTranscriptLine(db, meetingId, line);
    }
    return;
  }

  if (event.type === "heartbeat_output") {
    const version = reviewVersionFromHeartbeatPayload(event.payload, event.timestamp);
    if (version) {
      upsertReviewVersion(db, meetingId, version);
      updateLatestReview(db, meetingId, version);
    }
    return;
  }

  if (event.type === "review_initialized") {
    const version = reviewVersionFromInitializedPayload(event.payload);
    if (version) {
      upsertReviewVersion(db, meetingId, version);
      updateLatestReview(db, meetingId, version);
    }
    return;
  }

  if (event.type === "review_restored") {
    const version = reviewVersionFromRestorePayload(event.payload);
    if (version) {
      upsertReviewVersion(db, meetingId, version);
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
    db.prepare(
      `UPDATE meeting_sessions
        SET status = 'ended',
            is_paused = 1,
            ended_at = COALESCE(ended_at, ?)
        WHERE id = ?`
    ).run(event.timestamp, meetingId);
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

function updateLatestReview(
  db: DatabaseSync,
  meetingId: string,
  version: ReviewVersion
): void {
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

  return rows.map((row) => ({
    id: row.id,
    speakerId: row.speaker_id,
    speakerLabel: row.speaker_label,
    text: row.text,
    timestamp: row.timestamp,
    source: row.source as TranscriptLine["source"],
    confidence: row.confidence
  }));
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

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    source: row.source as ReviewVersion["source"],
    markdown: row.markdown,
    summary: row.summary
  }));
}

function lineFromPayload(payload: unknown): TranscriptLine | null {
  if (!isRecord(payload) || !isRecord(payload.line)) return null;
  const line = payload.line;
  if (
    !isNonEmptyString(line.id) ||
    !isNonEmptyString(line.speakerId) ||
    !isNonEmptyString(line.speakerLabel) ||
    typeof line.text !== "string" ||
    !isFiniteNumber(line.timestamp) ||
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
  if (typeof output.reviewMarkdown !== "string") return null;

  return {
    id:
      isNonEmptyString(payload.reviewVersionId)
        ? payload.reviewVersionId
        : `${timestamp}-review`,
    timestamp,
    source: normalizeReviewSource(output.source),
    markdown: output.reviewMarkdown,
    summary: typeof output.summary === "string" ? output.summary : "Heartbeat update."
  };
}

function reviewVersionFromRestorePayload(payload: unknown): ReviewVersion | null {
  if (!isRecord(payload) || !isRecord(payload.restoredVersion)) return null;
  const version = payload.restoredVersion;
  if (
    !isNonEmptyString(version.id) ||
    !isFiniteNumber(version.timestamp) ||
    !isReviewSource(version.source) ||
    typeof version.markdown !== "string" ||
    typeof version.summary !== "string"
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
    !isNonEmptyString(version.id) ||
    !isFiniteNumber(version.timestamp) ||
    !isReviewSource(version.source) ||
    typeof version.markdown !== "string" ||
    typeof version.summary !== "string"
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

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
