import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_HEARTBEAT_INPUT_TEXT_LENGTH } from "@/lib/facilitator";

const validMeeting = {
  title: "Boundary meeting",
  goal: "Validate state",
  context: "Local storage",
  agenda: [{ id: "a1", title: "Discuss logs", done: false }],
  expectedParticipants: 2,
  participants: [],
  heartbeatIntervalSeconds: 30
};

describe("/api/meetings/[meetingId] route boundary validation", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/meeting-log-store");
    vi.restoreAllMocks();
  });

  it("rejects oversized PATCH transcript state before touching storage", async () => {
    const updateMeetingLogState = vi.fn(async () => ({ id: "meeting-1" }));
    vi.doMock("@/lib/meeting-log-store", () => ({
      readMeetingLog: vi.fn(),
      updateMeetingLogState
    }));
    const { PATCH } = await import("./route");
    const timestamp = Date.now();

    const response = await PATCH(
      jsonRequest({
        updatedAt: timestamp,
        state: {
          ...persistedState(timestamp),
          transcript: [
            {
              id: "line-oversized-text",
              speakerId: "speaker-1",
              speakerLabel: "Speaker 1",
              text: "T".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 1),
              timestamp,
              source: "manual",
              confidence: 1
            }
          ]
        }
      }),
      routeContext("meeting-1")
    );

    expect(response.status).toBe(400);
    expect(updateMeetingLogState).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Invalid meeting state payload"
    });
  });
});

function jsonRequest(payload: unknown): Request {
  return new Request("http://localhost/api/meetings/meeting-1", {
    method: "PATCH",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" }
  });
}

function routeContext(meetingId: string) {
  return {
    params: Promise.resolve({ meetingId })
  };
}

function persistedState(timestamp: number) {
  return {
    status: "active",
    meeting: validMeeting,
    transcript: [],
    reviewMarkdown: "# Review",
    reviewVersions: [
      {
        id: "review-1",
        timestamp,
        source: "pi",
        markdown: "# Review",
        summary: "Current review."
      }
    ],
    currentReviewVersionId: "review-1",
    timeline: [
      {
        id: "pulse-1",
        timestamp,
        source: "pi",
        cards: [
          {
            id: "card-1",
            kind: "heartbeat",
            title: "Heartbeat",
            body: "Keep going.",
            priority: "medium"
          }
        ],
        summary: "One cue.",
        reminder: null
      }
    ],
    lastHeartbeatAt: timestamp,
    nextHeartbeatAt: timestamp + 30_000,
    meetingStartedAt: timestamp,
    heartbeatCount: 1,
    isPaused: false,
    currentOutput: null,
    activeAgendaItemId: "a1",
    updatedAt: timestamp
  };
}
