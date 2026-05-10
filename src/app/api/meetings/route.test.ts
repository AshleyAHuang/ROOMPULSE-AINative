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

  it("rejects malformed materialized events instead of silently dropping them", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "transcript_line",
        timestamp: Date.now(),
        payload: { text: "This is not the materialized line envelope." }
      }),
      routeContext(created.id)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });
  });

  it("rejects transcript events with impossible speaker metadata", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "transcript_line",
        timestamp: Date.now(),
        payload: {
          line: {
            id: "line-1",
            speakerId: "",
            speakerLabel: " ",
            text: "Broken speaker metadata should not persist.",
            timestamp: Date.now(),
            source: "speech",
            confidence: 1.4
          }
        }
      }),
      routeContext(created.id)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });
  });

  it("rejects review events that would not materialize into queryable versions", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "review_initialized",
        timestamp: Date.now(),
        payload: {
          reviewVersion: {
            id: " ",
            timestamp: Date.now(),
            source: "pi",
            markdown: "# Review",
            summary: "Should be rejected before storage."
          }
        }
      }),
      routeContext(created.id)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });
  });

  it("keeps ended meetings terminal and rejects later materialized events", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();

    const endResponse = await POST_EVENT(
      jsonRequest({
        type: "meeting_ended",
        timestamp,
        payload: { endedAt: timestamp }
      }),
      routeContext(created.id)
    );
    expect(endResponse.status).toBe(201);

    const lateTranscript = await POST_EVENT(
      jsonRequest({
        type: "transcript_line",
        timestamp: timestamp + 1,
        payload: {
          line: {
            id: "late-line",
            speakerId: "speaker-1",
            speakerLabel: "Speaker 1",
            text: "This should not mutate an ended meeting.",
            timestamp: timestamp + 1,
            source: "speech",
            confidence: 0.9
          }
        }
      }),
      routeContext(created.id)
    );

    expect(lateTranscript.status).toBe(409);
    await expect(lateTranscript.json()).resolves.toEqual({
      error: "Meeting log has ended"
    });

    const snapshotResponse = await GET_MEETING(
      new Request("http://localhost/api/meetings/test"),
      routeContext(created.id)
    );
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      metadata: {
        status: "ended",
        isPaused: true,
        endedAt: timestamp
      },
      transcript: []
    });
  });

  it("honors the meeting_ended payload time instead of the log write time", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const endedAt = Date.now();

    const response = await POST_EVENT(
      jsonRequest({
        type: "meeting_ended",
        timestamp: endedAt + 5_000,
        payload: { endedAt }
      }),
      routeContext(created.id)
    );
    expect(response.status).toBe(201);

    const snapshotResponse = await GET_MEETING(
      new Request("http://localhost/api/meetings/test"),
      routeContext(created.id)
    );
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      metadata: { endedAt }
    });
  });

  it("does not regress latest review metadata for out-of-order heartbeat events", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();

    await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: timestamp + 2_000,
        payload: {
          reviewVersionId: "new-review",
          output: {
            source: "pi",
            summary: "New review.",
            reviewMarkdown: "# New review"
          }
        }
      }),
      routeContext(created.id)
    );

    await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: timestamp + 1_000,
        payload: {
          reviewVersionId: "old-review",
          output: {
            source: "pi",
            summary: "Old retry.",
            reviewMarkdown: "# Old retry"
          }
        }
      }),
      routeContext(created.id)
    );

    const snapshotResponse = await GET_MEETING(
      new Request("http://localhost/api/meetings/test"),
      routeContext(created.id)
    );
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      metadata: {
        latestReviewMarkdown: "# New review",
        latestReviewVersionId: "new-review"
      },
      reviewVersions: [{ id: "new-review" }, { id: "old-review" }]
    });
  });

  it("merges stale autosave state with newer materialized transcript and review rows", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();
    const firstLine = {
      id: "line-1",
      speakerId: "speaker-1",
      speakerLabel: "Speaker 1",
      text: "First line.",
      timestamp,
      source: "speech",
      confidence: 0.9
    };

    await POST_EVENT(
      jsonRequest({
        type: "transcript_line",
        timestamp,
        payload: { line: firstLine }
      }),
      routeContext(created.id)
    );
    await POST_EVENT(
      jsonRequest({
        type: "transcript_line",
        timestamp: timestamp + 1,
        payload: {
          line: {
            ...firstLine,
            id: "line-2",
            text: "Second line.",
            timestamp: timestamp + 1
          }
        }
      }),
      routeContext(created.id)
    );
    await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: timestamp + 2,
        payload: {
          reviewVersionId: "review-2",
          output: {
            source: "pi",
            summary: "Newer materialized review.",
            reviewMarkdown: "# Newer review"
          }
        }
      }),
      routeContext(created.id)
    );

    const patchResponse = await PATCH(
      jsonRequest({
        updatedAt: timestamp + 3,
        state: {
          status: "active",
          meeting: validMeeting,
          transcript: [firstLine],
          reviewMarkdown: "# Stale review",
          reviewVersions: [
            {
              id: "review-1",
              timestamp,
              source: "pi",
              markdown: "# Stale review",
              summary: "Stale autosave review."
            }
          ],
          currentReviewVersionId: "review-1",
          timeline: [],
          lastHeartbeatAt: timestamp,
          nextHeartbeatAt: timestamp + 30_000,
          meetingStartedAt: timestamp,
          heartbeatCount: 1,
          isPaused: false,
          currentOutput: null,
          activeAgendaItemId: "a1",
          updatedAt: timestamp + 3
        }
      }),
      routeContext(created.id)
    );
    expect(patchResponse.status).toBe(200);

    const snapshotResponse = await GET_MEETING(
      new Request("http://localhost/api/meetings/test"),
      routeContext(created.id)
    );
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      metadata: {
        state: {
          transcript: [{ id: "line-1" }, { id: "line-2" }],
          currentReviewVersionId: "review-2",
          reviewMarkdown: "# Newer review"
        },
        latestReviewMarkdown: "# Newer review",
        latestReviewVersionId: "review-2"
      },
      transcript: [{ id: "line-1" }, { id: "line-2" }]
    });
  });

  it("rejects malformed persisted state and keeps ended meetings terminal", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();

    const invalidPatch = await PATCH(
      jsonRequest({
        state: {
          status: "active",
          meeting: { title: "bad" },
          transcript: [{ id: "line-1" }],
          reviewMarkdown: "bad",
          reviewVersions: [],
          currentReviewVersionId: "v1",
          timeline: [],
          lastHeartbeatAt: timestamp,
          nextHeartbeatAt: timestamp,
          meetingStartedAt: timestamp,
          heartbeatCount: 0,
          isPaused: false,
          updatedAt: timestamp
        }
      }),
      routeContext(created.id)
    );

    expect(invalidPatch.status).toBe(400);

    const endedPatch = await PATCH(
      jsonRequest({
        status: "ended",
        isPaused: true,
        endedAt: timestamp,
        updatedAt: timestamp
      }),
      routeContext(created.id)
    );
    expect(endedPatch.status).toBe(200);

    const stalePatch = await PATCH(
      jsonRequest({
        status: "active",
        isPaused: false,
        updatedAt: timestamp + 1
      }),
      routeContext(created.id)
    );

    expect(stalePatch.status).toBe(200);
    await expect(stalePatch.json()).resolves.toMatchObject({
      status: "ended",
      isPaused: true,
      endedAt: timestamp
    });
  });

  it("returns 404 for writes to missing meeting logs", async () => {
    const response = await POST_EVENT(
      jsonRequest({
        type: "meeting_started",
        timestamp: Date.now(),
        payload: { meeting: validMeeting }
      }),
      routeContext("missing-meeting")
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 for invalid meeting payloads", async () => {
    const response = await POST(jsonRequest({ meeting: null }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid meeting payload"
    });
  });

  it("rejects impossible meeting configuration before it reaches SQLite", async () => {
    const response = await POST(
      jsonRequest({
        meeting: {
          ...validMeeting,
          expectedParticipants: -3,
          heartbeatIntervalSeconds: 0,
          agenda: [{ id: "", title: " ", done: false }]
        }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid meeting payload"
    });
  });

  it("rejects out-of-range meeting and event timestamps before persistence", async () => {
    const invalidCreate = await POST(
      jsonRequest({
        meeting: validMeeting,
        startedAt: 1e100
      })
    );
    expect(invalidCreate.status).toBe(400);
    await expect(invalidCreate.json()).resolves.toEqual({
      error: "Invalid meeting timestamp"
    });

    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const invalidEvent = await POST_EVENT(
      jsonRequest({
        type: "meeting_started",
        timestamp: 1e100,
        payload: { meeting: validMeeting }
      }),
      routeContext(created.id)
    );
    expect(invalidEvent.status).toBe(400);
    await expect(invalidEvent.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });

    const invalidEndedAt = await POST_EVENT(
      jsonRequest({
        type: "meeting_ended",
        timestamp: Date.now(),
        payload: { endedAt: 1e100 }
      }),
      routeContext(created.id)
    );
    expect(invalidEndedAt.status).toBe(400);
    await expect(invalidEndedAt.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });

    const invalidPatch = await PATCH(
      jsonRequest({
        updatedAt: 1e100
      }),
      routeContext(created.id)
    );
    expect(invalidPatch.status).toBe(400);
    await expect(invalidPatch.json()).resolves.toEqual({
      error: "Invalid meeting timestamp"
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
