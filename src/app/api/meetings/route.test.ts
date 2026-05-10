import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "./route";
import { GET as GET_MEETING, PATCH } from "./[meetingId]/route";
import { POST as POST_EVENT } from "./[meetingId]/events/route";

let logDir = "";

const validMeeting = {
  title: "Logged meeting",
  goal: "Persist events",
  context: "Local storage",
  agenda: [{ id: "a1", title: "Discuss logs", done: false }],
  expectedParticipants: 2,
  participants: [],
  heartbeatIntervalSeconds: 30
};

describe("/api/meetings", () => {
  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "roompulse-api-logs-"));
    process.env.ROOMPULSE_LOG_DIR = logDir;
  });

  afterEach(async () => {
    delete process.env.ROOMPULSE_LOG_DIR;
    if (logDir) {
      await rm(logDir, { force: true, recursive: true });
    }
  });

  it("creates and lists local meeting logs", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.title).toBe("Logged meeting");

    const listResponse = await GET();
    await expect(listResponse.json()).resolves.toMatchObject({
      meetings: [{ id: created.id, title: "Logged meeting", status: "active" }]
    });
  });

  it("stores transcript lines, review versions, and resumable state in SQLite", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();

    await POST_EVENT(
      jsonRequest({
        type: "transcript_line",
        timestamp,
        payload: {
          line: {
            id: "line-1",
            speakerId: "speaker-1",
            speakerLabel: "Speaker 1",
            text: "We need a launch owner.",
            timestamp,
            source: "speech",
            confidence: 0.91
          }
        }
      }),
      routeContext(created.id)
    );

    await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: timestamp + 1,
        payload: {
          reviewVersionId: "review-1",
          output: {
            source: "local-fallback",
            summary: "Captured owner risk.",
            reviewMarkdown: "## Decision status\nOwner still open."
          }
        }
      }),
      routeContext(created.id)
    );

    const patchResponse = await PATCH(
      jsonRequest({
        status: "paused",
        isPaused: true,
        updatedAt: timestamp + 2,
        state: {
          status: "paused",
          meeting: validMeeting,
          transcript: [],
          reviewMarkdown: "## Decision status\nOwner still open.",
          reviewVersions: [],
          currentReviewVersionId: "review-1",
          timeline: [],
          lastHeartbeatAt: timestamp,
          nextHeartbeatAt: timestamp + 30000,
          meetingStartedAt: timestamp - 1000,
          heartbeatCount: 1,
          isPaused: true,
          currentOutput: null,
          activeAgendaItemId: "a1",
          updatedAt: timestamp + 2
        }
      }),
      routeContext(created.id)
    );

    expect(patchResponse.status).toBe(200);
    await expect(patchResponse.json()).resolves.toMatchObject({
      id: created.id,
      status: "paused",
      isPaused: true,
      state: {
        currentReviewVersionId: "review-1"
      }
    });

    const snapshotResponse = await GET_MEETING(
      new Request("http://localhost/api/meetings/test"),
      routeContext(created.id)
    );
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      metadata: { id: created.id, status: "paused" },
      transcript: [{ text: "We need a launch owner." }],
      reviewVersions: [{ id: "review-1" }]
    });
  });

  it("returns 400 for invalid meeting payloads", async () => {
    const response = await POST(jsonRequest({ meeting: null }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid meeting payload"
    });
  });
});

function jsonRequest(payload: unknown): Request {
  return new Request("http://localhost/api/meetings", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" }
  });
}

function routeContext(meetingId: string) {
  return {
    params: Promise.resolve({ meetingId })
  };
}
