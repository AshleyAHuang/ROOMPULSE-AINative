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
export const MAX_OBSERVED_SPEAKER_LABELS = 24;
export const MAX_SPEAKER_LABEL_LENGTH = 80;
export const MAX_SPEAKER_BADGE_NUMBER = 99;
export const SPEAKER_BADGE_COLOR_COUNT = 6;

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
    const safeFeatures = normalizeVoiceFeatures(features);
    const nearest = this.findNearest(safeFeatures);

    if (!nearest || nearest.distance > this.distanceThreshold) {
      const cluster: SpeakerCluster = {
        id: `speaker-${this.clusters.length + 1}`,
        label: `Speaker ${this.clusters.length + 1}`,
        centroid: { ...safeFeatures },
        samples: 1,
        lastSeenAt: this.now()
      };
      this.clusters.push(cluster);
      return { ...cluster, centroid: { ...cluster.centroid } };
    }

    const cluster = nearest.cluster;
    const samples = cluster.samples + 1;
    const updateWeight = centroidUpdateWeight(
      nearest.distance,
      this.distanceThreshold,
      samples
    );
    cluster.centroid = {
      spectralCentroid:
        cluster.centroid.spectralCentroid * (1 - updateWeight) +
        safeFeatures.spectralCentroid * updateWeight,
      rms:
        cluster.centroid.rms * (1 - updateWeight) +
        safeFeatures.rms * updateWeight,
      zeroCrossingRate:
        cluster.centroid.zeroCrossingRate * (1 - updateWeight) +
        safeFeatures.zeroCrossingRate * updateWeight,
      pitch:
        cluster.centroid.pitch * (1 - updateWeight) +
        safeFeatures.pitch * updateWeight
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

function centroidUpdateWeight(
  distance: number,
  threshold: number,
  samples: number
): number {
  const averageWeight = 1 / Math.max(1, samples);
  if (threshold <= 0) {
    return averageWeight;
  }

  const confidence = Math.max(0, Math.min(1, 1 - distance / threshold));
  const guardedWeight = 0.04 + confidence * 0.46;
  return Math.min(averageWeight, guardedWeight);
}

export function createParticipationStatus(
  expectedParticipants: number,
  observedLabels: string[]
): ParticipationStatus {
  const expected = Number.isFinite(expectedParticipants)
    ? Math.min(
        MAX_OBSERVED_SPEAKER_LABELS,
        Math.max(0, Math.floor(expectedParticipants))
      )
    : 0;
  const uniqueLabels = normalizeObservedSpeakerLabels(observedLabels);
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

export function normalizeObservedSpeakerLabels(observedLabels: string[]): string[] {
  const uniqueLabels: string[] = [];
  const seen = new Set<string>();

  for (const rawLabel of observedLabels) {
    const label = normalizeSpeakerLabel(rawLabel);
    if (!label || seen.has(label)) {
      continue;
    }

    seen.add(label);
    uniqueLabels.push(label);
    if (uniqueLabels.length >= MAX_OBSERVED_SPEAKER_LABELS) {
      break;
    }
  }

  return uniqueLabels;
}

export function normalizeSpeakerLabel(value: string): string | null {
  const compacted = value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!compacted) {
    return null;
  }

  const numberedSpeakerMatch = compacted.match(/^speaker\s+0*(\d+)$/i);
  if (numberedSpeakerMatch) {
    const speakerNumber = Number(numberedSpeakerMatch[1]);
    if (Number.isSafeInteger(speakerNumber) && speakerNumber > 0) {
      return `Speaker ${speakerNumber}`;
    }
    return null;
  }

  if (compacted.length <= MAX_SPEAKER_LABEL_LENGTH) {
    return compacted;
  }

  return `${compacted.slice(0, MAX_SPEAKER_LABEL_LENGTH - 3)}...`;
}

export function speakerBadgeNumber(label: string): number {
  const normalizedLabel = normalizeSpeakerLabel(label);
  const match = normalizedLabel?.match(/^Speaker (\d+)$/);
  const value = match ? Number(match[1]) : 1;
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function speakerBadgeLabel(label: string): string {
  const value = speakerBadgeNumber(label);
  return value > MAX_SPEAKER_BADGE_NUMBER
    ? `S${MAX_SPEAKER_BADGE_NUMBER}+`
    : `S${value}`;
}

export function speakerBadgeClass(label: string): string {
  const value = speakerBadgeNumber(label);
  const colorNumber = ((value - 1) % SPEAKER_BADGE_COLOR_COUNT) + 1;
  return `speaker-${colorNumber}`;
}

export function isSafeSpeakerLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= MAX_SPEAKER_LABEL_LENGTH &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
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
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return 1;
  }

  return Math.min(1, Math.abs(left - right) / range);
}

function normalizeVoiceFeatures(features: VoiceFeatures): VoiceFeatures {
  return {
    spectralCentroid: finiteOrZero(features.spectralCentroid),
    rms: finiteOrZero(features.rms),
    zeroCrossingRate: finiteOrZero(features.zeroCrossingRate),
    pitch: finiteOrZero(features.pitch)
  };
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
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
