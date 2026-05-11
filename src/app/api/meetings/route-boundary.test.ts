import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FACILITATOR_OUTPUT_TEXT_LENGTH } from "@/lib/facilitator";

const validMeeting = {
  title: "Boundary meeting",
  goal: "Validate storage failures",
  context: "Local storage",
  agenda: [{ id: "a1", title: "Discuss logs", done: false }],
  expectedParticipants: 2,
  participants: [],
  heartbeatIntervalSeconds: 30
};

describe("/api/meetings route boundary validation", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/meeting-log-store");
    vi.restoreAllMocks();
  });

  it("caps oversized list storage errors before returning route JSON", async () => {
    const oversizedError = "E".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1);
    vi.doMock("@/lib/meeting-log-store", () => ({
      createMeetingLog: vi.fn(),
      listMeetingLogs: vi.fn(async () => {
        throw new Error(oversizedError);
      })
    }));
    const { GET } = await import("./route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toHaveLength(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH);
    expect(body.error).toBe("E".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH));
  });

  it("caps oversized create storage errors before returning route JSON", async () => {
    const oversizedError = "E".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1);
    vi.doMock("@/lib/meeting-log-store", () => ({
      createMeetingLog: vi.fn(async () => {
        throw new Error(oversizedError);
      }),
      listMeetingLogs: vi.fn()
    }));
    const { POST } = await import("./route");

    const response = await POST(jsonRequest({ meeting: validMeeting }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toHaveLength(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH);
    expect(body.error).toBe("E".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH));
  });
});

function jsonRequest(payload: unknown): Request {
  return new Request("http://localhost/api/meetings", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" }
  });
}
