import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendMeetingLogEvent,
  createMeetingLog,
  listMeetingLogs,
  readMeetingLog
} from "./meeting-log-store";
import type { MeetingConfig } from "./facilitator";

const meeting: MeetingConfig = {
  title: "Persistence review",
  goal: "Keep local meeting logs",
  context: "Test",
  agenda: [{ id: "a1", title: "Open", done: false }],
  expectedParticipants: 2,
  participants: [],
  heartbeatIntervalSeconds: 30
};

let logDir = "";

describe("meeting log store", () => {
  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "roompulse-logs-"));
    process.env.ROOMPULSE_LOG_DIR = logDir;
  });

  afterEach(async () => {
    delete process.env.ROOMPULSE_LOG_DIR;
    if (logDir) {
      await rm(logDir, { force: true, recursive: true });
    }
  });

  it("creates, appends, reads, and lists local meeting logs", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);

    expect(metadata.title).toBe("Persistence review");
    expect(metadata.eventCount).toBe(0);

    await appendMeetingLogEvent(metadata.id, {
      type: "meeting_started",
      timestamp: startedAt,
      payload: { meeting }
    });
    await appendMeetingLogEvent(metadata.id, {
      type: "transcript_line",
      timestamp: startedAt + 1_000,
      payload: { text: "We should keep this." }
    });

    const snapshot = await readMeetingLog(metadata.id);
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.metadata.eventCount).toBe(2);
    expect(snapshot.events[1]?.type).toBe("transcript_line");

    await expect(listMeetingLogs()).resolves.toEqual([snapshot.metadata]);
  });

  it("does not materialize invalid transcript payloads into the query tables", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);

    await appendMeetingLogEvent(metadata.id, {
      type: "transcript_line",
      timestamp: startedAt + 1_000,
      payload: {
        line: {
          id: "line-1",
          speakerId: "",
          speakerLabel: " ",
          text: "This should remain only in the raw event stream.",
          timestamp: startedAt + 1_000,
          source: "speech",
          confidence: 2
        }
      }
    });

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.transcript).toEqual([]);
  });

  it("migrates older local SQLite session tables before writing", async () => {
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database.exec(`
      CREATE TABLE meeting_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        meeting_json TEXT NOT NULL
      );

      CREATE TABLE meeting_events (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE transcript_lines (
        id TEXT NOT NULL,
        meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
        speaker_id TEXT NOT NULL,
        speaker_label TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (meeting_id, id)
      );

      CREATE TABLE review_versions (
        id TEXT NOT NULL,
        meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
        timestamp INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        PRIMARY KEY (meeting_id, id)
      );
    `);
    database.close();

    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    await appendMeetingLogEvent(metadata.id, {
      type: "transcript_line",
      timestamp: startedAt + 1_000,
      payload: {
        line: {
          id: "line-1",
          speakerId: "speaker-1",
          speakerLabel: "Speaker 1",
          text: "Legacy database still accepts new transcript rows.",
          timestamp: startedAt + 1_000,
          source: "speech",
          confidence: 0.9
        }
      }
    });

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.metadata.status).toBe("active");
    expect(snapshot.metadata.eventCount).toBe(1);
    expect(snapshot.transcript).toHaveLength(1);
    expect(snapshot.transcript[0]?.source).toBe("speech");
  });
});
