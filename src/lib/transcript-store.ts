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
    const id = this.createLineId(timestamp);
    const line: TranscriptLine = {
      id,
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

  private createLineId(timestamp: number): string {
    const existingIds = new Set(this.lines.map((line) => line.id));
    let suffix = this.lines.length + 1;
    let id = `${timestamp}-${suffix}`;

    while (existingIds.has(id)) {
      suffix += 1;
      id = `${timestamp}-${suffix}`;
    }

    return id;
  }
}
