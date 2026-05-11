import { describe, expect, it } from "vitest";
import {
  MAX_FACILITATOR_CARD_TEXT_LENGTH,
  MAX_FACILITATOR_OUTPUT_CARDS,
  MAX_FACILITATOR_OUTPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_HISTORY_ITEMS,
  MAX_HEARTBEAT_INPUT_TEXT_LENGTH,
  MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH,
  MAX_HEARTBEAT_REVIEW_VERSIONS,
  MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES,
  MAX_HEARTBEAT_TRANSCRIPT_DELTA_LINES,
  applyAgendaCoverage,
  capFacilitatorOutput,
  createHeartbeatInput,
  runLocalFacilitation,
  type FacilitatorOutput,
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

  it("bounds long heartbeat history before it reaches facilitator adapters", () => {
    const longTranscript: TranscriptLine[] = Array.from(
      { length: MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES + 30 },
      (_, index) => ({
        id: `line-${index + 1}`,
        speakerId: `speaker-${(index % 4) + 1}`,
        speakerLabel: `Speaker ${(index % 4) + 1}`,
        text: `Transcript line ${index + 1}`,
        timestamp: (index + 1) * 1_000,
        source: "simulated",
        confidence: 1
      })
    );
    const lastHeartbeatAt =
      longTranscript[longTranscript.length - 4].timestamp - 1;

    const input = createHeartbeatInput({
      meeting,
      transcript: longTranscript,
      observedSpeakerLabels: ["Speaker 1", "Speaker 2"],
      lastHeartbeatAt,
      now: longTranscript.at(-1)!.timestamp + 1_000,
      priorInterventions: Array.from(
        { length: MAX_HEARTBEAT_HISTORY_ITEMS + 5 },
        (_, index) => ({
          id: `pulse-${index + 1}`,
          timestamp: index + 1,
          source: "pi" as const,
          cards: [],
          summary: `Prior heartbeat ${index + 1}`
        })
      ),
      reviewVersions: Array.from(
        { length: MAX_HEARTBEAT_REVIEW_VERSIONS + 5 },
        (_, index) => ({
          id: `review-${index + 1}`,
          timestamp: index + 1,
          source: "pi" as const,
          markdown: [
            `# Review ${index + 1}`,
            "Opening version context.",
            "Historical detail.\n".repeat(900),
            "Closing version context."
          ].join("\n"),
          summary: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 10)
        })
      )
    });

    expect(input.transcript).toHaveLength(MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES + 4);
    expect(input.transcript.map((line) => line.id)).not.toContain("line-1");
    expect(input.transcriptDelta.map((line) => line.id)).toEqual([
      `line-${MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES + 27}`,
      `line-${MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES + 28}`,
      `line-${MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES + 29}`,
      `line-${MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES + 30}`
    ]);
    expect(input.priorInterventions).toHaveLength(MAX_HEARTBEAT_HISTORY_ITEMS);
    expect(input.priorInterventions.map((entry) => entry.id)).toEqual([
      "pulse-11",
      "pulse-10",
      "pulse-9",
      "pulse-8",
      "pulse-7",
      "pulse-6"
    ]);
    expect(input.reviewVersions).toHaveLength(MAX_HEARTBEAT_REVIEW_VERSIONS);
    expect(input.reviewVersions.map((version) => version.id)).toEqual([
      "review-9",
      "review-8",
      "review-7",
      "review-6"
    ]);
    expect(input.reviewVersions[0].markdown.length).toBeLessThanOrEqual(4_000);
    expect(input.reviewVersions[0].markdown).toContain(
      "RoomPulse omitted middle review content"
    );
    expect(input.reviewVersions[0].summary).toHaveLength(
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    );
  });

  it("caps oversized fresh transcript delta lines while keeping the latest context", () => {
    const longTranscript: TranscriptLine[] = Array.from(
      { length: MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES + 170 },
      (_, index) => ({
        id: `line-${index + 1}`,
        speakerId: `speaker-${(index % 4) + 1}`,
        speakerLabel: `Speaker ${(index % 4) + 1}`,
        text: `Transcript line ${index + 1}`,
        timestamp: (index + 1) * 1_000,
        source: "speech",
        confidence: 0.9
      })
    );
    const firstFreshIndex = MAX_HEARTBEAT_TRANSCRIPT_CONTEXT_LINES + 1;
    const input = createHeartbeatInput({
      meeting,
      transcript: longTranscript,
      observedSpeakerLabels: ["Speaker 1", "Speaker 2"],
      lastHeartbeatAt: longTranscript[firstFreshIndex - 2].timestamp,
      now: longTranscript.at(-1)!.timestamp + 1_000,
      priorInterventions: []
    });

    expect(input.transcript.length).toBeLessThan(longTranscript.length);
    expect(input.transcriptDelta).toHaveLength(
      MAX_HEARTBEAT_TRANSCRIPT_DELTA_LINES
    );
    expect(input.transcriptDelta[0]?.id).toBe(
      `line-${longTranscript.length - MAX_HEARTBEAT_TRANSCRIPT_DELTA_LINES + 1}`
    );
    expect(input.transcriptDelta.at(-1)?.id).toBe(
      `line-${longTranscript.length}`
    );
  });

  it("caps heartbeat history text and cards before adapters see it", () => {
    const input = createHeartbeatInput({
      meeting,
      transcript,
      observedSpeakerLabels: ["Speaker 1", "Speaker 2"],
      lastHeartbeatAt: 0,
      now: 3_000,
      priorInterventions: [
        {
          id: "bloated-pulse",
          timestamp: 2_500,
          source: "pi",
          cards: Array.from({ length: MAX_FACILITATOR_OUTPUT_CARDS + 4 }, (_, index) => ({
            id: `card-${index + 1}`,
            kind: "heartbeat" as const,
            title: "T".repeat(MAX_FACILITATOR_CARD_TEXT_LENGTH + 10),
            body: "B".repeat(MAX_FACILITATOR_CARD_TEXT_LENGTH + 10),
            priority: "medium" as const
          })),
          summary: "S".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 10),
          reminder: "R".repeat(MAX_FACILITATOR_OUTPUT_TEXT_LENGTH + 10),
          reviewMarkdown: [
            "# Large historical review",
            "Timeline opening.",
            "Timeline middle.\n".repeat(900),
            "Timeline closing."
          ].join("\n")
        }
      ]
    });

    expect(input.priorInterventions[0].cards).toHaveLength(
      MAX_FACILITATOR_OUTPUT_CARDS
    );
    expect(input.priorInterventions[0].cards[0].title).toHaveLength(
      MAX_FACILITATOR_CARD_TEXT_LENGTH
    );
    expect(input.priorInterventions[0].cards[0].body).toHaveLength(
      MAX_FACILITATOR_CARD_TEXT_LENGTH
    );
    expect(input.priorInterventions[0].summary).toHaveLength(
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    );
    expect(input.priorInterventions[0].reminder).toHaveLength(
      MAX_FACILITATOR_OUTPUT_TEXT_LENGTH
    );
    expect(input.priorInterventions[0].reviewMarkdown?.length).toBeLessThanOrEqual(
      4_000
    );
    expect(input.priorInterventions[0].reviewMarkdown).toContain(
      "RoomPulse omitted middle review content"
    );
  });

  it("caps oversized meeting and transcript text before adapters see it", () => {
    const input = createHeartbeatInput({
      meeting: {
        ...meeting,
        title: "T".repeat(2_000),
        goal: "G".repeat(2_000),
        context: "C".repeat(2_000),
        agenda: [
          {
            id: "a1",
            title: "A".repeat(2_000),
            done: false
          }
        ],
        participants: [
          {
            name: "N".repeat(2_000),
            role: "R".repeat(2_000)
          }
        ]
      },
      transcript: [
        {
          id: "long-line",
          speakerId: "speaker-1",
          speakerLabel: "Speaker 1",
          text: "Transcript ".repeat(300),
          timestamp: 1_000,
          source: "speech",
          confidence: 0.9
        }
      ],
      observedSpeakerLabels: ["Speaker 1"],
      lastHeartbeatAt: 0,
      now: 2_000,
      priorInterventions: []
    });

    expect(input.meeting.title).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(input.meeting.goal).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(input.meeting.context).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
    expect(input.meeting.agenda[0].title).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(input.meeting.participants[0].name).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(input.meeting.participants[0].role).toHaveLength(
      MAX_HEARTBEAT_INPUT_TEXT_LENGTH
    );
    expect(input.transcript[0].text).toHaveLength(MAX_HEARTBEAT_INPUT_TEXT_LENGTH);
  });

  it("trims meeting text before capping it for adapters and storage", () => {
    const input = createHeartbeatInput({
      meeting: {
        ...meeting,
        title: `${" ".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 5)}Recovered title`,
        goal: `${" ".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 5)}Recovered goal`,
        context: `${" ".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 5)}Recovered context`,
        agenda: [
          {
            id: "a1",
            title: `${" ".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 5)}Recovered agenda`,
            done: false
          }
        ],
        participants: [
          {
            name: `${" ".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 5)}Recovered name`,
            role: `${" ".repeat(MAX_HEARTBEAT_INPUT_TEXT_LENGTH + 5)}Recovered role`
          }
        ]
      },
      transcript,
      observedSpeakerLabels: ["Speaker 1"],
      lastHeartbeatAt: 0,
      now: 2_000,
      priorInterventions: []
    });

    expect(input.meeting.title).toBe("Recovered title");
    expect(input.meeting.goal).toBe("Recovered goal");
    expect(input.meeting.context).toBe("Recovered context");
    expect(input.meeting.agenda[0].title).toBe("Recovered agenda");
    expect(input.meeting.participants[0].name).toBe("Recovered name");
    expect(input.meeting.participants[0].role).toBe("Recovered role");
  });

  it("strips extra fields before heartbeat adapters see compacted input", () => {
    const input = createHeartbeatInput({
      meeting: {
        ...meeting,
        debug: "meeting-debug",
        agenda: [{ ...meeting.agenda[0], debug: "agenda-debug" }],
        participants: [{ ...meeting.participants[0], debug: "participant-debug" }]
      } as unknown as MeetingConfig,
      transcript: [
        {
          ...transcript[0],
          debug: "transcript-debug"
        } as unknown as TranscriptLine
      ],
      observedSpeakerLabels: ["Speaker 1"],
      lastHeartbeatAt: 0,
      now: 2_000,
      priorInterventions: [
        {
          id: "pulse-extra",
          timestamp: 1_500,
          source: "pi" as const,
          cards: [
            {
              id: "card-extra",
              kind: "heartbeat" as const,
              title: "Heartbeat",
              body: "Keep going.",
              priority: "medium" as const,
              debug: "card-debug"
            } as unknown as FacilitatorOutput["cards"][number]
          ],
          summary: "Prior pulse.",
          debug: "timeline-debug"
        } as unknown as Parameters<typeof createHeartbeatInput>[0]["priorInterventions"][number]
      ],
      reviewVersions: [
        {
          id: "review-extra",
          timestamp: 1_000,
          source: "pi" as const,
          markdown: "# Review",
          summary: "Review.",
          debug: "review-debug"
        } as unknown as NonNullable<
          Parameters<typeof createHeartbeatInput>[0]["reviewVersions"]
        >[number]
      ]
    });

    expect("debug" in input.meeting).toBe(false);
    expect("debug" in input.meeting.agenda[0]).toBe(false);
    expect("debug" in input.meeting.participants[0]).toBe(false);
    expect("debug" in input.transcript[0]).toBe(false);
    expect("debug" in input.priorInterventions[0]).toBe(false);
    expect("debug" in input.priorInterventions[0].cards[0]).toBe(false);
    expect("debug" in input.reviewVersions[0]).toBe(false);
  });

  it("compacts oversized current review markdown before adapters see it", () => {
    const input = createHeartbeatInput({
      meeting,
      transcript,
      observedSpeakerLabels: ["Speaker 1"],
      lastHeartbeatAt: 0,
      now: 2_000,
      priorInterventions: [],
      currentReviewMarkdown: [
        "# Oversized review",
        "",
        "Opening review state that must remain visible.",
        "Middle section.\n".repeat(900),
        "Closing review state that must remain visible."
      ].join("\n")
    });

    expect(input.currentReviewMarkdown.length).toBeLessThanOrEqual(4_000);
    expect(input.currentReviewMarkdown).toContain(
      "Opening review state that must remain visible."
    );
    expect(input.currentReviewMarkdown).toContain(
      "Closing review state that must remain visible."
    );
    expect(input.currentReviewMarkdown).toContain(
      "RoomPulse omitted middle review content"
    );
  });

  it("normalizes transcript speaker labels before heartbeat prompt construction", () => {
    const input = createHeartbeatInput({
      meeting,
      transcript: [
        {
          id: "unsafe-label",
          speakerId: "speaker-1",
          speakerLabel: ` ${"Speaker 1 ".repeat(30)} `,
          text: "This line came from restored state with a bloated label.",
          timestamp: 1_000,
          source: "speech",
          confidence: 0.9
        },
        {
          id: "multiline-label",
          speakerId: "speaker-2",
          speakerLabel: "Speaker\n2",
          text: "This line should keep a compact speaker label.",
          timestamp: 2_000,
          source: "speech",
          confidence: 0.9
        }
      ],
      observedSpeakerLabels: ["Speaker 1", "Speaker 2"],
      lastHeartbeatAt: 0,
      now: 3_000,
      priorInterventions: []
    });

    expect(input.transcript[0].speakerLabel).toHaveLength(80);
    expect(input.transcript[0].speakerLabel.endsWith("...")).toBe(true);
    expect(input.transcript[1].speakerLabel).toBe("Speaker 2");
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

  it("local fallback does not leak heartbeat compaction markers into visible review markdown", async () => {
    const input = createHeartbeatInput({
      meeting,
      transcript,
      observedSpeakerLabels: ["Speaker 1"],
      lastHeartbeatAt: 0,
      now: 3_000,
      priorInterventions: [],
      currentReviewMarkdown: [
        "# Visible review",
        "",
        "Opening room-visible review state.",
        "Middle room-visible detail.\n".repeat(900),
        "Closing room-visible review state."
      ].join("\n")
    });

    const output = await runLocalFacilitation(input);

    expect(input.currentReviewMarkdown).toContain(
      "RoomPulse omitted middle review content"
    );
    expect(output.reviewMarkdown).not.toContain(
      "RoomPulse omitted middle review content"
    );
  });

  it("caps local fallback room-facing output text", async () => {
    const longMeeting: MeetingConfig = {
      ...meeting,
      title: "T".repeat(1_000),
      goal: "G".repeat(1_000),
      agenda: [{ id: "a1", title: "A".repeat(1_000), done: false }]
    };
    const input = createHeartbeatInput({
      meeting: longMeeting,
      transcript: [],
      observedSpeakerLabels: [],
      lastHeartbeatAt: 0,
      now: 1_000,
      priorInterventions: []
    });

    const output = await runLocalFacilitation(input);

    expect(output.cards.every((card) => card.title.length <= 280)).toBe(true);
    expect(output.cards.every((card) => card.body.length <= 280)).toBe(true);
    expect(output.summary.length).toBeLessThanOrEqual(500);
    expect(output.nextHeartbeatHint.length).toBeLessThanOrEqual(500);
    expect(output.ephemeralReminder?.length ?? 0).toBeLessThanOrEqual(500);
  });

  it("keeps the latest review document tool action when capping UI actions", () => {
    const output: FacilitatorOutput = {
      source: "pi",
      cards: [
        {
          id: "card-1",
          kind: "heartbeat",
          title: "Heartbeat",
          body: "Keep going.",
          priority: "medium"
        }
      ],
      summary: "Many actions.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Latest review",
      agendaActions: [],
      uiActions: [
        {
          tool: "update_review_document",
          parameters: { markdown: "# Old review" },
          reason: "Older review."
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          tool: "send_room_reminder" as const,
          parameters: { message: `Reminder ${index + 1}` },
          reason: `Reminder ${index + 1}.`
        })),
        {
          tool: "update_review_document",
          parameters: { markdown: "# Latest review" },
          reason: "Latest review."
        }
      ],
      ephemeralReminder: null
    };

    const capped = capFacilitatorOutput(output);

    expect(capped.uiActions).toHaveLength(8);
    expect(
      capped.uiActions.filter((action) => action.tool === "update_review_document")
    ).toEqual([
      {
        tool: "update_review_document",
        parameters: { markdown: "# Latest review" },
        reason: "Latest review."
      }
    ]);
  });

  it("strips extra fields while capping facilitator output", () => {
    const output = {
      source: "pi",
      cards: [
        {
          id: "card-extra",
          kind: "heartbeat",
          title: "Heartbeat",
          body: "Keep going.",
          priority: "medium",
          debug: "card-debug"
        }
      ],
      summary: "Output.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Review",
      agendaActions: [
        {
          itemId: "a1",
          done: true,
          reason: "Done.",
          debug: "agenda-debug"
        }
      ],
      uiActions: [
        {
          tool: "send_room_reminder",
          parameters: { message: "Invite quiet voices." },
          reason: "Reminder.",
          debug: "ui-debug"
        }
      ],
      ephemeralReminder: null,
      debug: "output-debug"
    } as unknown as FacilitatorOutput;

    const capped = capFacilitatorOutput(output);

    expect("debug" in capped).toBe(false);
    expect("debug" in capped.cards[0]).toBe(false);
    expect("debug" in capped.agendaActions[0]).toBe(false);
    expect("debug" in capped.uiActions[0]).toBe(false);
  });

  it("compacts oversized facilitator review documents before returning output", () => {
    const oversizedMarkdown = [
      "# Oversized review",
      "Opening context.",
      "Middle context.\n".repeat(900),
      "Closing decisions."
    ].join("\n");
    const output: FacilitatorOutput = {
      source: "pi",
      cards: [
        {
          id: "card-1",
          kind: "heartbeat",
          title: "Heartbeat",
          body: "Keep going.",
          priority: "medium"
        }
      ],
      summary: "Large review.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: oversizedMarkdown,
      agendaActions: [],
      uiActions: [
        {
          tool: "update_review_document",
          parameters: { markdown: oversizedMarkdown },
          reason: "Pi returned a long document."
        }
      ],
      ephemeralReminder: null
    };

    const capped = capFacilitatorOutput(output);

    expect(capped.reviewMarkdown.length).toBeLessThanOrEqual(
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    );
    expect(capped.reviewMarkdown).not.toContain(
      "RoomPulse omitted middle review content"
    );
    expect(
      String(capped.uiActions[0].parameters.markdown).length
    ).toBeLessThanOrEqual(
      MAX_HEARTBEAT_REVIEW_MARKDOWN_LENGTH
    );
    expect(capped.uiActions[0].parameters.markdown).not.toContain(
      "RoomPulse omitted middle review content"
    );
  });

  it("drops UI actions that are missing required parameters while capping output", () => {
    const output: FacilitatorOutput = {
      source: "pi",
      cards: [
        {
          id: "card-1",
          kind: "heartbeat",
          title: "Heartbeat",
          body: "Keep going.",
          priority: "medium"
        }
      ],
      summary: "Malformed actions.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Review",
      agendaActions: [],
      uiActions: [
        {
          tool: "send_room_reminder",
          parameters: {},
          reason: "Missing message."
        },
        {
          tool: "set_agenda_item",
          parameters: { itemId: "a1" },
          reason: "Missing done flag."
        },
        {
          tool: "update_review_document",
          parameters: { summary: "Missing markdown." },
          reason: "Missing markdown."
        },
        {
          tool: "open_external_url" as never,
          parameters: { url: "https://example.test" },
          reason: "Unknown UI tool."
        },
        {
          tool: "send_room_reminder",
          parameters: { message: "Invite quiet voices." },
          reason: "Valid reminder."
        }
      ],
      ephemeralReminder: null
    };

    expect(capFacilitatorOutput(output).uiActions).toEqual([
      {
        tool: "send_room_reminder",
        parameters: { message: "Invite quiet voices." },
        reason: "Valid reminder."
      }
    ]);
  });

  it("drops UI actions with malformed parameter containers while capping output", () => {
    const output = {
      source: "pi",
      cards: [
        {
          id: "card-1",
          kind: "heartbeat",
          title: "Heartbeat",
          body: "Keep going.",
          priority: "medium"
        }
      ],
      summary: "Malformed actions.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Review",
      agendaActions: [],
      uiActions: [
        {
          tool: "send_room_reminder",
          parameters: null,
          reason: "Null parameters."
        },
        {
          tool: "update_review_document",
          parameters: "markdown",
          reason: "String parameters."
        },
        {
          tool: "send_room_reminder",
          parameters: { message: "Invite quiet voices." },
          reason: "Valid reminder."
        }
      ],
      ephemeralReminder: null
    } as unknown as FacilitatorOutput;

    expect(capFacilitatorOutput(output).uiActions).toEqual([
      {
        tool: "send_room_reminder",
        parameters: { message: "Invite quiet voices." },
        reason: "Valid reminder."
      }
    ]);
  });

  it("deduplicates agenda actions by item id while keeping the latest state", () => {
    const output: FacilitatorOutput = {
      source: "pi",
      cards: [
        {
          id: "card-1",
          kind: "agenda",
          title: "Agenda",
          body: "Update agenda state.",
          priority: "medium"
        }
      ],
      summary: "Agenda actions.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Review",
      agendaActions: [
        { itemId: "a1", done: true, reason: "Older completion." },
        { itemId: "a2", done: true, reason: "Only update." },
        { itemId: "a1", done: false, reason: "Latest reopening." }
      ],
      uiActions: [],
      ephemeralReminder: null
    };

    expect(capFacilitatorOutput(output).agendaActions).toEqual([
      { itemId: "a1", done: false, reason: "Latest reopening." },
      { itemId: "a2", done: true, reason: "Only update." }
    ]);
  });

  it("drops malformed agenda actions while capping facilitator output", () => {
    const output = {
      source: "pi",
      cards: [
        {
          id: "card-1",
          kind: "agenda",
          title: "Agenda",
          body: "Update agenda state.",
          priority: "medium"
        }
      ],
      summary: "Agenda actions.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Review",
      agendaActions: [
        null,
        {
          itemId: null,
          done: true,
          reason: "Bad item id."
        },
        {
          itemId: "a1",
          done: "true",
          reason: "Bad done flag."
        },
        {
          itemId: "a2",
          done: false,
          reason: "Valid action."
        }
      ],
      uiActions: [],
      ephemeralReminder: null
    } as unknown as FacilitatorOutput;

    expect(capFacilitatorOutput(output).agendaActions).toEqual([
      { itemId: "a2", done: false, reason: "Valid action." }
    ]);
  });

  it("keeps capped facilitator card ids unique for stable rendering", () => {
    const output: FacilitatorOutput = {
      source: "pi",
      cards: [
        {
          id: "duplicate-card",
          kind: "heartbeat",
          title: "First",
          body: "First cue.",
          priority: "medium"
        },
        {
          id: "duplicate-card",
          kind: "risk",
          title: "Second",
          body: "Second cue.",
          priority: "high"
        },
        {
          id: "duplicate-card-2",
          kind: "agenda",
          title: "Existing suffix",
          body: "Existing suffix should not collide.",
          priority: "medium"
        }
      ],
      summary: "Duplicate cards.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Review",
      agendaActions: [],
      uiActions: [],
      ephemeralReminder: null
    };

    expect(capFacilitatorOutput(output).cards.map((card) => card.id)).toEqual([
      "duplicate-card",
      "duplicate-card-3",
      "duplicate-card-2"
    ]);
  });

  it("drops malformed cards while capping facilitator output", () => {
    const output = {
      source: "pi",
      cards: [
        null,
        {
          id: "unknown-kind",
          kind: "external",
          title: "Unknown",
          body: "Unknown card kind.",
          priority: "medium"
        },
        {
          id: "bad-priority",
          kind: "heartbeat",
          title: "Bad priority",
          body: "Priority should be known.",
          priority: "urgent"
        },
        {
          id: "valid-card",
          kind: "heartbeat",
          title: "Heartbeat",
          body: "Keep going.",
          priority: "medium"
        }
      ],
      summary: "Cards.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Review",
      agendaActions: [],
      uiActions: [],
      ephemeralReminder: null
    } as unknown as FacilitatorOutput;

    expect(capFacilitatorOutput(output).cards).toEqual([
      {
        id: "valid-card",
        kind: "heartbeat",
        title: "Heartbeat",
        body: "Keep going.",
        priority: "medium"
      }
    ]);
  });

  it("drops blank facilitator cards while capping output", () => {
    const output = {
      source: "pi",
      cards: [
        {
          id: "blank-title",
          kind: "heartbeat",
          title: "   ",
          body: "No room-facing title.",
          priority: "medium"
        },
        {
          id: "blank-body",
          kind: "risk",
          title: "Risk",
          body: "",
          priority: "high"
        },
        {
          id: "valid-card",
          kind: "heartbeat",
          title: "  Heartbeat  ",
          body: "  Keep going.  ",
          priority: "medium"
        }
      ],
      summary: "Cards.",
      nextHeartbeatHint: "Continue.",
      reviewMarkdown: "# Review",
      agendaActions: [],
      uiActions: [],
      ephemeralReminder: null
    } as unknown as FacilitatorOutput;

    expect(capFacilitatorOutput(output).cards).toEqual([
      {
        id: "valid-card",
        kind: "heartbeat",
        title: "Heartbeat",
        body: "Keep going.",
        priority: "medium"
      }
    ]);
  });

  it("normalizes malformed top-level facilitator output fields", () => {
    const output = {
      source: "external-agent",
      cards: null,
      summary: null,
      nextHeartbeatHint: { text: "Continue." },
      reviewMarkdown: null,
      agendaActions: "agenda",
      uiActions: "actions",
      ephemeralReminder: 42,
      adapterNotice: { message: "bad notice" }
    } as unknown as FacilitatorOutput;

    expect(capFacilitatorOutput(output)).toEqual({
      source: "local-fallback",
      cards: [],
      summary: "",
      nextHeartbeatHint: "",
      reviewMarkdown: "",
      agendaActions: [],
      uiActions: [],
      ephemeralReminder: null
    });
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

  it("does not mark the active agenda item done for unrelated decisions", async () => {
    const input = createHeartbeatInput({
      meeting,
      transcript: [
        {
          id: "t6",
          speakerId: "speaker-1",
          speakerLabel: "Speaker 1",
          text: "We decided the lunch order is settled, but we have not assigned the launch risk owner.",
          timestamp: 6_000,
          source: "simulated",
          confidence: 1
        }
      ],
      observedSpeakerLabels: ["Speaker 1"],
      lastHeartbeatAt: 5_000,
      now: 7_000,
      priorInterventions: []
    });

    const output = await runLocalFacilitation(input);

    expect(output.agendaActions).not.toContainEqual(
      expect.objectContaining({ itemId: "a2", done: true })
    );
  });

  it("does not complete short agenda titles without title evidence", async () => {
    const shortTitleMeeting: MeetingConfig = {
      ...meeting,
      agenda: [{ id: "qa", title: "QA", done: false }]
    };
    const input = createHeartbeatInput({
      meeting: shortTitleMeeting,
      transcript: [
        {
          id: "t7",
          speakerId: "speaker-1",
          speakerLabel: "Speaker 1",
          text: "That unrelated question is resolved.",
          timestamp: 7_000,
          source: "simulated",
          confidence: 1
        }
      ],
      observedSpeakerLabels: ["Speaker 1"],
      lastHeartbeatAt: 6_000,
      now: 8_000,
      priorInterventions: []
    });

    const output = await runLocalFacilitation(input);

    expect(output.agendaActions).toEqual([]);
  });
});
