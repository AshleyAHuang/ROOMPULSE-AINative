import { MAX_EXPECTED_PARTICIPANTS } from "./facilitator";

export interface LocalTranscriptSegment {
  id: string;
  speakerId: string;
  speakerLabel: string;
  text: string;
  confidence: number;
  observedSpeakerLabels: string[];
}

export interface LocalTranscriptionStatus {
  status: string;
  message: string;
  observedSpeakerLabels?: string[];
}

export interface LocalTranscriptionClientOptions {
  url?: string;
  expectedParticipants?: number;
  onSegment: (segment: LocalTranscriptSegment) => void;
  onStatus: (status: LocalTranscriptionStatus) => void;
  onError: (message: string) => void;
}

type TranscriptionServerMessage =
  | ({
      type: "final_transcript";
    } & LocalTranscriptSegment)
  | ({
      type: "engine_status";
    } & LocalTranscriptionStatus)
  | {
      type: "engine_error";
      message: string;
    };

const TARGET_SAMPLE_RATE = 16_000;
const SOCKET_CONNECT_TIMEOUT_MS = 4_000;
const SOCKET_FLUSH_TIMEOUT_MS = 2_000;

type AudioContextConstructor = new () => AudioContext;

export class LocalTranscriptionClient {
  private readonly url: string;
  private readonly onSegment: (segment: LocalTranscriptSegment) => void;
  private readonly onStatus: (status: LocalTranscriptionStatus) => void;
  private readonly onError: (message: string) => void;
  private expectedParticipants: number | undefined;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private flushResolver: (() => void) | null = null;

  constructor(options: LocalTranscriptionClientOptions) {
    this.url = options.url ?? getDefaultTranscriptionUrl();
    this.onSegment = options.onSegment;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.expectedParticipants = options.expectedParticipants;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Browser microphone capture is not available.");
    }
    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor) {
      throw new Error("Browser audio processing is not available.");
    }

    try {
      this.onStatus({ status: "requesting-mic", message: "Requesting microphone" });
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      this.onStatus({
        status: "mic-granted",
        message: "Microphone permission granted; opening local transcription stream"
      });

      this.onStatus({
        status: "connecting",
        message: "Connecting to local transcription service"
      });
      this.socket = await openSocket(this.url);
      this.socket.binaryType = "arraybuffer";
      this.socket.onmessage = (event) => this.handleMessage(event);
      this.socket.onerror = () => {
        this.onError("Local transcription WebSocket error");
      };
      this.socket.onclose = () => {
        this.onStatus({ status: "closed", message: "Local transcription stopped" });
      };

      this.audioContext = new AudioContextCtor();
      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.silentGain = this.audioContext.createGain();
      this.silentGain.gain.value = 0;

      this.processor.onaudioprocess = (event) => {
        if (this.socket?.readyState !== WebSocket.OPEN || !this.audioContext) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);
        const pcm = floatToPcm16(
          downsample(input, this.audioContext.sampleRate, TARGET_SAMPLE_RATE)
        );
        if (pcm.byteLength > 0) {
          this.socket.send(pcm);
        }
      };

      this.source.connect(this.processor);
      this.processor.connect(this.silentGain);
      this.silentGain.connect(this.audioContext.destination);
      this.socket.send(
        JSON.stringify(createResetControlMessage(this.expectedParticipants))
      );
      this.onStatus({
        status: "streaming",
        message: "Microphone active; streaming audio to local transcription"
      });
    } catch (error) {
      this.stopImmediately();
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.flushOpenSocket();
    } finally {
      this.disconnectAudioGraph();
      this.closeResources();
    }
  }

  configureExpectedParticipants(expectedParticipants: number): void {
    this.expectedParticipants = expectedParticipants;
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(
      JSON.stringify(createSpeakerConfigControlMessage(expectedParticipants))
    );
  }

  stopImmediately(): void {
    this.resolveFlushWaiter();
    this.disconnectAudioGraph();
    this.closeResources();
  }

  private disconnectAudioGraph(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.processor = null;
    this.source = null;
    this.silentGain = null;
  }

  private closeResources(): void {
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.stream = null;

    void this.audioContext?.close();
    this.audioContext = null;

    this.socket?.close();
    this.socket = null;
  }

  private async flushOpenSocket(): Promise<void> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        if (this.flushResolver === finish) {
          this.flushResolver = null;
        }
        resolve();
      };
      const timeout = window.setTimeout(finish, SOCKET_FLUSH_TIMEOUT_MS);
      this.flushResolver = finish;
      try {
        socket.send(JSON.stringify({ type: "flush" }));
      } catch {
        finish();
      }
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      this.onError("Local transcription service sent invalid JSON");
      return;
    }

    if (!isRecord(message) || typeof message.type !== "string") {
      this.onError("Local transcription service sent a malformed message");
      return;
    }

    if (message.type === "final_transcript") {
      if (!isTranscriptSegment(message)) {
        this.onError("Local transcription service sent a malformed transcript");
        return;
      }
      this.onSegment(message);
      return;
    }

    if (message.type === "engine_status") {
      if (!isEngineStatus(message)) {
        this.onError("Local transcription service sent a malformed status");
        return;
      }
      this.onStatus(message);
      if (message.status === "flushed") {
        this.resolveFlushWaiter();
      }
      return;
    }

    if (message.type !== "engine_error" || typeof message.message !== "string") {
      this.onError("Local transcription service sent an unknown message");
      return;
    }
    this.onError(message.message);
  }

  private resolveFlushWaiter(): void {
    const resolver = this.flushResolver;
    this.flushResolver = null;
    resolver?.();
  }
}

export function getDefaultTranscriptionUrl(): string {
  return (
    process.env.NEXT_PUBLIC_ROOMPULSE_TRANSCRIPTION_WS ||
    "ws://127.0.0.1:8765/ws"
  );
}

export function createResetControlMessage(expectedParticipants: number | undefined): {
  type: "reset";
  maxSpeakerClusters?: number;
} {
  const maxSpeakerClusters = normalizeSpeakerClusterCap(expectedParticipants);
  return maxSpeakerClusters === null
    ? { type: "reset" }
    : { type: "reset", maxSpeakerClusters };
}

export function createSpeakerConfigControlMessage(
  expectedParticipants: number | undefined
): {
  type: "configure";
  maxSpeakerClusters?: number;
} {
  const maxSpeakerClusters = normalizeSpeakerClusterCap(expectedParticipants);
  return maxSpeakerClusters === null
    ? { type: "configure" }
    : { type: "configure", maxSpeakerClusters };
}

function normalizeSpeakerClusterCap(expectedParticipants: number | undefined): number | null {
  if (
    typeof expectedParticipants !== "number" ||
    !Number.isFinite(expectedParticipants)
  ) {
    return null;
  }

  const maxSpeakerClusters = Math.floor(expectedParticipants);
  return maxSpeakerClusters > 0
    ? Math.min(maxSpeakerClusters, MAX_EXPECTED_PARTICIPANTS)
    : null;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url);
    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.close();
      reject(new Error(`Could not connect to ${url}`));
    }, SOCKET_CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      resolve(socket);
    };
    socket.onerror = () => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      reject(new Error(`Could not connect to ${url}`));
    };
  });
}

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const audioWindow = window as Window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return window.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

export function downsample(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number
): Float32Array {
  if (input.length === 0 || sourceSampleRate <= 0 || targetSampleRate <= 0) {
    return new Float32Array();
  }

  if (sourceSampleRate === targetSampleRate) {
    return input;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(sourceIndex));
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    output[index] = input[left] * (1 - weight) + input[right] * weight;
  }

  return output;
}

export function floatToPcm16(input: Float32Array): ArrayBuffer {
  const output = new Int16Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    const value = Math.max(-1, Math.min(1, input[index]));
    output[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }

  return output.buffer;
}

function isTranscriptSegment(
  value: Record<string, unknown>
): value is Record<string, unknown> &
  { type: "final_transcript" } &
  LocalTranscriptSegment {
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.speakerId) &&
    isNonEmptyString(value.speakerLabel) &&
    typeof value.text === "string" &&
    isConfidence(value.confidence) &&
    Array.isArray(value.observedSpeakerLabels) &&
    value.observedSpeakerLabels.every(isNonEmptyString)
  );
}

function isEngineStatus(
  value: Record<string, unknown>
): value is Record<string, unknown> &
  { type: "engine_status" } &
  LocalTranscriptionStatus {
  return (
    isNonEmptyString(value.status) &&
    typeof value.message === "string" &&
    (value.observedSpeakerLabels === undefined ||
      (Array.isArray(value.observedSpeakerLabels) &&
        value.observedSpeakerLabels.every(isNonEmptyString)))
  );
}

function isConfidence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
