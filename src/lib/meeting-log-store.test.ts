import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
});
