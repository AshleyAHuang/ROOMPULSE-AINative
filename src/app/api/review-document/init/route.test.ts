import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { runPiInitialReviewDocument } from "@/lib/pi-adapter";

vi.mock("@/lib/pi-adapter", () => ({
  runPiInitialReviewDocument: vi.fn()
}));

const validMeeting = {
  title: "Initial review",
  goal: "Prepare the meeting file.",
  context: "RoomPulse setup",
  agenda: [{ id: "a1", title: "Confirm goal", done: false }],
  expectedParticipants: 2,
  participants: [],
  heartbeatIntervalSeconds: 30
};

describe("POST /api/review-document/init", () => {
  it("returns the initialized review document for a valid meeting", async () => {
    vi.mocked(runPiInitialReviewDocument).mockResolvedValue({
      source: "local-fallback",
      markdown: "# Initial review",
      summary: "Initialized."
    });

    const response = await POST(jsonRequest({ meeting: validMeeting }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      source: "local-fallback",
      markdown: "# Initial review",
      summary: "Initialized."
    });
    expect(runPiInitialReviewDocument).toHaveBeenCalledWith(validMeeting);
  });

  it("rejects impossible meeting configuration before calling the agent", async () => {
    vi.mocked(runPiInitialReviewDocument).mockReset();

    const response = await POST(
      jsonRequest({
        meeting: {
          ...validMeeting,
          title: "",
          expectedParticipants: 0,
          heartbeatIntervalSeconds: 0
        }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid meeting payload"
    });
    expect(runPiInitialReviewDocument).not.toHaveBeenCalled();
  });
});

function jsonRequest(payload: unknown): Request {
  return new Request("http://localhost/api/review-document/init", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" }
  });
}
