import { describe, expect, it } from "vitest";
import {
  SpeakerTracker,
  createParticipationStatus,
  isSafeSpeakerLabel,
  normalizeSpeakerLabel,
  speakerBadgeClass,
  speakerBadgeLabel,
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

  it("limits centroid drift from borderline voice windows", () => {
    const tracker = new SpeakerTracker({ distanceThreshold: 0.26 });

    tracker.assignSpeaker(features(1000, 0.3, 0.1, 100));
    tracker.assignSpeaker(features(2200, 0.5, 0.2, 180));

    const [cluster] = tracker.getClusters();
    expect(cluster.samples).toBe(2);
    expect(cluster.centroid.spectralCentroid).toBeLessThan(1300);
  });

  it("keeps non-finite voice features from poisoning cluster centroids", () => {
    const tracker = new SpeakerTracker({ distanceThreshold: 0.26 });

    tracker.assignSpeaker(features(1000, 0.3, 0.1, 100));
    tracker.assignSpeaker(
      features(
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NaN
      )
    );
    const next = tracker.assignSpeaker(features(1010, 0.31, 0.11, 102));

    expect(next.label).toBe("Speaker 1");
    for (const cluster of tracker.getClusters()) {
      expect(Number.isFinite(cluster.centroid.spectralCentroid)).toBe(true);
      expect(Number.isFinite(cluster.centroid.rms)).toBe(true);
      expect(Number.isFinite(cluster.centroid.zeroCrossingRate)).toBe(true);
      expect(Number.isFinite(cluster.centroid.pitch)).toBe(true);
    }
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

  it("canonicalizes numbered speaker labels before counting participation", () => {
    expect(
      createParticipationStatus(3, [
        "Speaker 1",
        "speaker 01",
        "Speaker    001",
        "Speaker 2"
      ])
    ).toMatchObject({
      observed: 2,
      missingCount: 1,
      observedLabels: ["Speaker 1", "Speaker 2"]
    });
  });

  it("drops non-positive numbered speaker labels before counting participation", () => {
    expect(
      createParticipationStatus(2, ["Speaker 0", "speaker 000", "Speaker 1"])
    ).toMatchObject({
      observed: 1,
      missingCount: 1,
      observedLabels: ["Speaker 1"]
    });
  });

  it("bounds observed labels before participation state reaches heartbeat prompts", () => {
    const status = createParticipationStatus(
      24,
      Array.from({ length: 40 }, (_, index) => `Speaker ${index + 1}`)
    );

    expect(status.observed).toBe(24);
    expect(status.observedLabels).toHaveLength(24);
    expect(status.observedLabels.at(-1)).toBe("Speaker 24");
  });

  it("normalizes long or multiline speaker labels before prompt use", () => {
    const status = createParticipationStatus(2, [
      ` ${"Speaker 1 ".repeat(30)} `,
      "Speaker\n2"
    ]);

    expect(status.observedLabels[0]).toHaveLength(80);
    expect(status.observedLabels[0]?.endsWith("...")).toBe(true);
    expect(status.observedLabels[1]).toBe("Speaker 2");
  });

  it("normalizes control characters out of speaker labels", () => {
    const label = normalizeSpeakerLabel(" Speaker\u00011 ");

    expect(label).toBe("Speaker 1");
    expect(label ? isSafeSpeakerLabel(label) : false).toBe(true);
  });

  it("caps oversized speaker badge text while cycling known color classes", () => {
    expect(speakerBadgeLabel("Speaker 1000000")).toBe("S99+");
    expect(speakerBadgeClass("Speaker 1000000")).toBe("speaker-4");
  });

  it("falls invalid speaker badge labels back to the first badge", () => {
    expect(speakerBadgeLabel("Speaker 0")).toBe("S1");
    expect(speakerBadgeClass("not a numbered speaker")).toBe("speaker-1");
  });

  it("normalizes impossible expected participant counts before computing gaps", () => {
    expect(createParticipationStatus(Number.NaN, ["Speaker 1"])).toMatchObject({
      expected: 0,
      observed: 1,
      missingCount: 0,
      needsNudge: false,
      reminder: null
    });
    expect(createParticipationStatus(Number.POSITIVE_INFINITY, [])).toMatchObject({
      expected: 0,
      observed: 0,
      missingCount: 0,
      needsNudge: false,
      reminder: null
    });
  });
});
