import { describe, expect, it, vi } from "vitest";
import {
  createResetControlMessage,
  createSpeakerConfigControlMessage,
  downsample,
  floatToPcm16,
  LocalTranscriptionClient
} from "./local-transcription-client";

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
});
