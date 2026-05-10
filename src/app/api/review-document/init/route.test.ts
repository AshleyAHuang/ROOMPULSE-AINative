import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { runPiInitialReviewDocument } from "@/lib/pi-adapter";
import {
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_INPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH,
  MAX_HEARTBEAT_INTERVAL_SECONDS
} from "@/lib/facilitator";

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
          expectedParticipants: 10_000,
          agenda: Array.from({ length: 31 }, (_, index) => ({
            id: `a${index}`,
            title: `Item ${index}`,
            done: false
          })),
          participants: Array.from({ length: 25 }, (_, index) => ({
            name: `Person ${index}`
          })),
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

  it("rejects heartbeat intervals above the timer-safe cap before calling the agent", async () => {
    vi.mocked(runPiInitialReviewDocument).mockReset();

    const response = await POST(
      jsonRequest({
        meeting: {
          ...validMeeting,
          heartbeatIntervalSeconds: MAX_HEARTBEAT_INTERVAL_SECONDS + 1
        }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid meeting payload"
    });
    expect(runPiInitialReviewDocument).not.toHaveBeenCalled();
  });

  it("rejects duplicate agenda ids before calling the agent", async () => {
    vi.mocked(runPiInitialReviewDocument).mockReset();

    const response = await POST(
      jsonRequest({
        meeting: {
          ...validMeeting,
          agenda: [
            { id: "duplicate", title: "First", done: false },
            { id: "duplicate", title: "Second", done: false }
          ]
        }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid meeting payload"
    });
    expect(runPiInitialReviewDocument).not.toHaveBeenCalled();
  });

  it("caps oversized setup text before calling the Pi initial-review adapter", async () => {
    vi.mocked(runPiInitialReviewDocument).mockResolvedValue({
      source: "pi",
      markdown: "# Initial review",
      summary: "Initialized."
    });

    const response = await POST(
      jsonRequest({
        meeting: {
          ...validMeeting,
          title: "T".repeat(2_000),
          goal: "G".repeat(2_000),
          context: "C".repeat(2_000),
          agenda: [{ id: "a1", title: "A".repeat(2_000), done: false }],
          participants: [{ name: "N".repeat(2_000), role: "R".repeat(2_000) }]
        }
      })
    );

    expect(response.status).toBe(200);
    const [meeting] = vi.mocked(runPiInitialReviewDocument).mock.calls.at(-1)!;
    expect(meeting.title).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(meeting.goal).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(meeting.context).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(meeting.agenda[0].title).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(meeting.participants[0].name).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(meeting.participants[0].role).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
  });

  it("caps oversized initial-review metadata before returning it to the app", async () => {
    vi.mocked(runPiInitialReviewDocument).mockResolvedValue({
      source: "pi",
      markdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1),
      summary: "S".repeat(2_000),
      adapterNotice: "N".repeat(2_000)
    });

    const response = await POST(jsonRequest({ meeting: validMeeting }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary).toHaveLength(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH);
    expect(body.adapterNotice).toHaveLength(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH);
    expect(body.markdown).toHaveLength(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH);
  });

  it("marks failed initialization as Pi-required when strict mode is enabled", async () => {
    process.env.ROOMPULSE_REQUIRE_PI = "1";
    vi.mocked(runPiInitialReviewDocument).mockRejectedValue(
      new Error("Codex auth missing")
    );

    try {
      const response = await POST(jsonRequest({ meeting: validMeeting }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Codex auth missing",
        piRequired: true
      });
    } finally {
      delete process.env.ROOMPULSE_REQUIRE_PI;
    }
  });
});

function jsonRequest(payload: unknown): Request {
  return new Request("http://localhost/api/review-document/init", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" }
  });
}
