import {
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_EXPECTED_PARTICIPANTS,
  MAX_HEARTBEAT_INPUT_TEXT_LENGTH
} from "./facilitator";
import {
  MAX_OBSERVED_SPEAKER_LABELS,
  isSafeSpeakerLabel
} from "./speaker-tracker";

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
  speakerLabelOffset?: number;
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
const DEFAULT_SOCKET_FLUSH_TIMEOUT_MS = 15_000;

type AudioContextConstructor = new () => AudioContext;

export class LocalTranscriptionClient {
  private readonly url: string;
  private readonly onSegment: (segment: LocalTranscriptSegment) => void;
  private readonly onStatus: (status: LocalTranscriptionStatus) => void;
  private readonly onError: (message: string) => void;
  private expectedParticipants: number | undefined;
  private readonly speakerLabelOffset: number;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private flushResolver: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(options: LocalTranscriptionClientOptions) {
    this.url = options.url ?? getDefaultTranscriptionUrl();
    this.onSegment = options.onSegment;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.expectedParticipants = options.expectedParticipants;
    this.speakerLabelOffset = normalizeSpeakerLabelOffset(
      options.speakerLabelOffset
    );
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
      this.throwIfStoppedDuringStart();
      this.stream.getTracks().forEach((track) => {
        track.onended = () => this.handleInputDeviceEnded();
      });
      this.onStatus({
        status: "mic-granted",
        message: "Microphone permission granted; opening local transcription stream"
      });

      this.onStatus({
        status: "connecting",
        message: "Connecting to local transcription service"
      });
      this.socket = await openSocket(this.url, (pendingSocket) => {
        this.socket = pendingSocket;
      });
      this.throwIfStoppedDuringStart();
      const socket = this.socket;
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event) => this.handleMessage(event);
      socket.onerror = () => {
        this.handleSocketError(socket);
      };
      socket.onclose = () => {
        this.handleSocketClose(socket);
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
          try {
            this.socket.send(pcm);
          } catch {
            const failedSocket = this.socket;
            this.onError("Local transcription audio send failed");
            closeSocketQuietly(failedSocket);
            this.handleSocketClose(failedSocket);
          }
        }
      };

      this.source.connect(this.processor);
      this.processor.connect(this.silentGain);
      this.silentGain.connect(this.audioContext.destination);
      this.throwIfStoppedDuringStart();
      try {
        socket.send(
          JSON.stringify(
            createResetControlMessage(
              this.expectedParticipants,
              this.speakerLabelOffset
            )
          )
        );
      } catch {
        throw new Error("Local transcription reset send failed");
      }
      this.onStatus({
        status: "streaming",
        message: "Microphone active; streaming audio to local transcription"
      });
    } catch (error) {
      const wasStopped = this.stopped;
      this.stopImmediately();
      if (wasStopped) {
        throw new Error("Microphone start cancelled.");
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopped = true;
    this.stopPromise = this.stopGracefully();
    return this.stopPromise;
  }

  configureExpectedParticipants(expectedParticipants: number): void {
    this.expectedParticipants = expectedParticipants;
    if (this.stopped) {
      return;
    }
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(
        JSON.stringify(createSpeakerConfigControlMessage(expectedParticipants))
      );
    } catch {
      this.onError("Local transcription speaker cap reconfigure failed");
      closeSocketQuietly(socket);
      this.handleSocketClose(socket);
    }
  }

  stopImmediately(): void {
    this.stopped = true;
    this.resolveFlushWaiter();
    this.disconnectAudioGraph();
    this.closeResources();
  }

  private async stopGracefully(): Promise<void> {
    this.disconnectAudioGraph();
    try {
      await this.flushOpenSocket();
    } finally {
      this.closeResources();
    }
  }

  private throwIfStoppedDuringStart(): void {
    if (!this.stopped) {
      return;
    }

    this.stopImmediately();
    throw new Error("Microphone start cancelled.");
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
    this.closeBrowserAudioResources();
    const socket = this.socket;
    this.socket = null;
    closeSocketQuietly(socket);
  }

  private closeBrowserAudioResources(): void {
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.stream = null;

    void this.audioContext?.close();
    this.audioContext = null;
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
      const timeout = window.setTimeout(finish, getSocketFlushTimeoutMs());
      this.flushResolver = finish;
      try {
        socket.send(JSON.stringify({ type: "flush" }));
      } catch {
        finish();
      }
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (this.stopped && !this.flushResolver) {
      return;
    }

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
    this.onError(capText(message.message, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH));
  }

  private handleSocketClose(socket: WebSocket): void {
    this.stopped = true;
    const shouldNotify =
      this.socket === socket ||
      this.stream !== null ||
      this.audioContext !== null ||
      this.processor !== null ||
      this.source !== null ||
      this.silentGain !== null;
    this.resolveFlushWaiter();
    this.disconnectAudioGraph();
    this.closeBrowserAudioResources();
    if (this.socket === socket) {
      this.socket = null;
    }
    if (shouldNotify) {
      this.onStatus({ status: "closed", message: "Local transcription stopped" });
    }
  }

  private handleSocketError(socket: WebSocket): void {
    if (!this.isActiveSocketEvent(socket)) {
      return;
    }
    this.onError("Local transcription WebSocket error");
    try {
      socket.close();
    } catch {
      // The socket may already be closing; resource cleanup still needs to run.
    }
    this.handleSocketClose(socket);
  }

  private isActiveSocketEvent(socket: WebSocket): boolean {
    return (
      this.socket === socket ||
      this.stream !== null ||
      this.audioContext !== null ||
      this.processor !== null ||
      this.source !== null ||
      this.silentGain !== null
    );
  }

  private handleInputDeviceEnded(): void {
    this.stopped = true;
    const socket = this.socket;
    this.onError("Browser microphone input ended.");
    closeSocketQuietly(socket);
    if (socket) {
      this.handleSocketClose(socket);
      return;
    }

    this.disconnectAudioGraph();
    this.closeBrowserAudioResources();
    this.onStatus({ status: "closed", message: "Local transcription stopped" });
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

export function createResetControlMessage(
  expectedParticipants: number | undefined,
  speakerLabelOffset?: number
): {
  type: "reset";
  maxSpeakerClusters?: number;
  speakerLabelOffset?: number;
} {
  const maxSpeakerClusters = normalizeSpeakerClusterCap(expectedParticipants);
  const normalizedOffset = normalizeSpeakerLabelOffset(speakerLabelOffset);
  return {
    type: "reset",
    ...(maxSpeakerClusters === null ? {} : { maxSpeakerClusters }),
    ...(normalizedOffset > 0 ? { speakerLabelOffset: normalizedOffset } : {})
  };
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

function normalizeSpeakerLabelOffset(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(MAX_EXPECTED_PARTICIPANTS, Math.floor(value)));
}

function getSocketFlushTimeoutMs(): number {
  const raw = process.env.NEXT_PUBLIC_ROOMPULSE_TRANSCRIPTION_FLUSH_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_SOCKET_FLUSH_TIMEOUT_MS;
  }

  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.max(1_000, Math.min(60_000, Math.floor(value)))
    : DEFAULT_SOCKET_FLUSH_TIMEOUT_MS;
}

function openSocket(
  url: string,
  onPendingSocket?: (socket: WebSocket) => void
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = 0;
    const socket = new WebSocket(url);
    onPendingSocket?.(socket);
    const rejectConnection = () => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      reject(new Error(`Could not connect to ${url}`));
    };
    timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      closeSocketQuietly(socket);
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
    socket.onerror = rejectConnection;
    socket.onclose = rejectConnection;
  });
}

function closeSocketQuietly(socket: WebSocket | null): void {
  try {
    socket?.close();
  } catch {
    // Cleanup paths must not fail if the browser socket is already invalid.
  }
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
    isBoundedNonEmptyString(value.id, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isBoundedNonEmptyString(value.speakerId, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isSafeSpeakerLabel(value.speakerLabel) &&
    isBoundedString(value.text, MAX_HEARTBEAT_INPUT_TEXT_LENGTH) &&
    isConfidence(value.confidence) &&
    isSafeObservedSpeakerLabels(value.observedSpeakerLabels)
  );
}

function isEngineStatus(
  value: Record<string, unknown>
): value is Record<string, unknown> &
  { type: "engine_status" } &
  LocalTranscriptionStatus {
  return (
    isBoundedNonEmptyString(value.status, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    isBoundedString(value.message, MAX_FACILITATOR_OUTPUT_TEXT_LENGTH) &&
    (value.observedSpeakerLabels === undefined ||
      isSafeObservedSpeakerLabels(value.observedSpeakerLabels))
  );
}

function isSafeObservedSpeakerLabels(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_OBSERVED_SPEAKER_LABELS &&
    value.every(isSafeSpeakerLabel)
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

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isBoundedNonEmptyString(
  value: unknown,
  maxLength: number
): value is string {
  return isNonEmptyString(value) && isBoundedString(value, maxLength);
}

function capText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
