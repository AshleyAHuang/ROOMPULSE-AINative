/**
 * Scripted demo arc for RoomPulse.
 *
 * Drives a roughly 20-minute meeting that hits every facilitator card kind in
 * turn: risk → drift → decision → action → participation → agenda close.
 *
 * The transcript is intentionally paced like a room conversation: pauses,
 * clarifying turns, and decisions unfold over minutes rather than seconds.
 */

export interface DemoBeat {
  /** Milliseconds from the start of the demo. */
  delayMs: number;
  speaker: string;
  text: string;
}

export const DEMO_HEARTBEAT_INTERVAL_SECONDS = 60;
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
    delayMs: 8_000,
    speaker: "Speaker 1",
    text: "Let's kick off the launch readiness review. Goal today is owners for every open risk."
  },
  {
    delayMs: 42_000,
    speaker: "Speaker 1",
    text: "That covers confirming the meeting goal."
  },
  {
    delayMs: 86_000,
    speaker: "Speaker 1",
    text: "We still have an unresolved risk around weekend support coverage if traffic spikes."
  },
  {
    delayMs: 138_000,
    speaker: "Speaker 2",
    text: "And the campaign date is fixed. Timeline is tight on our side too."
  },
  {
    delayMs: 212_000,
    speaker: "Speaker 4",
    text: "Can we separate launch blockers from things that are just nice to have?"
  },
  {
    delayMs: 276_000,
    speaker: "Speaker 2",
    text: "The support gap is a blocker for me. If we do not staff the weekend, escalation will be messy."
  },
  {
    delayMs: 336_000,
    speaker: "Speaker 1",
    text: "Let's stay with that risk for a minute and define what coverage actually means."
  },
  {
    delayMs: 405_000,
    speaker: "Speaker 2",
    text: "Maybe we put the support gap in the parking lot for now and focus on marketing?"
  },
  {
    delayMs: 472_000,
    speaker: "Speaker 1",
    text: "No, we need to decide who owns the mitigation today before we move on."
  },
  {
    delayMs: 545_000,
    speaker: "Speaker 3",
    text: "I can take the support coverage piece if we can scope it tight."
  },
  {
    delayMs: 612_000,
    speaker: "Speaker 1",
    text: "Great. Let's write that as Ari owning the mitigation plan, not the whole support organization."
  },
  {
    delayMs: 676_000,
    speaker: "Speaker 1",
    text: "Great. What's the rollback plan if we hit issues at peak?"
  },
  {
    delayMs: 738_000,
    speaker: "Speaker 3",
    text: "We don't have one yet. That's another open risk we should track."
  },
  {
    delayMs: 798_000,
    speaker: "Speaker 4",
    text: "I can own the support team comms, but I need the risk language by tomorrow morning."
  },
  {
    delayMs: 854_000,
    speaker: "Speaker 2",
    text: "That works. I also want a decision on whether we launch if rollback is still incomplete."
  },
  {
    delayMs: 906_000,
    speaker: "Speaker 1",
    text: "Decision proposal: launch preparation continues, but go or no-go depends on rollback and support coverage by Thursday."
  },
  {
    delayMs: 966_000,
    speaker: "Speaker 3",
    text: "I can bring the rollback draft to the Thursday check."
  },
  {
    delayMs: 1_026_000,
    speaker: "Speaker 1",
    text: "We've covered the launch risks and blockers."
  },
  {
    delayMs: 1_074_000,
    speaker: "Speaker 4",
    text: "Quick one — do we have a comms message ready for the support team?"
  },
  {
    delayMs: 1_128_000,
    speaker: "Speaker 1",
    text: "Action: Speaker 3 owns mitigation, Speaker 4 owns comms by EOD tomorrow. That covers owners and next steps."
  },
  {
    delayMs: 1_176_000,
    speaker: "Speaker 1",
    text: "Anything else before we close? Otherwise we're done."
  }
];

export const DEMO_DURATION_MS = 1_200_000;
