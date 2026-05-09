import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RoomPulseApp from "./RoomPulseApp";

describe("RoomPulseApp", () => {
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
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/live raw transcript/i)).toBeInTheDocument();
    expect(screen.getByText(/0 of 3 heard/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/demo line/i), {
      target: { value: "We have not made a decision yet." }
    });
    fireEvent.click(screen.getByRole("button", { name: /add demo line/i }));

    expect(screen.getByText(/we have not made a decision yet/i)).toBeVisible();
    expect(screen.getByText(/1 of 3 heard/i)).toBeVisible();
  });
});
