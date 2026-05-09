/**
 * Scripted demo arc for RoomPulse.
 *
 * Drives a 75-second meeting that hits every facilitator card kind in turn:
 * risk → drift → decision → action → participation → agenda close.
 *
 * Designed for live judging: each heartbeat (default 15s) produces a visibly
 * different set of room cues. Timestamps are aligned so the most dramatic
 * lines land just before each pulse fires.
 */

export interface DemoBeat {
  /** Milliseconds from the start of the demo. */
  delayMs: number;
  speaker: string;
  text: string;
}

export const DEMO_HEARTBEAT_INTERVAL_SECONDS = 15;
export const DEMO_EXPECTED_PARTICIPANTS = 4;

export const DEMO_AGENDA = [
  "Confirm the meeting goal",
  "Surface launch risks and blockers",
  "Assign owners and next steps"
];

export const DEMO_PARTICIPANTS = [
  { name: "Mina", role: "PM" },
  { name: "Jules", role: "Support" },
  { name: "Ari", role: "Engineering" },
  { name: "Noor", role: "Design" }
];

export const DEMO_SCRIPT: DemoBeat[] = [
  {
    delayMs: 800,
    speaker: "Speaker 1",
    text: "Let's kick off the launch readiness review. Goal today is owners for every open risk."
  },
  {
    delayMs: 3_200,
    speaker: "Speaker 1",
    text: "That covers confirming the meeting goal."
  },
  {
    delayMs: 5_500,
    speaker: "Speaker 1",
    text: "We still have an unresolved risk around weekend support coverage if traffic spikes."
  },
  {
    delayMs: 11_000,
    speaker: "Speaker 2",
    text: "And the campaign date is fixed. Timeline is tight on our side too."
  },
  {
    delayMs: 18_500,
    speaker: "Speaker 2",
    text: "Maybe we put the support gap in the parking lot for now and focus on marketing?"
  },
  {
    delayMs: 24_500,
    speaker: "Speaker 1",
    text: "No, we need to decide who owns the mitigation today before we move on."
  },
  {
    delayMs: 34_000,
    speaker: "Speaker 3",
    text: "I can take the support coverage piece if we can scope it tight."
  },
  {
    delayMs: 40_500,
    speaker: "Speaker 1",
    text: "Great. What's the rollback plan if we hit issues at peak?"
  },
  {
    delayMs: 45_500,
    speaker: "Speaker 3",
    text: "We don't have one yet. That's another open risk we should track."
  },
  {
    delayMs: 49_000,
    speaker: "Speaker 1",
    text: "We've covered the launch risks and blockers."
  },
  {
    delayMs: 53_000,
    speaker: "Speaker 4",
    text: "Quick one — do we have a comms message ready for the support team?"
  },
  {
    delayMs: 59_000,
    speaker: "Speaker 1",
    text: "Action: Speaker 3 owns mitigation, Speaker 4 owns comms by EOD tomorrow. That covers owners and next steps."
  },
  {
    delayMs: 67_000,
    speaker: "Speaker 1",
    text: "Anything else before we close? Otherwise we're done."
  }
];

export const DEMO_DURATION_MS = 75_000;
