"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  applyAgendaCoverage,
  createHeartbeatInput,
  createInitialReviewMarkdown,
  getAgendaProgress,
  type AgendaItem,
  type FacilitatorOutput,
  type MeetingConfig,
  type ReviewVersion,
  type TimelineEntry,
  type TranscriptLine,
  type UiAction
} from "@/lib/facilitator";
import { createParticipationStatus } from "@/lib/speaker-tracker";
import { LocalTranscriptionClient } from "@/lib/local-transcription-client";
import { TranscriptStore } from "@/lib/transcript-store";
import {
  DEMO_AGENDA,
  DEMO_DURATION_MS,
  DEMO_EXPECTED_PARTICIPANTS,
  DEMO_HEARTBEAT_INTERVAL_SECONDS,
  DEMO_PARTICIPANTS,
  DEMO_SCRIPT
} from "@/lib/demo-script";

type Phase = "setup" | "meeting";
type TranscriptMode = "demo" | "mic";

interface ClientMeetingLogMetadata {
  id: string;
  title: string;
  goal: string;
  startedAt: number;
  updatedAt: number;
  eventCount: number;
}

interface ClientMeetingLogEvent {
  id: string;
  type: string;
  timestamp: number;
  payload: unknown;
}

interface ClientMeetingLogSnapshot {
  metadata: ClientMeetingLogMetadata;
  events: ClientMeetingLogEvent[];
}

interface PendingMeetingLogEvent {
  type: string;
  timestamp: number;
  payload: unknown;
}

const defaultMeeting: MeetingConfig = {
  title: "Product readiness review",
  goal: "Leave with owners for the open launch risks.",
  context:
    "The room needs visible reminders, concise risk surfacing, and a participation check every heartbeat.",
  agenda: [
    { id: "agenda-1", title: "Confirm the meeting goal", done: false },
    { id: "agenda-2", title: "List open risks and blockers", done: false },
    { id: "agenda-3", title: "Assign owners and next steps", done: false }
  ],
  expectedParticipants: 4,
  participants: [
    { name: "Mina", role: "PM" },
    { name: "Jules", role: "Support" },
    { name: "Ari", role: "Engineering" },
    { name: "Noor", role: "Design" }
  ],
  heartbeatIntervalSeconds: 45
};

const demoSnippets = [
  "We have not made a decision yet.",
  "There is still an unresolved risk around support coverage.",
  "Can someone own the mitigation before we move on?",
  "This feels like a side topic for the parking lot."
];

export default function RoomPulseApp() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [meetingDraft, setMeetingDraft] = useState(defaultMeeting);
  const [agendaText, setAgendaText] = useState(
    defaultMeeting.agenda.map((item) => item.title).join("\n")
  );
  const [participantsText, setParticipantsText] = useState(
    defaultMeeting.participants
      .map((participant) =>
        participant.role
          ? `${participant.name} - ${participant.role}`
          : participant.name
      )
      .join("\n")
  );
  const [meeting, setMeeting] = useState(defaultMeeting);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("demo");
  const [demoLine, setDemoLine] = useState("");
  const [demoSpeaker, setDemoSpeaker] = useState("Speaker 1");
  const [currentOutput, setCurrentOutput] = useState<FacilitatorOutput | null>(
    null
  );
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState(0);
  const [nextHeartbeatAt, setNextHeartbeatAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [isHeartbeatRunning, setIsHeartbeatRunning] = useState(false);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState("Local transcription idle");
  const [micPermissionStatus, setMicPermissionStatus] =
    useState("permission unknown");
  const [currentMicSpeaker, setCurrentMicSpeaker] = useState("Speaker 1");
  const [isMicRunning, setIsMicRunning] = useState(false);
  const [isDemoRunning, setIsDemoRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isPastMeetingsOpen, setIsPastMeetingsOpen] = useState(false);
  const [activeAgendaItemId, setActiveAgendaItemId] = useState<string | null>(
    defaultMeeting.agenda.find((item) => !item.done)?.id ??
      defaultMeeting.agenda[0]?.id ??
      null
  );
  const [meetingStartedAt, setMeetingStartedAt] = useState(0);
  const [heartbeatCount, setHeartbeatCount] = useState(0);
  const [reviewMarkdown, setReviewMarkdown] = useState(
    createInitialReviewMarkdown(defaultMeeting)
  );
  const [reviewVersions, setReviewVersions] = useState<ReviewVersion[]>([
    {
      id: "initial-review",
      timestamp: Date.now(),
      source: "initial",
      markdown: createInitialReviewMarkdown(defaultMeeting),
      summary: "Initial meeting review document."
    }
  ]);
  const [currentReviewVersionId, setCurrentReviewVersionId] =
    useState("initial-review");
  const [ephemeralReminder, setEphemeralReminder] = useState<string | null>(null);
  const [meetingLogId, setMeetingLogId] = useState<string | null>(null);
  const [logStatus, setLogStatus] = useState("Logs idle");
  const [pastMeetings, setPastMeetings] = useState<ClientMeetingLogMetadata[]>([]);
  const [selectedMeetingLog, setSelectedMeetingLog] =
    useState<ClientMeetingLogSnapshot | null>(null);

  const transcriptStoreRef = useRef(new TranscriptStore());
  const transcriptionClientRef = useRef<LocalTranscriptionClient | null>(null);
  const currentMicSpeakerRef = useRef("Speaker 1");
  const isHeartbeatRunningRef = useRef(false);
  const transcriptFeedRef = useRef<HTMLDivElement | null>(null);
  const demoTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const meetingLogIdRef = useRef<string | null>(null);
  const pendingLogEventsRef = useRef<PendingMeetingLogEvent[]>([]);

  const observedSpeakerLabels = useMemo(
    () => Array.from(new Set(transcript.map((line) => line.speakerLabel))),
    [transcript]
  );
  const participation = useMemo(
    () =>
      createParticipationStatus(
        meeting.expectedParticipants,
        observedSpeakerLabels
      ),
    [meeting.expectedParticipants, observedSpeakerLabels]
  );
  const agendaProgress = useMemo(
    () => getAgendaProgress(meeting.agenda),
    [meeting.agenda]
  );
  const countdownSeconds = Math.max(
    0,
    Math.ceil((nextHeartbeatAt - now) / 1000)
  );
  const meetingElapsedSeconds = Math.max(
    0,
    Math.floor((now - (meetingStartedAt || now)) / 1000)
  );
  const progressPercent =
    agendaProgress.total === 0
      ? 0
      : Math.round((agendaProgress.completed / agendaProgress.total) * 100);
  const activeAgendaItem =
    meeting.agenda.find((item) => item.id === activeAgendaItemId) ??
    agendaProgress.active ??
    meeting.agenda[0] ??
    null;

  useEffect(() => {
    if (
      activeAgendaItemId &&
      meeting.agenda.some((item) => item.id === activeAgendaItemId)
    ) {
      return;
    }
    setActiveAgendaItemId(
      agendaProgress.active?.id ?? meeting.agenda[0]?.id ?? null
    );
  }, [activeAgendaItemId, agendaProgress.active, meeting.agenda]);

  const logMeetingEvent = useCallback(
    (type: string, payload: unknown, timestamp = Date.now()) => {
      const event = { type, timestamp, payload };
      const currentMeetingLogId = meetingLogIdRef.current;

      if (!currentMeetingLogId) {
        pendingLogEventsRef.current.push(event);
        return;
      }

      void sendMeetingLogEvent(currentMeetingLogId, event).catch((error) => {
        setLogStatus(
          `Log write failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    },
    []
  );

  const refreshPastMeetings = useCallback(async () => {
    try {
      const response = await fetch("/api/meetings");
      if (!response.ok) {
        throw new Error(`Meeting list returned ${response.status}`);
      }
      const payload = (await response.json()) as {
        meetings?: ClientMeetingLogMetadata[];
      };
      setPastMeetings(payload.meetings ?? []);
    } catch {
      setPastMeetings([]);
    }
  }, []);

  const loadPastMeetingLog = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(id)}`);
      if (!response.ok) {
        throw new Error(`Meeting log returned ${response.status}`);
      }
      setSelectedMeetingLog((await response.json()) as ClientMeetingLogSnapshot);
    } catch (error) {
      setSelectedMeetingLog({
        metadata: {
          id,
          title: "Unable to load meeting",
          goal: error instanceof Error ? error.message : String(error),
          startedAt: Date.now(),
          updatedAt: Date.now(),
          eventCount: 0
        },
        events: []
      });
    }
  }, []);

  const createMeetingLogFor = useCallback(
    async (
      configuredMeeting: MeetingConfig,
      startedAt: number,
      initialEvents: PendingMeetingLogEvent[]
    ) => {
      meetingLogIdRef.current = null;
      pendingLogEventsRef.current = [...initialEvents];
      setMeetingLogId(null);
      setLogStatus("Creating local meeting log...");

      try {
        const response = await fetch("/api/meetings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            meeting: configuredMeeting,
            startedAt
          })
        });

        if (!response.ok) {
          throw new Error(`Meeting log route returned ${response.status}`);
        }

        const metadata = (await response.json()) as ClientMeetingLogMetadata;
        meetingLogIdRef.current = metadata.id;
        setMeetingLogId(metadata.id);
        setLogStatus(`Logging locally: ${metadata.id}`);

        const queued = pendingLogEventsRef.current.splice(0);
        await Promise.all(
          queued.map((event) => sendMeetingLogEvent(metadata.id, event))
        );
        void refreshPastMeetings();
      } catch (error) {
        pendingLogEventsRef.current = [];
        setLogStatus(
          `Meeting logging unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    },
    [refreshPastMeetings]
  );

  const addTranscriptLine = useCallback(
    (
      text: string,
      speakerLabel: string,
      source: TranscriptLine["source"],
      confidence = 1
    ) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const speakerId = speakerLabel.toLowerCase().replace(/\s+/g, "-");
      const line = transcriptStoreRef.current.addLine({
        speakerId,
        speakerLabel,
        text: trimmed,
        source,
        confidence
      });
      setTranscript(transcriptStoreRef.current.getLines());
      logMeetingEvent("transcript_line", { line }, line.timestamp);
    },
    [logMeetingEvent]
  );

  const applyHeartbeatOutput = useCallback(
    (output: FacilitatorOutput, heartbeatNow: number) => {
      setCurrentOutput(output);
      setReviewMarkdown(output.reviewMarkdown);
      setCurrentReviewVersionId(`${heartbeatNow}-review`);
      setReviewVersions((versions) => [
        {
          id: `${heartbeatNow}-review`,
          timestamp: heartbeatNow,
          source: output.source,
          markdown: output.reviewMarkdown,
          summary: output.summary
        },
        ...versions
      ]);
      setEphemeralReminder(output.ephemeralReminder);
      if (output.agendaActions.length > 0) {
        applyAgendaActions(output.agendaActions);
      }
      if (output.uiActions?.length > 0) {
        applyUiActions(output.uiActions);
      }
      setTimeline((entries) => [
        {
          id: `${heartbeatNow}-${entries.length + 1}`,
          timestamp: heartbeatNow,
          source: output.source,
          cards: output.cards,
          summary: output.summary,
          reviewMarkdown: output.reviewMarkdown,
          reminder: output.ephemeralReminder
        },
        ...entries
      ]);
      logMeetingEvent(
        "heartbeat_output",
        {
          output,
          reviewVersionId: `${heartbeatNow}-review`
        },
        heartbeatNow
      );
    },
    [logMeetingEvent]
  );

  const runHeartbeat = useCallback(async () => {
    if (isHeartbeatRunningRef.current || phase !== "meeting" || isPaused) {
      return;
    }

    const heartbeatNow = Date.now();
    const input = createHeartbeatInput({
      meeting,
      transcript,
      observedSpeakerLabels,
      lastHeartbeatAt,
      now: heartbeatNow,
      priorInterventions: timeline,
      currentReviewMarkdown: reviewMarkdown,
      reviewVersions,
      meetingStartedAt,
      isPaused,
      heartbeatCount
    });

    setIsHeartbeatRunning(true);
    isHeartbeatRunningRef.current = true;
    setHeartbeatError(null);

    try {
      const response = await fetch("/api/heartbeat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          meeting,
          transcript,
          observedSpeakerLabels,
          lastHeartbeatAt,
          now: heartbeatNow,
          priorInterventions: timeline,
          currentReviewMarkdown: reviewMarkdown,
          reviewVersions,
          meetingStartedAt,
          isPaused,
          heartbeatCount
        })
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          errorBody?.error ?? `Heartbeat route returned ${response.status}`
        );
      }

      const output = (await response.json()) as FacilitatorOutput;
      applyHeartbeatOutput(output, heartbeatNow);
      setHeartbeatCount((count) => count + 1);
      setLastHeartbeatAt(heartbeatNow);
      setNextHeartbeatAt(
        Date.now() + meeting.heartbeatIntervalSeconds * 1000
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHeartbeatError(message);
      if (process.env.NEXT_PUBLIC_ROOMPULSE_REQUIRE_PI === "1") {
        return;
      }

      const fallbackOutput = await runLocalHeartbeatInBrowser(input);
      applyHeartbeatOutput(fallbackOutput, heartbeatNow);
      setHeartbeatCount((count) => count + 1);
      setLastHeartbeatAt(heartbeatNow);
      setNextHeartbeatAt(
        Date.now() + meeting.heartbeatIntervalSeconds * 1000
      );
    } finally {
      setIsHeartbeatRunning(false);
      isHeartbeatRunningRef.current = false;
    }
  }, [
    applyHeartbeatOutput,
    lastHeartbeatAt,
    meeting,
    meetingStartedAt,
    observedSpeakerLabels,
    phase,
    isPaused,
    timeline,
    transcript,
    reviewMarkdown,
    reviewVersions,
    heartbeatCount
  ]);

  const stopScriptedDemo = useCallback(() => {
    for (const timer of demoTimeoutsRef.current) {
      clearTimeout(timer);
    }
    demoTimeoutsRef.current = [];
    setIsDemoRunning(false);
  }, []);

  const startScriptedDemo = useCallback(() => {
    stopScriptedDemo();
    stopMic();
    setTranscriptMode("demo");
    setIsDemoRunning(true);

    transcriptStoreRef.current.clear();
    setTranscript([]);
    setTimeline([]);
    setHeartbeatCount(0);
    setHeartbeatError(null);
    setEphemeralReminder(null);
    logMeetingEvent("scripted_demo_started", {
      durationMs: DEMO_DURATION_MS,
      beats: DEMO_SCRIPT.length
    });

    const startedAt = Date.now();
    setLastHeartbeatAt(startedAt);
    setNextHeartbeatAt(startedAt + meeting.heartbeatIntervalSeconds * 1000);

    for (const beat of DEMO_SCRIPT) {
      const timer = setTimeout(() => {
        addTranscriptLine(beat.text, beat.speaker, "simulated");
      }, beat.delayMs);
      demoTimeoutsRef.current.push(timer);
    }

    const finalTimer = setTimeout(() => {
      setIsDemoRunning(false);
      demoTimeoutsRef.current = [];
    }, DEMO_DURATION_MS + meeting.heartbeatIntervalSeconds * 1000);
    demoTimeoutsRef.current.push(finalTimer);
  }, [
    addTranscriptLine,
    logMeetingEvent,
    meeting.heartbeatIntervalSeconds,
    stopScriptedDemo
  ]);

  const launchLiveDemo = useCallback(() => {
    const demoMeeting: MeetingConfig = {
      title: "Launch readiness review",
      goal: "Leave with owners for every open launch risk.",
      context:
        "RoomPulse should surface risks, drift, and missing voices on the shared display.",
      agenda: DEMO_AGENDA.map((title, index) => ({
        id: `agenda-${index + 1}`,
        title,
        done: false
      })),
      expectedParticipants: DEMO_EXPECTED_PARTICIPANTS,
      participants: [...DEMO_PARTICIPANTS],
      heartbeatIntervalSeconds: DEMO_HEARTBEAT_INTERVAL_SECONDS
    };
    const startedAt = Date.now();
    const initialReview = createInitialReviewMarkdown(demoMeeting);
    const initialVersion: ReviewVersion = {
      id: `${startedAt}-initial-review`,
      timestamp: startedAt,
      source: "initial",
      markdown: initialReview,
      summary: "Initial meeting review document."
    };

    setMeeting(demoMeeting);
    setActiveAgendaItemId(
      demoMeeting.agenda.find((item) => !item.done)?.id ??
        demoMeeting.agenda[0]?.id ??
        null
    );
    setPhase("meeting");
    setMeetingStartedAt(startedAt);
    setHeartbeatCount(0);
    setIsPaused(false);
    setReviewMarkdown(initialReview);
    setReviewVersions([initialVersion]);
    setCurrentReviewVersionId(initialVersion.id);
    setEphemeralReminder(null);
    setCurrentOutput({
      source: "local-fallback",
      cards: [
        {
          id: "demo-armed",
          kind: "heartbeat",
          title: "Demo armed",
          body:
            "Scripted transcript starts in moments. Watch heartbeat reviews and agenda checks update live.",
          priority: "medium"
        }
      ],
      summary: "Scripted demo armed.",
      nextHeartbeatHint: "First pulse will arrive at 15 seconds.",
      reviewMarkdown: initialReview,
      agendaActions: [],
      uiActions: [],
      ephemeralReminder: null
    });
    transcriptStoreRef.current.clear();
    setTranscript([]);
    setTimeline([]);
    setLastHeartbeatAt(startedAt);
    setNextHeartbeatAt(startedAt + demoMeeting.heartbeatIntervalSeconds * 1000);
    void createMeetingLogFor(demoMeeting, startedAt, [
      {
        type: "meeting_started",
        timestamp: startedAt,
        payload: { meeting: demoMeeting, mode: "scripted-demo" }
      }
    ]);
    setTimeout(() => startScriptedDemo(), 120);
  }, [createMeetingLogFor, startScriptedDemo]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (
      phase === "meeting" &&
      !isPaused &&
      nextHeartbeatAt > 0 &&
      now >= nextHeartbeatAt &&
      !isHeartbeatRunningRef.current
    ) {
      void runHeartbeat();
    }
  }, [isPaused, nextHeartbeatAt, now, phase, runHeartbeat]);

  useEffect(() => {
    return () => {
      cleanupMicResources();
    };
  }, []);

  useEffect(() => {
    return () => {
      stopScriptedDemo();
    };
  }, [stopScriptedDemo]);

  useEffect(() => {
    let permissionStatus: PermissionStatus | null = null;

    async function readMicPermission() {
      if (!navigator.permissions?.query) {
        setMicPermissionStatus("permission API unavailable");
        return;
      }

      try {
        permissionStatus = await navigator.permissions.query({
          name: "microphone" as PermissionName
        });
        const update = () => {
          setMicPermissionStatus(permissionStatus?.state ?? "permission unknown");
        };
        update();
        permissionStatus.onchange = update;
      } catch {
        setMicPermissionStatus("permission API unavailable");
      }
    }

    void readMicPermission();

    return () => {
      if (permissionStatus) {
        permissionStatus.onchange = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!transcriptFeedRef.current) {
      return;
    }

    transcriptFeedRef.current.scrollTop = transcriptFeedRef.current.scrollHeight;
  }, [transcript.length]);

  useEffect(() => {
    if (phase !== "meeting") return;
    setMeeting((current) => {
      const updated = applyAgendaCoverage(current.agenda, transcript);
      if (updated === current.agenda) return current;
      logMeetingEvent("agenda_auto_checked", {
        previousAgenda: current.agenda,
        nextAgenda: updated
      });
      return { ...current, agenda: updated };
    });
  }, [logMeetingEvent, phase, transcript]);

  useEffect(() => {
    if (phase === "setup") {
      void refreshPastMeetings();
    }
  }, [phase, refreshPastMeetings]);

  function startMeeting() {
    const expectedParticipants = clampFiniteNumber(
      meetingDraft.expectedParticipants,
      1,
      1
    );
    const heartbeatIntervalSeconds = clampFiniteNumber(
      meetingDraft.heartbeatIntervalSeconds,
      15,
      15
    );
    const configuredMeeting: MeetingConfig = {
      ...meetingDraft,
      title: meetingDraft.title.trim() || defaultMeeting.title,
      goal: meetingDraft.goal.trim() || defaultMeeting.goal,
      context: meetingDraft.context.trim(),
      expectedParticipants,
      heartbeatIntervalSeconds,
      agenda: parseAgenda(agendaText),
      participants: parseParticipants(participantsText)
    };

    setMeeting(configuredMeeting);
    setActiveAgendaItemId(
      configuredMeeting.agenda.find((item) => !item.done)?.id ??
        configuredMeeting.agenda[0]?.id ??
        null
    );
    setPhase("meeting");
    const startedAt = Date.now();
    const initialReview = createInitialReviewMarkdown(configuredMeeting);
    const initialVersion: ReviewVersion = {
      id: `${startedAt}-initial-review`,
      timestamp: startedAt,
      source: "initial",
      markdown: initialReview,
      summary: "Initial meeting review document."
    };
    setMeetingStartedAt(startedAt);
    setHeartbeatCount(0);
    setIsPaused(false);
    setReviewMarkdown(initialReview);
    setReviewVersions([initialVersion]);
    setCurrentReviewVersionId(initialVersion.id);
    setEphemeralReminder(null);
    setCurrentOutput({
      source: "local-fallback",
      cards: [
        {
          id: "initial-heartbeat",
          kind: "heartbeat",
          title: "Meeting display armed",
          body:
            "Start the discussion. RoomPulse will pulse the facilitator on the configured heartbeat.",
          priority: "medium"
        }
      ],
      summary: "Waiting for the first heartbeat.",
      nextHeartbeatHint: "Use Run heartbeat now for a live check.",
      reviewMarkdown: initialReview,
      agendaActions: [],
      uiActions: [],
      ephemeralReminder: null
    });
    setLastHeartbeatAt(startedAt);
    setNextHeartbeatAt(
      startedAt + configuredMeeting.heartbeatIntervalSeconds * 1000
    );
    void createMeetingLogFor(configuredMeeting, startedAt, [
      {
        type: "meeting_started",
        timestamp: startedAt,
        payload: { meeting: configuredMeeting, mode: "manual" }
      }
    ]);
  }

  function addDemoLine() {
    const text = demoLine || demoSnippets[transcript.length % demoSnippets.length];
    addTranscriptLine(text, demoSpeaker, "simulated");
    setDemoLine("");
  }

  async function startMic() {
    setTranscriptMode("mic");

    if (isMicRunning || transcriptionClientRef.current) {
      return;
    }

    try {
      setMicStatus("Requesting browser microphone permission");
      const client = new LocalTranscriptionClient({
        onSegment: (segment) => {
          currentMicSpeakerRef.current = segment.speakerLabel;
          setCurrentMicSpeaker(segment.speakerLabel);
          addTranscriptLine(
            segment.text,
            segment.speakerLabel,
            "speech",
            segment.confidence
          );
        },
        onStatus: (status) => {
          const observed = status.observedSpeakerLabels;
          if (observed && observed.length > 0) {
            const latest = observed[observed.length - 1];
            currentMicSpeakerRef.current = latest;
            setCurrentMicSpeaker(latest);
          }
          if (status.status === "closed") {
            setIsMicRunning(false);
            transcriptionClientRef.current = null;
          }
          setMicStatus(status.message);
        },
        onError: (message) => {
          setMicStatus(`Local transcription error: ${message}`);
        }
      });
      transcriptionClientRef.current = client;
      await client.start();
      setIsMicRunning(true);
    } catch (error) {
      cleanupMicResources();
      setIsMicRunning(false);
      setMicStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function stopMic() {
    cleanupMicResources();
    currentMicSpeakerRef.current = "Speaker 1";
    setCurrentMicSpeaker("Speaker 1");
    setIsMicRunning(false);
    setMicStatus("Local transcription idle");
  }

  function cleanupMicResources() {
    transcriptionClientRef.current?.stop();
    transcriptionClientRef.current = null;
  }

  function updateAgendaItem(id: string, done: boolean) {
    setMeeting((current) => ({
      ...current,
      agenda: current.agenda.map((item) =>
        item.id === id ? { ...item, done } : item
      )
    }));
    logMeetingEvent("agenda_manual_update", { itemId: id, done });
  }

  function addAgendaItem(title: string, reason: string) {
    const trimmed = title.trim();
    if (!trimmed) return;

    const item: AgendaItem = {
      id: `agenda-${Date.now()}`,
      title: trimmed,
      done: false
    };
    setMeeting((current) => ({
      ...current,
      agenda: [...current.agenda, item]
    }));
    setActiveAgendaItemId((current) => current ?? item.id);
    logMeetingEvent("agenda_item_added", { item, reason });
  }

  function deleteAgendaItem(id: string, reason: string) {
    setMeeting((current) => {
      const deleted = current.agenda.find((item) => item.id === id);
      if (!deleted) return current;
      const agenda = current.agenda.filter((item) => item.id !== id);
      logMeetingEvent("agenda_item_deleted", { item: deleted, reason });
      return { ...current, agenda };
    });
    setActiveAgendaItemId((current) =>
      current === id ? meeting.agenda.find((item) => item.id !== id)?.id ?? null : current
    );
  }

  function setRuntimeHeartbeatInterval(value: number) {
    const seconds = clampFiniteNumber(
      value,
      meeting.heartbeatIntervalSeconds,
      15
    );
    const nowMs = Date.now();

    setMeeting((current) => ({
      ...current,
      heartbeatIntervalSeconds: seconds
    }));

    if (phase === "meeting" && lastHeartbeatAt > 0 && !isPaused) {
      const elapsedSinceLastHeartbeatMs = Math.max(0, nowMs - lastHeartbeatAt);
      const remainingMs = Math.max(
        0,
        seconds * 1000 - elapsedSinceLastHeartbeatMs
      );
      setNextHeartbeatAt(nowMs + remainingMs);
    }

    logMeetingEvent("heartbeat_interval_changed", { seconds });
  }

  function applyAgendaActions(actions: FacilitatorOutput["agendaActions"]) {
    setMeeting((current) => ({
      ...current,
      agenda: current.agenda.map((item) => {
        const action = actions.find((candidate) => candidate.itemId === item.id);
        return action ? { ...item, done: action.done } : item;
      })
    }));
  }

  function applyUiActions(actions: UiAction[]) {
    for (const action of actions) {
      const params = action.parameters;

      if (action.tool === "add_agenda_item") {
        const title = stringParam(params.title);
        if (title) {
          addAgendaItem(title, action.reason);
        }
      }

      if (action.tool === "set_agenda_item") {
        const itemId = stringParam(params.itemId);
        const done = booleanParam(params.done);
        if (itemId && done !== null) {
          updateAgendaItem(itemId, done);
        }
      }

      if (action.tool === "delete_agenda_item") {
        const itemId = stringParam(params.itemId);
        if (itemId) {
          deleteAgendaItem(itemId, action.reason);
        }
      }

      if (action.tool === "send_room_reminder") {
        const message = stringParam(params.message);
        if (message) {
          setEphemeralReminder(message);
        }
      }

      if (action.tool === "update_review_document") {
        const markdown = stringParam(params.markdown);
        if (markdown) {
          setReviewMarkdown(markdown);
        }
      }
    }
  }

  function restoreReviewVersion(version: ReviewVersion) {
    const restoredAt = Date.now();
    const restoredVersion: ReviewVersion = {
      id: `${restoredAt}-restored-review`,
      timestamp: restoredAt,
      source: "restored",
      markdown: version.markdown,
      summary: `Restored review from ${formatClock(version.timestamp)}.`
    };
    setReviewMarkdown(version.markdown);
    setCurrentReviewVersionId(restoredVersion.id);
    setReviewVersions((versions) => [restoredVersion, ...versions]);
    logMeetingEvent("review_restored", {
      restoredVersion,
      sourceVersionId: version.id
    }, restoredAt);
  }

  function togglePause() {
    const nextPaused = !isPaused;
    setIsPaused(nextPaused);
    logMeetingEvent("meeting_pause_toggled", { paused: nextPaused });
    if (!nextPaused) {
      setNextHeartbeatAt(Date.now() + meeting.heartbeatIntervalSeconds * 1000);
    }
  }

  if (phase === "setup") {
    return (
      <main className="app-shell setup-shell">
        <header className="app-topbar setup-topbar">
          <BrandMark />
          <div className="topbar-title">
            <span>Prepare the shared display</span>
            <h1 id="setup-title">RoomPulse setup</h1>
          </div>
          <div className="topbar-pills" aria-label="Setup readiness">
            <StatusPill tone="good">Local-first</StatusPill>
            <StatusPill>{meetingDraft.heartbeatIntervalSeconds}s pulse</StatusPill>
          </div>
        </header>

        <section className="setup-workspace" aria-labelledby="setup-title">
          <aside className="setup-brief" aria-label="RoomPulse brief">
            <div className="setup-brief-copy">
              <div className="section-kicker">Mode 2 shared room display</div>
              <h2>Initialize the room before anyone starts talking.</h2>
              <p>
                RoomPulse needs the meeting goal, agenda, expected voices, and
                participant context up front so each heartbeat can nudge the
                room instead of writing private notes.
              </p>
            </div>
            <div className="setup-flow">
              <div>
                <span>1</span>
                <strong>Context</strong>
                <p>Goal, stakes, and background the facilitator should remember.</p>
              </div>
              <div>
                <span>2</span>
                <strong>Room shape</strong>
                <p>Expected voices and optional names for participation nudges.</p>
              </div>
              <div>
                <span>3</span>
                <strong>Heartbeat</strong>
                <p>How often the Pi adapter reviews transcript deltas.</p>
              </div>
            </div>
          </aside>

          <form
            className="setup-panel"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              startMeeting();
            }}
          >
            <div className="section-kicker">Context feeder</div>
            <label>
              <span>Meeting title</span>
              <input
                value={meetingDraft.title}
                onChange={(event) =>
                  setMeetingDraft((current) => ({
                    ...current,
                    title: event.target.value
                  }))
                }
              />
            </label>
            <label>
              <span>Goal</span>
              <input
                value={meetingDraft.goal}
                onChange={(event) =>
                  setMeetingDraft((current) => ({
                    ...current,
                    goal: event.target.value
                  }))
                }
              />
            </label>
            <label>
              <span>Important context</span>
              <textarea
                rows={4}
                value={meetingDraft.context}
                onChange={(event) =>
                  setMeetingDraft((current) => ({
                    ...current,
                    context: event.target.value
                  }))
                }
              />
            </label>
            <label>
              <span>Agenda</span>
              <textarea
                rows={5}
                value={agendaText}
                onChange={(event) => setAgendaText(event.target.value)}
              />
            </label>
            <div className="field-row">
              <label>
                <span>Expected participants</span>
                <input
                  type="number"
                  min={1}
                  value={meetingDraft.expectedParticipants}
                  onChange={(event) =>
                    setMeetingDraft((current) => ({
                      ...current,
                      expectedParticipants: Number(event.target.value)
                    }))
                  }
                />
              </label>
              <label>
                <span>Heartbeat interval</span>
                <input
                  type="number"
                  min={15}
                  step={5}
                  value={meetingDraft.heartbeatIntervalSeconds}
                  onChange={(event) =>
                    setMeetingDraft((current) => ({
                      ...current,
                      heartbeatIntervalSeconds: Number(event.target.value)
                    }))
                  }
                />
              </label>
            </div>
            <label>
              <span>Optional names and roles</span>
              <textarea
                rows={4}
                value={participantsText}
                onChange={(event) => setParticipantsText(event.target.value)}
              />
            </label>
            <button className="primary-action" type="submit">
              Start meeting
            </button>
          </form>

          <aside className="preview-panel">
            <section className="setup-card demo-launch">
              <div className="setup-card-title">
                <span className="status-dot live" />
                <strong>One-click demo</strong>
              </div>
              <p>
                Jump straight to a 75-second launch-readiness meeting with
                transcript, reviews, participation, and agenda checks already
                choreographed for judging.
              </p>
              <button
                type="button"
                className="demo-launch-button"
                onClick={launchLiveDemo}
              >
                Launch live demo
              </button>
            </section>
            <div className="section-kicker">Launch check</div>
            <div className="setup-metrics">
              <div>
                <strong>{meetingDraft.heartbeatIntervalSeconds}s</strong>
                <span>heartbeat</span>
              </div>
              <div>
                <strong>{meetingDraft.expectedParticipants}</strong>
                <span>voices</span>
              </div>
            </div>
            <section className="setup-card">
              <div className="setup-card-title">
                <span className="status-dot live" />
                <strong>Facilitator adapter</strong>
              </div>
              <p>
                Every pulse calls <code>runPiHeartbeat(input)</code>. Strict mode
                surfaces missing Pi auth; normal mode keeps a deterministic
                local fallback.
              </p>
            </section>
            <section className="setup-card">
              <div className="setup-card-title">
                <span className="status-dot" />
                <strong>Microphone path</strong>
              </div>
              <p>
                Browser audio streams to local Whisper and returns live
                transcript lines with Speaker N clustering.
              </p>
            </section>
            <section className="setup-card agenda-preview">
              <div className="setup-card-title">
                <strong>Agenda preview</strong>
                <span>{agendaText.split("\n").filter(Boolean).length} items</span>
              </div>
              <ol>
                {agendaText
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean)
                  .slice(0, 4)
                  .map((item) => (
                    <li key={item}>{item}</li>
                  ))}
              </ol>
            </section>
            <section className="setup-card past-meetings">
              <div className="setup-card-title">
                <strong>Past meetings</strong>
                <button type="button" onClick={() => void refreshPastMeetings()}>
                  Refresh
                </button>
              </div>
              {pastMeetings.length === 0 ? (
                <p>No local meeting logs yet.</p>
              ) : (
                <div className="past-meeting-list">
                  {pastMeetings.slice(0, 5).map((pastMeeting) => (
                    <button
                      key={pastMeeting.id}
                      type="button"
                      onClick={() => void loadPastMeetingLog(pastMeeting.id)}
                    >
                      <strong>{pastMeeting.title}</strong>
                      <span>
                        {pastMeeting.eventCount} events -{" "}
                        {formatClock(pastMeeting.startedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {selectedMeetingLog ? (
                <div className="meeting-log-preview">
                  <div>
                    <strong>{selectedMeetingLog.metadata.title}</strong>
                    <span>{selectedMeetingLog.events.length} logged events</span>
                  </div>
                  {selectedMeetingLog.events.slice(-6).map((event) => (
                    <p key={event.id}>
                      <span>{formatClock(event.timestamp)}</span>
                      {event.type.replaceAll("_", " ")}
                    </p>
                  ))}
                </div>
              ) : null}
            </section>
          </aside>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell room-shell">
      <header className="app-bar">
        <div className="app-bar-left">
          <button
            aria-label="Past meetings"
            className="icon-button"
            type="button"
            onClick={() => {
              setIsPastMeetingsOpen(true);
              void refreshPastMeetings();
            }}
          >
            <MaterialIcon name="menu" />
          </button>
          <BrandMark paused={isPaused} />
        </div>
        <div className="app-bar-right">
          <button
            aria-label="Meeting settings"
            className={`icon-button ${showSettings ? "active" : ""}`}
            type="button"
            onClick={() => setShowSettings((value) => !value)}
          >
            <MaterialIcon name="settings" />
          </button>
        </div>
        {showSettings ? (
          <aside className="settings-popover" aria-label="Meeting settings">
            <label>
              <span>Heartbeat interval</span>
              <div className="settings-num">
                <input
                  min={15}
                  step={5}
                  type="number"
                  value={meeting.heartbeatIntervalSeconds}
                  onChange={(event) =>
                    setRuntimeHeartbeatInterval(Number(event.target.value))
                  }
                />
                <span>seconds</span>
              </div>
            </label>
            <label>
              <span>Expected participants</span>
              <div className="settings-num">
                <input
                  min={1}
                  type="number"
                  value={meeting.expectedParticipants}
                  onChange={(event) =>
                    setMeeting((current) => ({
                      ...current,
                      expectedParticipants: clampFiniteNumber(
                        Number(event.target.value),
                        current.expectedParticipants,
                        1
                      )
                    }))
                  }
                />
                <span>voices</span>
              </div>
            </label>
            <p className="log-status">
              {logStatus}
              {meetingLogId ? ` (${meetingLogId})` : ""}
            </p>
          </aside>
        ) : null}
      </header>

      {isPastMeetingsOpen ? (
        <PastMeetingsDrawer
          meetings={pastMeetings}
          selectedMeetingLog={selectedMeetingLog}
          onClose={() => setIsPastMeetingsOpen(false)}
          onRefresh={() => void refreshPastMeetings()}
          onSelect={(id) => void loadPastMeetingLog(id)}
          onNewMeeting={() => {
            setIsPastMeetingsOpen(false);
            setPhase("setup");
          }}
        />
      ) : null}

      <section className="meet-subheader">
        <div className="meeting-title-block">
          <div className="meeting-kicker">
            <span className={`status-dot ${isPaused ? "" : "live"}`} />
            <span>{isPaused ? "Meeting paused" : "Meeting live"}</span>
            {isDemoRunning ? <span className="demo-pill">Demo running</span> : null}
            <span>{formatElapsed(meetingElapsedSeconds)} elapsed</span>
            <span>Heartbeat {heartbeatCount}</span>
          </div>
          <h1>{meeting.title}</h1>
          <p>{meeting.goal}</p>
        </div>

        <HeartbeatRing
          running={isHeartbeatRunning}
          secondsLeft={countdownSeconds}
          total={meeting.heartbeatIntervalSeconds}
        />

        <div className="meeting-status">
          <StatusPill tone={isMicRunning ? "good" : "neutral"}>
            <MaterialIcon name={isMicRunning ? "mic" : "mic_off"} />
            {isMicRunning ? "Mic live" : "Mic off"}
          </StatusPill>
          <StatusPill>
            <MaterialIcon name={currentOutput?.source === "pi" ? "auto_awesome" : "memory"} />
            {currentOutput?.source === "pi" ? "Pi · gpt-5.5" : "Local"}
          </StatusPill>
          <StatusPill>
            <MaterialIcon name={isPaused ? "pause" : "schedule"} />
            {isPaused ? "Paused" : `${countdownSeconds}s`}
          </StatusPill>
        </div>
      </section>

      <section className="meeting-grid">
        <section className="transcript-panel room-column" aria-label="Live raw transcript">
          <div className="panel-toolbar">
            <div>
              <div className="section-kicker">Live raw transcript</div>
              <h2>Transcript</h2>
            </div>
            <div className="mode-switch" aria-label="Transcript mode">
              <button
                className={transcriptMode === "demo" ? "active" : ""}
                type="button"
                onClick={() => {
                  stopMic();
                  setTranscriptMode("demo");
                }}
              >
                Demo
              </button>
              <button
                className={transcriptMode === "mic" ? "active" : ""}
                disabled={isMicRunning}
                type="button"
                onClick={() => void startMic()}
              >
                Mic
              </button>
            </div>
          </div>

          <div className="transcript-feed" ref={transcriptFeedRef}>
            {transcript.length === 0 ? (
              <p className="empty-state">
                Raw transcript will appear here as speech or simulated lines arrive.
              </p>
            ) : (
              transcript.map((line) => (
                <article className="transcript-line" key={line.id}>
                  <div className={`speaker-badge speaker-${speakerNumber(line.speakerLabel)}`}>
                    S{speakerNumber(line.speakerLabel)}
                  </div>
                  <div>
                    <span>{line.speakerLabel}</span>
                    <p>{line.text}</p>
                  </div>
                  <time>{formatClock(line.timestamp)}</time>
                </article>
              ))
            )}
          </div>

          <div className="demo-controls">
            <label>
              <span>Demo speaker</span>
              <select
                value={demoSpeaker}
                onChange={(event) => setDemoSpeaker(event.target.value)}
              >
                {Array.from(
                  { length: Math.max(6, meeting.expectedParticipants) },
                  (_, index) => (
                    <option key={index + 1}>Speaker {index + 1}</option>
                  )
                )}
              </select>
            </label>
            <label className="demo-line-field">
              <span>Demo line</span>
              <input
                value={demoLine}
                onChange={(event) => setDemoLine(event.target.value)}
                placeholder={demoSnippets[transcript.length % demoSnippets.length]}
              />
            </label>
            <button type="button" onClick={addDemoLine}>
              Add demo line
            </button>
          </div>
          {transcriptMode === "mic" ? (
            <p className="mic-status">
              {isMicRunning ? "Microphone active. " : ""}
              Browser mic: {micPermissionStatus}. {micStatus}. Current audio
              cluster: {currentMicSpeaker}
              {isMicRunning ? (
                <button type="button" onClick={stopMic}>
                  Stop mic
                </button>
              ) : null}
            </p>
          ) : null}
        </section>

        <section className="review-panel room-column" aria-label="AI reviews">
          <div className="panel-toolbar">
            <div>
              <div className="section-kicker">AI reviews</div>
              <h2>Live review document</h2>
            </div>
            <span>{currentOutput?.source === "pi" ? "GPT-5.5 fast" : "Local"}</span>
          </div>
          <div className="review-meta">
            <span>{reviewVersions.length} versions</span>
            <span>{formatElapsed(meetingElapsedSeconds)} elapsed</span>
            {currentOutput?.adapterNotice ? <span>{currentOutput.adapterNotice}</span> : null}
            {heartbeatError ? <span>{heartbeatError}</span> : null}
          </div>
          <article className="markdown-document">
            <MarkdownDocument markdown={reviewMarkdown} />
          </article>
          <div className="version-bar" aria-label="Review document version control">
            <button
              disabled={reviewVersions.length < 2}
              type="button"
              onClick={() => {
                const previous = reviewVersions.find(
                  (version) => version.id !== currentReviewVersionId
                );
                if (previous) {
                  restoreReviewVersion(previous);
                }
              }}
            >
              Revert one version
            </button>
            <select
              aria-label="Review versions"
              value={currentReviewVersionId}
              onChange={(event) => {
                const version = reviewVersions.find(
                  (candidate) => candidate.id === event.target.value
                );
                if (version) {
                  restoreReviewVersion(version);
                }
              }}
            >
              {reviewVersions.map((version) => (
                <option key={version.id} value={version.id}>
                  {formatClock(version.timestamp)} - {version.summary}
                </option>
              ))}
            </select>
          </div>
        </section>

        <aside className="right-rail room-column">
          <section className="now-card" aria-label="Now discussing">
            <div className="section-kicker">Now discussing</div>
            <h2>{activeAgendaItem?.title ?? "Open discussion"}</h2>
            <div className="now-row">
              <span>Item</span>
              <strong>
                {activeAgendaItem
                  ? `${meeting.agenda.findIndex((item) => item.id === activeAgendaItem.id) + 1} of ${meeting.agenda.length}`
                  : "0 of 0"}
              </strong>
            </div>
            <div className="now-row">
              <span>Elapsed</span>
              <strong>{formatElapsed(meetingElapsedSeconds)}</strong>
            </div>
            <div className="now-row">
              <span>Voices heard</span>
              <strong>{participation.observed}</strong>
            </div>
          </section>

          <section className="agenda-card" aria-label="Agenda">
            <div className="rail-card-heading">
              <h2>Agenda</h2>
              <span>{progressPercent}% complete</span>
            </div>
            <div className="meter agenda-meter">
              <span style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="agenda-list">
              {meeting.agenda.map((item) => (
                <label className="agenda-item" key={item.id}>
                  <input
                    checked={item.done}
                    type="checkbox"
                    onChange={(event) => {
                      setActiveAgendaItemId(item.id);
                      updateAgendaItem(item.id, event.target.checked);
                    }}
                  />
                  <span>{item.title}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="participation-card" aria-label="Participation">
            <div className="rail-card-heading">
              <h2>Participation</h2>
              <span>
                {participation.observed} of {participation.expected} heard
              </span>
            </div>
            <div className="meter">
              <span
                style={{
                  width: `${Math.min(
                    100,
                    (participation.observed / Math.max(1, participation.expected)) *
                      100
                  )}%`
                }}
              />
            </div>
            <div className="speaker-list">
              {observedSpeakerLabels.length === 0 ? (
                <span>No speakers observed yet</span>
              ) : (
                observedSpeakerLabels.map((label) => <span key={label}>{label}</span>)
              )}
            </div>
          </section>
        </aside>
      </section>

      <div className="bottom-bar" aria-label="Meeting controls">
        <button
          className={`pill-btn ${isMicRunning ? "" : "toggled"}`}
          type="button"
          onClick={isMicRunning ? stopMic : () => void startMic()}
        >
          <MaterialIcon name={isMicRunning ? "mic" : "mic_off"} filled />
          {isMicRunning ? "Mic on" : "Mic off"}
        </button>
        <button
          className={`pill-btn ${isPaused ? "toggled" : ""}`}
          type="button"
          onClick={togglePause}
        >
          <MaterialIcon name={isPaused ? "play_arrow" : "pause"} filled />
          {isPaused ? "Resume" : "Pause"}
        </button>
        <button
          className={`pill-btn ${isDemoRunning ? "toggled" : ""}`}
          type="button"
          onClick={isDemoRunning ? stopScriptedDemo : startScriptedDemo}
        >
          <MaterialIcon name={isDemoRunning ? "stop_circle" : "movie"} filled />
          {isDemoRunning ? "Stop demo" : "Script demo"}
        </button>
        <span className="bottom-divider" />
        <button
          aria-label="Run heartbeat now"
          className="pill-btn primary"
          disabled={isHeartbeatRunning}
          type="button"
          onClick={() => void runHeartbeat()}
        >
          <MaterialIcon name="favorite" filled />
          {isHeartbeatRunning ? "Reviewing..." : "Run heartbeat"}
        </button>
        <span className="bottom-divider" />
        <button
          className="pill-btn danger"
          type="button"
          onClick={() => setPhase("setup")}
        >
          <MaterialIcon name="call_end" filled />
          End
        </button>
      </div>

      {ephemeralReminder ? (
        <div className="reminder-snackbar" role="status">
          <MaterialIcon name="campaign" filled />
          <div>
            <span>Heartbeat reminder</span>
            <p>{ephemeralReminder}</p>
          </div>
          <button type="button" onClick={() => setEphemeralReminder(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </main>
  );
}

function BrandMark({ paused = false }: { paused?: boolean }) {
  return (
    <div className="brand-mark" aria-label="RoomPulse">
      <span className={`wave-mark ${paused ? "paused" : ""}`} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="wordmark" aria-hidden="true">
        <span>R</span>
        <span>o</span>
        <span>o</span>
        <span>m</span>
        <span>P</span>
        <span>u</span>
        <span>l</span>
        <span>s</span>
        <span>e</span>
      </span>
    </div>
  );
}

function MaterialIcon({
  name,
  filled = false
}: {
  name: string;
  filled?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`material-symbols-outlined ${filled ? "filled" : ""}`}
    >
      {name}
    </span>
  );
}

function HeartbeatRing({
  running,
  secondsLeft,
  total
}: {
  running: boolean;
  secondsLeft: number;
  total: number;
}) {
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(1, secondsLeft / Math.max(1, total)));

  return (
    <div className="heartbeat-ring" aria-label="Heartbeat countdown">
      <svg viewBox="0 0 84 84" role="img">
        <circle className="track" cx="42" cy="42" r={radius} />
        <circle
          className="progress"
          cx="42"
          cy="42"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
        />
      </svg>
      <div className="heartbeat-label">
        <strong>{running ? "..." : secondsLeft}</strong>
        <span>{running ? "reviewing" : "s pulse"}</span>
      </div>
    </div>
  );
}

function PastMeetingsDrawer({
  meetings,
  selectedMeetingLog,
  onClose,
  onRefresh,
  onSelect,
  onNewMeeting
}: {
  meetings: ClientMeetingLogMetadata[];
  selectedMeetingLog: ClientMeetingLogSnapshot | null;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onNewMeeting: () => void;
}) {
  return (
    <>
      <button
        aria-label="Close past meetings"
        className="drawer-scrim"
        type="button"
        onClick={onClose}
      />
      <aside className="meetings-drawer" aria-label="Past meetings">
        <div className="drawer-head">
          <button className="icon-button" type="button" onClick={onClose}>
            <MaterialIcon name="menu_open" />
          </button>
          <strong>Past meetings</strong>
          <button className="drawer-refresh" type="button" onClick={onRefresh}>
            Refresh
          </button>
        </div>
        <p>
          Saved local meeting state, including transcript events, agenda updates,
          heartbeat reminders, and review versions.
        </p>
        <div className="drawer-list">
          {meetings.length === 0 ? (
            <span className="drawer-empty">No local meeting logs yet.</span>
          ) : (
            meetings.map((meetingLog) => (
              <button
                className="drawer-row"
                key={meetingLog.id}
                type="button"
                onClick={() => onSelect(meetingLog.id)}
              >
                <span className="drawer-dot" />
                <span>
                  <strong>{meetingLog.title}</strong>
                  <small>
                    {formatClock(meetingLog.startedAt)} -{" "}
                    {meetingLog.eventCount} events
                  </small>
                </span>
                <MaterialIcon name="chevron_right" />
              </button>
            ))
          )}
        </div>
        {selectedMeetingLog ? (
          <div className="drawer-preview">
            <strong>{selectedMeetingLog.metadata.title}</strong>
            {selectedMeetingLog.events.slice(-5).map((event) => (
              <span key={event.id}>
                {formatClock(event.timestamp)} -{" "}
                {event.type.replaceAll("_", " ")}
              </span>
            ))}
          </div>
        ) : null}
        <div className="drawer-foot">
          <button className="btn outlined" type="button" onClick={onNewMeeting}>
            <MaterialIcon name="add" />
            New meeting
          </button>
        </div>
      </aside>
    </>
  );
}

function StatusPill({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: "good" | "neutral";
}) {
  return (
    <span className={`status-pill ${tone}`}>
      {tone === "good" ? <span className="status-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

async function sendMeetingLogEvent(
  meetingLogId: string,
  event: PendingMeetingLogEvent
) {
  const response = await fetch(
    `/api/meetings/${encodeURIComponent(meetingLogId)}/events`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(event)
    }
  );

  if (!response.ok) {
    throw new Error(`Meeting event log returned ${response.status}`);
  }
}

async function runLocalHeartbeatInBrowser(input: ReturnType<typeof createHeartbeatInput>) {
  const { runLocalFacilitation } = await import("@/lib/facilitator");
  return runLocalFacilitation(input);
}

function MarkdownDocument({ markdown }: { markdown: string }) {
  return (
    <>
      {markdown.split("\n").map((line, index) => {
        const key = `${index}-${line.slice(0, 12)}`;
        if (line.startsWith("# ")) {
          return <h1 key={key}>{renderInlineMarkdown(line.slice(2))}</h1>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={key}>{renderInlineMarkdown(line.slice(3))}</h2>;
        }
        if (line.startsWith("### ")) {
          return <h3 key={key}>{renderInlineMarkdown(line.slice(4))}</h3>;
        }
        if (line.startsWith("#### ")) {
          return <h4 key={key}>{renderInlineMarkdown(line.slice(5))}</h4>;
        }
        if (line.startsWith("- [x] ") || line.startsWith("- [ ] ")) {
          const checked = line.startsWith("- [x] ");
          return (
            <p className="markdown-check" key={key}>
              <input checked={checked} readOnly type="checkbox" />
              <span>{renderInlineMarkdown(line.slice(6))}</span>
            </p>
          );
        }
        if (line.startsWith("- ")) {
          return <li key={key}>{renderInlineMarkdown(line.slice(2))}</li>;
        }
        if (!line.trim()) {
          return <div className="markdown-gap" key={key} />;
        }
        return <p key={key}>{renderInlineMarkdown(line)}</p>;
      })}
    </>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`)/g);
  return parts.map((part, index) => {
    const key = `${index}-${part}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("~~") && part.endsWith("~~")) {
      return <s key={key}>{part.slice(2, -2)}</s>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("_") && part.endsWith("_") && part.length > 1) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <span key={key}>{part}</span>;
  });
}

function parseAgenda(value: string): AgendaItem[] {
  const items = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return (items.length > 0 ? items : ["Open discussion"]).map((title, index) => ({
    id: `agenda-${index + 1}`,
    title,
    done: false
  }));
}

function parseParticipants(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, role] = line.split(/\s+-\s+/, 2);
      return {
        name,
        role
      };
    });
}

function clampFiniteNumber(value: number, fallback: number, min: number): number {
  const finiteValue = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.floor(finiteValue));
}

function stringParam(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanParam(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function speakerNumber(label: string): number {
  const match = label.match(/\d+/);
  return match ? Number(match[0]) : 1;
}
