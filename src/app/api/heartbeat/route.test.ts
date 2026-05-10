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

  it("rejects unsafe heartbeat timestamps and counters before calling the agent", async () => {
    const validLine = {
      id: "line-1",
      speakerId: "speaker-1",
      speakerLabel: "Speaker 1",
      text: "We need a launch owner.",
      timestamp: 1_000,
      source: "speech",
      confidence: 0.9
    };
    const validIntervention = {
      id: "pulse-1",
      timestamp: 1_000,
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
    };
    const invalidPayloads = [
      { ...validPayload, now: 1e100 },
      { ...validPayload, now: -1 },
      { ...validPayload, lastHeartbeatAt: 2_000, now: 1_000 },
      { ...validPayload, meetingStartedAt: 1e100 },
      { ...validPayload, meetingStartedAt: -1 },
      { ...validPayload, meetingStartedAt: 2_000, now: 1_000 },
      { ...validPayload, heartbeatCount: -1 },
      { ...validPayload, transcript: [{ ...validLine, timestamp: 1e100 }] },
      { ...validPayload, transcript: [{ ...validLine, timestamp: -1 }] },
      { ...validPayload, transcript: [{ ...validLine, timestamp: 2_000 }], now: 1_000 },
      {
        ...validPayload,
        priorInterventions: [{ ...validIntervention, timestamp: 1e100 }]
      },
      {
        ...validPayload,
        priorInterventions: [{ ...validIntervention, timestamp: 2_000 }],
        now: 1_000
      },
      {
        ...validPayload,
        reviewVersions: [
          {
            id: "review-1",
            timestamp: 1e100,
            source: "pi",
            markdown: "# Review",
            summary: "Broken timestamp."
          }
        ]
      },
      {
        ...validPayload,
        reviewVersions: [
          {
            id: "review-1",
            timestamp: 2_000,
            source: "pi",
            markdown: "# Review",
            summary: "Future review."
          }
        ],
        now: 1_000
      }
    ];

    for (const payload of invalidPayloads) {
      const response = await POST(jsonRequest(payload));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid heartbeat payload"
      });
    }
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects excessive expected participants before creating heartbeat input", async () => {
    const response = await POST(
      jsonRequest({
        ...validPayload,
        meeting: {
          ...validPayload.meeting,
          expectedParticipants: 10_000
        }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid heartbeat payload"
    });
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects malformed speaker labels and card kinds in heartbeat history", async () => {
    const response = await POST(
      jsonRequest({
        ...validPayload,
        observedSpeakerLabels: [""],
        priorInterventions: [
          {
            id: "pulse-1",
            timestamp: 1_000,
            source: "pi",
            cards: [
              {
                id: "card-1",
                kind: "unknown",
                title: "Heartbeat",
                body: "Keep going.",
                priority: "medium"
              }
            ],
            summary: "One cue."
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
