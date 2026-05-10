import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptStore } from "./transcript-store";
import {
  MAX_HEARTBEAT_INPUT_TEXT_LENGTH,
  type TranscriptLine
} from "./facilitator";

describe("TranscriptStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores trimmed transcript lines and ignores blank text", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const store = new TranscriptStore();

    const blank = store.addLine({
      speakerId: "speaker-1",
      speakerLabel: "Speaker 1",
      text: "   ",
      source: "speech"
    });
    const line = store.addLine({
      speakerId: "speaker-1",
      speakerLabel: "Speaker 1",
      text: "  Keep this line.  ",
      source: "speech",
      confidence: 0.91
    });

    expect(blank.text).toBe("");
    expect(store.getLines()).toEqual([
      expect.objectContaining({
        id: "1700000000000-1",
        text: "Keep this line.",
        confidence: 0.91
      })
    ]);
    expect(line.id).toBe("1700000000000-1");
  });

  it("caps transcript text before it reaches persistence and heartbeat payloads", () => {
    const store = new TranscriptStore();

    const line = store.addLine({
      speakerId: "speaker-1",
      speakerLabel: "Speaker 1",
      text: "T".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 1),
      source: "speech"
    });

    expect(line.text).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(store.getLines()[0]?.text).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
  });

  it("generates a fresh id after restored transcript ids leave gaps", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_010_000);
    const store = new TranscriptStore();
    const restored: TranscriptLine[] = [
      {
        id: "1700000010000-2",
        speakerId: "speaker-1",
        speakerLabel: "Speaker 1",
        text: "Restored sparse line.",
        timestamp: 1_700_000_010_000,
        source: "speech",
        confidence: 0.9
      }
    ];
    store.replace(restored);

    const line = store.addLine({
      speakerId: "speaker-2",
      speakerLabel: "Speaker 2",
      text: "New line after restore.",
      source: "speech"
    });

    expect(line.id).toBe("1700000010000-3");
    expect(store.getLines().map((entry) => entry.id)).toEqual([
      "1700000010000-2",
      "1700000010000-3"
    ]);
  });

  it("returns transcript copies for since, replace, and clear operations", () => {
    const store = new TranscriptStore();
    store.replace([
      {
        id: "old",
        speakerId: "speaker-1",
        speakerLabel: "Speaker 1",
        text: "Old line.",
        timestamp: 10,
        source: "simulated",
        confidence: 1
      },
      {
        id: "new",
        speakerId: "speaker-2",
        speakerLabel: "Speaker 2",
        text: "New line.",
        timestamp: 20,
        source: "simulated",
        confidence: 1
      }
    ]);

    expect(store.getSince(10).map((line) => line.id)).toEqual(["new"]);
    const copy = store.getLines();
    copy.pop();
    expect(store.getLines()).toHaveLength(2);

    store.clear();
    expect(store.getLines()).toEqual([]);
  });
});
