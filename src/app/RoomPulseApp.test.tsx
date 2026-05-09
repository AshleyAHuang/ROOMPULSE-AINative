import { fireEvent, render, screen } from "@testing-library/react";
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

  it("moves from setup feeder to room display with demo transcript controls", async () => {
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

    fireEvent.change(screen.getByLabelText(/demo line/i), {
      target: { value: "We have not made a decision yet." }
    });
    fireEvent.click(screen.getByRole("button", { name: /add demo line/i }));

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
});
