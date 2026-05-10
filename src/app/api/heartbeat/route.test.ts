import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { runPiHeartbeat } from "@/lib/pi-adapter";
import {
  MAX_AGENDA_ITEMS,
  MAX_EXPECTED_PARTICIPANTS,
  MAX_FACILITATOR_OUTPUT_CARDS,
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_HISTORY_ITEMS,
  MAX_HEARTBEAT_INPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH,
  MAX_HEARTBEAT_REVIEW_VERSIONS,
  MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES,
  MAX_HEARTBEAT_TRANSCRIPT_DELTA_LINES,
  type FacilitatorOutput
} from "@/lib/facilitator";

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

  it("rejects unsafe transcript speaker labels before creating heartbeat input", async () => {
    const response = await POST(
      jsonRequest({
        ...validPayload,
        transcript: [
          {
            id: "line-1",
            speakerId: "speaker-1",
            speakerLabel: "Speaker\n1",
            text: "This label should not enter the heartbeat prompt.",
            timestamp: 500,
            source: "speech",
            confidence: 0.9
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

  it("rejects heartbeat intervals above the timer-safe cap", async () => {
    const response = await POST(
      jsonRequest({
        ...validPayload,
        meeting: {
          ...validPayload.meeting,
          heartbeatIntervalSeconds: MAX_HEARTBEAT_INTERVAL_SECONDS + 1
        }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid heartbeat payload"
    });
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects duplicate agenda ids before creating heartbeat input", async () => {
    const response = await POST(
      jsonRequest({
        ...validPayload,
        meeting: {
          ...validPayload.meeting,
          agenda: [
            { id: "duplicate", title: "First", done: false },
            { id: "duplicate", title: "Second", done: false }
          ]
        }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid heartbeat payload"
    });
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects duplicate heartbeat history ids before creating heartbeat input", async () => {
    const duplicateTranscript = await POST(
      jsonRequest({
        ...validPayload,
        transcript: [
          {
            id: "line-1",
            speakerId: "speaker-1",
            speakerLabel: "Speaker 1",
            text: "First.",
            timestamp: 100,
            source: "speech",
            confidence: 0.9
          },
          {
            id: "line-1",
            speakerId: "speaker-2",
            speakerLabel: "Speaker 2",
            text: "Second.",
            timestamp: 200,
            source: "speech",
            confidence: 0.9
          }
        ]
      })
    );

    const duplicateReview = await POST(
      jsonRequest({
        ...validPayload,
        reviewVersions: [
          {
            id: "review-1",
            timestamp: 100,
            source: "pi",
            markdown: "# Review",
            summary: "First."
          },
          {
            id: "review-1",
            timestamp: 200,
            source: "pi",
            markdown: "# Review",
            summary: "Second."
          }
        ]
      })
    );

    const duplicateIntervention = await POST(
      jsonRequest({
        ...validPayload,
        priorInterventions: [
          {
            id: "pulse-1",
            timestamp: 100,
            source: "pi",
            cards: [],
            summary: "First."
          },
          {
            id: "pulse-1",
            timestamp: 200,
            source: "pi",
            cards: [],
            summary: "Second."
          }
        ]
      })
    );

    const duplicateCards = await POST(
      jsonRequest({
        ...validPayload,
        priorInterventions: [
          {
            id: "pulse-1",
            timestamp: 100,
            source: "pi",
            cards: [
              {
                id: "card-1",
                kind: "heartbeat",
                title: "First",
                body: "First.",
                priority: "medium"
              },
              {
                id: "card-1",
                kind: "heartbeat",
                title: "Second",
                body: "Second.",
                priority: "medium"
              }
            ],
            summary: "Duplicate card ids."
          }
        ]
      })
    );

    for (const response of [
      duplicateTranscript,
      duplicateReview,
      duplicateIntervention,
      duplicateCards
    ]) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid heartbeat payload"
      });
    }
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
    const farFuture = Date.now() + 10 * 60_000;
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
      { ...validPayload, now: farFuture },
      { ...validPayload, now: -1 },
      { ...validPayload, lastHeartbeatAt: 2_000, now: 1_000 },
      { ...validPayload, meetingStartedAt: 1e100 },
      { ...validPayload, meetingStartedAt: farFuture },
      { ...validPayload, meetingStartedAt: -1 },
      { ...validPayload, meetingStartedAt: 2_000, now: 1_000 },
      { ...validPayload, heartbeatCount: -1 },
      { ...validPayload, transcript: [{ ...validLine, timestamp: 1e100 }] },
      { ...validPayload, transcript: [{ ...validLine, timestamp: farFuture }] },
      { ...validPayload, transcript: [{ ...validLine, timestamp: -1 }] },
      { ...validPayload, transcript: [{ ...validLine, timestamp: 2_000 }], now: 1_000 },
      {
        ...validPayload,
        priorInterventions: [{ ...validIntervention, timestamp: 1e100 }]
      },
      {
        ...validPayload,
        priorInterventions: [{ ...validIntervention, timestamp: farFuture }]
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
            timestamp: farFuture,
            source: "pi",
            markdown: "# Review",
            summary: "Future timestamp."
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
          expectedParticipants: 10_000,
          agenda: Array.from({ length: 31 }, (_, index) => ({
            id: `a${index}`,
            title: `Item ${index}`,
            done: false
          })),
          participants: Array.from({ length: 25 }, (_, index) => ({
            name: `Person ${index}`
          }))
        }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid heartbeat payload"
    });
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects oversized heartbeat context arrays before creating heartbeat input", async () => {
    const maxTranscriptLines =
      MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES +
      MAX_HEARTBEAT_TRANSCRIPT_DELTA_LINES;
    const oversizedPayloads = [
      {
        ...validPayload,
        transcript: Array.from({ length: maxTranscriptLines + 1 }, (_, index) => ({
          id: `line-${index + 1}`,
          speakerId: "speaker-1",
          speakerLabel: "Speaker 1",
          text: `Transcript line ${index + 1}.`,
          timestamp: index + 1,
          source: "speech",
          confidence: 0.9
        }))
      },
      {
        ...validPayload,
        priorInterventions: Array.from(
          { length: MAX_HEARTBEAT_HISTORY_ITEMS + 1 },
          (_, index) => ({
            id: `pulse-${index + 1}`,
            timestamp: index + 1,
            source: "pi",
            cards: [],
            summary: `Heartbeat ${index + 1}.`
          })
        )
      },
      {
        ...validPayload,
        priorInterventions: [
          {
            id: "pulse-too-many-cards",
            timestamp: 100,
            source: "pi",
            cards: Array.from(
              { length: MAX_FACILITATOR_OUTPUT_CARDS + 1 },
              (_, index) => ({
              id: `card-${index + 1}`,
              kind: "heartbeat",
              title: `Card ${index + 1}`,
              body: `Cue ${index + 1}.`,
              priority: "medium"
              })
            ),
            summary: "Too many cards."
          }
        ]
      },
      {
        ...validPayload,
        reviewVersions: Array.from(
          { length: MAX_HEARTBEAT_REVIEW_VERSIONS + 1 },
          (_, index) => ({
            id: `review-${index + 1}`,
            timestamp: index + 1,
            source: "pi",
            markdown: `# Review ${index + 1}`,
            summary: `Review ${index + 1}.`
          })
        )
      }
    ];

    for (const payload of oversizedPayloads) {
      const response = await POST(jsonRequest(payload));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid heartbeat payload"
      });
    }
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects oversized heartbeat text fields before creating heartbeat input", async () => {
    const oversizedPayloads = [
      {
        ...validPayload,
        currentReviewMarkdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1)
      },
      {
        ...validPayload,
        transcript: [
          {
            id: "line-1",
            speakerId: "speaker-1",
            speakerLabel: "Speaker 1",
            text: "T".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 1),
            timestamp: 100,
            source: "speech",
            confidence: 0.9
          }
        ]
      },
      {
        ...validPayload,
        priorInterventions: [
          {
            id: "pulse-1",
            timestamp: 100,
            source: "pi",
            cards: [],
            summary: "Prior heartbeat.",
            reviewMarkdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1)
          }
        ]
      },
      {
        ...validPayload,
        reviewVersions: [
          {
            id: "review-1",
            timestamp: 100,
            source: "pi",
            markdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1),
            summary: "Review."
          }
        ]
      }
    ];

    for (const payload of oversizedPayloads) {
      const response = await POST(jsonRequest(payload));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid heartbeat payload"
      });
    }
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects oversized heartbeat ids before creating heartbeat input", async () => {
    const oversizedId = "x".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1);
    const oversizedPayloads = [
      {
        ...validPayload,
        transcript: [
          {
            id: oversizedId,
            speakerId: "speaker-1",
            speakerLabel: "Speaker 1",
            text: "Transcript id should be bounded.",
            timestamp: 100,
            source: "speech",
            confidence: 0.9
          }
        ]
      },
      {
        ...validPayload,
        transcript: [
          {
            id: "line-1",
            speakerId: oversizedId,
            speakerLabel: "Speaker 1",
            text: "Speaker id should be bounded.",
            timestamp: 100,
            source: "speech",
            confidence: 0.9
          }
        ]
      },
      {
        ...validPayload,
        priorInterventions: [
          {
            id: oversizedId,
            timestamp: 100,
            source: "pi",
            cards: [],
            summary: "Timeline id should be bounded."
          }
        ]
      },
      {
        ...validPayload,
        priorInterventions: [
          {
            id: "pulse-1",
            timestamp: 100,
            source: "pi",
            cards: [
              {
                id: oversizedId,
                kind: "heartbeat",
                title: "Card id",
                body: "Card id should be bounded.",
                priority: "medium"
              }
            ],
            summary: "Card id should be bounded."
          }
        ]
      },
      {
        ...validPayload,
        reviewVersions: [
          {
            id: oversizedId,
            timestamp: 100,
            source: "pi",
            markdown: "# Review",
            summary: "Review id should be bounded."
          }
        ]
      }
    ];

    for (const payload of oversizedPayloads) {
      const response = await POST(jsonRequest(payload));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid heartbeat payload"
      });
    }
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

  it("rejects oversized observed speaker label lists before calling the agent", async () => {
    const response = await POST(
      jsonRequest({
        ...validPayload,
        observedSpeakerLabels: Array.from(
          { length: MAX_EXPECTED_PARTICIPANTS + 1 },
          (_, index) => `Speaker ${index + 1}`
        )
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid heartbeat payload"
    });
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects oversized or multiline observed speaker labels before calling the agent", async () => {
    for (const label of ["Speaker\n2", "x".repeat(81)]) {
      const response = await POST(
        jsonRequest({
          ...validPayload,
          observedSpeakerLabels: [label]
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid heartbeat payload"
      });
    }
    expect(runPiHeartbeat).not.toHaveBeenCalled();
  });

  it("caps oversized facilitator output lists before returning route JSON", async () => {
    vi.mocked(runPiHeartbeat).mockResolvedValue({
      ...output,
      cards: Array.from({ length: 12 }, (_, index) => ({
        id: `card-${index + 1}`,
        kind: "heartbeat",
        title: `Card ${index + 1}`,
        body: `Cue ${index + 1}.`,
        priority: "medium"
      })),
      agendaActions: Array.from(
        { length: MAX_AGENDA_ITEMS + 5 },
        (_, index) => ({
          itemId: `a${index + 1}`,
          done: true,
          reason: `Agenda action ${index + 1}.`
        })
      ),
      uiActions: Array.from({ length: 12 }, (_, index) => ({
        tool: "send_room_reminder",
        parameters: { message: `Reminder ${index + 1}` },
        reason: `Reminder action ${index + 1}.`
      }))
    });

    const response = await POST(jsonRequest(validPayload));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cards).toHaveLength(5);
    expect(body.cards.at(-1)?.title).toBe("Card 5");
    expect(body.agendaActions).toHaveLength(MAX_AGENDA_ITEMS);
    expect(body.uiActions).toHaveLength(8);
    expect(body.uiActions.at(-1)?.parameters.message).toBe("Reminder 8");
  });

  it("caps oversized room-facing output text before returning route JSON", async () => {
    vi.mocked(runPiHeartbeat).mockResolvedValue({
      ...output,
      cards: [
        {
          id: "long-card",
          kind: "heartbeat",
          title: "T".repeat(400),
          body: "B".repeat(1_000),
          priority: "medium"
        }
      ],
      summary: "S".repeat(1_000),
      nextHeartbeatHint: "H".repeat(1_000),
      agendaActions: [
        {
          itemId: "a1",
          done: true,
          reason: "A".repeat(1_000)
        }
      ],
      uiActions: [
        {
          tool: "send_room_reminder",
          parameters: { message: "M".repeat(1_000) },
          reason: "R".repeat(1_000)
        }
      ],
      ephemeralReminder: "E".repeat(1_000),
      adapterNotice: "N".repeat(1_000)
    });

    const response = await POST(jsonRequest(validPayload));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cards[0].title).toHaveLength(280);
    expect(body.cards[0].body).toHaveLength(280);
    expect(body.summary).toHaveLength(500);
    expect(body.nextHeartbeatHint).toHaveLength(500);
    expect(body.agendaActions[0].reason).toHaveLength(500);
    expect(body.uiActions[0].reason).toHaveLength(500);
    expect(body.uiActions[0].parameters.message).toHaveLength(500);
    expect(body.ephemeralReminder).toHaveLength(500);
    expect(body.adapterNotice).toHaveLength(500);
  });

  it("strips unsupported UI action parameters before returning route JSON", async () => {
    vi.mocked(runPiHeartbeat).mockResolvedValue({
      ...output,
      uiActions: [
        {
          tool: "send_room_reminder",
          parameters: {
            message: "Invite quiet voices.",
            unused: "x".repeat(10_000),
            nested: { payload: "y".repeat(10_000) }
          },
          reason: "Pi sent a room reminder."
        },
        {
          tool: "set_agenda_item",
          parameters: {
            itemId: "a1",
            done: true,
            extra: "z".repeat(10_000)
          },
          reason: "Pi checked the agenda item."
        }
      ]
    });

    const response = await POST(jsonRequest(validPayload));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.uiActions[0].parameters).toEqual({
      message: "Invite quiet voices."
    });
    expect(body.uiActions[1].parameters).toEqual({
      itemId: "a1",
      done: true
    });
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
