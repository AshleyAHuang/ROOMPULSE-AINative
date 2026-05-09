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

export class LocalTranscriptionClient {
  private readonly url: string;
  private readonly onSegment: (segment: LocalTranscriptSegment) => void;
  private readonly onStatus: (status: LocalTranscriptionStatus) => void;
  private readonly onError: (message: string) => void;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;

  constructor(options: LocalTranscriptionClientOptions) {
    this.url = options.url ?? getDefaultTranscriptionUrl();
    this.onSegment = options.onSegment;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Browser microphone capture is not available.");
    }

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

    this.audioContext = new AudioContext();
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
    this.socket.send(JSON.stringify({ type: "reset" }));
    this.onStatus({
      status: "streaming",
      message: "Microphone active; streaming audio to local transcription"
    });
  }

  stop(): void {
    this.socket?.send(JSON.stringify({ type: "flush" }));
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.processor = null;
    this.source = null;
    this.silentGain = null;

    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.stream = null;

    void this.audioContext?.close();
    this.audioContext = null;

    this.socket?.close();
    this.socket = null;
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }

    let message: TranscriptionServerMessage;
    try {
      message = JSON.parse(event.data) as TranscriptionServerMessage;
    } catch {
      this.onError("Local transcription service sent invalid JSON");
      return;
    }

    if (message.type === "final_transcript") {
      this.onSegment(message);
      return;
    }

    if (message.type === "engine_status") {
      this.onStatus(message);
      return;
    }

    this.onError(message.message);
  }
}

export function getDefaultTranscriptionUrl(): string {
  return (
    process.env.NEXT_PUBLIC_ROOMPULSE_TRANSCRIPTION_WS ||
    "ws://127.0.0.1:8765/ws"
  );
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error(`Could not connect to ${url}`));
  });
}

export function downsample(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number
): Float32Array {
  if (sourceSampleRate === targetSampleRate) {
    return input;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
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
