import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clients = vi.hoisted(
  () =>
    [] as Array<{
      options: {
        expectedParticipants?: number;
        speakerLabelOffset?: number;
        onSegment: (segment: {
          id: string;
          speakerId: string;
          speakerLabel: string;
          text: string;
          confidence: number;
          observedSpeakerLabels: string[];
        }) => void;
        onStatus: (status: { status: string; message: string }) => void;
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

  it("does not attach a stale microphone permission listener after unmount", async () => {
    let resolveQuery: (status: { state: string; onchange: (() => void) | null }) => void =
      () => undefined;
    const permissionStatus = {
      state: "prompt",
      onchange: null as (() => void) | null
    };
    const query = vi.fn(
      () =>
        new Promise<{ state: string; onchange: (() => void) | null }>((resolve) => {
          resolveQuery = resolve;
        })
    );
    vi.stubGlobal("navigator", {
      permissions: { query }
    });

    const { unmount } = render(<RoomPulseApp />);
    await waitFor(() => {
      expect(query).toHaveBeenCalled();
    });

    unmount();
    await act(async () => {
      resolveQuery(permissionStatus);
      await Promise.resolve();
    });

    expect(permissionStatus.onchange).toBeNull();
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

  it("continues speaker labels after restarting mic capture", async () => {
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

    act(() => {
      clients[0].options.onSegment({
        id: "first-speaker",
        speakerId: "speaker-1",
        speakerLabel: "Speaker 1",
        text: "First mic segment.",
        confidence: 0.9,
        observedSpeakerLabels: ["Speaker 1"]
      });
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

    expect(clients[1].options.speakerLabelOffset).toBe(1);
  });

  it("ignores non-canonical label digits when offsetting restarted mic clusters", async () => {
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

    act(() => {
      clients[0].options.onSegment({
        id: "non-canonical-speaker",
        speakerId: "room-2026",
        speakerLabel: "Room 2026",
        text: "A restored non-canonical label should not offset Speaker N.",
        confidence: 0.9,
        observedSpeakerLabels: ["Room 2026"]
      });
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

    expect(clients[1].options.speakerLabelOffset).toBe(0);
  });

  it("does not render arbitrary label digits as numbered speaker badges", async () => {
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

    act(() => {
      clients[0].options.onSegment({
        id: "room-number-label",
        speakerId: "room-2026",
        speakerLabel: "Room 2026",
        text: "This label includes a room number, not a speaker number.",
        confidence: 0.9,
        observedSpeakerLabels: ["Room 2026"]
      });
    });

    expect(screen.getAllByText("Room 2026").length).toBeGreaterThan(0);
    expect(screen.queryByText("S2026")).not.toBeInTheDocument();
    expect(screen.getByText("S1")).toBeVisible();
  });

  it("keeps oversized canonical speaker numbers from overflowing live badges", async () => {
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

    act(() => {
      clients[0].options.onSegment({
        id: "huge-speaker",
        speakerId: "speaker-1000000",
        speakerLabel: "Speaker 1000000",
        text: "The full label stays visible, but the badge must stay compact.",
        confidence: 0.9,
        observedSpeakerLabels: ["Speaker 1000000"]
      });
    });

    expect(screen.getAllByText("Speaker 1000000").length).toBeGreaterThan(0);
    expect(screen.queryByText("S1000000")).not.toBeInTheDocument();
    expect(screen.getByText("S99+")).toBeVisible();
  });

  it("normalizes unsafe mic speaker labels before adding transcript lines", async () => {
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

    act(() => {
      clients[0].options.onSegment({
        id: "unsafe-label",
        speakerId: "speaker-control",
        speakerLabel: "Speaker\u00011",
        text: "Unsafe label segment.",
        confidence: 0.9,
        observedSpeakerLabels: ["Speaker\u00011"]
      });
    });

    const line = screen.getByText(/unsafe label segment/i).closest("article");
    expect(line?.querySelector("span")?.textContent).toBe("Speaker 1");
    expect(screen.getByText(/browser mic:/i).textContent).toContain(
      "Current audio cluster: Speaker 1"
    );
    expect(screen.getByText(/browser mic:/i).textContent).not.toContain(
      "Speaker\u00011"
    );
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

  it("restarts mic capture after an unexpected transcription stream close", async () => {
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

    act(() => {
      clients[0].options.onStatus({
        status: "closed",
        message: "Local transcription stopped unexpectedly"
      });
    });

    await waitFor(() => {
      expect(clients).toHaveLength(2);
    });
    expect(clients[1].start).toHaveBeenCalledOnce();
    expect(screen.getByText(/browser mic:/i)).not.toHaveTextContent(
      /local transcription stopped unexpectedly/i
    );
  });

  it("retries mic capture when the initial transcription socket connection fails", async () => {
    startHandlers.push(
      () => Promise.reject(new Error("Could not connect to ws://127.0.0.1:8765/ws")),
      () => {
        clients[1].options.onStatus({
          status: "streaming",
          message: "Microphone active; streaming audio to local transcription"
        });
        return Promise.resolve();
      }
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
      expect(clients).toHaveLength(2);
    });
    expect(clients[0].stop).toHaveBeenCalledOnce();
    expect(clients[1].start).toHaveBeenCalledOnce();
    expect(screen.getByText(/browser mic:/i)).toHaveTextContent(
      /microphone active; streaming audio to local transcription/i
    );
  });

  it("restarts mic capture when browser audio devices change", async () => {
    const listeners = new Map<string, EventListener>();
    const addEventListener = vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    });
    const removeEventListener = vi.fn();
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({
          state: "prompt",
          onchange: null
        })
      },
      mediaDevices: {
        addEventListener,
        removeEventListener
      }
    });

    render(<RoomPulseApp />);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /new meeting/i })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });
    await waitFor(() => {
      expect(clients).toHaveLength(1);
    });

    expect(addEventListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function)
    );
    await act(async () => {
      listeners.get("devicechange")?.(new Event("devicechange"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(clients).toHaveLength(2);
    });
    expect(clients[0].stop).toHaveBeenCalledOnce();
    expect(clients[1].start).toHaveBeenCalledOnce();
  });

  it("restarts mic capture when the stream closes during initial mic start", async () => {
    startHandlers.push(() => {
      clients[0].options.onStatus({
        status: "closed",
        message: "Local transcription stopped during start"
      });
      return Promise.resolve();
    });

    render(<RoomPulseApp />);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /new meeting/i })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start meeting/i }));
    });

    await waitFor(() => {
      expect(clients).toHaveLength(2);
    });
    expect(clients[1].start).toHaveBeenCalledOnce();
    expect(screen.getByText(/browser mic:/i)).not.toHaveTextContent(
      /local transcription stopped during start/i
    );
  });
});
