import { describe, expect, it } from "vitest";
import {
  SpeakerTracker,
  createParticipationStatus,
  type VoiceFeatures
} from "./speaker-tracker";

const features = (
  centroid: number,
  rms: number,
  zeroCrossingRate: number,
  pitch: number
): VoiceFeatures => ({
  spectralCentroid: centroid,
  rms,
  zeroCrossingRate,
  pitch
});

describe("SpeakerTracker", () => {
  it("keeps similar voice feature windows in the same speaker cluster", () => {
    const tracker = new SpeakerTracker({ distanceThreshold: 0.18 });

    const first = tracker.assignSpeaker(features(1180, 0.36, 0.14, 168));
    const second = tracker.assignSpeaker(features(1205, 0.38, 0.15, 171));

    expect(first.label).toBe("Speaker 1");
    expect(second.label).toBe("Speaker 1");
    expect(tracker.getObservedSpeakers()).toEqual(["Speaker 1"]);
  });

  it("creates new numbered clusters for meaningfully different voices", () => {
    const tracker = new SpeakerTracker({ distanceThreshold: 0.18 });

    tracker.assignSpeaker(features(1180, 0.36, 0.14, 168));
    const second = tracker.assignSpeaker(features(3150, 0.19, 0.31, 104));
    const third = tracker.assignSpeaker(features(2090, 0.66, 0.08, 236));

    expect(second.label).toBe("Speaker 2");
    expect(third.label).toBe("Speaker 3");
    expect(tracker.getObservedSpeakers()).toEqual([
      "Speaker 1",
      "Speaker 2",
      "Speaker 3"
    ]);
  });

  it("reports participation gaps against the expected room count", () => {
    const tracker = new SpeakerTracker({ distanceThreshold: 0.18 });

    tracker.assignSpeaker(features(1180, 0.36, 0.14, 168));
    tracker.assignSpeaker(features(3150, 0.19, 0.31, 104));

    expect(tracker.getParticipationStatus(5)).toEqual({
      expected: 5,
      observed: 2,
      missingCount: 3,
      observedLabels: ["Speaker 1", "Speaker 2"],
      needsNudge: true,
      reminder:
        "3 people have not been heard yet. Invite quieter voices before moving on."
    });
  });

  it("does not count blank or whitespace-variant labels as extra speakers", () => {
    expect(
      createParticipationStatus(3, ["Speaker 1", " Speaker 1 ", "", "   "])
    ).toMatchObject({
      observed: 1,
      missingCount: 2,
      observedLabels: ["Speaker 1"]
    });
  });
});
