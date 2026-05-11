import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RoomPulseApp, {
  latestHeartbeatOutputFromEvents,
  latestHeartbeatTimestamp,
  mergeCurrentOutputWithHeartbeatEvents,
  mergeTimelineEntriesWithEvents,
  previousReviewVersion
} from "./RoomPulseApp";
import {
  MAX_AGENDA_ITEMS,
  MAX_EXPECTED_PARTICIPANTS,
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MAX_HEARTBEAT_INPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
} from "@/lib/facilitator";

type CapturedHeartbeatPayload = Record<string, unknown> & {
  currentReviewMarkdown?: string;
  reviewVersions?: Array<{ markdown: string }>;
  now?: number;
  lastHeartbeatAt?: number;
  observedSpeakerLabels?: string[];
};

function capturedSignal(signal: AbortSignal | null): AbortSignal | null {
  return signal;
}

function capturedHeartbeatPayload(
  payload: Record<string, unknown> | null
): CapturedHeartbeatPayload | null {
  return payload as CapturedHeartbeatPayload | null;
}

describe("RoomPulseApp", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ROOMPULSE_PI_TIMEOUT_MS;
    delete process.env.NEXT_PUBLIC_ROOMPULSE_REQUIRE_PI;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({
          state: "prompt",
          onchange: null
        })
      }
    });
  });

  async function openSetupScreen() {
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /new meeting/i })[0]);
    });
    expect(
      screen.getByRole("heading", { name: /roompulse setup/i })
    ).toBeInTheDocument();
  }

  it("walks back restored review ids without confusing timestamp ids for sequence ids", () => {
    const versions = [
      {
        id: "1700000010000-review",
        timestamp: 1_700_000_010_000,
        source: "pi" as const,
        markdown: "# Heartbeat",
        summary: "Heartbeat."
      },
      {
        id: "1700000000000-initial-review",
        timestamp: 1_700_000_000_000,
        source: "initial" as const,
        markdown: "# Initial",
        summary: "Initial."
      }
    ];

    expect(
      previousReviewVersion(
        versions,
        "1700000020000-restored-1700000010000-review",
        "# Not the fallback signal"
      )?.id
    ).toBe("1700000000000-initial-review");
    expect(
      previousReviewVersion(
        versions,
        "1700000020000-restored-1-1700000010000-review",
        "# Not the fallback signal"
      )?.id
    ).toBe("1700000000000-initial-review");
    expect(
      previousReviewVersion(
        versions,
        "1700000020000-restored-r1-1700000010000-review",
        "# Not the fallback signal"
      )?.id
    ).toBe("1700000000000-initial-review");
  });

  it("rebuilds restore timeline metadata from heartbeat events when autosave is stale", () => {
    const staleTimeline = [
      {
        id: "stale-pulse",
        timestamp: 1_700_000_001_000,
        source: "local-fallback" as const,
        cards: [],
        summary: "Older autosaved heartbeat.",
        reviewMarkdown: "# Older"
      }
    ];
    const heartbeatEvents = [
      {
        id: "meeting-started",
        type: "meeting_started",
        timestamp: 1_700_000_000_000,
        payload: {}
      },
      {
        id: "newer-heartbeat",
        type: "heartbeat_output",
        timestamp: 1_700_000_030_000,
        payload: {
          output: {
            source: "pi",
            cards: [
              {
                id: "card-1",
                kind: "participation",
                title: "Invite quiet voices",
                body: "One expected participant has not spoken.",
                priority: "medium"
              }
            ],
            summary: "Newer logged heartbeat.",
            nextHeartbeatHint: "Invite a quiet voice next.",
            reviewMarkdown: "# Newer",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: "Invite a quiet voice next."
          }
        }
      }
    ];

    expect(
      mergeTimelineEntriesWithEvents(staleTimeline, heartbeatEvents).map(
        (entry) => entry.summary
      )
    ).toEqual(["Newer logged heartbeat.", "Older autosaved heartbeat."]);
    expect(latestHeartbeatTimestamp({ events: heartbeatEvents }, 123)).toBe(
      1_700_000_030_000
    );
    expect(latestHeartbeatOutputFromEvents(heartbeatEvents)?.summary).toBe(
      "Newer logged heartbeat."
    );
  });

  it("prefers logged heartbeat timeline details over duplicate autosave entries", () => {
    const events = [
      {
        id: "event-pulse",
        type: "heartbeat_output",
        timestamp: 1_700_000_030_000,
        payload: {
          output: {
            source: "pi",
            cards: [
              {
                id: "card-1",
                kind: "risk",
                title: "Logged card",
                body: "The logged event has the complete card payload.",
                priority: "high"
              }
            ],
            summary: "Same heartbeat.",
            reviewMarkdown: "# Same",
            ephemeralReminder: "Logged reminder."
          }
        }
      }
    ];
    const stateTimeline = [
      {
        id: "state-pulse",
        timestamp: 1_700_000_030_000,
        source: "pi" as const,
        cards: [],
        summary: "Same heartbeat.",
        reviewMarkdown: "# Same",
        reminder: "Logged reminder."
      }
    ];

    expect(
      mergeTimelineEntriesWithEvents(stateTimeline, events)[0]?.cards[0]?.title
    ).toBe("Logged card");
  });

  it("caps restored heartbeat event cards before rebuilding the room timeline", () => {
    const events = [
      {
        id: "event-pulse",
        type: "heartbeat_output",
        timestamp: 1_700_000_030_000,
        payload: {
          output: {
            source: "pi",
            cards: Array.from({ length: 9 }, (_, index) => ({
              id: `card-${index + 1}`,
              kind: "heartbeat",
              title: `Card ${index + 1}`,
              body: `Cue ${index + 1}.`,
              priority: "medium"
            })),
            summary: "Large restored heartbeat.",
            reviewMarkdown: "# Restored"
          }
        }
      }
    ];

    const [entry] = mergeTimelineEntriesWithEvents([], events);

    expect(entry?.cards).toHaveLength(5);
    expect(entry?.cards.map((card) => card.title)).toEqual([
      "Card 1",
      "Card 2",
      "Card 3",
      "Card 4",
      "Card 5"
    ]);
  });

  it("keeps newer autosaved current output ahead of older heartbeat events", () => {
    const stateCurrentOutput = {
      source: "pi" as const,
      cards: [],
      summary: "Newer autosaved output.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Newer autosave",
      agendaActions: [],
      uiActions: [],
      ephemeralReminder: null
    };
    const stateTimeline = [
      {
        id: "new-state-pulse",
        timestamp: 1_700_000_030_000,
        source: "pi" as const,
        cards: [],
        summary: "Newer autosaved output.",
        reviewMarkdown: "# Newer autosave"
      }
    ];
    const olderEvents = [
      {
        id: "old-event-pulse",
        type: "heartbeat_output",
        timestamp: 1_700_000_001_000,
        payload: {
          output: {
            source: "pi",
            summary: "Older logged output.",
            reviewMarkdown: "# Older event"
          }
        }
      }
    ];

    expect(
      mergeCurrentOutputWithHeartbeatEvents(
        stateCurrentOutput,
        stateTimeline,
        olderEvents
      )?.summary
    ).toBe("Newer autosaved output.");
  });

  it("rebuilds missing current output from a newer autosaved timeline", () => {
    const stateTimeline = [
      {
        id: "new-state-pulse",
        timestamp: 1_700_000_030_000,
        source: "pi" as const,
        cards: [
          {
            id: "state-card",
            kind: "heartbeat" as const,
            title: "State card",
            body: "The autosaved timeline has the latest room-facing cue.",
            priority: "medium" as const
          }
        ],
        summary: "Newer autosaved timeline.",
        reviewMarkdown: "# Newer autosaved timeline",
        reminder: "Use the newer reminder."
      }
    ];
    const olderEvents = [
      {
        id: "old-event-pulse",
        type: "heartbeat_output",
        timestamp: 1_700_000_001_000,
        payload: {
          output: {
            source: "pi",
            cards: [
              {
                id: "event-card",
                kind: "risk",
                title: "Old event card",
                body: "This stale event should not replace the newer timeline.",
                priority: "high"
              }
            ],
            summary: "Older logged output.",
            reviewMarkdown: "# Older event",
            ephemeralReminder: "Old reminder."
          }
        }
      }
    ];

    const output = mergeCurrentOutputWithHeartbeatEvents(
      null,
      stateTimeline,
      olderEvents
    );

    expect(output?.summary).toBe("Newer autosaved timeline.");
    expect(output?.cards[0]?.title).toBe("State card");
    expect(output?.ephemeralReminder).toBe("Use the newer reminder.");
  });

  it("starts on the dashboard and can browse local meeting logs", async () => {
    const now = Date.now();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/meetings") {
        return Response.json({
          meetings: [
            {
              id: "past-1",
              title: "Past launch review",
              goal: "Review export flow.",
              startedAt: now,
              updatedAt: now,
              endedAt: now,
              status: "ended",
              isPaused: true,
              eventCount: 3,
              meeting: {},
              state: null,
              latestReviewMarkdown: "# Past launch review",
              latestReviewVersionId: "v1"
            }
          ]
        });
      }
      if (url.includes("/api/meetings/past-1")) {
        return Response.json({
          metadata: {
            id: "past-1",
            title: "Past launch review",
            goal: "Review export flow.",
            startedAt: now,
            updatedAt: now,
            endedAt: now,
            status: "ended",
            isPaused: true,
            eventCount: 3,
            meeting: {},
            state: null,
            latestReviewMarkdown: "# Past launch review",
            latestReviewVersionId: "v1"
          },
          events: [
            {
              id: "event-1",
              type: "meeting_started",
              timestamp: now,
              payload: {}
            }
          ],
          transcript: [],
          reviewVersions: []
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);

    expect(
      screen.getByRole("heading", { name: /roompulse sessions/i })
    ).toBeInTheDocument();
    expect(await screen.findByText(/past launch review/i)).toBeVisible();

    await act(async () => {
      fireEvent.click(
        screen.getAllByRole("button", { name: /past launch review/i })[0]
      );
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/meetings/past-1");
    });
    expect(await screen.findByText(/1 logged events/i)).toBeVisible();
  });

  it("moves from setup feeder to room display with mic-first transcript controls", async () => {
    render(<RoomPulseApp />);

    await openSetupScreen();

    fireEvent.change(screen.getByLabelText(/meeting title/i), {
      target: { value: "Design review" }
    });
    fireEvent.change(screen.getByLabelText(/expected participants/i), {
      target: { value: "3" }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    expect(
      await screen.findByRole("button", { name: /run heartbeat/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/live raw transcript/i)).toBeInTheDocument();
    expect(screen.getByText(/0 of 3 heard/i)).toBeInTheDocument();
    expect(screen.getByText(/live review document/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^mic$/i })).toHaveClass("active");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^demo$/i }));
    });
    fireEvent.change(screen.getByLabelText(/demo line/i), {
      target: { value: "We have not made a decision yet." }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /add line/i }));
    });

    expect(screen.getByText(/we have not made a decision yet/i)).toBeVisible();
    expect(screen.getByText(/1 of 3 heard/i)).toBeVisible();
  });

  it("disables manual heartbeat while the meeting is paused", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings" && method === "GET") {
        return Response.json({ meetings: [] });
      }
      if (url.includes("/api/review-document/init")) {
        return Response.json({
          source: "pi",
          markdown: "# Pausable meeting",
          summary: "Initialized."
        });
      }
      if (url === "/api/meetings" && method === "POST") {
        return Response.json(
          {
            id: "pausable-meeting",
            title: "Pausable meeting",
            goal: "Show paused controls.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeEnabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
    });

    expect(screen.getByRole("button", { name: /run heartbeat now/i })).toBeDisabled();
  });

  it("does not start a heartbeat from a rapid pause-then-heartbeat click", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings" && method === "GET") {
        return Response.json({ meetings: [] });
      }
      if (url.includes("/api/review-document/init")) {
        return Response.json({
          source: "pi",
          markdown: "# Pause race meeting",
          summary: "Initialized."
        });
      }
      if (url === "/api/meetings" && method === "POST") {
        return Response.json(
          {
            id: "pause-race-meeting",
            title: "Pause race meeting",
            goal: "Do not heartbeat after pausing.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      if (url === "/api/heartbeat") {
        return Response.json({
          source: "pi",
          cards: [],
          summary: "This heartbeat should not run after pause.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Pause race meeting",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    const heartbeatButton = await screen.findByRole("button", {
      name: /run heartbeat now/i
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
      fireEvent.click(heartbeatButton);
      await Promise.resolve();
    });

    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === "/api/heartbeat")
    ).toBe(false);
  });

  it("cancels an in-flight heartbeat when the meeting is paused", async () => {
    let resolveHeartbeat: ((response: Response) => void) | null = null;
    let heartbeatSignal: AbortSignal | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings" && method === "GET") {
        return Response.json({ meetings: [] });
      }
      if (url.includes("/api/review-document/init")) {
        return Response.json({
          source: "pi",
          markdown: "# Pause in-flight meeting",
          summary: "Initialized."
        });
      }
      if (url === "/api/meetings" && method === "POST") {
        return Response.json(
          {
            id: "pause-in-flight-meeting",
            title: "Pause in-flight meeting",
            goal: "Do not apply stale heartbeat output after pausing.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url === "/api/heartbeat") {
        heartbeatSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          resolveHeartbeat = resolve;
        });
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat now/i }));
    });
    await waitFor(() => expect(resolveHeartbeat).not.toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
      await Promise.resolve();
    });

    expect(capturedSignal(heartbeatSignal)?.aborted).toBe(true);

    await act(async () => {
      resolveHeartbeat?.(
        Response.json({
          source: "pi",
          cards: [
            {
              id: "paused-stale-card",
              kind: "heartbeat",
              title: "Paused stale heartbeat",
              body: "This response arrived after pause.",
              priority: "high"
            }
          ],
          summary: "Paused stale heartbeat.",
          nextHeartbeatHint: "Do not apply.",
          reviewMarkdown: "# Pause in-flight meeting\n\nPaused stale heartbeat.",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        })
      );
      await Promise.resolve();
    });

    expect(screen.queryByText(/paused stale heartbeat/i)).not.toBeInTheDocument();
  });

  it("caps pasted setup text, agenda, and participant lists before initialization", async () => {
    let initialReviewBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings" && method === "GET") {
        return Response.json({ meetings: [] });
      }
      if (url.includes("/api/review-document/init")) {
        initialReviewBody = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({
          source: "pi",
          markdown: "# Capped setup",
          summary: "Initialized."
        });
      }
      if (url === "/api/meetings" && method === "POST") {
        return Response.json(
          {
            id: "capped-session",
            title: "Capped setup",
            goal: "Keep setup bounded.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    const oversizedText = "T".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 1);
    fireEvent.change(screen.getByLabelText(/meeting title/i), {
      target: { value: oversizedText }
    });
    fireEvent.change(screen.getByLabelText(/^goal$/i), {
      target: { value: oversizedText }
    });
    fireEvent.change(screen.getByLabelText(/important context/i), {
      target: { value: oversizedText }
    });
    fireEvent.change(screen.getByLabelText(/agenda/i), {
      target: {
        value: Array.from(
          { length: 40 },
          (_, index) => `${oversizedText} ${index}`
        ).join("\n")
      }
    });
    fireEvent.change(screen.getByLabelText(/optional names and roles/i), {
      target: {
        value: Array.from(
          { length: 30 },
          (_, index) => `${oversizedText} ${index} - ${oversizedText}`
        ).join("\n")
      }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    await waitFor(() => {
      const meeting = initialReviewBody?.meeting as {
        title: string;
        goal: string;
        context: string;
        agenda: unknown[];
        participants: Array<{ name: string; role?: string }>;
      };
      expect(meeting.title).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
      expect(meeting.goal).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
      expect(meeting.context).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
      expect(meeting.agenda).toHaveLength(30);
      expect((meeting.agenda[0] as { title: string }).title).toHaveLength(
        MAX_HEARTBEAT_INPUT_TEXT_LENGTH
      );
      expect(meeting.participants).toHaveLength(24);
      expect(meeting.participants[0].name).toHaveLength(
        MAX_HEARTBEAT_INPUT_TEXT_LENGTH
      );
      expect(meeting.participants[0].role).toHaveLength(
        MAX_HEARTBEAT_INPUT_TEXT_LENGTH
      );
    });
  });

  it("caps oversized initial-review route output before rendering and logging", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings" && method === "GET") {
        return Response.json({ meetings: [] });
      }
      if (url.includes("/api/review-document/init")) {
        return Response.json({
          source: "pi",
          markdown: "R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1),
          summary: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1),
          adapterNotice: "N".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1)
        });
      }
      if (url === "/api/meetings" && method === "POST") {
        return Response.json(
          {
            id: "initial-cap-session",
            title: "Initial cap",
            goal: "Keep initialization bounded.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/events")) {
        events.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ id: `event-${events.length}` }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    await waitFor(() => {
      const reviewEvent = events.find(
        (event) => event.type === "review_initialized"
      );
      const reviewVersion = reviewEvent?.payload.reviewVersion as
        | { markdown: string; summary: string }
        | undefined;
      expect(reviewVersion?.markdown).toHaveLength(
        MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
      );
      expect(reviewVersion?.summary).toHaveLength(
        MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
      );
    });
    expect(screen.getByText(/document ready/i)).toBeVisible();
    expect(screen.queryByText("R".repeat(MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH + 1)))
      .not.toBeInTheDocument();
  });

  it("moves now discussing to the next open agenda item when the active item is completed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings" && method === "GET") {
        return Response.json({ meetings: [] });
      }
      if (url.includes("/api/review-document/init")) {
        return Response.json({
          source: "pi",
          markdown: "# Agenda advance",
          summary: "Initialized."
        });
      }
      if (url === "/api/meetings" && method === "POST") {
        return Response.json(
          {
            id: "agenda-advance-session",
            title: "Agenda advance",
            goal: "Keep the active topic accurate.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    const nowDiscussing = await screen.findByRole("region", {
      name: /now discussing/i
    });
    expect(
      within(nowDiscussing).getByRole("heading", {
        name: /confirm the meeting goal/i
      })
    ).toBeVisible();

    const agenda = screen.getByRole("region", { name: /^agenda$/i });
    fireEvent.click(
      within(agenda).getByRole("checkbox", {
        name: /confirm the meeting goal/i
      })
    );

    await waitFor(() => {
      expect(
        within(nowDiscussing).getByRole("heading", {
          name: /list open risks and blockers/i
        })
      ).toBeVisible();
    });
  });

  it("records browser fallback heartbeat pulses as review document versions", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);

    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    expect(await screen.findByText(/network down/i)).toBeVisible();
    expect((await screen.findAllByText(/heartbeat check/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/2 versions/i)).toBeVisible();
  });

  it("keeps browser fallback review output bounded without leaking heartbeat markers", async () => {
    const middleMarker = "UNIQUE_VISIBLE_REVIEW_MIDDLE";
    const hugeReview = [
      "# Full visible review",
      "Opening visible review state.",
      ...Array.from({ length: 700 }, (_, index) =>
        index === 350 ? middleMarker : `Visible review detail ${index}`
      ),
      "Closing visible review state."
    ].join("\n");
    let heartbeatEvent: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: hugeReview,
            summary: "Initialized a large visible review."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-browser-fallback-review",
              title: "Browser fallback review",
              goal: "Keep local visible markdown intact.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url === "/api/heartbeat") {
          throw new Error("network down");
        }
        if (url.includes("/events")) {
          const event = JSON.parse(String(init?.body ?? "{}"));
          if (event.type === "heartbeat_output") {
            heartbeatEvent = event;
          }
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        if (url.includes("/api/meetings/meeting-browser-fallback-review")) {
          return Response.json({ id: "meeting-browser-fallback-review" });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    expect(await screen.findByText(/network down/i)).toBeVisible();
    await waitFor(() => {
      expect(heartbeatEvent).toBeDefined();
    });
    const output = (heartbeatEvent?.payload as { output: { reviewMarkdown: string } })
      .output;
    expect(output.reviewMarkdown.length).toBeLessThanOrEqual(
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    );
    expect(output.reviewMarkdown).not.toContain(middleMarker);
    expect(output.reviewMarkdown).not.toContain(
      "RoomPulse omitted middle review content"
    );
  });

  it("deduplicates rapid start-meeting clicks before initial review resolves", async () => {
    let initRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/meetings") {
        return Response.json({ meetings: [] });
      }
      if (url.includes("/api/review-document/init")) {
        initRequests += 1;
        return new Promise<Response>(() => {
          // Keep initialization in flight so both rapid clicks exercise the guard.
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    const startButton = screen.getByRole("button", { name: /start meeting/i });

    await act(async () => {
      fireEvent.click(startButton);
      fireEvent.click(startButton);
      await Promise.resolve();
    });

    expect(initRequests).toBe(1);
  });

  it("deduplicates rapid live-demo launch clicks before initial review resolves", async () => {
    let initRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/meetings") {
        return Response.json({ meetings: [] });
      }
      if (url.includes("/api/review-document/init")) {
        initRequests += 1;
        return new Promise<Response>(() => {
          // Keep initialization in flight so both rapid clicks exercise the guard.
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    const launchButton = await screen.findByRole("button", {
      name: /launch live demo/i
    });

    await act(async () => {
      fireEvent.click(launchButton);
      fireEvent.click(launchButton);
      await Promise.resolve();
    });

    expect(initRequests).toBe(1);
  });

  it("rebuilds server local-fallback heartbeat output from bounded visible review", async () => {
    const middleMarker = "SERVER_FALLBACK_VISIBLE_REVIEW_MIDDLE";
    const hugeReview = [
      "# Server fallback review",
      "Opening server fallback review state.",
      ...Array.from({ length: 700 }, (_, index) =>
        index === 350 ? middleMarker : `Server fallback detail ${index}`
      ),
      "Closing server fallback review state."
    ].join("\n");
    let heartbeatEvent: Record<string, unknown> | undefined;
    let sentHeartbeatReview = "";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: hugeReview,
            summary: "Initialized a large review."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-server-fallback-review",
              title: "Server fallback review",
              goal: "Keep server fallback visible markdown intact.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url === "/api/heartbeat") {
          const payload = JSON.parse(String(init?.body ?? "{}"));
          sentHeartbeatReview = payload.currentReviewMarkdown;
          return Response.json({
            source: "local-fallback",
            cards: [
              {
                id: "server-fallback-card",
                kind: "heartbeat",
                title: "Server fallback",
                body: "Server fallback used compact markdown.",
                priority: "medium"
              }
            ],
            summary: "Server fallback ran.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: `${payload.currentReviewMarkdown}\n\n### Server fallback`,
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null,
            adapterNotice: "Pi adapter fell back locally: auth missing"
          });
        }
        if (url.includes("/events")) {
          const event = JSON.parse(String(init?.body ?? "{}"));
          if (event.type === "heartbeat_output") {
            heartbeatEvent = event;
          }
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        if (url.includes("/api/meetings/meeting-server-fallback-review")) {
          return Response.json({ id: "meeting-server-fallback-review" });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    await waitFor(() => {
      expect(heartbeatEvent).toBeDefined();
    });
    expect(sentHeartbeatReview).toContain("RoomPulse omitted middle review content");
    const output = (heartbeatEvent?.payload as { output: { reviewMarkdown: string; adapterNotice?: string } })
      .output;
    expect(output.reviewMarkdown.length).toBeLessThanOrEqual(
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    );
    expect(output.reviewMarkdown).not.toContain(middleMarker);
    expect(output.reviewMarkdown).not.toContain(
      "RoomPulse omitted middle review content"
    );
    expect(output.adapterNotice).toContain("auth missing");
  });

  it("blocks local initial-review fallback when the server requires Pi", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json(
            { error: "Codex auth missing", piRequired: true },
            { status: 500 }
          );
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /codex auth missing/i
    );
    expect(screen.queryByRole("button", { name: /run heartbeat/i }))
      .not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === "/api/meetings" && init?.method === "POST"
      )
    ).toBe(false);
  });

  it("normalizes AbortError-shaped initial-review failures as Pi timeouts", async () => {
    process.env.NEXT_PUBLIC_ROOMPULSE_REQUIRE_PI = "1";
    process.env.NEXT_PUBLIC_ROOMPULSE_PI_TIMEOUT_MS = "1000";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          throw Object.assign(new Error("The operation was aborted."), {
            name: "AbortError"
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json({ id: "should-not-create" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /pi initial review timed out after 1000ms/i
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === "/api/meetings" && init?.method === "POST"
      )
    ).toBe(false);
  });

  it("blocks a successful local initial-review fallback in client strict mode", async () => {
    process.env.NEXT_PUBLIC_ROOMPULSE_REQUIRE_PI = "1";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "local-fallback",
            markdown: "# Local fallback",
            summary: "Local fallback initialized the review.",
            adapterNotice: "Codex auth missing"
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json({ id: "should-not-create" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /pi initial review required/i
    );
    expect(screen.queryByRole("button", { name: /run heartbeat/i }))
      .not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === "/api/meetings" && init?.method === "POST"
      )
    ).toBe(false);
  });

  it("blocks a successful local heartbeat fallback in client strict mode", async () => {
    process.env.NEXT_PUBLIC_ROOMPULSE_REQUIRE_PI = "1";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Strict review",
            summary: "Initialized through Pi."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-strict-heartbeat",
              title: "Strict heartbeat",
              goal: "Do not accept heartbeat fallback.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "local-fallback",
            cards: [
              {
                id: "fallback-card",
                kind: "heartbeat",
                title: "Local fallback",
                body: "This fallback must not render in strict mode.",
                priority: "medium"
              }
            ],
            summary: "Local fallback heartbeat.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Local heartbeat fallback",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null,
            adapterNotice: "Pi auth missing"
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    expect(await screen.findByText(/pi heartbeat required/i)).toBeVisible();
    expect(screen.queryByText(/this fallback must not render/i))
      .not.toBeInTheDocument();
  });

  it("normalizes AbortError-shaped heartbeat failures as Pi timeouts", async () => {
    process.env.NEXT_PUBLIC_ROOMPULSE_REQUIRE_PI = "1";
    process.env.NEXT_PUBLIC_ROOMPULSE_PI_TIMEOUT_MS = "1000";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Strict review",
            summary: "Initialized through Pi."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-strict-heartbeat-timeout",
              title: "Strict heartbeat timeout",
              goal: "Show useful timeout errors.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          throw Object.assign(new Error("The operation was aborted."), {
            name: "AbortError"
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    expect(await screen.findByText(/pi heartbeat timed out after 1000ms/i))
      .toBeVisible();
  });

  it("caps oversized heartbeat route errors before showing them in the room", async () => {
    const oversizedError = "E".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings" && method === "GET") {
        return Response.json({ meetings: [] });
      }
      if (url.includes("/api/review-document/init")) {
        return Response.json({
          source: "pi",
          markdown: "# Heartbeat route error cap",
          summary: "Initialized."
        });
      }
      if (url === "/api/meetings" && method === "POST") {
        return Response.json(
          {
            id: "heartbeat-error-cap-session",
            title: "Heartbeat route error cap",
            goal: "Keep route errors bounded.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url === "/api/heartbeat") {
        return Response.json(
          { error: oversizedError, piRequired: true },
          { status: 500 }
        );
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByText("E".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH))
      ).toBeVisible();
    });
    expect(screen.queryByText(oversizedError)).not.toBeInTheDocument();
  });

  it("versions the markdown produced by an update_review_document tool", async () => {
    const toolMarkdown = "# Tool markdown\n\nUpdated through the UI tool.";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-tool-review",
              title: "Tool review",
              goal: "Validate tool markdown versioning.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "pi",
            cards: [
              {
                id: "tool-card",
                kind: "heartbeat",
                title: "Tool update",
                body: "Updated markdown through a UI tool.",
                priority: "medium"
              }
            ],
            summary: "Tool markdown applied.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Stale markdown",
            agendaActions: [],
            uiActions: [
              {
                tool: "update_review_document",
                parameters: { markdown: toolMarkdown },
                reason: "Agent edited the document through the UI tool."
              },
              {
                tool: "send_room_reminder",
                parameters: {
                  message: "Invite the quiet speaker before moving on."
                },
                reason: "The agent raised a one-round room reminder."
              }
            ],
            ephemeralReminder: null
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        if (url.includes("/api/meetings/meeting-tool-review")) {
          return Response.json({ id: "meeting-tool-review" });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);

    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    expect(await screen.findByText(/updated through the ui tool/i)).toBeVisible();
    expect(screen.queryByText(/stale markdown/i)).not.toBeInTheDocument();
    await waitFor(() => {
      const heartbeatEvent = fetchMock.mock.calls
        .filter(([url]) => String(url).includes("/events"))
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")))
        .find((event) => event.type === "heartbeat_output");
      expect(heartbeatEvent?.payload.output.reviewMarkdown).toBe(toolMarkdown);
      expect(heartbeatEvent?.payload.output.ephemeralReminder).toBe(
        "Invite the quiet speaker before moving on."
      );
    });
  });

  it("normalizes heartbeat responses that omit optional action arrays", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-minimal-heartbeat",
              title: "Minimal heartbeat",
              goal: "Handle route response shape drift.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "pi",
            cards: [
              {
                id: "minimal-card",
                kind: "heartbeat",
                title: "Minimal heartbeat",
                body: "The route returned the core heartbeat fields only.",
                priority: "medium"
              }
            ],
            summary: "Minimal heartbeat applied.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Minimal heartbeat\n\nApplied."
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    expect(await screen.findByText(/the route returned the core heartbeat fields only/i))
      .toBeVisible();
    await waitFor(() => {
      const heartbeatEvent = fetchMock.mock.calls
        .filter(([url]) => String(url).includes("/events"))
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")))
        .find((event) => event.type === "heartbeat_output");
      expect(heartbeatEvent?.payload.output.source).toBe("pi");
      expect(heartbeatEvent?.payload.output.agendaActions).toEqual([]);
      expect(heartbeatEvent?.payload.output.uiActions).toEqual([]);
      expect(heartbeatEvent?.payload.output.reviewMarkdown).toContain(
        "Minimal heartbeat"
      );
    });
  });

  it("caps oversized heartbeat response card lists before rendering and logging", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-card-cap",
              title: "Card cap",
              goal: "Keep room display bounded.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "pi",
            cards: Array.from({ length: 12 }, (_, index) => ({
              id: `card-${index + 1}`,
              kind: "heartbeat",
              title: `Card ${index + 1}`,
              body: `Cue ${index + 1}.`,
              priority: "medium"
            })),
            summary: "Too many cards.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Card cap\n\nApplied.",
            agendaActions: [],
            uiActions: []
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    expect(await screen.findByText("Card 5")).toBeVisible();
    expect(screen.queryByText("Card 6")).not.toBeInTheDocument();
    await waitFor(() => {
      const heartbeatEvent = fetchMock.mock.calls
        .filter(([url]) => String(url).includes("/events"))
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")))
        .find((event) => event.type === "heartbeat_output");
      expect(heartbeatEvent?.payload.output.cards).toHaveLength(5);
    });
  });

  it("caps oversized heartbeat response action lists before applying and logging", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-action-cap",
              title: "Action cap",
              goal: "Keep heartbeat mutations bounded.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "pi",
            cards: [
              {
                id: "action-cap-card",
                kind: "heartbeat",
                title: "Action cap",
                body: "The route returned too many mutation requests.",
                priority: "medium"
              }
            ],
            summary: "Too many actions.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Action cap\n\nApplied.",
            agendaActions: Array.from(
              { length: MAX_AGENDA_ITEMS + 5 },
              (_, index) => ({
                itemId: `agenda-${index + 1}`,
                done: true,
                reason: `Agenda reason ${index + 1}.`
              })
            ),
            uiActions: Array.from({ length: 12 }, (_, index) => ({
              tool: "send_room_reminder",
              parameters: { message: `Reminder ${index + 1}` },
              reason: `Reminder reason ${index + 1}.`
            }))
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    expect(await screen.findByText("Reminder 8")).toBeVisible();
    expect(screen.queryByText("Reminder 9")).not.toBeInTheDocument();
    await waitFor(() => {
      const heartbeatEvent = fetchMock.mock.calls
        .filter(([url]) => String(url).includes("/events"))
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")))
        .find((event) => event.type === "heartbeat_output");
      expect(heartbeatEvent?.payload.output.agendaActions).toHaveLength(
        MAX_AGENDA_ITEMS
      );
      expect(heartbeatEvent?.payload.output.uiActions).toHaveLength(8);
      expect(heartbeatEvent?.payload.output.ephemeralReminder).toBe("Reminder 8");
    });
  });

  it("preserves late review and agenda updates before capping route actions", async () => {
    const lateToolMarkdown = "# Late tool markdown\n\nThis update must survive.";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-late-action-cap",
              title: "Late action cap",
              goal: "Preserve late review and agenda actions.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "pi",
            cards: [
              {
                id: "late-action-card",
                kind: "heartbeat",
                title: "Late actions",
                body: "The route returned important late actions.",
                priority: "medium"
              }
            ],
            summary: "Late actions returned.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Stale route markdown",
            agendaActions: [
              {
                itemId: "agenda-1",
                done: true,
                reason: "Early stale agenda state."
              },
              ...Array.from({ length: MAX_AGENDA_ITEMS }, (_, index) => ({
                itemId: `overflow-${index + 1}`,
                done: true,
                reason: `Overflow agenda action ${index + 1}.`
              })),
              {
                itemId: "agenda-1",
                done: false,
                reason: "Late agenda state should win."
              }
            ],
            uiActions: [
              ...Array.from({ length: 10 }, (_, index) => ({
                tool: "send_room_reminder",
                parameters: { message: `Reminder ${index + 1}` },
                reason: `Reminder action ${index + 1}.`
              })),
              {
                tool: "update_review_document",
                parameters: { markdown: lateToolMarkdown },
                reason: "Late review document should win."
              }
            ],
            ephemeralReminder: null
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    const agendaCheckbox = screen.getByLabelText(
      /confirm the meeting goal/i
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    expect(await screen.findByText(/this update must survive/i)).toBeVisible();
    expect(screen.queryByText(/stale route markdown/i)).not.toBeInTheDocument();
    expect(agendaCheckbox.checked).toBe(false);
    await waitFor(() => {
      const heartbeatEvent = fetchMock.mock.calls
        .filter(([url]) => String(url).includes("/events"))
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")))
        .find((event) => event.type === "heartbeat_output");
      expect(heartbeatEvent?.payload.output.reviewMarkdown).toBe(lateToolMarkdown);
      expect(
        heartbeatEvent?.payload.output.agendaActions.find(
          (action: { itemId: string }) => action.itemId === "agenda-1"
        )?.done
      ).toBe(false);
      expect(heartbeatEvent?.payload.output.agendaActions).toHaveLength(
        MAX_AGENDA_ITEMS
      );
      expect(heartbeatEvent?.payload.output.uiActions).toHaveLength(8);
      expect(
        heartbeatEvent?.payload.output.uiActions.some(
          (action: { tool: string }) => action.tool === "update_review_document"
        )
      ).toBe(true);
    });
  });

  it("caps oversized heartbeat response text before rendering and logging", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-text-cap",
              title: "Text cap",
              goal: "Keep room-facing text bounded.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "pi",
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
            reviewMarkdown: "# Text cap\n\nApplied.",
            agendaActions: [
              {
                itemId: "agenda-1",
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
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    await waitFor(() => {
      const heartbeatEvent = fetchMock.mock.calls
        .filter(([url]) => String(url).includes("/events"))
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")))
        .find((event) => event.type === "heartbeat_output");
      expect(heartbeatEvent?.payload.output.cards[0].title).toHaveLength(280);
      expect(heartbeatEvent?.payload.output.cards[0].body).toHaveLength(280);
      expect(heartbeatEvent?.payload.output.summary).toHaveLength(500);
      expect(heartbeatEvent?.payload.output.nextHeartbeatHint).toHaveLength(500);
      expect(heartbeatEvent?.payload.output.agendaActions[0].reason).toHaveLength(
        500
      );
      expect(heartbeatEvent?.payload.output.uiActions[0].reason).toHaveLength(500);
      expect(
        heartbeatEvent?.payload.output.uiActions[0].parameters.message
      ).toHaveLength(500);
      expect(heartbeatEvent?.payload.output.ephemeralReminder).toHaveLength(500);
      expect(heartbeatEvent?.payload.output.adapterNotice).toHaveLength(500);
    });
  });

  it("sends a compact current review document in heartbeat requests", async () => {
    let heartbeatPayload: Record<string, unknown> | null = null;
    const hugeReview = [
      "# Huge review",
      "",
      "Opening context that should stay visible.",
      "Middle detail.\n".repeat(900),
      "Final decisions that should stay visible."
    ].join("\n");
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: hugeReview,
            summary: "Initialized huge review."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-review-cap",
              title: "Review cap",
              goal: "Keep heartbeat requests bounded.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url === "/api/heartbeat") {
          heartbeatPayload = JSON.parse(String(init?.body ?? "{}"));
          return Response.json({
            source: "pi",
            cards: [
              {
                id: "review-cap-card",
                kind: "heartbeat",
                title: "Reviewed compact document",
                body: "The current review document was compact.",
                priority: "medium"
              }
            ],
            summary: "Reviewed compact document.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Review cap\n\nApplied.",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    await waitFor(() => {
      expect(
        typeof capturedHeartbeatPayload(heartbeatPayload)?.currentReviewMarkdown
      ).toBe("string");
    });
    const sentPayload = capturedHeartbeatPayload(heartbeatPayload);
    const sentReview = sentPayload?.currentReviewMarkdown as string;
    expect(sentReview.length).toBeLessThanOrEqual(4_000);
    expect(sentReview).toContain("Opening context that should stay visible.");
    expect(sentReview).toContain("Final decisions that should stay visible.");
    expect(sentReview).toContain("RoomPulse omitted middle review content");
    const sentVersions = sentPayload?.reviewVersions as Array<{
      markdown: string;
    }>;
    expect(sentVersions[0]?.markdown.length).toBeLessThanOrEqual(4_000);
    expect(sentVersions[0]?.markdown).toContain(
      "RoomPulse omitted middle review content"
    );
  });

  it("creates unique review version ids for rapid heartbeat pulses in the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    let heartbeatCount = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-rapid-heartbeats",
              title: "Rapid heartbeats",
              goal: "Persist every heartbeat review.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          heartbeatCount += 1;
          return Response.json({
            source: "pi",
            cards: [
              {
                id: `heartbeat-card-${heartbeatCount}`,
                kind: "heartbeat",
                title: `Heartbeat ${heartbeatCount}`,
                body: "Review updated.",
                priority: "medium"
              }
            ],
            summary: `Heartbeat ${heartbeatCount}.`,
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: `# Heartbeat ${heartbeatCount}`,
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run heartbeat/i }));
    });

    await waitFor(() => {
      const reviewIds = fetchMock.mock.calls
        .filter(([url]) => String(url).includes("/events"))
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")))
        .filter((event) => event.type === "heartbeat_output")
        .map((event) => event.payload.reviewVersionId);
      expect(reviewIds).toHaveLength(2);
      expect(new Set(reviewIds).size).toBe(2);
    });
    expect(screen.getByText(/3 versions/i)).toBeVisible();
  });

  it("creates unique ids for multiple agenda items added in one heartbeat", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-agenda-add",
              title: "Agenda add review",
              goal: "Validate agenda tool actions.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "pi",
            cards: [],
            summary: "Agenda items added.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Agenda add review",
            agendaActions: [],
            uiActions: [
              {
                tool: "add_agenda_item",
                parameters: { title: "Confirm rollout owner" },
                reason: "Room created a new owner follow-up."
              },
              {
                tool: "add_agenda_item",
                parameters: { title: "Confirm support coverage" },
                reason: "Room created a new support follow-up."
              }
            ],
            ephemeralReminder: null
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    expect(await screen.findByText(/confirm rollout owner/i)).toBeVisible();
    expect(screen.getByText(/confirm support coverage/i)).toBeVisible();
    await waitFor(() => {
      const addedItems = fetchMock.mock.calls
        .filter(([url]) => String(url).includes("/events"))
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")))
        .filter((event) => event.type === "agenda_item_added")
        .map((event) => event.payload.item.id);
      expect(new Set(addedItems).size).toBe(2);
    });
  });

  it("keeps the active agenda on a current item after an agent deletes the active item", async () => {
    let now = 1_700_000_020_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-agenda-delete",
              title: "Agenda delete review",
              goal: "Validate agenda deletion.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "pi",
            cards: [],
            summary: "Agenda item replaced.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Agenda delete review",
            agendaActions: [],
            uiActions: [
              {
                tool: "add_agenda_item",
                parameters: { title: "New follow-up item" },
                reason: "The room replaced the original agenda item."
              },
              {
                tool: "delete_agenda_item",
                parameters: { itemId: "agenda-1" },
                reason: "The room dropped the original agenda item."
              }
            ],
            ephemeralReminder: null
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    fireEvent.change(screen.getByLabelText(/agenda/i), {
      target: { value: "Original item" }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    const nowDiscussing = await screen.findByLabelText("Now discussing");
    expect(
      within(nowDiscussing).getByRole("heading", { name: /new follow-up item/i })
    ).toBeVisible();
    expect(screen.queryByText(/^Original item$/i)).not.toBeInTheDocument();
  });

  it("does not log agenda updates for unknown agent agenda ids", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-unknown-agenda-action",
              title: "Unknown agenda action",
              goal: "Ignore invalid agent agenda ids.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "pi",
            cards: [],
            summary: "Invalid agenda action ignored.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Unknown agenda action",
            agendaActions: [],
            uiActions: [
              {
                tool: "set_agenda_item",
                parameters: { itemId: "missing-agenda-id", done: true },
                reason: "The agent guessed an agenda id."
              }
            ],
            ephemeralReminder: null
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    await waitFor(() => {
      const events = fetchMock.mock.calls
        .filter(([url]) => String(url).includes("/events"))
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")));
      expect(events.some((event) => event.type === "heartbeat_output")).toBe(true);
      expect(events.some((event) => event.type === "agenda_manual_update")).toBe(
        false
      );
    });
  });

  it("creates unique ids when restoring the same review version repeatedly", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_010_000);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Initial review",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "meeting-review-restore",
              title: "Review restore",
              goal: "Validate review version ids.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return Response.json({
            source: "pi",
            cards: [],
            summary: "Heartbeat review.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Heartbeat review",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });

    const initialVersionId = "1700000010000-initial-review";
    const versionSelect = screen.getByLabelText(/review versions/i);
    await act(async () => {
      fireEvent.change(versionSelect, { target: { value: initialVersionId } });
    });
    await act(async () => {
      fireEvent.change(versionSelect, { target: { value: initialVersionId } });
    });

    await waitFor(() => {
      const restoredIds = fetchMock.mock.calls
        .filter(([url]) => String(url).includes("/events"))
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")))
        .filter((event) => event.type === "review_restored")
        .map((event) => event.payload.restoredVersion.id);
      expect(restoredIds).toHaveLength(2);
      expect(new Set(restoredIds).size).toBe(2);
    });
  });

  it("launches the live demo from the setup screen", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/review-document/init")) {
        return Response.json({
          source: "pi",
          markdown: "# Launch readiness review\n\n## Agenda\n- [ ] Confirm the meeting goal",
          summary: "Initialized demo review."
        });
      }
      if (url === "/api/meetings") {
        return Response.json(
          {
            id: "demo-session",
            title: "Launch readiness review",
            goal: "Leave with owners for every open launch risk.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);

    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /launch live demo/i }));
    });

    expect(
      await screen.findByRole("button", { name: /run heartbeat/i })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getAllByRole("heading", { name: /launch readiness review/i })
          .length
      ).toBeGreaterThan(0);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/review-document/init",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("caps live-demo initial-review fallback adapter notices", async () => {
    const oversizedNotice = "N".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/review-document/init")) {
        throw new Error(oversizedNotice);
      }
      if (url === "/api/meetings") {
        return Response.json(
          {
            id: "demo-fallback-session",
            title: "Demo fallback",
            goal: "Keep fallback notices bounded.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);

    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /launch live demo/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByText("N".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH))
      ).toBeVisible();
    });
    expect(screen.queryByText(oversizedNotice)).not.toBeInTheDocument();
  });

  it("enters the live demo immediately while strict Pi initialization is pending", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/review-document/init")) {
        return new Promise<Response>(() => undefined);
      }
      if (url === "/api/meetings") {
        return Response.json(
          {
            id: "demo-session",
            title: "RoomPulse MVP readiness review",
            goal: "Strict init is pending.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);

    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /launch live demo/i }));
    });

    expect(
      await screen.findByRole("button", { name: /run heartbeat/i })
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", {
        name: /roompulse mvp readiness review/i
      }).length
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/strict pi initialization/i).length).toBeGreaterThan(
      0
    );
  });

  it("does not let late live demo initialization overwrite a heartbeat review", async () => {
    let resolveInit: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/meetings") {
        return Response.json(
          {
            id: "demo-session",
            title: "RoomPulse MVP readiness review",
            goal: "Strict init can finish late.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/api/review-document/init")) {
        return new Promise<Response>((resolve) => {
          resolveInit = resolve;
        });
      }
      if (url.includes("/api/heartbeat")) {
        return Response.json({
          source: "pi",
          cards: [
            {
              id: "heartbeat-card",
              kind: "heartbeat",
              title: "Heartbeat applied",
              body: "The heartbeat review is newer than initialization.",
              priority: "medium"
            }
          ],
          summary: "Heartbeat review.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Heartbeat review\n\nNewer content.",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        });
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({ meetings: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);

    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /launch live demo/i }));
    });
    await waitFor(() => expect(resolveInit).not.toBeNull());
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });
    expect(
      await screen.findByRole("heading", { name: /heartbeat review/i })
    ).toBeVisible();

    await act(async () => {
      resolveInit?.(
        Response.json({
          source: "pi",
          markdown: "# Late initial review\n\nOlder content.",
          summary: "Late initialization."
        })
      );
      await Promise.resolve();
    });

    expect(
      screen.getByRole("heading", { name: /heartbeat review/i })
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: /late initial review/i })
    ).not.toBeInTheDocument();
  });

  it("ignores late live demo initialization errors after heartbeat success", async () => {
    let rejectInit: ((error: Error) => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/meetings") {
        return Response.json(
          {
            id: "demo-session",
            title: "RoomPulse MVP readiness review",
            goal: "Strict init can fail late.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/api/review-document/init")) {
        return new Promise<Response>((_resolve, reject) => {
          rejectInit = reject;
        });
      }
      if (url.includes("/api/heartbeat")) {
        return Response.json({
          source: "pi",
          cards: [
            {
              id: "heartbeat-card",
              kind: "heartbeat",
              title: "Heartbeat applied",
              body: "The heartbeat review is current.",
              priority: "medium"
            }
          ],
          summary: "Heartbeat review.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Heartbeat review\n\nCurrent content.",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        });
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({ meetings: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);

    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /launch live demo/i }));
    });
    await waitFor(() => expect(rejectInit).not.toBeNull());
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });
    expect(
      await screen.findByRole("heading", { name: /heartbeat review/i })
    ).toBeVisible();

    await act(async () => {
      rejectInit?.(new Error("late init failed"));
      await Promise.resolve();
    });

    expect(screen.queryByText(/late init failed/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /heartbeat review/i })
    ).toBeVisible();
  });

  it("keeps scripted transcript running while heartbeat review is pending", async () => {
    vi.useFakeTimers();
    process.env.NEXT_PUBLIC_ROOMPULSE_PI_TIMEOUT_MS = "60000";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url.includes("/api/review-document/init") ||
        url.includes("/api/heartbeat")
      ) {
        return new Promise<Response>(() => undefined);
      }
      if (url === "/api/meetings") {
        return Response.json(
          {
            id: "demo-session",
            title: "RoomPulse MVP readiness review",
            goal: "Strict review is pending.",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 0,
            meeting: {},
            state: null,
            latestReviewMarkdown: "",
            latestReviewVersionId: null
          },
          { status: 201 }
        );
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);

    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /launch live demo/i }));
    });
    expect(screen.getByRole("button", { name: /run heartbeat/i })).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run heartbeat/i }));
    });
    expect(
      screen.getByRole("button", { name: /run heartbeat now/i })
    ).toBeDisabled();
    expect(
      screen.getByText(/heartbeat review is running; transcript capture continues live/i)
    ).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(8_100);
      await Promise.resolve();
    });

    expect(
      screen.getByText(/let's start the roompulse readiness review/i)
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /run heartbeat now/i })
    ).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(23_000);
      await Promise.resolve();
    });

    expect(
      screen.getByText(/center document needs to look like a real markdown artifact/i)
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /run heartbeat now/i })
    ).toBeDisabled();
  });

  it("uses the latest runtime heartbeat interval after a pending review finishes", async () => {
    let resolveHeartbeat:
      | ((response: Response) => void)
      | undefined;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Runtime interval",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "runtime-interval-session",
              title: "Runtime interval",
              goal: "Use latest interval.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          return new Promise<Response>((resolve) => {
            resolveHeartbeat = resolve;
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /run heartbeat/i }));
    });
    fireEvent.click(screen.getByRole("button", { name: /meeting settings/i }));
    fireEvent.change(screen.getByLabelText(/heartbeat interval/i), {
      target: { value: "60" }
    });

    await act(async () => {
      resolveHeartbeat?.(
        Response.json({
          source: "pi",
          cards: [
            {
              id: "heartbeat-card",
              kind: "heartbeat",
              title: "Interval applied",
              body: "The next heartbeat should use the newest interval.",
              priority: "medium"
            }
          ],
          summary: "Heartbeat complete.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Runtime interval\n\nUpdated.",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        })
      );
      await Promise.resolve();
    });

    const countdownValue = within(
      screen.getByLabelText(/heartbeat countdown/i)
    ).getByText((content, element) => {
      return (
        element?.tagName.toLowerCase() === "strong" &&
        Number(content) >= 55
      );
    });
    expect(countdownValue).toBeVisible();
  });

  it("runs an overdue heartbeat when the browser tab becomes active again", async () => {
    let now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let heartbeatPayload: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Visibility heartbeat",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "visibility-session",
              title: "Visibility heartbeat",
              goal: "Catch up after background throttling.",
              startedAt: now,
              updatedAt: now,
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url === "/api/heartbeat") {
          heartbeatPayload = JSON.parse(String(init?.body ?? "{}"));
          return Response.json({
            source: "pi",
            cards: [
              {
                id: "visibility-card",
                kind: "heartbeat",
                title: "Caught up",
                body: "Heartbeat ran when the tab became active.",
                priority: "medium"
              }
            ],
            summary: "Visibility heartbeat ran.",
            nextHeartbeatHint: "Continue.",
            reviewMarkdown: "# Visibility heartbeat\n\nCaught up.",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: null
          });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByRole("button", { name: /run heartbeat now/i })
    ).toBeVisible();
    expect(heartbeatPayload).toBeNull();

    now += 46_000;
    vi.setSystemTime(now);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(capturedHeartbeatPayload(heartbeatPayload)?.now).toBe(now);
  });

  it("checkpoints the current session before opening another saved meeting", async () => {
    const now = Date.now();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({
            meetings: [
              {
                id: "other-session",
                title: "Other active session",
                goal: "Resume safely.",
                startedAt: now - 60_000,
                updatedAt: now,
                endedAt: null,
                status: "paused",
                isPaused: true,
                eventCount: 2,
                meeting: {},
                state: null,
                latestReviewMarkdown: "# Other",
                latestReviewVersionId: "other-review"
              }
            ]
          });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Current session",
            summary: "Initialized current session."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "current-session",
              title: "Current session",
              goal: "Checkpoint before leaving.",
              startedAt: now,
              updatedAt: now,
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url === "/api/meetings/current-session" && method === "PATCH") {
          return Response.json({ id: "current-session" });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        if (url === "/api/meetings/other-session") {
          return Response.json({
            metadata: {
              id: "other-session",
              title: "Other active session",
              goal: "Resume safely.",
              startedAt: now - 60_000,
              updatedAt: now,
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 3,
              meeting: {
                title: "Other active session",
                goal: "Resume safely.",
                context: "",
                agenda: [{ id: "a1", title: "Open", done: false }],
                expectedParticipants: 1,
                participants: [],
                heartbeatIntervalSeconds: 30
              },
              state: null,
              latestReviewMarkdown: "# Other",
              latestReviewVersionId: "other-review"
            },
            events: [],
            transcript: [],
            reviewVersions: [
              {
                id: "other-review",
                timestamp: now,
                source: "pi",
                markdown: "# Other",
                summary: "Other review."
              }
            ]
          });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /past meetings/i }));
    });
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: /other active session/i })
      );
    });

    await waitFor(() => {
      const checkpointCallIndex = fetchMock.mock.calls.findIndex(
        ([url, init]) =>
          String(url) === "/api/meetings/current-session" &&
          init?.method === "PATCH"
      );
      const openCallIndex = fetchMock.mock.calls.findIndex(
        ([url]) => String(url) === "/api/meetings/other-session"
      );
      expect(checkpointCallIndex).toBeGreaterThan(-1);
      expect(openCallIndex).toBeGreaterThan(checkpointCallIndex);
    });
    expect(
      await screen.findByRole("heading", { name: /other active session/i })
    ).toBeVisible();
  });

  it("does not leave the active meeting when checkpointing fails", async () => {
    const now = Date.now();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({
            meetings: [
              {
                id: "other-session",
                title: "Other active session",
                goal: "Resume safely.",
                startedAt: now - 60_000,
                updatedAt: now,
                endedAt: null,
                status: "paused",
                isPaused: true,
                eventCount: 2,
                meeting: {},
                state: null,
                latestReviewMarkdown: "# Other",
                latestReviewVersionId: "other-review"
              }
            ]
          });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Current session",
            summary: "Initialized current session."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "current-session",
              title: "Current session",
              goal: "Checkpoint before leaving.",
              startedAt: now,
              updatedAt: now,
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url === "/api/meetings/current-session" && method === "PATCH") {
          return Response.json({ error: "disk full" }, { status: 500 });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        if (url === "/api/meetings/other-session") {
          return Response.json({});
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /past meetings/i }));
    });
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: /other active session/i })
      );
    });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/meetings/current-session" &&
            init?.method === "PATCH"
        )
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === "/api/meetings/other-session"
      )
    ).toBe(false);
    expect(
      screen.getByRole("heading", { name: /product readiness review/i })
    ).toBeVisible();
  });

  it("does not start a new meeting when the current meeting log is unavailable", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Current session",
            summary: "Initialized current session."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json({ error: "disk unavailable" }, { status: 500 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByRole("heading", { name: /product readiness review/i })
    ).toBeVisible();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /past meetings/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^new meeting$/i }));
      await vi.advanceTimersByTimeAsync(2_600);
    });

    expect(
      screen.getByRole("heading", { name: /product readiness review/i })
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /start meeting/i })
    ).not.toBeInTheDocument();
  });

  it("keeps an in-flight heartbeat when new meeting checkpointing fails", async () => {
    let resolveHeartbeat: ((response: Response) => void) | null = null;
    let heartbeatSignal: AbortSignal | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Current session",
            summary: "Initialized current session."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "current-session",
              title: "Current session",
              goal: "Checkpoint before leaving.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/api/heartbeat")) {
          heartbeatSignal = init?.signal as AbortSignal;
          return new Promise<Response>((resolve) => {
            resolveHeartbeat = resolve;
          });
        }
        if (url === "/api/meetings/current-session" && method === "PATCH") {
          return Response.json({ error: "disk full" }, { status: 500 });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run heartbeat now/i }));
    });
    await waitFor(() => expect(resolveHeartbeat).not.toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /past meetings/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^new meeting$/i }));
    });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/meetings/current-session" &&
            init?.method === "PATCH"
        )
      ).toBe(true);
    });
    expect(capturedSignal(heartbeatSignal)?.aborted).toBe(false);

    await act(async () => {
      resolveHeartbeat?.(
        Response.json({
          source: "pi",
          cards: [
            {
              id: "checkpoint-heartbeat",
              kind: "heartbeat",
              title: "Checkpoint heartbeat",
              body: "This heartbeat still belongs to the active meeting.",
              priority: "medium"
            }
          ],
          summary: "Heartbeat survived checkpoint failure.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Current session\n\nHeartbeat survived.",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        })
      );
      await Promise.resolve();
    });

    const reviewDocument = (
      await screen.findByRole("heading", { name: /current session/i })
    ).closest(".markdown-document");
    expect(reviewDocument).not.toBeNull();
    expect(
      within(reviewDocument as HTMLElement).getByText(/^Heartbeat survived\.$/i)
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: /product readiness review/i }))
      .toBeVisible();
  });

  it("keeps an in-flight heartbeat when ending is blocked by a missing meeting log", async () => {
    vi.useFakeTimers();
    process.env.NEXT_PUBLIC_ROOMPULSE_PI_TIMEOUT_MS = "60000";
    let resolveHeartbeat: ((response: Response) => void) | null = null;
    let heartbeatSignal: AbortSignal | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Current session",
            summary: "Initialized current session."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json({ error: "disk unavailable" }, { status: 500 });
        }
        if (url.includes("/api/heartbeat")) {
          heartbeatSignal = init?.signal as AbortSignal;
          return new Promise<Response>((resolve) => {
            resolveHeartbeat = resolve;
          });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run heartbeat now/i }));
      await Promise.resolve();
    });
    expect(resolveHeartbeat).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /end & review/i }));
      await Promise.resolve();
    });
    expect(capturedSignal(heartbeatSignal)?.aborted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600);
    });
    expect(capturedSignal(heartbeatSignal)?.aborted).toBe(false);

    await act(async () => {
      resolveHeartbeat?.(
        Response.json({
          source: "pi",
          cards: [
            {
              id: "end-blocked-heartbeat",
              kind: "heartbeat",
              title: "Still live",
              body: "The meeting stayed active after the blocked end attempt.",
              priority: "medium"
            }
          ],
          summary: "Heartbeat survived blocked end.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Current session\n\nBlocked end heartbeat survived.",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        })
      );
      await Promise.resolve();
    });

    const reviewDocument = screen
      .getByRole("heading", { name: /current session/i })
      .closest(".markdown-document");
    expect(reviewDocument).not.toBeNull();
    expect(
      within(reviewDocument as HTMLElement).getByText(
        /^Blocked end heartbeat survived\.$/i
      )
    ).toBeVisible();
  });

  it("deduplicates rapid end-session clicks before final checkpointing", async () => {
    const eventTypes: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Rapid end session",
            summary: "Initialized rapid end session."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "rapid-end-session",
              title: "Rapid end session",
              goal: "End once.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url.includes("/events")) {
          const event = JSON.parse(String(init?.body ?? "{}")) as {
            type?: string;
          };
          if (event.type) {
            eventTypes.push(event.type);
          }
          return Response.json(
            { id: `event-${eventTypes.length}` },
            { status: 201 }
          );
        }
        if (url === "/api/meetings/rapid-end-session" && method === "PATCH") {
          return new Promise<Response>(() => {
            // Keep navigation from firing so both rapid clicks can settle in place.
          });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    const endButton = await screen.findByRole("button", {
      name: /end & review/i
    });

    await act(async () => {
      fireEvent.click(endButton);
      fireEvent.click(endButton);
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    expect(eventTypes.filter((type) => type === "meeting_ended")).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url) === "/api/meetings/rapid-end-session" &&
          init?.method === "PATCH"
      )
    ).toHaveLength(1);
  });

  it("hands off to review when final state save fails after meeting end is logged", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# End state failure",
            summary: "Initialized end state failure session."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "end-state-failure",
              title: "End state failure",
              goal: "Still reach review.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url === "/api/meetings/end-state-failure/events") {
          return Response.json({ id: "event-ok" }, { status: 201 });
        }
        if (url === "/api/meetings/end-state-failure" && method === "PATCH") {
          return Response.json({ error: "state save failed" }, { status: 500 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    const endButton = await screen.findByRole("button", {
      name: /end & review/i
    });

    await act(async () => {
      fireEvent.click(endButton);
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/meetings/end-state-failure" &&
            init?.method === "PATCH"
        )
      ).toBe(true);
    });
    expect(
      screen.getByRole("link", { name: /open review\/export/i })
    ).toHaveAttribute("href", "/meetings/end-state-failure");
  });

  it("ignores stale heartbeat results after opening another saved meeting", async () => {
    const now = Date.now();
    let resolveHeartbeat: ((response: Response) => void) | null = null;
    let heartbeatSignal: AbortSignal | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({
            meetings: [
              {
                id: "other-session",
                title: "Other active session",
                goal: "Resume safely.",
                startedAt: now - 60_000,
                updatedAt: now,
                endedAt: null,
                status: "paused",
                isPaused: true,
                eventCount: 2,
                meeting: {},
                state: null,
                latestReviewMarkdown: "# Other review",
                latestReviewVersionId: "other-review"
              }
            ]
          });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Current session",
            summary: "Initialized current session."
          });
        }
        if (url === "/api/heartbeat") {
          heartbeatSignal = init?.signal as AbortSignal;
          return new Promise<Response>((resolve) => {
            resolveHeartbeat = resolve;
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "current-session",
              title: "Current session",
              goal: "Checkpoint before leaving.",
              startedAt: now,
              updatedAt: now,
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url === "/api/meetings/current-session" && method === "PATCH") {
          return Response.json({ id: "current-session" });
        }
        if (url.includes("/events")) {
          return Response.json({ id: "event-1" }, { status: 201 });
        }
        if (url === "/api/meetings/other-session") {
          return Response.json({
            metadata: {
              id: "other-session",
              title: "Other active session",
              goal: "Resume safely.",
              startedAt: now - 60_000,
              updatedAt: now,
              endedAt: null,
              status: "paused",
              isPaused: true,
              eventCount: 2,
              meeting: {
                title: "Other active session",
                goal: "Resume safely.",
                context: "",
                agenda: [{ id: "a1", title: "Open", done: false }],
                expectedParticipants: 1,
                participants: [],
                heartbeatIntervalSeconds: 30
              },
              state: null,
              latestReviewMarkdown: "# Other review",
              latestReviewVersionId: "other-review"
            },
            events: [],
            transcript: [],
            reviewVersions: [
              {
                id: "other-review",
                timestamp: now,
                source: "pi",
                markdown: "# Other review",
                summary: "Other review."
              }
            ]
          });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run heartbeat now/i }));
    });
    await waitFor(() => expect(resolveHeartbeat).not.toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /past meetings/i }));
    });
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: /other active session/i })
      );
    });
    expect(
      await screen.findByRole("heading", { name: /other active session/i })
    ).toBeVisible();
    expect(capturedSignal(heartbeatSignal)?.aborted).toBe(true);

    await act(async () => {
      resolveHeartbeat?.(
        Response.json({
          source: "pi",
          cards: [
            {
              id: "stale-card",
              kind: "heartbeat",
              title: "Stale heartbeat",
              body: "This response belongs to the previous session.",
              priority: "high"
            }
          ],
          summary: "Stale response.",
          nextHeartbeatHint: "Do not apply.",
          reviewMarkdown: "# Stale heartbeat\n\nWrong session.",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        })
      );
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: /other review/i })).toBeVisible();
    expect(screen.queryByText(/stale heartbeat/i)).not.toBeInTheDocument();
  });

  it("resumes the materialized latest review instead of stale persisted markdown", async () => {
    const now = Date.now();
    const meeting = {
      title: "Stale state session",
      goal: "Prefer materialized review rows.",
      context: "",
      agenda: [{ id: "a1", title: "Open", done: false }],
      expectedParticipants: 1,
      participants: [],
      heartbeatIntervalSeconds: 30
    };
    const staleState = {
      status: "paused",
      meeting,
      transcript: [],
      reviewMarkdown: "# Stale review\n\nOld body",
      reviewVersions: [
        {
          id: "stale-review",
          timestamp: now - 1_000,
          source: "pi",
          markdown: "# Stale review\n\nOld body",
          summary: "Stale review."
        }
      ],
      currentReviewVersionId: "stale-review",
      timeline: [
        {
          id: "old-pulse",
          timestamp: now - 1_000,
          source: "pi",
          cards: [],
          summary: "Old autosaved intervention.",
          reviewMarkdown: "# Stale review\n\nOld body"
        }
      ],
      lastHeartbeatAt: now - 1_000,
      nextHeartbeatAt: now + 30_000,
      meetingStartedAt: now - 60_000,
      heartbeatCount: 1,
      isPaused: true,
      currentOutput: null,
      activeAgendaItemId: "a1",
      updatedAt: now - 1_000
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/meetings") {
        return Response.json({
          meetings: [
            {
              id: "stale-session",
              title: meeting.title,
              goal: meeting.goal,
              startedAt: now - 60_000,
              updatedAt: now,
              endedAt: null,
              status: "paused",
              isPaused: true,
              eventCount: 2,
              meeting,
              state: staleState,
              latestReviewMarkdown: "# New review\n\nNew materialized body",
              latestReviewVersionId: "new-review"
            }
          ]
        });
      }
      if (url === "/api/meetings/stale-session") {
        return Response.json({
          metadata: {
            id: "stale-session",
            title: meeting.title,
            goal: meeting.goal,
            startedAt: now - 60_000,
            updatedAt: now,
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 3,
            meeting,
            state: staleState,
            latestReviewMarkdown: "# New review\n\nNew materialized body",
            latestReviewVersionId: "new-review"
          },
          events: [
            {
              id: "new-heartbeat-event",
              type: "heartbeat_output",
              timestamp: now,
              payload: {
                output: {
                  source: "pi",
                  cards: [
                    {
                      id: "new-card",
                      kind: "participation",
                      title: "Invite quiet voices",
                      body: "One expected participant has not spoken.",
                      priority: "medium"
                    }
                  ],
                  summary: "New logged intervention.",
                  nextHeartbeatHint: "Invite quieter voices.",
                  reviewMarkdown: "# New review\n\nNew materialized body",
                  agendaActions: [],
                  uiActions: [],
                  ephemeralReminder: "Invite quieter voices."
                }
              }
            }
          ],
          transcript: [],
          reviewVersions: [
            {
              id: "new-review",
              timestamp: now,
              source: "pi",
              markdown: "# New review\n\nNew materialized body",
              summary: "New review."
            }
          ]
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /refresh/i })[0]);
    });
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: /^resume$/i })
      );
    });

    expect(await screen.findByText(/new materialized body/i)).toBeVisible();
    expect(screen.getByText(/new logged intervention/i)).toBeVisible();
    expect(screen.getByText(/invite quiet voices/i)).toBeVisible();
    expect(screen.getByText(/heartbeat 2/i)).toBeVisible();
    expect(screen.getByText(/meeting live/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /^pause$/i })).toBeVisible();
    expect(screen.queryByText(/old body/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: /review versions/i })
    ).toHaveValue("new-review");
  });

  it("resumes the latest heartbeat review when review version rows are missing", async () => {
    const now = Date.now();
    const meeting = {
      title: "Event-only review session",
      goal: "Recover review markdown from heartbeat events.",
      context: "",
      agenda: [{ id: "a1", title: "Open", done: false }],
      expectedParticipants: 1,
      participants: [],
      heartbeatIntervalSeconds: 30
    };
    const staleState = {
      status: "paused",
      meeting,
      transcript: [],
      reviewMarkdown: "# Event-only review session\n\nOld body",
      reviewVersions: [],
      currentReviewVersionId: "missing-old-review",
      timeline: [],
      lastHeartbeatAt: now - 90_000,
      nextHeartbeatAt: now + 30_000,
      meetingStartedAt: now - 120_000,
      heartbeatCount: 1,
      isPaused: true,
      currentOutput: null,
      activeAgendaItemId: "a1",
      updatedAt: now - 90_000
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/meetings") {
        return Response.json({
          meetings: [
            {
              id: "event-only-review",
              title: meeting.title,
              goal: meeting.goal,
              startedAt: now - 120_000,
              updatedAt: now,
              endedAt: null,
              status: "paused",
              isPaused: true,
              eventCount: 2,
              meeting,
              state: staleState,
              latestReviewMarkdown: "# Event-only review session\n\nOld body",
              latestReviewVersionId: "missing-old-review"
            }
          ]
        });
      }
      if (url === "/api/meetings/event-only-review") {
        return Response.json({
          metadata: {
            id: "event-only-review",
            title: meeting.title,
            goal: meeting.goal,
            startedAt: now - 120_000,
            updatedAt: now,
            endedAt: null,
            status: "paused",
            isPaused: true,
            eventCount: 2,
            meeting,
            state: staleState,
            latestReviewMarkdown: "# Event-only review session\n\nOld body",
            latestReviewVersionId: "missing-old-review"
          },
          events: [
            {
              id: "event-1",
              type: "meeting_started",
              timestamp: now - 120_000,
              payload: { meeting }
            },
            {
              id: "event-2",
              type: "heartbeat_output",
              timestamp: now - 60_000,
              payload: {
                reviewVersionId: "event-review-1",
                output: {
                  source: "pi",
                  cards: [
                    {
                      id: "event-card-1",
                      kind: "heartbeat",
                      title: "Earlier event review",
                      body: "The event log has an earlier recoverable review.",
                      priority: "medium"
                    }
                  ],
                  summary: "Earlier event review.",
                  nextHeartbeatHint: "Continue.",
                  reviewMarkdown:
                    "# Event-only review session\n\nEarlier heartbeat event.",
                  agendaActions: [],
                  uiActions: [],
                  ephemeralReminder: null
                }
              }
            },
            {
              id: "event-3",
              type: "heartbeat_output",
              timestamp: now - 30_000,
              payload: {
                reviewVersionId: "event-review-2",
                output: {
                  source: "pi",
                  cards: [
                    {
                      id: "event-card",
                      kind: "heartbeat",
                      title: "Recovered event review",
                      body: "The heartbeat event has the latest review body.",
                      priority: "medium"
                    }
                  ],
                  summary: "Recovered event review.",
                  nextHeartbeatHint: "Continue.",
                  reviewMarkdown:
                    "# Event-only review session\n\nRecovered from heartbeat event.",
                  agendaActions: [],
                  uiActions: [],
                  ephemeralReminder: null
                }
              }
            }
          ],
          transcript: [],
          reviewVersions: []
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    expect(await screen.findByText(/event-only review session/i)).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    });

    expect(await screen.findByText(/recovered from heartbeat event/i)).toBeVisible();
    expect(screen.queryByText(/old body/i)).not.toBeInTheDocument();
    const versionSelect = screen.getByRole("combobox", {
      name: /review versions/i
    });
    expect(versionSelect).toHaveValue("event-review-2");
    expect(
      within(versionSelect)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value"))
    ).toEqual(["event-review-2", "event-review-1"]);
  });

  it("resumes metadata-only reviews with a selectable fallback version id", async () => {
    const now = Date.now();
    const startedAt = now - 60_000;
    const meeting = {
      title: "Metadata-only session",
      goal: "Recover review metadata safely.",
      context: "",
      agenda: [{ id: "a1", title: "Open", done: false }],
      expectedParticipants: 1,
      participants: [],
      heartbeatIntervalSeconds: 30
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/meetings") {
        return Response.json({
          meetings: [
            {
              id: "metadata-only-session",
              title: meeting.title,
              goal: meeting.goal,
              startedAt,
              updatedAt: now,
              endedAt: null,
              status: "paused",
              isPaused: true,
              eventCount: 1,
              meeting,
              state: null,
              latestReviewMarkdown: "# Metadata-only review",
              latestReviewVersionId: "missing-review"
            }
          ]
        });
      }
      if (url === "/api/meetings/metadata-only-session") {
        return Response.json({
          metadata: {
            id: "metadata-only-session",
            title: meeting.title,
            goal: meeting.goal,
            startedAt,
            updatedAt: now,
            endedAt: null,
            status: "paused",
            isPaused: true,
            eventCount: 1,
            meeting,
            state: null,
            latestReviewMarkdown: "# Metadata-only review",
            latestReviewVersionId: "missing-review"
          },
          events: [],
          transcript: [],
          reviewVersions: []
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /refresh/i })[0]);
    });
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: /^resume$/i })
      );
    });

    expect(await screen.findByText(/metadata-only review/i)).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: /review versions/i })
    ).toHaveValue(`${startedAt}-initial-review`);
  });

  it("resumes stateless sessions from the latest heartbeat instead of updatedAt", async () => {
    const now = Date.now();
    const lastHeartbeatAt = now - 60_000;
    const meeting = {
      title: "Stateless resume",
      goal: "Review the fresh transcript delta.",
      context: "",
      agenda: [{ id: "a1", title: "Open", done: false }],
      expectedParticipants: 1,
      participants: [],
      heartbeatIntervalSeconds: 30
    };
    let heartbeatPayload: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings") {
        return Response.json({
          meetings: [
            {
              id: "stateless-session",
              title: meeting.title,
              goal: meeting.goal,
              startedAt: now - 120_000,
              updatedAt: now,
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 3,
              meeting,
              state: null,
              latestReviewMarkdown: "# Stateless resume",
              latestReviewVersionId: "review-1"
            }
          ]
        });
      }
      if (url === "/api/meetings/stateless-session") {
        if (method === "PATCH") {
          return Response.json({ id: "stateless-session" });
        }
        return Response.json({
          metadata: {
            id: "stateless-session",
            title: meeting.title,
            goal: meeting.goal,
            startedAt: now - 120_000,
            updatedAt: now,
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 3,
            meeting,
            state: null,
            latestReviewMarkdown: "# Stateless resume",
            latestReviewVersionId: "review-1"
          },
          events: [
            {
              id: "event-1",
              type: "meeting_started",
              timestamp: now - 120_000,
              payload: { meeting }
            },
            {
              id: "event-2",
              type: "heartbeat_output",
              timestamp: lastHeartbeatAt,
              payload: {
                reviewVersionId: "review-1",
                output: {
                  source: "pi",
                  summary: "Previous heartbeat.",
                  reviewMarkdown: "# Stateless resume"
                }
              }
            },
            {
              id: "event-3",
              type: "transcript_line",
              timestamp: now - 10_000,
              payload: {}
            }
          ],
          transcript: [
            {
              id: "line-after-heartbeat",
              speakerId: "speaker-1",
              speakerLabel: "Speaker 1",
              text: "This line should be in the next heartbeat delta.",
              timestamp: now - 10_000,
              source: "speech",
              confidence: 0.9
            }
          ],
          reviewVersions: [
            {
              id: "review-1",
              timestamp: lastHeartbeatAt,
              source: "pi",
              markdown: "# Stateless resume",
              summary: "Previous heartbeat."
            }
          ]
        });
      }
      if (url === "/api/heartbeat") {
        heartbeatPayload = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({
          source: "pi",
          cards: [
            {
              id: "card-1",
              kind: "heartbeat",
              title: "Reviewed",
              body: "Reviewed the delta.",
              priority: "medium"
            }
          ],
          summary: "Reviewed delta.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Stateless resume\n\nReviewed.",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        });
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    expect(await screen.findByText(/stateless resume/i)).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run heartbeat now/i }));
    });

    await waitFor(() => {
      expect(
        capturedHeartbeatPayload(heartbeatPayload)?.lastHeartbeatAt
      ).toBe(lastHeartbeatAt);
    });
  });

  it("resumes stateless sessions with agenda state from heartbeat events", async () => {
    const now = Date.now();
    const meeting = {
      title: "Stateless agenda resume",
      goal: "Keep agenda progress after restore.",
      context: "",
      agenda: [
        { id: "a1", title: "Confirm scope", done: false },
        { id: "a2", title: "Assign owner", done: false }
      ],
      expectedParticipants: 1,
      participants: [],
      heartbeatIntervalSeconds: 30
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings") {
        return Response.json({
          meetings: [
            {
              id: "stateless-agenda-session",
              title: meeting.title,
              goal: meeting.goal,
              startedAt: now - 120_000,
              updatedAt: now,
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 2,
              meeting,
              state: null,
              latestReviewMarkdown: "# Stateless agenda resume",
              latestReviewVersionId: "review-1"
            }
          ]
        });
      }
      if (url === "/api/meetings/stateless-agenda-session") {
        if (method === "PATCH") {
          return Response.json({ id: "stateless-agenda-session" });
        }
        return Response.json({
          metadata: {
            id: "stateless-agenda-session",
            title: meeting.title,
            goal: meeting.goal,
            startedAt: now - 120_000,
            updatedAt: now,
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 2,
            meeting,
            state: null,
            latestReviewMarkdown: "# Stateless agenda resume",
            latestReviewVersionId: "review-1"
          },
          events: [
            {
              id: "event-1",
              type: "meeting_started",
              timestamp: now - 120_000,
              payload: { meeting }
            },
            {
              id: "event-2",
              type: "heartbeat_output",
              timestamp: now - 60_000,
              payload: {
                reviewVersionId: "review-1",
                output: {
                  source: "pi",
                  summary: "Scope confirmed.",
                  reviewMarkdown: "# Stateless agenda resume",
                  agendaActions: [
                    {
                      itemId: "a1",
                      done: true,
                      reason: "The room confirmed scope."
                    }
                  ],
                  uiActions: [],
                  ephemeralReminder: null
                }
              }
            }
          ],
          transcript: [],
          reviewVersions: [
            {
              id: "review-1",
              timestamp: now - 60_000,
              source: "pi",
              markdown: "# Stateless agenda resume",
              summary: "Scope confirmed."
            }
          ]
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    expect(await screen.findByText(/stateless agenda resume/i)).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    });

    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeVisible();
    expect(
      screen.getByLabelText(/confirm scope/i) as HTMLInputElement
    ).toBeChecked();
    expect(screen.getByRole("heading", { name: /assign owner/i })).toBeVisible();
  });

  it("resumes stale autosaved sessions with newer agenda state from heartbeat events", async () => {
    const now = Date.now();
    const meeting = {
      title: "Stale agenda autosave",
      goal: "Prefer logged agenda progress over stale autosave.",
      context: "",
      agenda: [
        { id: "a1", title: "Confirm scope", done: false },
        { id: "a2", title: "Assign owner", done: false }
      ],
      expectedParticipants: 1,
      participants: [],
      heartbeatIntervalSeconds: 30
    };
    const staleState = {
      status: "active",
      meeting,
      transcript: [],
      reviewMarkdown: "# Stale agenda autosave",
      reviewVersions: [
        {
          id: "old-review",
          timestamp: now - 90_000,
          source: "pi",
          markdown: "# Stale agenda autosave",
          summary: "Old autosave."
        }
      ],
      currentReviewVersionId: "old-review",
      timeline: [],
      lastHeartbeatAt: now - 90_000,
      nextHeartbeatAt: now - 60_000,
      meetingStartedAt: now - 120_000,
      heartbeatCount: 1,
      isPaused: false,
      currentOutput: null,
      activeAgendaItemId: "a1",
      updatedAt: now - 90_000
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings") {
        return Response.json({
          meetings: [
            {
              id: "stale-agenda-autosave",
              title: meeting.title,
              goal: meeting.goal,
              startedAt: now - 120_000,
              updatedAt: now,
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 2,
              meeting,
              state: staleState,
              latestReviewMarkdown: "# Stale agenda autosave\n\nScope confirmed.",
              latestReviewVersionId: "new-review"
            }
          ]
        });
      }
      if (url === "/api/meetings/stale-agenda-autosave") {
        if (method === "PATCH") {
          return Response.json({ id: "stale-agenda-autosave" });
        }
        return Response.json({
          metadata: {
            id: "stale-agenda-autosave",
            title: meeting.title,
            goal: meeting.goal,
            startedAt: now - 120_000,
            updatedAt: now,
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 2,
            meeting,
            state: staleState,
            latestReviewMarkdown: "# Stale agenda autosave\n\nScope confirmed.",
            latestReviewVersionId: "new-review"
          },
          events: [
            {
              id: "event-1",
              type: "meeting_started",
              timestamp: now - 120_000,
              payload: { meeting }
            },
            {
              id: "event-2",
              type: "heartbeat_output",
              timestamp: now - 60_000,
              payload: {
                reviewVersionId: "new-review",
                output: {
                  source: "pi",
                  cards: [
                    {
                      id: "card-1",
                      kind: "agenda",
                      title: "Scope confirmed",
                      body: "The room confirmed the first agenda item.",
                      priority: "medium"
                    }
                  ],
                  summary: "Scope confirmed.",
                  nextHeartbeatHint: "Move to owner assignment.",
                  reviewMarkdown: "# Stale agenda autosave\n\nScope confirmed.",
                  agendaActions: [
                    {
                      itemId: "a1",
                      done: true,
                      reason: "The room confirmed scope after the last autosave."
                    }
                  ],
                  uiActions: [],
                  ephemeralReminder: null
                }
              }
            }
          ],
          transcript: [],
          reviewVersions: [
            {
              id: "new-review",
              timestamp: now - 60_000,
              source: "pi",
              markdown: "# Stale agenda autosave\n\nScope confirmed.",
              summary: "Scope confirmed."
            }
          ]
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    expect(await screen.findByText(/stale agenda autosave/i)).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    });

    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeVisible();
    expect(
      screen.getByLabelText(/confirm scope/i) as HTMLInputElement
    ).toBeChecked();
    expect(screen.getByRole("heading", { name: /assign owner/i })).toBeVisible();
  });

  it("sends bounded observed speaker labels from restored transcript state", async () => {
    const now = Date.now();
    const meeting = {
      title: "Overclustered resume",
      goal: "Keep heartbeat payloads compact.",
      context: "",
      agenda: [{ id: "a1", title: "Open", done: false }],
      expectedParticipants: MAX_EXPECTED_PARTICIPANTS,
      participants: [],
      heartbeatIntervalSeconds: 30
    };
    let heartbeatPayload: Record<string, unknown> | null = null;
    const transcript = Array.from(
      { length: MAX_EXPECTED_PARTICIPANTS + 8 },
      (_, index) => ({
        id: `line-${index + 1}`,
        speakerId: `speaker-${index + 1}`,
        speakerLabel: `Speaker ${index + 1}`,
        text: `Line ${index + 1}.`,
        timestamp: now - 10_000 + index,
        source: "speech",
        confidence: 0.9
      })
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/meetings") {
        return Response.json({
          meetings: [
            {
              id: "overclustered-session",
              title: meeting.title,
              goal: meeting.goal,
              startedAt: now - 60_000,
              updatedAt: now,
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 1,
              meeting,
              state: null,
              latestReviewMarkdown: "# Overclustered resume",
              latestReviewVersionId: "review-1"
            }
          ]
        });
      }
      if (url === "/api/meetings/overclustered-session") {
        if (method === "PATCH") {
          return Response.json({ id: "overclustered-session" });
        }
        return Response.json({
          metadata: {
            id: "overclustered-session",
            title: meeting.title,
            goal: meeting.goal,
            startedAt: now - 60_000,
            updatedAt: now,
            endedAt: null,
            status: "active",
            isPaused: false,
            eventCount: 1,
            meeting,
            state: null,
            latestReviewMarkdown: "# Overclustered resume",
            latestReviewVersionId: "review-1"
          },
          events: [
            {
              id: "event-1",
              type: "meeting_started",
              timestamp: now - 60_000,
              payload: { meeting }
            }
          ],
          transcript,
          reviewVersions: [
            {
              id: "review-1",
              timestamp: now - 60_000,
              source: "initial",
              markdown: "# Overclustered resume",
              summary: "Initial."
            }
          ]
        });
      }
      if (url === "/api/heartbeat") {
        heartbeatPayload = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({
          source: "pi",
          cards: [
            {
              id: "card-1",
              kind: "heartbeat",
              title: "Reviewed",
              body: "Reviewed compact speaker state.",
              priority: "medium"
            }
          ],
          summary: "Reviewed compact speaker state.",
          nextHeartbeatHint: "Continue.",
          reviewMarkdown: "# Overclustered resume\n\nReviewed.",
          agendaActions: [],
          uiActions: [],
          ephemeralReminder: null
        });
      }
      if (url.includes("/events")) {
        return Response.json({ id: "event-1" }, { status: 201 });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    expect(await screen.findByText(/overclustered resume/i)).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run heartbeat now/i }));
    });

    await waitFor(() => {
      expect(
        capturedHeartbeatPayload(heartbeatPayload)?.observedSpeakerLabels
      ).toHaveLength(MAX_EXPECTED_PARTICIPANTS);
    });
    expect(
      capturedHeartbeatPayload(heartbeatPayload)?.observedSpeakerLabels
    ).not.toContain("Speaker 25");
    expect(
      within(screen.getByLabelText(/participation/i)).queryByText("Speaker 25")
    ).not.toBeInTheDocument();
  });

  it("retries queued meeting log events after a transient event write failure", async () => {
    let eventWrites = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/meetings" && method === "GET") {
          return Response.json({ meetings: [] });
        }
        if (url.includes("/api/review-document/init")) {
          return Response.json({
            source: "pi",
            markdown: "# Retry logging",
            summary: "Initialized."
          });
        }
        if (url === "/api/meetings" && method === "POST") {
          return Response.json(
            {
              id: "retry-session",
              title: "Retry logging",
              goal: "Do not drop queued events.",
              startedAt: Date.now(),
              updatedAt: Date.now(),
              endedAt: null,
              status: "active",
              isPaused: false,
              eventCount: 0,
              meeting: {},
              state: null,
              latestReviewMarkdown: "",
              latestReviewVersionId: null
            },
            { status: 201 }
          );
        }
        if (url === "/api/meetings/retry-session/events") {
          eventWrites += 1;
          if (eventWrites === 1) {
            return Response.json({ error: "temporary failure" }, { status: 500 });
          }
          return Response.json({ id: `event-${eventWrites}` }, { status: 201 });
        }
        return Response.json({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);
    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/events"))).toBe(
        true
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^demo$/i }));
    });
    fireEvent.change(screen.getByLabelText(/demo line/i), {
      target: { value: "Retry this transcript event." }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /add line/i }));
    });

    await waitFor(() => {
      const eventBodies = fetchMock.mock.calls
        .filter(([url]) => String(url) === "/api/meetings/retry-session/events")
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")));
      expect(eventBodies.map((event) => event.type)).toEqual([
        "meeting_started",
        "meeting_started",
        "review_initialized",
        "transcript_line"
      ]);
    });
  });

  it("clamps invalid numeric setup values before starting the room display", async () => {
    render(<RoomPulseApp />);

    await openSetupScreen();
    fireEvent.change(screen.getByLabelText(/expected participants/i), {
      target: { value: "not-a-number" }
    });
    fireEvent.change(screen.getByLabelText(/heartbeat interval/i), {
      target: { value: "not-a-number" }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    expect(await screen.findByText(/0 of 1 heard/i)).toBeVisible();
    expect(screen.queryByText(/nan/i)).not.toBeInTheDocument();
  });

  it("caps excessive setup heartbeat intervals before scheduling timers", async () => {
    render(<RoomPulseApp />);

    await openSetupScreen();
    fireEvent.change(screen.getByLabelText(/heartbeat interval/i), {
      target: { value: String(MAX_HEARTBEAT_INTERVAL_SECONDS + 60) }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    const countdown = await screen.findByLabelText("Heartbeat countdown");
    const seconds = Number(
      within(countdown).getByText(/\d+/).textContent?.trim()
    );
    expect(seconds).toBeGreaterThanOrEqual(MAX_HEARTBEAT_INTERVAL_SECONDS - 1);
    expect(seconds).toBeLessThanOrEqual(MAX_HEARTBEAT_INTERVAL_SECONDS);
    expect(countdown).toHaveTextContent(/s pulse/i);
  });

  it("hides the stop mic control until mic mode is active", async () => {
    render(<RoomPulseApp />);

    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    expect(
      await screen.findByRole("button", { name: /run heartbeat/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /stop mic/i })
    ).not.toBeInTheDocument();
  });

  it("checks an agenda item when the transcript says it was covered", async () => {
    render(<RoomPulseApp />);

    await openSetupScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();

    const agendaCheckbox = screen.getByLabelText(
      /confirm the meeting goal/i
    ) as HTMLInputElement;
    expect(agendaCheckbox.checked).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^demo$/i }));
    });
    fireEvent.change(screen.getByLabelText(/demo line/i), {
      target: { value: "That covers confirming the meeting goal." }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /add line/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run heartbeat/i }));
    });

    await waitFor(() => expect(agendaCheckbox.checked).toBe(true));
  });
});
