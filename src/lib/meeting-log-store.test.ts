import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendMeetingLogEvent,
  createMeetingLog,
  listMeetingLogs,
  readMeetingLog,
  updateMeetingLogState
} from "./meeting-log-store";
import {
  MAX_FACILITATOR_CARD_TEXT_LENGTH,
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH,
  MAX_HEARTBEAT_INPUT_TEXT_LENGTH,
  type MeetingConfig
} from "./facilitator";

const meeting: MeetingConfig = {
  title: "Persistence review",
  goal: "Keep local meeting logs",
  context: "Test",
  agenda: [{ id: "a1", title: "Open", done: false }],
  expectedParticipants: 2,
  participants: [],
  heartbeatIntervalSeconds: 30
};

let logDir = "";

describe("meeting log store", () => {
  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "roompulse-logs-"));
    process.env.ROOMPULSE_LOG_DIR = logDir;
  });

  afterEach(async () => {
    delete process.env.ROOMPULSE_LOG_DIR;
    if (logDir) {
      await rm(logDir, { force: true, recursive: true });
    }
  });

  it("creates, appends, reads, and lists local meeting logs", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);

    expect(metadata.title).toBe("Persistence review");
    expect(metadata.eventCount).toBe(0);

    await appendMeetingLogEvent(metadata.id, {
      type: "meeting_started",
      timestamp: startedAt,
      payload: { meeting }
    });
    await appendMeetingLogEvent(metadata.id, {
      type: "transcript_line",
      timestamp: startedAt + 1_000,
      payload: { text: "We should keep this." }
    });

    const snapshot = await readMeetingLog(metadata.id);
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.metadata.eventCount).toBe(2);
    expect(snapshot.events[1]?.type).toBe("transcript_line");

    await expect(listMeetingLogs()).resolves.toEqual([snapshot.metadata]);
  });

  it("caps oversized meeting text before storing session metadata", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(
      {
        ...meeting,
        title: "T".repeat(2_000),
        goal: "G".repeat(2_000),
        context: "C".repeat(2_000),
        agenda: [{ id: "a1", title: "A".repeat(2_000), done: false }],
        participants: [{ name: "N".repeat(2_000), role: "R".repeat(2_000) }]
      },
      startedAt
    );

    expect(metadata.title).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(metadata.goal).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(metadata.meeting.context).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(metadata.meeting.agenda[0].title).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(metadata.meeting.participants[0].name).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(metadata.meeting.participants[0].role).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
  });

  it("does not materialize invalid transcript payloads into the query tables", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);

    await appendMeetingLogEvent(metadata.id, {
      type: "transcript_line",
      timestamp: startedAt + 1_000,
      payload: {
        line: {
          id: "line-1",
          speakerId: "",
          speakerLabel: " ",
          text: "This should remain only in the raw event stream.",
          timestamp: startedAt + 1_000,
          source: "speech",
          confidence: 2
        }
      }
    });

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.transcript).toEqual([]);
  });

  it("does not materialize review payloads with oversized summaries", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);

    await appendMeetingLogEvent(metadata.id, {
      type: "review_initialized",
      timestamp: startedAt + 1_000,
      payload: {
        reviewVersion: {
          id: "review-oversized-summary",
          timestamp: startedAt + 1_000,
          source: "initial",
          markdown: "# Review",
          summary: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1)
        }
      }
    });

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.reviewVersions).toEqual([]);
    expect(snapshot.metadata.latestReviewVersionId).toBeNull();
  });

  it("migrates older local SQLite session tables before writing", async () => {
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database.exec(`
      CREATE TABLE meeting_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        meeting_json TEXT NOT NULL
      );

      CREATE TABLE meeting_events (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE transcript_lines (
        id TEXT NOT NULL,
        meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
        speaker_id TEXT NOT NULL,
        speaker_label TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (meeting_id, id)
      );

      CREATE TABLE review_versions (
        id TEXT NOT NULL,
        meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
        timestamp INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        PRIMARY KEY (meeting_id, id)
      );
    `);
    database.close();

    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    await appendMeetingLogEvent(metadata.id, {
      type: "transcript_line",
      timestamp: startedAt + 1_000,
      payload: {
        line: {
          id: "line-1",
          speakerId: "speaker-1",
          speakerLabel: "Speaker 1",
          text: "Legacy database still accepts new transcript rows.",
          timestamp: startedAt + 1_000,
          source: "speech",
          confidence: 0.9
        }
      }
    });

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.metadata.status).toBe("active");
    expect(snapshot.metadata.eventCount).toBe(1);
    expect(snapshot.transcript).toHaveLength(1);
    expect(snapshot.transcript[0]?.source).toBe("speech");
  });

  it("drops malformed persisted state and falls back for malformed meeting JSON", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database
      .prepare(
        `UPDATE meeting_sessions
          SET meeting_json = ?,
              state_json = ?
          WHERE id = ?`
      )
      .run(
        JSON.stringify({ title: "Broken only" }),
        JSON.stringify({
          status: "paused",
          meeting: { title: "bad" },
          transcript: [{ id: "line-without-speaker" }],
          reviewMarkdown: "# Bad",
          reviewVersions: [],
          currentReviewVersionId: "bad",
          timeline: [],
          lastHeartbeatAt: startedAt,
          nextHeartbeatAt: startedAt,
          meetingStartedAt: startedAt,
          heartbeatCount: 0,
          isPaused: true,
          activeAgendaItemId: null,
          updatedAt: startedAt
        }),
        metadata.id
      );
    database.close();

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.metadata.meeting).toMatchObject({
      title: "Persistence review",
      goal: "Keep local meeting logs",
      expectedParticipants: 1
    });
    expect(snapshot.metadata.state).toBeNull();
  });

  it("caps oversized legacy meeting JSON and state JSON on read", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const oversizedMeeting: MeetingConfig = {
      ...meeting,
      title: "T".repeat(2_000),
      goal: "G".repeat(2_000),
      context: "C".repeat(2_000),
      agenda: [{ id: "a1", title: "A".repeat(2_000), done: false }],
      participants: [{ name: "N".repeat(2_000), role: "R".repeat(2_000) }]
    };
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database
      .prepare(
        `UPDATE meeting_sessions
          SET title = ?,
              goal = ?,
              meeting_json = ?,
              state_json = ?
          WHERE id = ?`
      )
      .run(
        oversizedMeeting.title,
        oversizedMeeting.goal,
        JSON.stringify(oversizedMeeting),
        JSON.stringify({
          status: "active",
          meeting: oversizedMeeting,
          transcript: [],
          reviewMarkdown: "# Review",
          reviewVersions: [
            {
              id: "review-1",
              timestamp: startedAt,
              source: "initial",
              markdown: "# Review",
              summary: "Initial."
            }
          ],
          currentReviewVersionId: "review-1",
          timeline: [],
          lastHeartbeatAt: startedAt,
          nextHeartbeatAt: startedAt + 30_000,
          meetingStartedAt: startedAt,
          heartbeatCount: 0,
          isPaused: false,
          currentOutput: null,
          activeAgendaItemId: null,
          updatedAt: startedAt
        }),
        metadata.id
      );
    database.close();

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.metadata.title).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(snapshot.metadata.goal).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(snapshot.metadata.meeting.context).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(snapshot.metadata.meeting.agenda[0].title).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(snapshot.metadata.meeting.participants[0].name).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(snapshot.metadata.state?.meeting.context).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
  });

  it("caps oversized legacy latest review metadata on read", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database
      .prepare(
        `UPDATE meeting_sessions
          SET latest_review_markdown = ?,
              latest_review_version_id = ?
          WHERE id = ?`
      )
      .run(
        "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1),
        "legacy-review-".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH),
        metadata.id
      );
    database.close();

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.metadata.latestReviewMarkdown).toHaveLength(
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    );
    expect(snapshot.metadata.latestReviewVersionId).toHaveLength(
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    );
  });

  it("drops persisted state with future-dated materialized children", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database
      .prepare(
        `UPDATE meeting_sessions
          SET state_json = ?
          WHERE id = ?`
      )
      .run(
        JSON.stringify({
          status: "active",
          meeting,
          transcript: [
            {
              id: "future-line",
              speakerId: "speaker-1",
              speakerLabel: "Speaker 1",
              text: "This future transcript line should invalidate state.",
              timestamp: startedAt + 1_000,
              source: "speech",
              confidence: 0.9
            }
          ],
          reviewMarkdown: "# Review",
          reviewVersions: [
            {
              id: "review-1",
              timestamp: startedAt,
              source: "initial",
              markdown: "# Review",
              summary: "Initial."
            }
          ],
          currentReviewVersionId: "review-1",
          timeline: [],
          lastHeartbeatAt: startedAt,
          nextHeartbeatAt: startedAt + 30_000,
          meetingStartedAt: startedAt,
          heartbeatCount: 0,
          isPaused: false,
          currentOutput: null,
          activeAgendaItemId: null,
          updatedAt: startedAt
        }),
        metadata.id
      );
    database.close();

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.metadata.state).toBeNull();
  });

  it("drops persisted state with a missing current review version", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database
      .prepare(
        `UPDATE meeting_sessions
          SET state_json = ?
          WHERE id = ?`
      )
      .run(
        JSON.stringify({
          status: "active",
          meeting,
          transcript: [],
          reviewMarkdown: "# Review",
          reviewVersions: [
            {
              id: "review-1",
              timestamp: startedAt,
              source: "initial",
              markdown: "# Review",
              summary: "Initial."
            }
          ],
          currentReviewVersionId: "missing-review",
          timeline: [],
          lastHeartbeatAt: startedAt,
          nextHeartbeatAt: startedAt + 30_000,
          meetingStartedAt: startedAt,
          heartbeatCount: 0,
          isPaused: false,
          currentOutput: null,
          activeAgendaItemId: null,
          updatedAt: startedAt
        }),
        metadata.id
      );
    database.close();

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.metadata.state).toBeNull();
  });

  it("rejects persisted meeting JSON and state with excessive participant counts", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const oversizedMeeting = {
      ...meeting,
      agenda: Array.from({ length: 31 }, (_, index) => ({
        id: `a${index}`,
        title: `Item ${index}`,
        done: false
      })),
      expectedParticipants: 10_000,
      participants: Array.from({ length: 25 }, (_, index) => ({
        name: `Person ${index}`
      }))
    };
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database
      .prepare(
        `UPDATE meeting_sessions
          SET meeting_json = ?,
              state_json = ?
          WHERE id = ?`
      )
      .run(
        JSON.stringify(oversizedMeeting),
        JSON.stringify({
          status: "active",
          meeting: oversizedMeeting,
          transcript: [],
          reviewMarkdown: "# Review",
          reviewVersions: [
            {
              id: "review-1",
              timestamp: startedAt,
              source: "initial",
              markdown: "# Review",
              summary: "Initial."
            }
          ],
          currentReviewVersionId: "review-1",
          timeline: [],
          lastHeartbeatAt: startedAt,
          nextHeartbeatAt: startedAt + 30_000,
          meetingStartedAt: startedAt,
          heartbeatCount: 0,
          isPaused: false,
          activeAgendaItemId: null,
          updatedAt: startedAt
        }),
        metadata.id
      );
    database.close();

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.metadata.meeting.expectedParticipants).toBe(1);
    expect(snapshot.metadata.state).toBeNull();
  });

  it("drops persisted meeting state with duplicate agenda ids", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const duplicateAgendaMeeting = {
      ...meeting,
      agenda: [
        { id: "duplicate", title: "First", done: false },
        { id: "duplicate", title: "Second", done: false }
      ]
    };
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database
      .prepare(
        `UPDATE meeting_sessions
          SET state_json = ?
          WHERE id = ?`
      )
      .run(
        JSON.stringify({
          status: "active",
          meeting: duplicateAgendaMeeting,
          transcript: [],
          reviewMarkdown: "# Review",
          reviewVersions: [
            {
              id: "review-1",
              timestamp: startedAt,
              source: "initial",
              markdown: "# Review",
              summary: "Initial."
            }
          ],
          currentReviewVersionId: "review-1",
          timeline: [],
          lastHeartbeatAt: startedAt,
          nextHeartbeatAt: startedAt + 30_000,
          meetingStartedAt: startedAt,
          heartbeatCount: 0,
          isPaused: false,
          currentOutput: null,
          activeAgendaItemId: "duplicate",
          updatedAt: startedAt
        }),
        metadata.id
      );
    database.close();

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.metadata.state).toBeNull();
  });

  it("drops persisted meeting state with duplicate child ids", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const state = {
      status: "active",
      meeting,
      transcript: [
        {
          id: "duplicate-line",
          speakerId: "speaker-1",
          speakerLabel: "Speaker 1",
          text: "First duplicate transcript line.",
          timestamp: startedAt,
          source: "speech",
          confidence: 0.9
        },
        {
          id: "duplicate-line",
          speakerId: "speaker-2",
          speakerLabel: "Speaker 2",
          text: "Second duplicate transcript line.",
          timestamp: startedAt,
          source: "speech",
          confidence: 0.9
        }
      ],
      reviewMarkdown: "# Review",
      reviewVersions: [
        {
          id: "review-1",
          timestamp: startedAt,
          source: "initial",
          markdown: "# Review",
          summary: "Initial."
        }
      ],
      currentReviewVersionId: "review-1",
      timeline: [
        {
          id: "pulse-1",
          timestamp: startedAt,
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
          summary: "Duplicate child ids."
        }
      ],
      lastHeartbeatAt: startedAt,
      nextHeartbeatAt: startedAt + 30_000,
      meetingStartedAt: startedAt,
      heartbeatCount: 0,
      isPaused: false,
      currentOutput: null,
      activeAgendaItemId: null,
      updatedAt: startedAt
    };
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database
      .prepare(
        `UPDATE meeting_sessions
          SET state_json = ?
          WHERE id = ?`
      )
      .run(JSON.stringify(state), metadata.id);
    database.close();

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.metadata.state).toBeNull();
  });

  it("backfills missing endedAt for legacy ended sessions on state update", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    try {
      database
        .prepare("UPDATE meeting_sessions SET status = 'ended', ended_at = NULL WHERE id = ?")
        .run(metadata.id);
    } finally {
      database.close();
    }

    const updated = await updateMeetingLogState(metadata.id, {
      status: "active",
      isPaused: false,
      updatedAt: startedAt + 5_000
    });

    expect(updated.status).toBe("ended");
    expect(updated.isPaused).toBe(true);
    expect(updated.endedAt).toBe(startedAt + 5_000);
  });

  it("rejects state updates with malformed current facilitator output", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);

    await expect(
      updateMeetingLogState(metadata.id, {
        updatedAt: startedAt,
        state: {
          status: "active",
          meeting,
          transcript: [],
          reviewMarkdown: "# Review",
          reviewVersions: [
            {
              id: "review-1",
              timestamp: startedAt,
              source: "initial",
              markdown: "# Review",
              summary: "Initial."
            }
          ],
          currentReviewVersionId: "review-1",
          timeline: [],
          lastHeartbeatAt: startedAt,
          nextHeartbeatAt: startedAt + 30_000,
          meetingStartedAt: startedAt,
          heartbeatCount: 0,
          isPaused: false,
          currentOutput: {
            source: "pi",
            cards: [],
            summary: "Missing required review markdown."
          },
          activeAgendaItemId: null,
          updatedAt: startedAt
        }
      })
    ).rejects.toThrow("Invalid meeting state payload");
  });

  it("rejects state updates with oversized room-facing facilitator text", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);

    await expect(
      updateMeetingLogState(metadata.id, {
        updatedAt: startedAt,
        state: {
          status: "active",
          meeting,
          transcript: [],
          reviewMarkdown: "# Review",
          reviewVersions: [
            {
              id: "review-1",
              timestamp: startedAt,
              source: "initial",
              markdown: "# Review",
              summary: "Initial."
            }
          ],
          currentReviewVersionId: "review-1",
          timeline: [
            {
              id: "pulse-1",
              timestamp: startedAt,
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
              reminder: null
            }
          ],
          lastHeartbeatAt: startedAt,
          nextHeartbeatAt: startedAt + 30_000,
          meetingStartedAt: startedAt,
          heartbeatCount: 0,
          isPaused: false,
          currentOutput: {
            source: "pi",
            cards: [],
            summary: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1),
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Review",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null
          },
          activeAgendaItemId: null,
          updatedAt: startedAt
        }
      })
    ).rejects.toThrow("Invalid meeting state payload");
  });

  it("rejects state updates with oversized review version summaries", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);

    await expect(
      updateMeetingLogState(metadata.id, {
        updatedAt: startedAt,
        state: {
          status: "active",
          meeting,
          transcript: [],
          reviewMarkdown: "# Review",
          reviewVersions: [
            {
              id: "review-1",
              timestamp: startedAt,
              source: "initial",
              markdown: "# Review",
              summary: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1)
            }
          ],
          currentReviewVersionId: "review-1",
          timeline: [],
          lastHeartbeatAt: startedAt,
          nextHeartbeatAt: startedAt + 30_000,
          meetingStartedAt: startedAt,
          heartbeatCount: 0,
          isPaused: false,
          currentOutput: null,
          activeAgendaItemId: null,
          updatedAt: startedAt
        }
      })
    ).rejects.toThrow("Invalid meeting state payload");
  });

  it("caps oversized meeting text before storing resumable state", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const oversizedMeeting: MeetingConfig = {
      ...meeting,
      title: "T".repeat(2_000),
      goal: "G".repeat(2_000),
      context: "C".repeat(2_000),
      agenda: [{ id: "a1", title: "A".repeat(2_000), done: false }],
      participants: [{ name: "N".repeat(2_000), role: "R".repeat(2_000) }]
    };

    const updated = await updateMeetingLogState(metadata.id, {
      updatedAt: startedAt,
      state: {
        status: "active",
        meeting: oversizedMeeting,
        transcript: [],
        reviewMarkdown: "# Review",
        reviewVersions: [
          {
            id: "review-1",
            timestamp: startedAt,
            source: "initial",
            markdown: "# Review",
            summary: "Initial."
          }
        ],
        currentReviewVersionId: "review-1",
        timeline: [],
        lastHeartbeatAt: startedAt,
        nextHeartbeatAt: startedAt + 30_000,
        meetingStartedAt: startedAt,
        heartbeatCount: 0,
        isPaused: false,
        currentOutput: null,
        activeAgendaItemId: null,
        updatedAt: startedAt
      }
    });

    expect(updated.meeting.title).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(updated.meeting.goal).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(updated.meeting.context).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(updated.meeting.agenda[0].title).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(updated.meeting.participants[0].name).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(updated.meeting.participants[0].role).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(updated.state?.meeting.title).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
  });

  it("filters malformed materialized transcript and review rows on read", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const metadata = await createMeetingLog(meeting, startedAt);
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database
      .prepare(
        `INSERT INTO transcript_lines (
          id,
          meeting_id,
          speaker_id,
          speaker_label,
          text,
          timestamp,
          source,
          confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "valid-line",
        metadata.id,
        "speaker-1",
        "Speaker 1",
        "Keep this transcript row.",
        startedAt + 1_000,
        "speech",
        0.9
      );
    database
      .prepare(
        `INSERT INTO transcript_lines (
          id,
          meeting_id,
          speaker_id,
          speaker_label,
          text,
          timestamp,
          source,
          confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "bad-line",
        metadata.id,
        "speaker-2",
        "Speaker 2",
        "Drop this malformed transcript row.",
        startedAt + 2_000,
        "bad-source",
        0.9
      );
    database
      .prepare(
        `INSERT INTO transcript_lines (
          id,
          meeting_id,
          speaker_id,
          speaker_label,
          text,
          timestamp,
          source,
          confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "unsafe-label-line",
        metadata.id,
        "speaker-3",
        "Speaker\n3",
        "Drop this unsafe speaker label row.",
        startedAt + 3_000,
        "speech",
        0.9
      );
    database
      .prepare(
        `INSERT INTO transcript_lines (
          id,
          meeting_id,
          speaker_id,
          speaker_label,
          text,
          timestamp,
          source,
          confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "oversized-text-line",
        metadata.id,
        "speaker-4",
        "Speaker 4",
        "T".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 1),
        startedAt + 4_000,
        "speech",
        0.9
      );
    database
      .prepare(
        `INSERT INTO review_versions (
          id,
          meeting_id,
          timestamp,
          source,
          markdown,
          summary
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("valid-review", metadata.id, startedAt + 1_000, "pi", "# Good", "Good.");
    database
      .prepare(
        `INSERT INTO review_versions (
          id,
          meeting_id,
          timestamp,
          source,
          markdown,
          summary
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("bad-review", metadata.id, -1, "bad-source", "# Bad", "Bad.");
    database
      .prepare(
        `INSERT INTO review_versions (
          id,
          meeting_id,
          timestamp,
          source,
          markdown,
          summary
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "oversized-summary-review",
        metadata.id,
        startedAt + 2_000,
        "pi",
        "# Oversized summary",
        "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1)
      );
    database.close();

    const snapshot = await readMeetingLog(metadata.id);

    expect(snapshot.transcript.map((line) => line.id)).toEqual(["valid-line"]);
    expect(snapshot.reviewVersions.map((version) => version.id)).toEqual([
      "valid-review"
    ]);
  });

  it("backfills legacy event counts and latest review metadata", async () => {
    const startedAt = Date.UTC(2026, 4, 9, 12, 0, 0);
    const database = new DatabaseSync(join(logDir, "roompulse.sqlite"));
    database.exec(`
      CREATE TABLE meeting_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        meeting_json TEXT NOT NULL
      );

      CREATE TABLE meeting_events (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE transcript_lines (
        id TEXT NOT NULL,
        meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
        speaker_id TEXT NOT NULL,
        speaker_label TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (meeting_id, id)
      );

      CREATE TABLE review_versions (
        id TEXT NOT NULL,
        meeting_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
        timestamp INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        PRIMARY KEY (meeting_id, id)
      );
    `);
    database
      .prepare(
        `INSERT INTO meeting_sessions (
          id,
          title,
          goal,
          started_at,
          updated_at,
          meeting_json
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "legacy-meeting",
        "Legacy review",
        "Restore old metadata",
        startedAt,
        startedAt + 2_000,
        JSON.stringify(meeting)
      );
    database
      .prepare(
        `INSERT INTO meeting_events (
          id,
          meeting_id,
          type,
          timestamp,
          payload_json
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        "event-1",
        "legacy-meeting",
        "meeting_started",
        startedAt,
        JSON.stringify({ meeting })
      );
    database
      .prepare(
        `INSERT INTO meeting_events (
          id,
          meeting_id,
          type,
          timestamp,
          payload_json
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        "event-2",
        "legacy-meeting",
        "heartbeat_output",
        startedAt + 1_000,
        JSON.stringify({ output: { reviewMarkdown: "# Newer legacy review" } })
      );
    database
      .prepare(
        `INSERT INTO review_versions (
          id,
          meeting_id,
          timestamp,
          markdown
        ) VALUES (?, ?, ?, ?)`
      )
      .run("review-old", "legacy-meeting", startedAt, "# Old legacy review");
    database
      .prepare(
        `INSERT INTO review_versions (
          id,
          meeting_id,
          timestamp,
          markdown
        ) VALUES (?, ?, ?, ?)`
      )
      .run(
        "review-new",
        "legacy-meeting",
        startedAt + 1_000,
        "# Newer legacy review"
      );
    database.close();

    const snapshot = await readMeetingLog("legacy-meeting");

    expect(snapshot.metadata.eventCount).toBe(2);
    expect(snapshot.metadata.latestReviewVersionId).toBe("review-new");
    expect(snapshot.metadata.latestReviewMarkdown).toBe("# Newer legacy review");
  });
});
