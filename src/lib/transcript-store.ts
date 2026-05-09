import type { TranscriptLine, TranscriptSource } from "./facilitator";

export interface AddTranscriptLineInput {
  speakerId: string;
  speakerLabel: string;
  text: string;
  source: TranscriptSource;
  confidence?: number;
  timestamp?: number;
}

export class TranscriptStore {
  private lines: TranscriptLine[] = [];

  addLine(input: AddTranscriptLineInput): TranscriptLine {
    const timestamp = input.timestamp ?? Date.now();
    const line: TranscriptLine = {
      id: `${timestamp}-${this.lines.length + 1}`,
      speakerId: input.speakerId,
      speakerLabel: input.speakerLabel,
      text: input.text.trim(),
      timestamp,
      source: input.source,
      confidence: input.confidence ?? 1
    };

    if (line.text.length === 0) {
      return line;
    }

    this.lines = [...this.lines, line];
    return line;
  }

  getLines(): TranscriptLine[] {
    return [...this.lines];
  }

  getSince(timestamp: number): TranscriptLine[] {
    return this.lines.filter((line) => line.timestamp > timestamp);
  }

  replace(lines: TranscriptLine[]): void {
    this.lines = [...lines];
  }

  clear(): void {
    this.lines = [];
  }
}
