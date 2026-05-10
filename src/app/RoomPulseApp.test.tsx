import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RoomPulseApp, { previousReviewVersion } from "./RoomPulseApp";
import { MAX_HEARTBEAT_INTERVAL_SECONDS } from "@/lib/facilitator";

describe("RoomPulseApp", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ROOMPULSE_PI_TIMEOUT_MS;
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

  it("caps pasted setup agenda and participant lists before initialization", async () => {
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
    fireEvent.change(screen.getByLabelText(/agenda/i), {
      target: {
        value: Array.from({ length: 40 }, (_, index) => `Item ${index}`).join("\n")
      }
    });
    fireEvent.change(screen.getByLabelText(/optional names and roles/i), {
      target: {
        value: Array.from(
          { length: 30 },
          (_, index) => `Person ${index} - Role`
        ).join("\n")
      }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    await waitFor(() => {
      const meeting = initialReviewBody?.meeting as {
        agenda: unknown[];
        participants: unknown[];
      };
      expect(meeting.agenda).toHaveLength(30);
      expect(meeting.participants).toHaveLength(24);
    });
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

  it("ignores stale heartbeat results after opening another saved meeting", async () => {
    const now = Date.now();
    let resolveHeartbeat: ((response: Response) => void) | null = null;
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
      timeline: [],
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
            status: "paused",
            isPaused: true,
            eventCount: 2,
            meeting,
            state: staleState,
            latestReviewMarkdown: "# New review\n\nNew materialized body",
            latestReviewVersionId: "new-review"
          },
          events: [],
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
    expect(screen.queryByText(/old body/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: /review versions/i })
    ).toHaveValue("new-review");
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
      expect(heartbeatPayload?.lastHeartbeatAt).toBe(lastHeartbeatAt);
    });
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
