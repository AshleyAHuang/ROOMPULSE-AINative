import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResetControlMessage,
  createSpeakerConfigControlMessage,
  downsample,
  floatToPcm16,
  LocalTranscriptionClient
} from "./local-transcription-client";
import {
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_INPUT_TEXT_LENGTH
} from "./facilitator";
import { MAX_OBSERVED_SPEAKER_LABELS } from "./speaker-tracker";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local transcription audio utilities", () => {
  it("downsamples browser audio to the transcription service sample rate", () => {
    const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75]);
    const output = downsample(input, 48_000, 16_000);

    expect(Array.from(output)).toEqual([0, 0.75]);
  });

  it("upsamples without invalid samples when the source rate is lower", () => {
    const input = new Float32Array([0, 0.25, 0.5]);
    const output = downsample(input, 8_000, 16_000);

    expect(Array.from(output)).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.5]);
  });

  it("returns empty audio for impossible sample rates", () => {
    const output = downsample(new Float32Array([0.5]), 0, 16_000);

    expect(output).toHaveLength(0);
  });

  it("converts normalized floats into signed 16-bit PCM", () => {
    const buffer = floatToPcm16(new Float32Array([-1, 0, 1]));
    const pcm = new Int16Array(buffer);

    expect(Array.from(pcm)).toEqual([-32768, 0, 32767]);
  });

  it("sends expected participant count as the live speaker cluster cap", () => {
    expect(createResetControlMessage(4)).toEqual({
      type: "reset",
      maxSpeakerClusters: 4
    });
    expect(createResetControlMessage(4, 2)).toEqual({
      type: "reset",
      maxSpeakerClusters: 4,
      speakerLabelOffset: 2
    });
    expect(createSpeakerConfigControlMessage(5)).toEqual({
      type: "configure",
      maxSpeakerClusters: 5
    });
    expect(createResetControlMessage(Number.NaN)).toEqual({ type: "reset" });
    expect(createSpeakerConfigControlMessage(Number.NaN)).toEqual({
      type: "configure"
    });
    expect(createResetControlMessage(0)).toEqual({ type: "reset" });
    expect(createResetControlMessage(10_000)).toEqual({
      type: "reset",
      maxSpeakerClusters: 24
    });
  });

  it("can reconfigure the live speaker cap on an open socket", () => {
    const send = vi.fn();
    const client = new LocalTranscriptionClient({
      expectedParticipants: 2,
      onSegment: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn()
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket: {
        readyState: WebSocket.OPEN,
        send
      }
    });

    client.configureExpectedParticipants(6);

    expect(send).toHaveBeenCalledWith(
      JSON.stringify({ type: "configure", maxSpeakerClusters: 6 })
    );
  });

  it("does not throw when the socket closes during live speaker cap reconfigure", () => {
    const onError = vi.fn();
    const client = new LocalTranscriptionClient({
      expectedParticipants: 2,
      onSegment: vi.fn(),
      onStatus: vi.fn(),
      onError
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket: {
        readyState: WebSocket.OPEN,
        send: vi.fn(() => {
          throw new Error("socket already closing");
        })
      }
    });

    expect(() => client.configureExpectedParticipants(6)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(
      "Local transcription speaker cap reconfigure failed"
    );
  });

  it("does not open the transcription socket after mic start is stopped while permission is pending", async () => {
    let resolveUserMedia: (stream: MediaStream) => void = () => undefined;
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveUserMedia = resolve;
        })
    );
    const WebSocketMock = vi.fn(function WebSocketMock() {
      throw new Error("Socket should not open after mic start is stopped.");
    });
    Object.assign(WebSocketMock, { OPEN: 1 });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia }
    });
    vi.stubGlobal("WebSocket", WebSocketMock);
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: vi.fn()
    });

    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn()
    });

    const startPromise = client.start();
    await Promise.resolve();
    await client.stop();
    resolveUserMedia({
      getTracks: () => [
        {
          onended: null,
          stop: stopTrack
        }
      ]
    } as unknown as MediaStream);

    await expect(startPromise).rejects.toThrow("Microphone start cancelled.");
    expect(WebSocketMock).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("rejects malformed transcript socket messages before updating the UI", () => {
    const onSegment = vi.fn();
    const onError = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment,
      onStatus: vi.fn(),
      onError
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    handleMessage({
      data: JSON.stringify({
        type: "final_transcript",
        id: "line-1",
        speakerId: "",
        speakerLabel: "Speaker 1",
        text: "Missing usable speaker id.",
        confidence: 0.9,
        observedSpeakerLabels: ["Speaker 1"]
      })
    } as MessageEvent);

    expect(onSegment).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      "Local transcription service sent a malformed transcript"
    );
  });

  it("rejects unsafe speaker labels from transcript socket messages", () => {
    const onSegment = vi.fn();
    const onError = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment,
      onStatus: vi.fn(),
      onError
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    handleMessage({
      data: JSON.stringify({
        type: "final_transcript",
        id: "line-1",
        speakerId: "speaker-1",
        speakerLabel: "Speaker\n1",
        text: "Unsafe speaker label.",
        confidence: 0.9,
        observedSpeakerLabels: ["Speaker 1"]
      })
    } as MessageEvent);

    expect(onSegment).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      "Local transcription service sent a malformed transcript"
    );
  });

  it("rejects oversized transcript socket messages before updating the UI", () => {
    const onSegment = vi.fn();
    const onError = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment,
      onStatus: vi.fn(),
      onError
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    handleMessage({
      data: JSON.stringify({
        type: "final_transcript",
        id: "line-oversized",
        speakerId: "speaker-1",
        speakerLabel: "Speaker 1",
        text: "T".repeat(1_001),
        confidence: 0.9,
        observedSpeakerLabels: ["Speaker 1"]
      })
    } as MessageEvent);

    expect(onSegment).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      "Local transcription service sent a malformed transcript"
    );
  });

  it("rejects unbounded observed speaker labels from transcript messages", () => {
    const onSegment = vi.fn();
    const onError = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment,
      onStatus: vi.fn(),
      onError
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    handleMessage({
      data: JSON.stringify({
        type: "final_transcript",
        id: "line-overclustered",
        speakerId: "speaker-1",
        speakerLabel: "Speaker 1",
        text: "The service reported too many speaker labels.",
        confidence: 0.9,
        observedSpeakerLabels: Array.from(
          { length: MAX_OBSERVED_SPEAKER_LABELS + 1 },
          (_, index) => `Speaker ${index + 1}`
        )
      })
    } as MessageEvent);

    expect(onSegment).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      "Local transcription service sent a malformed transcript"
    );
  });

  it("rejects unbounded observed speaker labels from status messages", () => {
    const onStatus = vi.fn();
    const onError = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus,
      onError
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    handleMessage({
      data: JSON.stringify({
        type: "engine_status",
        status: "streaming",
        message: "Too many observed labels.",
        observedSpeakerLabels: Array.from(
          { length: MAX_OBSERVED_SPEAKER_LABELS + 1 },
          (_, index) => `Speaker ${index + 1}`
        )
      })
    } as MessageEvent);

    expect(onStatus).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      "Local transcription service sent a malformed status"
    );
  });

  it("rejects oversized status messages before updating the UI", () => {
    const onStatus = vi.fn();
    const onError = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus,
      onError
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    handleMessage({
      data: JSON.stringify({
        type: "engine_status",
        status: "streaming",
        message: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 1)
      })
    } as MessageEvent);

    expect(onStatus).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      "Local transcription service sent a malformed status"
    );
  });

  it("caps oversized transcription error messages before surfacing them", () => {
    const onError = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus: vi.fn(),
      onError
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    handleMessage({
      data: JSON.stringify({
        type: "engine_error",
        message: "E".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 1)
      })
    } as MessageEvent);

    expect(onError).toHaveBeenCalledWith(
      "E".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH)
    );
  });

  it("accepts valid transcript socket messages", () => {
    const onSegment = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment,
      onStatus: vi.fn(),
      onError: vi.fn()
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    handleMessage({
      data: JSON.stringify({
        type: "final_transcript",
        id: "line-1",
        speakerId: "speaker-1",
        speakerLabel: "Speaker 1",
        text: "Valid segment.",
        confidence: 0.9,
        observedSpeakerLabels: ["Speaker 1"]
      })
    } as MessageEvent);

    expect(onSegment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "line-1",
        speakerId: "speaker-1",
        text: "Valid segment."
      })
    );
  });

  it("waits for the transcription server flush acknowledgement before closing", async () => {
    const closeSocket = vi.fn();
    const closeAudio = vi.fn();
    const disconnectProcessor = vi.fn();
    const disconnectSource = vi.fn();
    const disconnectGain = vi.fn();
    const send = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn()
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket: {
        readyState: WebSocket.OPEN,
        send,
        close: closeSocket
      },
      stream: {
        getTracks: () => []
      },
      audioContext: {
        close: closeAudio
      },
      processor: {
        disconnect: disconnectProcessor
      },
      source: {
        disconnect: disconnectSource
      },
      silentGain: {
        disconnect: disconnectGain
      }
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    const stopPromise = client.stop();
    await Promise.resolve();

    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "flush" }));
    expect(closeSocket).not.toHaveBeenCalled();

    handleMessage({
      data: JSON.stringify({
        type: "engine_status",
        status: "flushed",
        message: "Transcription buffer flushed"
      })
    } as MessageEvent);
    await stopPromise;

    expect(closeSocket).toHaveBeenCalledOnce();
    expect(closeAudio).toHaveBeenCalledOnce();
    expect(disconnectProcessor).toHaveBeenCalledOnce();
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectGain).toHaveBeenCalledOnce();
  });

  it("still resolves stop when the socket throws while closing after flush", async () => {
    const closeSocket = vi.fn(() => {
      throw new Error("socket close failed");
    });
    const closeAudio = vi.fn();
    const send = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn()
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket: {
        readyState: WebSocket.OPEN,
        send,
        close: closeSocket
      },
      stream: {
        getTracks: () => []
      },
      audioContext: {
        close: closeAudio
      }
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    const stopPromise = client.stop();
    await Promise.resolve();
    handleMessage({
      data: JSON.stringify({
        type: "engine_status",
        status: "flushed",
        message: "Transcription buffer flushed"
      })
    } as MessageEvent);

    await expect(stopPromise).resolves.toBeUndefined();
    expect(closeSocket).toHaveBeenCalledOnce();
    expect(closeAudio).toHaveBeenCalledOnce();
  });

  it("disconnects browser audio before requesting the final socket flush", async () => {
    const order: string[] = [];
    const closeSocket = vi.fn();
    const closeAudio = vi.fn();
    const send = vi.fn((payload: string) => {
      if (payload === JSON.stringify({ type: "flush" })) {
        order.push("flush");
      }
    });
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn()
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket: {
        readyState: WebSocket.OPEN,
        send,
        close: closeSocket
      },
      stream: {
        getTracks: () => []
      },
      audioContext: {
        close: closeAudio
      },
      processor: {
        disconnect: vi.fn(() => order.push("processor-disconnected"))
      },
      source: {
        disconnect: vi.fn(() => order.push("source-disconnected"))
      },
      silentGain: {
        disconnect: vi.fn(() => order.push("gain-disconnected"))
      }
    });
    const handleMessage = (
      client as unknown as {
        handleMessage: (event: MessageEvent) => void;
      }
    ).handleMessage.bind(client);

    const stopPromise = client.stop();
    await Promise.resolve();

    expect(order).toEqual([
      "processor-disconnected",
      "source-disconnected",
      "gain-disconnected",
      "flush"
    ]);
    expect(closeSocket).not.toHaveBeenCalled();

    handleMessage({
      data: JSON.stringify({
        type: "engine_status",
        status: "flushed",
        message: "Transcription buffer flushed"
      })
    } as MessageEvent);
    await stopPromise;

    expect(closeSocket).toHaveBeenCalledOnce();
    expect(closeAudio).toHaveBeenCalledOnce();
  });

  it("releases browser audio resources when the socket closes during stop flush", async () => {
    const stopTrack = vi.fn();
    const closeSocket = vi.fn();
    const closeAudio = vi.fn();
    const disconnectProcessor = vi.fn();
    const disconnectSource = vi.fn();
    const disconnectGain = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn()
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket: {
        readyState: WebSocket.OPEN,
        send: vi.fn(() => {
          throw new Error("socket closed");
        }),
        close: closeSocket
      },
      stream: {
        getTracks: () => [{ stop: stopTrack }]
      },
      audioContext: {
        close: closeAudio
      },
      processor: {
        disconnect: disconnectProcessor
      },
      source: {
        disconnect: disconnectSource
      },
      silentGain: {
        disconnect: disconnectGain
      }
    });

    await expect(client.stop()).resolves.toBeUndefined();

    expect(disconnectProcessor).toHaveBeenCalledOnce();
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectGain).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeAudio).toHaveBeenCalledOnce();
    expect(closeSocket).toHaveBeenCalledOnce();
  });

  it("releases browser audio resources when the socket closes unexpectedly", () => {
    const stopTrack = vi.fn();
    const closeSocket = vi.fn();
    const closeAudio = vi.fn();
    const disconnectProcessor = vi.fn();
    const disconnectSource = vi.fn();
    const disconnectGain = vi.fn();
    const onStatus = vi.fn();
    const socket = {
      readyState: WebSocket.CLOSED,
      close: closeSocket
    };
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus,
      onError: vi.fn()
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket,
      stream: {
        getTracks: () => [{ stop: stopTrack }]
      },
      audioContext: {
        close: closeAudio
      },
      processor: {
        disconnect: disconnectProcessor
      },
      source: {
        disconnect: disconnectSource
      },
      silentGain: {
        disconnect: disconnectGain
      }
    });

    (
      client as unknown as {
        handleSocketClose: (socket: WebSocket) => void;
      }
    ).handleSocketClose(socket as unknown as WebSocket);

    expect(disconnectProcessor).toHaveBeenCalledOnce();
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectGain).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeAudio).toHaveBeenCalledOnce();
    expect(closeSocket).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith({
      status: "closed",
      message: "Local transcription stopped"
    });
  });

  it("closes the socket and releases resources when the microphone track ends", () => {
    const stopTrack = vi.fn();
    const closeSocket = vi.fn();
    const closeAudio = vi.fn();
    const disconnectProcessor = vi.fn();
    const disconnectSource = vi.fn();
    const disconnectGain = vi.fn();
    const onError = vi.fn();
    const onStatus = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      close: closeSocket
    };
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus,
      onError
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket,
      stream: {
        getTracks: () => [{ stop: stopTrack }]
      },
      audioContext: {
        close: closeAudio
      },
      processor: {
        disconnect: disconnectProcessor
      },
      source: {
        disconnect: disconnectSource
      },
      silentGain: {
        disconnect: disconnectGain
      }
    });

    (
      client as unknown as {
        handleInputDeviceEnded: () => void;
      }
    ).handleInputDeviceEnded();

    expect(onError).toHaveBeenCalledWith("Browser microphone input ended.");
    expect(closeSocket).toHaveBeenCalledOnce();
    expect(disconnectProcessor).toHaveBeenCalledOnce();
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectGain).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeAudio).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenCalledWith({
      status: "closed",
      message: "Local transcription stopped"
    });
  });

  it("notifies the app when the microphone track ends before the socket opens", () => {
    const stopTrack = vi.fn();
    const closeAudio = vi.fn();
    const disconnectProcessor = vi.fn();
    const disconnectSource = vi.fn();
    const disconnectGain = vi.fn();
    const onError = vi.fn();
    const onStatus = vi.fn();
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus,
      onError
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket: null,
      stream: {
        getTracks: () => [{ stop: stopTrack }]
      },
      audioContext: {
        close: closeAudio
      },
      processor: {
        disconnect: disconnectProcessor
      },
      source: {
        disconnect: disconnectSource
      },
      silentGain: {
        disconnect: disconnectGain
      }
    });

    (
      client as unknown as {
        handleInputDeviceEnded: () => void;
      }
    ).handleInputDeviceEnded();

    expect(onError).toHaveBeenCalledWith("Browser microphone input ended.");
    expect(disconnectProcessor).toHaveBeenCalledOnce();
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectGain).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeAudio).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenCalledWith({
      status: "closed",
      message: "Local transcription stopped"
    });
  });

  it("closes and releases resources when the socket errors without a close event", () => {
    const stopTrack = vi.fn();
    const closeSocket = vi.fn();
    const closeAudio = vi.fn();
    const disconnectProcessor = vi.fn();
    const disconnectSource = vi.fn();
    const disconnectGain = vi.fn();
    const onError = vi.fn();
    const onStatus = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      close: closeSocket
    };
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus,
      onError
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket,
      stream: {
        getTracks: () => [{ stop: stopTrack }]
      },
      audioContext: {
        close: closeAudio
      },
      processor: {
        disconnect: disconnectProcessor
      },
      source: {
        disconnect: disconnectSource
      },
      silentGain: {
        disconnect: disconnectGain
      }
    });

    (
      client as unknown as {
        handleSocketError: (socket: WebSocket) => void;
      }
    ).handleSocketError(socket as unknown as WebSocket);

    expect(onError).toHaveBeenCalledWith("Local transcription WebSocket error");
    expect(closeSocket).toHaveBeenCalledOnce();
    expect(disconnectProcessor).toHaveBeenCalledOnce();
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectGain).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeAudio).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenCalledWith({
      status: "closed",
      message: "Local transcription stopped"
    });
  });

  it("ignores late socket errors after mic capture has already stopped", () => {
    const closeSocket = vi.fn();
    const onError = vi.fn();
    const onStatus = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      close: closeSocket
    };
    const client = new LocalTranscriptionClient({
      onSegment: vi.fn(),
      onStatus,
      onError
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      socket
    });

    client.stopImmediately();
    onError.mockClear();
    onStatus.mockClear();
    closeSocket.mockClear();

    (
      client as unknown as {
        handleSocketError: (socket: WebSocket) => void;
      }
    ).handleSocketError(socket as unknown as WebSocket);

    expect(onError).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    expect(closeSocket).not.toHaveBeenCalled();
  });
});
