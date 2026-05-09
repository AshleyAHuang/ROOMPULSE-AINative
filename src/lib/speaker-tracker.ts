export interface VoiceFeatures {
  spectralCentroid: number;
  rms: number;
  zeroCrossingRate: number;
  pitch: number;
}

export interface SpeakerCluster {
  id: string;
  label: string;
  centroid: VoiceFeatures;
  samples: number;
  lastSeenAt: number;
}

export interface ParticipationStatus {
  expected: number;
  observed: number;
  missingCount: number;
  observedLabels: string[];
  needsNudge: boolean;
  reminder: string | null;
}

export interface SpeakerTrackerOptions {
  distanceThreshold?: number;
  now?: () => number;
}

const DEFAULT_DISTANCE_THRESHOLD = 0.22;

export class SpeakerTracker {
  private readonly distanceThreshold: number;
  private readonly now: () => number;
  private clusters: SpeakerCluster[] = [];

  constructor(options: SpeakerTrackerOptions = {}) {
    this.distanceThreshold =
      options.distanceThreshold ?? DEFAULT_DISTANCE_THRESHOLD;
    this.now = options.now ?? Date.now;
  }

  assignSpeaker(features: VoiceFeatures): SpeakerCluster {
    const nearest = this.findNearest(features);

    if (!nearest || nearest.distance > this.distanceThreshold) {
      const cluster: SpeakerCluster = {
        id: `speaker-${this.clusters.length + 1}`,
        label: `Speaker ${this.clusters.length + 1}`,
        centroid: { ...features },
        samples: 1,
        lastSeenAt: this.now()
      };
      this.clusters.push(cluster);
      return { ...cluster, centroid: { ...cluster.centroid } };
    }

    const cluster = nearest.cluster;
    const samples = cluster.samples + 1;
    cluster.centroid = {
      spectralCentroid:
        (cluster.centroid.spectralCentroid * cluster.samples +
          features.spectralCentroid) /
        samples,
      rms: (cluster.centroid.rms * cluster.samples + features.rms) / samples,
      zeroCrossingRate:
        (cluster.centroid.zeroCrossingRate * cluster.samples +
          features.zeroCrossingRate) /
        samples,
      pitch:
        (cluster.centroid.pitch * cluster.samples + features.pitch) / samples
    };
    cluster.samples = samples;
    cluster.lastSeenAt = this.now();

    return { ...cluster, centroid: { ...cluster.centroid } };
  }

  getClusters(): SpeakerCluster[] {
    return this.clusters.map((cluster) => ({
      ...cluster,
      centroid: { ...cluster.centroid }
    }));
  }

  getObservedSpeakers(): string[] {
    return this.clusters.map((cluster) => cluster.label);
  }

  getParticipationStatus(expectedParticipants: number): ParticipationStatus {
    return createParticipationStatus(
      expectedParticipants,
      this.getObservedSpeakers()
    );
  }

  reset(): void {
    this.clusters = [];
  }

  private findNearest(features: VoiceFeatures):
    | {
        cluster: SpeakerCluster;
        distance: number;
      }
    | undefined {
    let nearest:
      | {
          cluster: SpeakerCluster;
          distance: number;
        }
      | undefined;

    for (const cluster of this.clusters) {
      const distance = voiceFeatureDistance(cluster.centroid, features);
      if (!nearest || distance < nearest.distance) {
        nearest = { cluster, distance };
      }
    }

    return nearest;
  }
}

export function createParticipationStatus(
  expectedParticipants: number,
  observedLabels: string[]
): ParticipationStatus {
  const expected = Math.max(0, Math.floor(expectedParticipants));
  const uniqueLabels = Array.from(new Set(observedLabels));
  const observed = uniqueLabels.length;
  const missingCount = Math.max(0, expected - observed);

  return {
    expected,
    observed,
    missingCount,
    observedLabels: uniqueLabels,
    needsNudge: missingCount > 0,
    reminder:
      missingCount > 0
        ? `${missingCount} ${missingCount === 1 ? "person has" : "people have"} not been heard yet. Invite quieter voices before moving on.`
        : null
  };
}

export function voiceFeatureDistance(
  left: VoiceFeatures,
  right: VoiceFeatures
): number {
  const centroid = normalizeDifference(
    left.spectralCentroid,
    right.spectralCentroid,
    4000
  );
  const rms = normalizeDifference(left.rms, right.rms, 1);
  const zeroCrossing = normalizeDifference(
    left.zeroCrossingRate,
    right.zeroCrossingRate,
    0.5
  );
  const pitch = normalizeDifference(left.pitch, right.pitch, 300);

  return Math.sqrt(
    (centroid ** 2 * 1.2 + rms ** 2 + zeroCrossing ** 2 + pitch ** 2 * 1.1) /
      4.3
  );
}

export function extractVoiceFeaturesFromFrequencyData(
  frequencyData: Uint8Array,
  timeDomainData: Uint8Array,
  sampleRate: number
): VoiceFeatures {
  const spectralCentroid = calculateSpectralCentroid(frequencyData, sampleRate);
  const rms = calculateRms(timeDomainData);
  const zeroCrossingRate = calculateZeroCrossingRate(timeDomainData);
  const pitch = estimatePitch(timeDomainData, sampleRate);

  return {
    spectralCentroid,
    rms,
    zeroCrossingRate,
    pitch
  };
}

function normalizeDifference(left: number, right: number, range: number): number {
  if (range <= 0) {
    return 0;
  }

  return Math.min(1, Math.abs(left - right) / range);
}

function calculateSpectralCentroid(
  frequencyData: Uint8Array,
  sampleRate: number
): number {
  let weightedSum = 0;
  let magnitudeSum = 0;
  const binWidth = sampleRate / 2 / Math.max(1, frequencyData.length);

  frequencyData.forEach((magnitude, index) => {
    weightedSum += magnitude * index * binWidth;
    magnitudeSum += magnitude;
  });

  return magnitudeSum === 0 ? 0 : weightedSum / magnitudeSum;
}

function calculateRms(timeDomainData: Uint8Array): number {
  const sumSquares = timeDomainData.reduce((sum, value) => {
    const normalized = (value - 128) / 128;
    return sum + normalized * normalized;
  }, 0);

  return Math.sqrt(sumSquares / Math.max(1, timeDomainData.length));
}

function calculateZeroCrossingRate(timeDomainData: Uint8Array): number {
  let crossings = 0;
  let previous = timeDomainData[0] ?? 128;

  for (let index = 1; index < timeDomainData.length; index += 1) {
    const current = timeDomainData[index];
    if ((previous < 128 && current >= 128) || (previous >= 128 && current < 128)) {
      crossings += 1;
    }
    previous = current;
  }

  return crossings / Math.max(1, timeDomainData.length - 1);
}

function estimatePitch(timeDomainData: Uint8Array, sampleRate: number): number {
  let crossings = 0;
  let previous = timeDomainData[0] ?? 128;

  for (let index = 1; index < timeDomainData.length; index += 1) {
    const current = timeDomainData[index];
    if ((previous < 128 && current >= 128) || (previous >= 128 && current < 128)) {
      crossings += 1;
    }
    previous = current;
  }

  if (crossings === 0) {
    return 0;
  }

  return Math.min(320, (crossings * sampleRate) / (2 * timeDomainData.length));
}
