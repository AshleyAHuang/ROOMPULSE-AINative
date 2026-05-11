import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "./route";
import { GET as GET_MEETING, PATCH } from "./[meetingId]/route";
import { POST as POST_EVENT } from "./[meetingId]/events/route";
import {
  MAX_FACILITATOR_CARD_TEXT_LENGTH,
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH,
  MAX_HEARTBEAT_INPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_INTERVAL_SECONDS
} from "@/lib/facilitator";

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

  it("caps oversized meeting text before storing log metadata", async () => {
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
    const created = await response.json();

    expect(response.status).toBe(201);
    expect(created.title).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(created.goal).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(created.meeting.context).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(created.meeting.agenda[0].title).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(created.meeting.participants[0].name).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(created.meeting.participants[0].role).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
  });

  it("caps oversized meeting_started event setup before storing the event log", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();

    const response = await POST_EVENT(
      jsonRequest({
        type: "meeting_started",
        timestamp,
        payload: {
          meeting: {
            ...validMeeting,
            title: "T".repeat(2_000),
            goal: "G".repeat(2_000),
            context: "C".repeat(2_000),
            agenda: [{ id: "a1", title: "A".repeat(2_000), done: false }],
            participants: [{ name: "N".repeat(2_000), role: "R".repeat(2_000) }]
          },
          mode: "manual"
        }
      }),
      routeContext(created.id)
    );
    expect(response.status).toBe(201);

    const snapshotResponse = await GET_MEETING(
      new Request("http://localhost/api/meetings/test"),
      routeContext(created.id)
    );
    const snapshot = await snapshotResponse.json();
    const startedEvent = snapshot.events.find(
      (event: { type: string }) => event.type === "meeting_started"
    );

    expect(startedEvent.payload.meeting.title).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(startedEvent.payload.meeting.goal).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(startedEvent.payload.meeting.context).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(startedEvent.payload.meeting.agenda[0].title).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(startedEvent.payload.meeting.participants[0].name).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(startedEvent.payload.meeting.participants[0].role).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
  });

  it("rejects unknown event types before storing arbitrary payloads", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "debug_dump",
        timestamp: Date.now(),
        payload: {
          dump: "D".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 1)
        }
      }),
      routeContext(created.id)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });
  });

  it("caps and strips known event payload fields before storing the event log", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();
    const oversizedOutputText = "O".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1);
    const oversizedInputText = "I".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 1);

    const failedInitResponse = await POST_EVENT(
      jsonRequest({
        type: "review_initialization_failed",
        timestamp,
        payload: {
          message: oversizedOutputText,
          debug: oversizedInputText
        }
      }),
      routeContext(created.id)
    );
    expect(failedInitResponse.status).toBe(201);

    const agendaResponse = await POST_EVENT(
      jsonRequest({
        type: "agenda_item_added",
        timestamp: timestamp + 1,
        payload: {
          item: {
            id: "agenda-extra",
            title: oversizedInputText,
            done: false,
            debug: oversizedInputText
          },
          reason: oversizedOutputText,
          debug: oversizedInputText
        }
      }),
      routeContext(created.id)
    );
    expect(agendaResponse.status).toBe(201);

    const heartbeatResponse = await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: timestamp + 2,
        payload: {
          reviewVersionId: "review-extra",
          output: {
            source: "local-fallback",
            cards: [
              {
                id: "card-extra",
                kind: "heartbeat",
                title: "Heartbeat",
                body: "Keep going.",
                priority: "medium",
                debug: oversizedInputText
              }
            ],
            summary: "Summary",
            nextHeartbeatHint: "Next heartbeat.",
            reviewMarkdown: "# Review",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null,
            debug: oversizedInputText
          },
          debug: oversizedInputText
        }
      }),
      routeContext(created.id)
    );
    expect(heartbeatResponse.status).toBe(201);

    const snapshotResponse = await GET_MEETING(
      new Request("http://localhost/api/meetings/test"),
      routeContext(created.id)
    );
    const snapshot = await snapshotResponse.json();
    const failedInitEvent = snapshot.events.find(
      (event: { type: string }) => event.type === "review_initialization_failed"
    );
    const agendaEvent = snapshot.events.find(
      (event: { type: string }) => event.type === "agenda_item_added"
    );
    const heartbeatEvent = snapshot.events.find(
      (event: { type: string }) => event.type === "heartbeat_output"
    );

    expect(failedInitEvent.payload.message).toHaveLength(
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    );
    expect(failedInitEvent.payload.debug).toBeUndefined();
    expect(agendaEvent.payload.item.title).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(agendaEvent.payload.item.debug).toBeUndefined();
    expect(agendaEvent.payload.reason).toHaveLength(
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    );
    expect(agendaEvent.payload.debug).toBeUndefined();
    expect(heartbeatEvent.payload.output.cards[0].debug).toBeUndefined();
    expect(heartbeatEvent.payload.output.debug).toBeUndefined();
    expect(heartbeatEvent.payload.debug).toBeUndefined();
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

  it("strips oversized extra fields from persisted state before storing", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();
    const oversized = "X".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 1);
    const baseState = persistedState(timestamp);

    const patchResponse = await PATCH(
      jsonRequest({
        updatedAt: timestamp,
        state: {
          ...baseState,
          debug: oversized,
          meeting: {
            ...baseState.meeting,
            debug: oversized,
            agenda: [
              {
                ...baseState.meeting.agenda[0],
                debug: oversized
              }
            ],
            participants: [
              {
                name: "Ada",
                role: "Facilitator",
                debug: oversized
              }
            ]
          },
          transcript: [
            {
              id: "line-extra",
              speakerId: "speaker-1",
              speakerLabel: "Speaker 1",
              text: "State checkpoint line.",
              timestamp,
              source: "manual",
              confidence: 1,
              debug: oversized
            }
          ],
          reviewVersions: [
            {
              ...baseState.reviewVersions[0],
              debug: oversized
            }
          ],
          timeline: [
            {
              ...baseState.timeline[0],
              cards: [
                {
                  ...baseState.timeline[0].cards[0],
                  debug: oversized
                }
              ],
              debug: oversized
            }
          ],
          currentOutput: {
            source: "local-fallback",
            cards: [
              {
                id: "current-card",
                kind: "heartbeat",
                title: "Current",
                body: "Keep moving.",
                priority: "medium",
                debug: oversized
              }
            ],
            summary: "Current output.",
            nextHeartbeatHint: "Next.",
            reviewMarkdown: "# Review",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null,
            debug: oversized
          }
        }
      }),
      routeContext(created.id)
    );
    expect(patchResponse.status).toBe(200);

    const snapshotResponse = await GET_MEETING(
      new Request("http://localhost/api/meetings/test"),
      routeContext(created.id)
    );
    const snapshot = await snapshotResponse.json();
    const state = snapshot.metadata.state;

    expect(state.debug).toBeUndefined();
    expect(state.meeting.debug).toBeUndefined();
    expect(state.meeting.agenda[0].debug).toBeUndefined();
    expect(state.meeting.participants[0].debug).toBeUndefined();
    expect(state.transcript[0].debug).toBeUndefined();
    expect(state.reviewVersions[0].debug).toBeUndefined();
    expect(state.timeline[0].debug).toBeUndefined();
    expect(state.timeline[0].cards[0].debug).toBeUndefined();
    expect(state.currentOutput.debug).toBeUndefined();
    expect(state.currentOutput.cards[0].debug).toBeUndefined();
  });

  it("keeps materialized transcript and review rows immutable for duplicate payload ids", async () => {
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
            text: "Original transcript text.",
            timestamp,
            source: "speech",
            confidence: 0.9
          }
        }
      }),
      routeContext(created.id)
    );
    await POST_EVENT(
      jsonRequest({
        type: "transcript_line",
        timestamp: timestamp + 1,
        payload: {
          line: {
            id: "line-1",
            speakerId: "speaker-2",
            speakerLabel: "Speaker 2",
            text: "Overwriting duplicate transcript text.",
            timestamp: timestamp + 1,
            source: "speech",
            confidence: 0.9
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
          reviewVersionId: "review-1",
          output: {
            source: "pi",
            summary: "Original review.",
            reviewMarkdown: "# Original review"
          }
        }
      }),
      routeContext(created.id)
    );
    await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: timestamp + 3,
        payload: {
          reviewVersionId: "review-1",
          output: {
            source: "pi",
            summary: "Overwriting duplicate review.",
            reviewMarkdown: "# Overwritten review"
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
        latestReviewMarkdown: "# Original review",
        latestReviewVersionId: "review-1"
      },
      transcript: [
        {
          id: "line-1",
          speakerId: "speaker-1",
          text: "Original transcript text."
        }
      ],
      reviewVersions: [
        {
          id: "review-1",
          markdown: "# Original review",
          summary: "Original review."
        }
      ]
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

  it("rejects oversized materialized transcript text before storage", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();

    const response = await POST_EVENT(
      jsonRequest({
        type: "transcript_line",
        timestamp,
        payload: {
          line: {
            id: "line-oversized-text",
            speakerId: "speaker-1",
            speakerLabel: "Speaker 1",
            text: "T".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 1),
            timestamp,
            source: "speech",
            confidence: 0.9
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

  it("rejects whitespace-only event types before writing log rows", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "   ",
        timestamp: Date.now(),
        payload: { ignored: true }
      }),
      routeContext(created.id)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });
  });

  it("rejects padded materialized event types before they can bypass materialization", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();

    const response = await POST_EVENT(
      jsonRequest({
        type: " transcript_line ",
        timestamp,
        payload: {
          line: {
            id: "line-1",
            speakerId: "speaker-1",
            speakerLabel: "Speaker 1",
            text: "This should not be silently logged as a generic event.",
            timestamp,
            source: "speech",
            confidence: 0.9
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

  it("rejects transcript events with unsafe speaker labels", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();

    const response = await POST_EVENT(
      jsonRequest({
        type: "transcript_line",
        timestamp,
        payload: {
          line: {
            id: "line-1",
            speakerId: "speaker-1",
            speakerLabel: "Speaker\n1",
            text: "Unsafe labels should not persist.",
            timestamp,
            source: "speech",
            confidence: 0.9
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

  it("rejects review events with oversized version summaries before storage", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "review_initialized",
        timestamp: Date.now(),
        payload: {
          reviewVersion: {
            id: "review-oversized-summary",
            timestamp: Date.now(),
            source: "pi",
            markdown: "# Review",
            summary: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1)
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

  it("rejects review events with oversized markdown before storage", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "review_initialized",
        timestamp: Date.now(),
        payload: {
          reviewVersion: {
            id: "review-oversized-markdown",
            timestamp: Date.now(),
            source: "pi",
            markdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1),
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

  it("rejects malformed heartbeat output events before storage", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: Date.now(),
        payload: {
          reviewVersionId: "",
          output: {
            source: "unknown",
            cards: [{ id: "card-1", kind: "unknown" }],
            summary: "Malformed heartbeat.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Review",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null
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

  it("rejects malformed heartbeat agenda and UI tool actions before storage", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const baseOutput = {
      source: "pi",
      cards: [],
      summary: "Malformed tools should not persist.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Review",
      ephemeralReminder: null
    };

    const malformedAgendaAction = await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: Date.now(),
        payload: {
          reviewVersionId: "review-tools-1",
          output: {
            ...baseOutput,
            agendaActions: [{ itemId: "a1", done: "yes", reason: "Bad done flag." }],
            uiActions: []
          }
        }
      }),
      routeContext(created.id)
    );

    expect(malformedAgendaAction.status).toBe(400);
    await expect(malformedAgendaAction.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });

    const malformedUiAction = await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: Date.now(),
        payload: {
          reviewVersionId: "review-tools-2",
          output: {
            ...baseOutput,
            agendaActions: [],
            uiActions: [
              {
                tool: "set_agenda_item",
                parameters: { itemId: "a1", done: "true" },
                reason: "Bad parameter type."
              }
            ]
          }
        }
      }),
      routeContext(created.id)
    );

    expect(malformedUiAction.status).toBe(400);
    await expect(malformedUiAction.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });

    const uiActionWithExtraParameters = await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: Date.now(),
        payload: {
          reviewVersionId: "review-tools-3",
          output: {
            ...baseOutput,
            agendaActions: [],
            uiActions: [
              {
                tool: "send_room_reminder",
                parameters: {
                  message: "Invite quiet voices.",
                  unused: "x".repeat(10_000)
                },
                reason: "Extra parameter should be rejected."
              }
            ]
          }
        }
      }),
      routeContext(created.id)
    );

    expect(uiActionWithExtraParameters.status).toBe(400);
    await expect(uiActionWithExtraParameters.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });
  });

  it("rejects oversized heartbeat output room-facing text before storage", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: Date.now(),
        payload: {
          reviewVersionId: "review-oversized",
          output: {
            source: "pi",
            cards: [
              {
                id: "card-1",
                kind: "heartbeat",
                title: "Heartbeat",
                body: "B".repeat(MAX_FACILITATOR_CARD_TEXT_LENGTH + 1),
                priority: "medium"
              }
            ],
            summary: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1),
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Review",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null
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

  it("rejects blank heartbeat output cards before storage", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: Date.now(),
        payload: {
          reviewVersionId: "review-blank-card",
          output: {
            source: "pi",
            cards: [
              {
                id: "blank-card",
                kind: "heartbeat",
                title: "Heartbeat",
                body: "   ",
                priority: "medium"
              }
            ],
            summary: "Blank room cards should not persist.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Review",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null
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

  it("rejects oversized heartbeat output review markdown before storage", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();

    const response = await POST_EVENT(
      jsonRequest({
        type: "heartbeat_output",
        timestamp: Date.now(),
        payload: {
          reviewVersionId: "review-oversized-markdown",
          output: {
            source: "pi",
            cards: [],
            summary: "Oversized markdown.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1),
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null
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
    const staleFirstLine = {
      ...firstLine,
      text: "Stale autosave copy should not overwrite the event log."
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
          transcript: [staleFirstLine],
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
      transcript: [
        { id: "line-1", text: "First line." },
        { id: "line-2", text: "Second line." }
      ]
    });
  });

  it("rejects persisted state with invalid counters and review history", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();
    const baseState = persistedState(timestamp);
    const oversizedId = "x".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1);
    const invalidStates = [
      { ...baseState, heartbeatCount: -1 },
      { ...baseState, currentReviewVersionId: "" },
      { ...baseState, currentReviewVersionId: "missing-review" },
      {
        ...baseState,
        currentReviewVersionId: oversizedId,
        reviewVersions: [{ ...baseState.reviewVersions[0], id: oversizedId }]
      },
      { ...baseState, activeAgendaItemId: oversizedId },
      {
        ...baseState,
        reviewVersions: [{ ...baseState.reviewVersions[0], id: " " }]
      },
      { ...baseState, reviewVersions: [] },
      {
        ...baseState,
        transcript: [
          {
            id: "duplicate-line",
            speakerId: "speaker-1",
            speakerLabel: "Speaker 1",
            text: "First duplicate line.",
            timestamp,
            source: "speech",
            confidence: 0.9
          },
          {
            id: "duplicate-line",
            speakerId: "speaker-2",
            speakerLabel: "Speaker 2",
            text: "Second duplicate line.",
            timestamp,
            source: "speech",
            confidence: 0.9
          }
        ]
      },
      {
        ...baseState,
        transcript: [
          {
            id: oversizedId,
            speakerId: "speaker-1",
            speakerLabel: "Speaker 1",
            text: "Oversized transcript ids should not persist.",
            timestamp,
            source: "speech",
            confidence: 0.9
          }
        ]
      },
      {
        ...baseState,
        transcript: [
          {
            id: "line-1",
            speakerId: oversizedId,
            speakerLabel: "Speaker 1",
            text: "Oversized transcript speaker ids should not persist.",
            timestamp,
            source: "speech",
            confidence: 0.9
          }
        ]
      },
      {
        ...baseState,
        transcript: [
          {
            id: "unsafe-label",
            speakerId: "speaker-1",
            speakerLabel: "Speaker\n1",
            text: "Unsafe labels should not persist.",
            timestamp,
            source: "speech",
            confidence: 0.9
          }
        ]
      },
      {
        ...baseState,
        reviewVersions: [
          baseState.reviewVersions[0],
          { ...baseState.reviewVersions[0], markdown: "# Duplicate review" }
        ]
      },
      {
        ...baseState,
        reviewVersions: [
          {
            ...baseState.reviewVersions[0],
            summary: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1)
          }
        ]
      },
      {
        ...baseState,
        reviewMarkdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1)
      },
      {
        ...baseState,
        reviewVersions: [
          {
            ...baseState.reviewVersions[0],
            markdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1)
          }
        ]
      },
      {
        ...baseState,
        timeline: [
          baseState.timeline[0],
          { ...baseState.timeline[0], summary: "Duplicate timeline entry." }
        ]
      },
      {
        ...baseState,
        timeline: [
          {
            ...baseState.timeline[0],
            id: oversizedId
          }
        ]
      },
      {
        ...baseState,
        timeline: [
          {
            ...baseState.timeline[0],
            cards: [{ ...baseState.timeline[0].cards[0], id: oversizedId }]
          }
        ]
      },
      {
        ...baseState,
        timeline: [
          {
            ...baseState.timeline[0],
            cards: [
              baseState.timeline[0].cards[0],
              {
                ...baseState.timeline[0].cards[0],
                body: "Duplicate card id."
              }
            ]
          }
        ]
      },
      {
        ...baseState,
        timeline: [
          {
            ...baseState.timeline[0],
            cards: [{ ...baseState.timeline[0].cards[0], kind: "unknown" }]
          }
        ]
      },
      { ...baseState, meetingStartedAt: timestamp + 1 },
      { ...baseState, lastHeartbeatAt: timestamp + 1 },
      { ...baseState, endedAt: timestamp + 1 },
      {
        ...baseState,
        transcript: [
          {
            id: "future-line",
            speakerId: "speaker-1",
            speakerLabel: "Speaker 1",
            text: "This transcript line is from the future.",
            timestamp: timestamp + 1,
            source: "speech",
            confidence: 0.9
          }
        ]
      },
      {
        ...baseState,
        reviewVersions: [
          { ...baseState.reviewVersions[0], timestamp: timestamp + 1 }
        ]
      },
      {
        ...baseState,
        timeline: [{ ...baseState.timeline[0], timestamp: timestamp + 1 }]
      },
      {
        ...baseState,
        timeline: [
          {
            ...baseState.timeline[0],
            reviewMarkdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1)
          }
        ]
      },
      {
        ...baseState,
        currentOutput: {
          source: "pi",
          cards: [],
          summary: "Malformed current output is missing review markdown."
        }
      },
      {
        ...baseState,
        currentOutput: {
          source: "pi",
          cards: [],
          summary: "Oversized review markdown.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1),
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        }
      },
      {
        ...baseState,
        timeline: [
          {
            ...baseState.timeline[0],
            summary: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1)
          }
        ]
      },
      {
        ...baseState,
        currentOutput: {
          source: "pi",
          cards: [
            {
              id: oversizedId,
              kind: "heartbeat",
              title: "Heartbeat",
              body: "Current output card id should be bounded.",
              priority: "medium"
            }
          ],
          summary: "Oversized current output card id.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Review",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        }
      },
      {
        ...baseState,
        currentOutput: {
          source: "pi",
          cards: [
            {
              id: "card-1",
              kind: "heartbeat",
              title: "Heartbeat",
              body: "B".repeat(MAX_FACILITATOR_CARD_TEXT_LENGTH + 1),
              priority: "medium"
            }
          ],
          summary: "Oversized current output.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Review",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        }
      },
      {
        ...baseState,
        currentOutput: {
          source: "pi",
          cards: [
            {
              id: "blank-current-output-card",
              kind: "heartbeat",
              title: "Heartbeat",
              body: " ",
              priority: "medium"
            }
          ],
          summary: "Blank current output cards should not persist.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Review",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        }
      }
    ];

    for (const state of invalidStates) {
      const response = await PATCH(
        jsonRequest({
          updatedAt: timestamp + 1,
          state
        }),
        routeContext(created.id)
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid meeting state payload"
      });
    }
  });

  it("keeps patched pause status and isPaused flags coherent", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await createResponse.json();
    const timestamp = Date.now();

    const pausedByStatus = await PATCH(
      jsonRequest({
        status: "paused",
        updatedAt: timestamp
      }),
      routeContext(created.id)
    );
    expect(pausedByStatus.status).toBe(200);
    await expect(pausedByStatus.json()).resolves.toMatchObject({
      status: "paused",
      isPaused: true
    });

    const activeByFlag = await PATCH(
      jsonRequest({
        isPaused: false,
        updatedAt: timestamp + 1
      }),
      routeContext(created.id)
    );
    expect(activeByFlag.status).toBe(200);
    await expect(activeByFlag.json()).resolves.toMatchObject({
      status: "active",
      isPaused: false
    });

    const pausedByFlag = await PATCH(
      jsonRequest({
        isPaused: true,
        updatedAt: timestamp + 2
      }),
      routeContext(created.id)
    );
    expect(pausedByFlag.status).toBe(200);
    await expect(pausedByFlag.json()).resolves.toMatchObject({
      status: "paused",
      isPaused: true
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

  it("rejects heartbeat intervals that can overflow browser timers", async () => {
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
  });

  it("rejects duplicate agenda ids before tools can target the wrong item", async () => {
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
  });

  it("rejects agenda ids that exceed the persisted adapter id cap", async () => {
    const response = await POST(
      jsonRequest({
        meeting: {
          ...validMeeting,
          agenda: [
            {
              id: "a".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1),
              title: "Oversized id",
              done: false
            }
          ]
        }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid meeting payload"
    });
  });

  it("rejects excessive expected participant counts before UI replay can allocate them", async () => {
    const createResponse = await POST(
      jsonRequest({
        meeting: {
          ...validMeeting,
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

    expect(createResponse.status).toBe(400);
    await expect(createResponse.json()).resolves.toEqual({
      error: "Invalid meeting payload"
    });

    const validCreate = await POST(jsonRequest({ meeting: validMeeting }));
    const created = await validCreate.json();
    const timestamp = Date.now();
    const state = persistedState(timestamp);
    const patchResponse = await PATCH(
      jsonRequest({
        updatedAt: timestamp,
        state: {
          ...state,
          meeting: {
            ...state.meeting,
            expectedParticipants: 10_000
          }
        }
      }),
      routeContext(created.id)
    );

    expect(patchResponse.status).toBe(400);
    await expect(patchResponse.json()).resolves.toEqual({
      error: "Invalid meeting state payload"
    });
  });

  it("rejects out-of-range meeting and event timestamps before persistence", async () => {
    const farFuture = Date.now() + 10 * 60_000;
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

    const invalidCreateType = await POST(
      jsonRequest({
        meeting: validMeeting,
        startedAt: "not-a-timestamp"
      })
    );
    expect(invalidCreateType.status).toBe(400);
    await expect(invalidCreateType.json()).resolves.toEqual({
      error: "Invalid meeting timestamp"
    });

    const negativeCreate = await POST(
      jsonRequest({
        meeting: validMeeting,
        startedAt: -1
      })
    );
    expect(negativeCreate.status).toBe(400);
    await expect(negativeCreate.json()).resolves.toEqual({
      error: "Invalid meeting timestamp"
    });

    const futureCreate = await POST(
      jsonRequest({
        meeting: validMeeting,
        startedAt: farFuture
      })
    );
    expect(futureCreate.status).toBe(400);
    await expect(futureCreate.json()).resolves.toEqual({
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

    const negativeEvent = await POST_EVENT(
      jsonRequest({
        type: "meeting_started",
        timestamp: -1,
        payload: { meeting: validMeeting }
      }),
      routeContext(created.id)
    );
    expect(negativeEvent.status).toBe(400);
    await expect(negativeEvent.json()).resolves.toEqual({
      error: "Invalid log event payload"
    });

    const futureEvent = await POST_EVENT(
      jsonRequest({
        type: "meeting_started",
        timestamp: farFuture,
        payload: { meeting: validMeeting }
      }),
      routeContext(created.id)
    );
    expect(futureEvent.status).toBe(400);
    await expect(futureEvent.json()).resolves.toEqual({
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

    const futureEndedAt = await POST_EVENT(
      jsonRequest({
        type: "meeting_ended",
        timestamp: Date.now(),
        payload: { endedAt: farFuture }
      }),
      routeContext(created.id)
    );
    expect(futureEndedAt.status).toBe(400);
    await expect(futureEndedAt.json()).resolves.toEqual({
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

    const negativePatch = await PATCH(
      jsonRequest({
        updatedAt: -1
      }),
      routeContext(created.id)
    );
    expect(negativePatch.status).toBe(400);
    await expect(negativePatch.json()).resolves.toEqual({
      error: "Invalid meeting timestamp"
    });

    const futurePatch = await PATCH(
      jsonRequest({
        updatedAt: farFuture
      }),
      routeContext(created.id)
    );
    expect(futurePatch.status).toBe(400);
    await expect(futurePatch.json()).resolves.toEqual({
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
