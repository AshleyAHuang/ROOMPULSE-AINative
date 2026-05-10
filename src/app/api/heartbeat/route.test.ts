import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { runPiHeartbeat } from "@/lib/pi-adapter";
import type { FacilitatorOutput } from "@/lib/facilitator";

vi.mock("@/lib/pi-adapter", () => ({
  runPiHeartbeat: vi.fn()
}));

const output: FacilitatorOutput = {
  source: "local-fallback",
  cards: [
    {
      id: "test-card",
      kind: "heartbeat",
      title: "Heartbeat check",
      body: "RoomPulse is alive.",
      priority: "medium"
    }
  ],
  summary: "One cue generated.",
  nextHeartbeatHint: "Keep listening.",
  reviewMarkdown: "# Demo\n\nOne cue generated.",
  agendaActions: [],
  uiActions: [],
  ephemeralReminder: null
};

const validPayload = {
  meeting: {
    title: "Demo",
    goal: "Stay on track",
    context: "Local demo",
    agenda: [{ id: "a1", title: "Open", done: false }],
    expectedParticipants: 2,
    participants: [],
    heartbeatIntervalSeconds: 30
  },
  transcript: [],
  observedSpeakerLabels: [],
  lastHeartbeatAt: 0,
  now: 1_000,
  priorInterventions: []
};

describe("POST /api/heartbeat", () => {
  beforeEach(() => {
    delete process.env.ROOMPULSE_REQUIRE_PI;
    vi.mocked(runPiHeartbeat).mockReset();
    vi.mocked(runPiHeartbeat).mockResolvedValue(output);
  });

  afterEach(() => {
    delete process.env.ROOMPULSE_REQUIRE_PI;
  });

  it("returns facilitator output for a valid heartbeat payload", async () => {
    const response = await POST(jsonRequest(validPayload));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(output);
    expect(runPiHeartbeat).toHaveBeenCalledOnce();
  });

  it("returns a safe 400 for malformed JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/heartbeat", {
        method: "POST",
        body: "{",
        headers: { "Content-Type": "application/json" }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON payload"
    });
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("returns a safe 400 for missing heartbeat fields", async () => {
    const response = await POST(jsonRequest({ meeting: null }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid heartbeat payload"
    });
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects impossible heartbeat meeting and transcript values", async () => {
    const response = await POST(
      jsonRequest({
        ...validPayload,
        meeting: {
          ...validPayload.meeting,
          expectedParticipants: 0,
          heartbeatIntervalSeconds: 0
        },
        transcript: [
          {
            id: "line-1",
            speakerId: "speaker-1",
            speakerLabel: "",
            text: "This line has no usable speaker label.",
            timestamp: 500,
            source: "speech",
            confidence: -0.2
          }
        ]
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid heartbeat payload"
    });
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects malformed prior interventions before creating heartbeat input", async () => {
    const response = await POST(
      jsonRequest({
        ...validPayload,
        priorInterventions: [null]
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid heartbeat payload"
    });
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("marks strict Pi failures so the client does not silently fall back", async () => {
    process.env.ROOMPULSE_REQUIRE_PI = "1";
    vi.mocked(runPiHeartbeat).mockRejectedValue(new Error("Pi unavailable"));

    const response = await POST(jsonRequest(validPayload));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Pi unavailable",
      piRequired: true
    });
  });
});

function jsonRequest(payload: unknown): Request {
  return new Request("http://localhost/api/heartbeat", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" }
  });
}
