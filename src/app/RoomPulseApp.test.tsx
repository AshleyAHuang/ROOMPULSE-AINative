import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RoomPulseApp from "./RoomPulseApp";

describe("RoomPulseApp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("moves from setup feeder to room display with mic-first transcript controls", async () => {
    render(<RoomPulseApp />);

    expect(
      screen.getByRole("heading", { name: /roompulse/i })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/meeting title/i), {
      target: { value: "Design review" }
    });
    fireEvent.change(screen.getByLabelText(/expected participants/i), {
      target: { value: "3" }
    });
    fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));

    expect(
      await screen.findByRole("button", { name: /run heartbeat/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/live raw transcript/i)).toBeInTheDocument();
    expect(screen.getByText(/0 of 3 heard/i)).toBeInTheDocument();
    expect(screen.getByText(/live review document/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^mic$/i })).toHaveClass("active");

    fireEvent.click(screen.getByRole("button", { name: /^demo$/i }));
    fireEvent.change(screen.getByLabelText(/demo line/i), {
      target: { value: "We have not made a decision yet." }
    });
    fireEvent.click(screen.getByRole("button", { name: /add line/i }));

    expect(screen.getByText(/we have not made a decision yet/i)).toBeVisible();
    expect(screen.getByText(/1 of 3 heard/i)).toBeVisible();
  });

  it("records browser fallback heartbeat pulses as review document versions", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    render(<RoomPulseApp />);

    fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /run heartbeat/i })
    );

    expect(await screen.findByText(/network down/i)).toBeVisible();
    expect(screen.getByText(/2 versions/i)).toBeVisible();
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

    fireEvent.click(screen.getByRole("button", { name: /launch live demo/i }));

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

    fireEvent.click(screen.getByRole("button", { name: /launch live demo/i }));

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

  it("clamps invalid numeric setup values before starting the room display", async () => {
    render(<RoomPulseApp />);

    fireEvent.change(screen.getByLabelText(/expected participants/i), {
      target: { value: "not-a-number" }
    });
    fireEvent.change(screen.getByLabelText(/heartbeat interval/i), {
      target: { value: "not-a-number" }
    });
    fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));

    expect(await screen.findByText(/0 of 1 heard/i)).toBeVisible();
    expect(screen.queryByText(/nan/i)).not.toBeInTheDocument();
  });

  it("hides the stop mic control until mic mode is active", async () => {
    render(<RoomPulseApp />);

    fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));

    expect(
      await screen.findByRole("button", { name: /run heartbeat/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /stop mic/i })
    ).not.toBeInTheDocument();
  });

  it("checks an agenda item when the transcript says it was covered", async () => {
    render(<RoomPulseApp />);

    fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();

    const agendaCheckbox = screen.getByLabelText(
      /confirm the meeting goal/i
    ) as HTMLInputElement;
    expect(agendaCheckbox.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /^demo$/i }));
    fireEvent.change(screen.getByLabelText(/demo line/i), {
      target: { value: "That covers confirming the meeting goal." }
    });
    fireEvent.click(screen.getByRole("button", { name: /add line/i }));
    fireEvent.click(screen.getByRole("button", { name: /run heartbeat/i }));

    await waitFor(() => expect(agendaCheckbox.checked).toBe(true));
  });
});
