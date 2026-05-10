import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clients = vi.hoisted(
  () =>
    [] as Array<{
      options: {
        expectedParticipants?: number;
        onSegment: (segment: {
          id: string;
          speakerId: string;
          speakerLabel: string;
          text: string;
          confidence: number;
          observedSpeakerLabels: string[];
        }) => void;
      };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }>
);
const startHandlers = vi.hoisted(() => [] as Array<() => Promise<void>>);

vi.mock("@/lib/local-transcription-client", () => ({
  LocalTranscriptionClient: vi.fn().mockImplementation(function mockClient(options) {
    const client = {
      options,
      start: vi.fn(() => startHandlers.shift()?.() ?? Promise.resolve()),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    clients.push(client);
    return client;
  })
}));

import RoomPulseApp from "./RoomPulseApp";

describe("RoomPulseApp mic lifecycle", () => {
  beforeEach(() => {
    clients.length = 0;
    startHandlers.length = 0;
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({
          state: "prompt",
          onchange: null
        })
      }
    });
  });

  it("ignores late mic transcript callbacks after switching to demo mode", async () => {
    render(<RoomPulseApp />);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /new meeting/i })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(clients).toHaveLength(1);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^demo$/i }));
    });
    act(() => {
      clients[0].options.onSegment({
        id: "late-segment",
        speakerId: "speaker-1",
        speakerLabel: "Speaker 1",
        text: "Late microphone segment",
        confidence: 0.9,
        observedSpeakerLabels: ["Speaker 1"]
      });
    });

    expect(screen.queryByText(/late microphone segment/i)).not.toBeInTheDocument();
  });

  it("starts mic capture with the configured participant count", async () => {
    render(<RoomPulseApp />);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /new meeting/i })[0]);
    });
    fireEvent.change(screen.getByLabelText(/expected participants/i), {
      target: { value: "7" }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    await waitFor(() => {
      expect(clients).toHaveLength(1);
    });
    expect(clients[0].options.expectedParticipants).toBe(7);
  });

  it("keeps the microphone client alive when switching from demo back to mic", async () => {
    render(<RoomPulseApp />);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /new meeting/i })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(clients).toHaveLength(1);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^demo$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^mic$/i }));
    });

    await waitFor(() => {
      expect(clients).toHaveLength(2);
    });
    expect(clients[1].stop).not.toHaveBeenCalled();
  });

  it("does not let a stale failed mic start stop the newer mic client", async () => {
    let rejectFirstStart: (error: Error) => void = () => undefined;
    startHandlers.push(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstStart = reject;
        })
    );

    render(<RoomPulseApp />);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /new meeting/i })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    expect(
      await screen.findByRole("button", { name: /run heartbeat now/i })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(clients).toHaveLength(1);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^demo$/i }));
    });
    startHandlers.push(() => Promise.resolve());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^mic$/i }));
    });
    await waitFor(() => {
      expect(clients).toHaveLength(2);
    });

    await act(async () => {
      rejectFirstStart(new Error("permission denied after stop"));
      await Promise.resolve();
    });

    expect(clients[1].stop).not.toHaveBeenCalled();
    expect(screen.getByText(/browser mic:/i)).not.toHaveTextContent(
      /permission denied after stop/i
    );
  });
});
