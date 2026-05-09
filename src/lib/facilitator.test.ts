import { describe, expect, it } from "vitest";
import {
  applyAgendaCoverage,
  createHeartbeatInput,
  runLocalFacilitation,
  type MeetingConfig,
  type TranscriptLine
} from "./facilitator";

const meeting: MeetingConfig = {
  title: "Q3 launch planning",
  goal: "Choose the launch risk owner and next milestone",
  context: "The campaign date is fixed and support coverage is tight.",
  agenda: [
    { id: "a1", title: "Confirm launch date", done: true },
    { id: "a2", title: "Assign risk owner", done: false },
    { id: "a3", title: "Agree support plan", done: false }
  ],
  expectedParticipants: 4,
  participants: [
    { name: "Mina", role: "PM" },
    { name: "Jules", role: "Support" }
  ],
  heartbeatIntervalSeconds: 45
};

const transcript: TranscriptLine[] = [
  {
    id: "t1",
    speakerId: "speaker-1",
    speakerLabel: "Speaker 1",
    text: "We still have an unresolved risk around support staffing.",
    timestamp: 1_000,
    source: "simulated",
    confidence: 1
  },
  {
    id: "t2",
    speakerId: "speaker-2",
    speakerLabel: "Speaker 2",
    text: "Can we decide who owns that before we talk about launch swag?",
    timestamp: 2_000,
    source: "simulated",
    confidence: 1
  }
];

describe("heartbeat facilitation", () => {
  it("builds heartbeat input with only transcript lines since the last heartbeat", () => {
    const input = createHeartbeatInput({
      meeting,
      transcript,
      observedSpeakerLabels: ["Speaker 1", "Speaker 2"],
      lastHeartbeatAt: 1_500,
      now: 3_000,
      priorInterventions: []
    });

    expect(input.transcriptDelta.map((line) => line.id)).toEqual(["t2"]);
    expect(input.participation).toMatchObject({
      expected: 4,
      observed: 2,
      missingCount: 2,
      needsNudge: true
    });
    expect(input.agendaProgress).toEqual({
      total: 3,
      completed: 1,
      active: meeting.agenda[1]
    });
  });

  it("local fallback returns deterministic facilitator cards and participation nudges", async () => {
    const input = createHeartbeatInput({
      meeting,
      transcript,
      observedSpeakerLabels: ["Speaker 1", "Speaker 2"],
      lastHeartbeatAt: 0,
      now: 3_000,
      priorInterventions: []
    });

    const output = await runLocalFacilitation(input);

    expect(output.source).toBe("local-fallback");
    expect(output.cards.map((card) => card.kind)).toContain("participation");
    expect(output.cards.map((card) => card.kind)).toContain("risk");
    expect(output.cards[0].title).toBe("Heartbeat check");
    expect(output.summary).toContain("Q3 launch planning");
    expect(output.nextHeartbeatHint).toBe(
      'Next check should revisit "Assign risk owner".'
    );
  });

  it("auto-checks an agenda item when transcript says it was covered", () => {
    const updated = applyAgendaCoverage(meeting.agenda, [
      {
        id: "t3",
        speakerId: "speaker-1",
        speakerLabel: "Speaker 1",
        text: "That covers assigning the risk owner. Let's keep going.",
        timestamp: 3_000,
        source: "simulated",
        confidence: 1
      }
    ]);

    expect(updated.find((item) => item.id === "a2")?.done).toBe(true);
    expect(updated.find((item) => item.id === "a3")?.done).toBe(false);
  });

  it("does not auto-check an agenda item when coverage is explicitly negated", () => {
    const updated = applyAgendaCoverage(meeting.agenda, [
      {
        id: "t4",
        speakerId: "speaker-1",
        speakerLabel: "Speaker 1",
        text: "We have not covered the support plan yet.",
        timestamp: 4_000,
        source: "simulated",
        confidence: 1
      }
    ]);

    expect(updated).toBe(meeting.agenda);
    expect(updated.find((item) => item.id === "a3")?.done).toBe(false);
  });

  it("does not check a different agenda item just because one line contains a coverage cue", () => {
    const agenda = [
      { id: "a1", title: "Review blockers", done: false },
      { id: "a2", title: "Assign owners", done: false }
    ];
    const updated = applyAgendaCoverage(agenda, [
      {
        id: "t5",
        speakerId: "speaker-1",
        speakerLabel: "Speaker 1",
        text: "We've covered blockers. Next we should assign owners.",
        timestamp: 5_000,
        source: "simulated",
        confidence: 1
      }
    ]);

    expect(updated.find((item) => item.id === "a1")?.done).toBe(true);
    expect(updated.find((item) => item.id === "a2")?.done).toBe(false);
  });
});
