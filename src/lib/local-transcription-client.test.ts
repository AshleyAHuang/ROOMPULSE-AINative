import { describe, expect, it } from "vitest";
import { downsample, floatToPcm16 } from "./local-transcription-client";

describe("local transcription audio utilities", () => {
  it("downsamples browser audio to the transcription service sample rate", () => {
    const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75]);
    const output = downsample(input, 48_000, 16_000);

    expect(Array.from(output)).toEqual([0, 0.75]);
  });

  it("converts normalized floats into signed 16-bit PCM", () => {
    const buffer = floatToPcm16(new Float32Array([-1, 0, 1]));
    const pcm = new Int16Array(buffer);

    expect(Array.from(pcm)).toEqual([-32768, 0, 32767]);
  });
});
