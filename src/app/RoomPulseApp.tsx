"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import MarkdownDocument from "./MarkdownDocument";
import {
  MAX_AGENDA_ITEMS,
  MAX_EXPECTED_PARTICIPANTS,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MAX_PARTICIPANT_ENTRIES,
  MIN_HEARTBEAT_INTERVAL_SECONDS,
  capFacilitatorOutput,
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
import {
  createParticipationStatus,
  normalizeObservedSpeakerLabels,
  normalizeSpeakerLabel,
  speakerBadgeClass,
  speakerBadgeLabel
} from "@/lib/speaker-tracker";
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

type Phase = "dashboard" | "setup" | "meeting";
type TranscriptMode = "demo" | "mic";
type MeetingStatus = "active" | "paused" | "ended";

interface ClientMeetingLogMetadata {
  id: string;
  title: string;
  goal: string;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  status: MeetingStatus;
  isPaused: boolean;
  eventCount: number;
  meeting: MeetingConfig;
  state: PersistedMeetingState | null;
  latestReviewMarkdown: string;
  latestReviewVersionId: string | null;
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
  transcript: TranscriptLine[];
  reviewVersions: ReviewVersion[];
}

interface PersistedMeetingState {
  status: MeetingStatus;
  meeting: MeetingConfig;
  transcript: TranscriptLine[];
  reviewMarkdown: string;
  reviewVersions: ReviewVersion[];
  currentReviewVersionId: string;
  timeline: TimelineEntry[];
  lastHeartbeatAt: number;
  nextHeartbeatAt: number;
  meetingStartedAt: number;
  heartbeatCount: number;
  isPaused: boolean;
  currentOutput: FacilitatorOutput | null;
  activeAgendaItemId: string | null;
  updatedAt: number;
  endedAt?: number | null;
}

interface InitialReviewDocument {
  source: FacilitatorOutput["source"];
  markdown: string;
  summary: string;
  adapterNotice?: string;
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

const DEFAULT_CLIENT_PI_TIMEOUT_MS = 25_000;
const MAX_HEARTBEAT_OUTPUT_CARDS = 5;

export default function RoomPulseApp() {
  const [phase, setPhase] = useState<Phase>("dashboard");
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
  const [isInitializingReview, setIsInitializingReview] = useState(false);
  const [meeting, setMeeting] = useState(defaultMeeting);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("mic");
  const [demoLine, setDemoLine] = useState("");
  const [demoSpeaker, setDemoSpeaker] = useState("Speaker 1");
  const [currentOutput, setCurrentOutput] = useState<FacilitatorOutput | null>(
    null
  );
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState(0);
  const [nextHeartbeatAt, setNextHeartbeatAt] = useState(0);
  const [now, setNow] = useState(0);
  const [isHeartbeatRunning, setIsHeartbeatRunning] = useState(false);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState("Local transcription idle");
  const [micPermissionStatus, setMicPermissionStatus] =
    useState("permission unknown");
  const [currentMicSpeaker, setCurrentMicSpeaker] = useState("Speaker 1");
  const [isMicRunning, setIsMicRunning] = useState(false);
  const [isDemoRunning, setIsDemoRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);
  const [reviewHandoffUrl, setReviewHandoffUrl] = useState<string | null>(null);
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
      timestamp: 0,
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
  const transcriptModeRef = useRef<TranscriptMode>("mic");
  const phaseRef = useRef<Phase>("dashboard");
  const currentMicSpeakerRef = useRef("Speaker 1");
  const micStartTokenRef = useRef(0);
  const micStopRequestedRef = useRef(false);
  const micReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const isHeartbeatRunningRef = useRef(false);
  const heartbeatRunTokenRef = useRef(0);
  const heartbeatAbortControllerRef = useRef<AbortController | null>(null);
  const isPausedRef = useRef(false);
  const transcriptFeedRef = useRef<HTMLDivElement | null>(null);
  const demoTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const meetingLogIdRef = useRef<string | null>(null);
  const pendingLogEventsRef = useRef<PendingMeetingLogEvent[]>([]);
  const isFlushingLogEventsRef = useRef(false);
  const flushLogEventsPromiseRef = useRef<Promise<void> | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endingSessionRef = useRef(false);
  const meetingStartInFlightRef = useRef(false);
  const meetingStartAttemptRef = useRef(0);
  const agendaItemSequenceRef = useRef(0);
  const agendaCountRef = useRef(defaultMeeting.agenda.length);
  const heartbeatReviewSequenceRef = useRef(0);
  const reviewRestoreSequenceRef = useRef(0);
  const reviewLastUpdatedAtRef = useRef(0);
  const heartbeatIntervalSecondsRef = useRef(
    defaultMeeting.heartbeatIntervalSeconds
  );
  const expectedParticipantsRef = useRef(defaultMeeting.expectedParticipants);
  const meetingStartedAtRef = useRef(0);

  const observedSpeakerLabels = useMemo(
    () =>
      normalizeObservedSpeakerLabels(transcript.map((line) => line.speakerLabel)),
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
  const countdownSeconds = Math.min(
    meeting.heartbeatIntervalSeconds,
    Math.max(0, Math.ceil((nextHeartbeatAt - now) / 1000))
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
    meeting.agenda.find(
      (item) => item.id === activeAgendaItemId && !item.done
    ) ??
    agendaProgress.active ??
    meeting.agenda[0] ??
    null;
  const dashboardStats = useMemo(
    () => ({
      total: pastMeetings.length,
      live: pastMeetings.filter((item) => item.status !== "ended").length,
      ended: pastMeetings.filter((item) => item.status === "ended").length
    }),
    [pastMeetings]
  );

  const configuredDraftMeeting = useMemo(
    () =>
      normalizeMeetingDraft(meetingDraft, agendaText, participantsText),
    [agendaText, meetingDraft, participantsText]
  );

  const buildPersistedMeetingState = useCallback(
    (overrides: Partial<PersistedMeetingState> = {}): PersistedMeetingState => {
      const updatedAt = Date.now();
      const transcriptSnapshot = transcriptStoreRef.current.getLines();
      return {
        status: isPaused ? "paused" : "active",
        meeting,
        transcript: transcriptSnapshot,
        reviewMarkdown,
        reviewVersions,
        currentReviewVersionId,
        timeline,
        lastHeartbeatAt,
        nextHeartbeatAt,
        meetingStartedAt,
        heartbeatCount,
        isPaused,
        currentOutput,
        activeAgendaItemId,
        updatedAt,
        ...overrides
      };
    },
    [
      activeAgendaItemId,
      currentOutput,
      currentReviewVersionId,
      heartbeatCount,
      isPaused,
      lastHeartbeatAt,
      meeting,
      meetingStartedAt,
      nextHeartbeatAt,
      reviewMarkdown,
      reviewVersions,
      timeline,
      transcript
    ]
  );

  useEffect(() => {
    agendaCountRef.current = meeting.agenda.length;
  }, [meeting.agenda.length]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    transcriptModeRef.current = transcriptMode;
  }, [transcriptMode]);

  useEffect(() => {
    heartbeatIntervalSecondsRef.current = meeting.heartbeatIntervalSeconds;
  }, [meeting.heartbeatIntervalSeconds]);

  useEffect(() => {
    expectedParticipantsRef.current = meeting.expectedParticipants;
  }, [meeting.expectedParticipants]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    meetingStartedAtRef.current = meetingStartedAt;
  }, [meetingStartedAt]);

  function setPhaseState(nextPhase: Phase) {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  }

  function setTranscriptModeState(nextMode: TranscriptMode) {
    transcriptModeRef.current = nextMode;
    setTranscriptMode(nextMode);
  }

  useEffect(() => {
    if (
      activeAgendaItemId &&
      meeting.agenda.some((item) => item.id === activeAgendaItemId && !item.done)
    ) {
      return;
    }
    setActiveAgendaItemId(
      agendaProgress.active?.id ?? meeting.agenda[0]?.id ?? null
    );
  }, [activeAgendaItemId, agendaProgress.active, meeting.agenda]);

  const flushPendingLogEvents = useCallback((meetingId: string) => {
    if (flushLogEventsPromiseRef.current) {
      return flushLogEventsPromiseRef.current;
    }

    const flushPromise = (async () => {
      isFlushingLogEventsRef.current = true;
      while (
        pendingLogEventsRef.current.length > 0 &&
        meetingLogIdRef.current === meetingId
      ) {
        const queued = pendingLogEventsRef.current.splice(0);
        const failed: PendingMeetingLogEvent[] = [];

        for (const event of queued) {
          try {
            await sendMeetingLogEvent(meetingId, event);
          } catch (error) {
            failed.push(event);
            pendingLogEventsRef.current = [
              ...failed,
              ...queued.slice(queued.indexOf(event) + 1),
              ...pendingLogEventsRef.current
            ];
            throw error;
          }
        }
      }
    })();

    flushLogEventsPromiseRef.current = flushPromise;
    return flushPromise.finally(() => {
      if (flushLogEventsPromiseRef.current === flushPromise) {
        flushLogEventsPromiseRef.current = null;
      }
      isFlushingLogEventsRef.current = false;
    });
  }, []);

  const logMeetingEvent = useCallback(
    (type: string, payload: unknown, timestamp = Date.now()) => {
      const event = { type, timestamp, payload };
      pendingLogEventsRef.current.push(event);
      const currentMeetingLogId = meetingLogIdRef.current;

      if (!currentMeetingLogId) {
        return;
      }

      void flushPendingLogEvents(currentMeetingLogId)
        .then(() => {
          setLogStatus(`Logging locally: ${currentMeetingLogId}`);
        })
        .catch((error) => {
          setLogStatus(
            `Log write failed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
    },
    [flushPendingLogEvents]
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
          endedAt: null,
          status: "active",
          isPaused: false,
          eventCount: 0,
          meeting: defaultMeeting,
          state: null,
          latestReviewMarkdown: "",
          latestReviewVersionId: null
        },
        events: [],
        transcript: [],
        reviewVersions: []
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

        await flushPendingLogEvents(metadata.id);
        void refreshPastMeetings();
      } catch (error) {
        setLogStatus(
          `Meeting logging unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    },
    [flushPendingLogEvents, refreshPastMeetings]
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

      const safeSpeakerLabel = normalizeSpeakerLabel(speakerLabel) ?? "Speaker 1";
      const speakerId = safeSpeakerLabel.toLowerCase().replace(/\s+/g, "-");
      const line = transcriptStoreRef.current.addLine({
        speakerId,
        speakerLabel: safeSpeakerLabel,
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
      heartbeatReviewSequenceRef.current += 1;
      const reviewVersionId = `${heartbeatNow}-review-r${heartbeatReviewSequenceRef.current}`;
      const finalReviewMarkdown = reviewMarkdownFromOutput(output);
      const finalEphemeralReminder =
        output.ephemeralReminder ?? reminderFromOutput(output);
      const finalOutput =
        finalReviewMarkdown === output.reviewMarkdown &&
        finalEphemeralReminder === output.ephemeralReminder
          ? output
          : {
              ...output,
              reviewMarkdown: finalReviewMarkdown,
              ephemeralReminder: finalEphemeralReminder
            };

      setCurrentOutput(finalOutput);
      reviewLastUpdatedAtRef.current = heartbeatNow;
      setReviewMarkdown(finalReviewMarkdown);
      setCurrentReviewVersionId(reviewVersionId);
      setReviewVersions((versions) => [
        {
          id: reviewVersionId,
          timestamp: heartbeatNow,
          source: finalOutput.source,
          markdown: finalReviewMarkdown,
          summary: finalOutput.summary
        },
        ...versions
      ]);
      setEphemeralReminder(finalOutput.ephemeralReminder);
      if (finalOutput.agendaActions.length > 0) {
        applyAgendaActions(finalOutput.agendaActions);
      }
      if (finalOutput.uiActions?.length > 0) {
        applyUiActions(finalOutput.uiActions);
      }
      setTimeline((entries) => [
        {
          id: `${heartbeatNow}-${entries.length + 1}`,
          timestamp: heartbeatNow,
          source: finalOutput.source,
          cards: finalOutput.cards,
          summary: finalOutput.summary,
          reviewMarkdown: finalReviewMarkdown,
          reminder: finalOutput.ephemeralReminder
        },
        ...entries
      ]);
      logMeetingEvent(
        "heartbeat_output",
        {
          output: finalOutput,
          reviewVersionId
        },
        heartbeatNow
      );
    },
    [logMeetingEvent]
  );

  const runHeartbeat = useCallback(async () => {
    if (
      isHeartbeatRunningRef.current ||
      endingSessionRef.current ||
      phase !== "meeting" ||
      isPausedRef.current
    ) {
      return;
    }

    const runToken = heartbeatRunTokenRef.current + 1;
    heartbeatRunTokenRef.current = runToken;
    const heartbeatSessionStartedAt = meetingStartedAtRef.current;
    const shouldApplyHeartbeatResult = () =>
      heartbeatRunTokenRef.current === runToken &&
      meetingStartedAtRef.current === heartbeatSessionStartedAt;
    const heartbeatNow = Date.now();
    const transcriptSnapshot = transcriptStoreRef.current.getLines();
    const speakerSnapshot = Array.from(
      new Set(transcriptSnapshot.map((line) => line.speakerLabel))
    );
    const input = createHeartbeatInput({
      meeting,
      transcript: transcriptSnapshot,
      observedSpeakerLabels: speakerSnapshot,
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

    let controller: AbortController | null = null;
    try {
      const activeController = new AbortController();
      controller = activeController;
      heartbeatAbortControllerRef.current = activeController;
      const timeout = window.setTimeout(() => {
        activeController.abort();
      }, getClientPiTimeoutMs());
      const response = await fetch("/api/heartbeat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: activeController.signal,
        body: JSON.stringify({
          meeting: input.meeting,
          transcript: input.transcript,
          observedSpeakerLabels: input.participation.observedLabels,
          lastHeartbeatAt,
          now: heartbeatNow,
          priorInterventions: input.priorInterventions,
          currentReviewMarkdown: input.currentReviewMarkdown,
          reviewVersions: input.reviewVersions,
          meetingStartedAt,
          isPaused,
          heartbeatCount
        })
      }).finally(() => {
        window.clearTimeout(timeout);
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as {
          error?: string;
          piRequired?: boolean;
        } | null;
        const heartbeatError = new Error(
          errorBody?.error ?? `Heartbeat route returned ${response.status}`
        );
        (heartbeatError as Error & { piRequired?: boolean }).piRequired =
          errorBody?.piRequired === true;
        throw heartbeatError;
      }

      const routeOutput = normalizeHeartbeatRouteOutput(await response.json());
      if (!routeOutput) {
        throw new Error("Heartbeat route returned invalid facilitator output");
      }
      if (isClientStrictPiRequired() && routeOutput.source === "local-fallback") {
        throw new Error(
          strictPiFallbackMessage("Pi heartbeat", routeOutput.adapterNotice)
        );
      }
      const output =
        routeOutput.source === "local-fallback"
          ? {
              ...(await runLocalHeartbeatInBrowser({
                ...input,
                currentReviewMarkdown: reviewMarkdown
              })),
              adapterNotice: routeOutput.adapterNotice
            }
          : routeOutput;
      if (!shouldApplyHeartbeatResult()) {
        return;
      }
      applyHeartbeatOutput(output, heartbeatNow);
      setHeartbeatCount((count) => count + 1);
      setLastHeartbeatAt(heartbeatNow);
      setNextHeartbeatAt(
        Date.now() + heartbeatIntervalSecondsRef.current * 1000
      );
    } catch (error) {
      if (!shouldApplyHeartbeatResult()) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setHeartbeatError(
        error instanceof DOMException && error.name === "AbortError"
          ? `Pi heartbeat timed out after ${getClientPiTimeoutMs()}ms`
          : message
      );
      if (
        isClientStrictPiRequired() ||
        (error as Error & { piRequired?: boolean })?.piRequired === true
      ) {
        setNextHeartbeatAt(
          Date.now() + heartbeatIntervalSecondsRef.current * 1000
        );
        return;
      }

      const fallbackOutput = await runLocalHeartbeatInBrowser({
        ...input,
        currentReviewMarkdown: reviewMarkdown
      });
      if (!shouldApplyHeartbeatResult()) {
        return;
      }
      applyHeartbeatOutput(fallbackOutput, heartbeatNow);
      setHeartbeatCount((count) => count + 1);
      setLastHeartbeatAt(heartbeatNow);
      setNextHeartbeatAt(
        Date.now() + heartbeatIntervalSecondsRef.current * 1000
      );
    } finally {
      if (
        controller &&
        heartbeatAbortControllerRef.current?.signal === controller.signal
      ) {
        heartbeatAbortControllerRef.current = null;
      }
      if (heartbeatRunTokenRef.current === runToken) {
        setIsHeartbeatRunning(false);
        isHeartbeatRunningRef.current = false;
      }
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

  async function initializeReviewDocument(
    configuredMeeting: MeetingConfig
  ): Promise<InitialReviewDocument> {
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => {
        controller.abort();
      }, getClientPiTimeoutMs());
      const response = await fetch("/api/review-document/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({ meeting: configuredMeeting })
      }).finally(() => {
        window.clearTimeout(timeout);
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          piRequired?: boolean;
        } | null;
        const initError = new Error(
          payload?.error ?? `Review initialization returned ${response.status}`
        );
        (initError as Error & { piRequired?: boolean }).piRequired =
          payload?.piRequired === true;
        throw initError;
      }

      const document = normalizeInitialReviewDocument(
        await response.json(),
        configuredMeeting
      );
      if (isClientStrictPiRequired() && document.source === "local-fallback") {
        throw new Error(
          strictPiFallbackMessage("Pi initial review", document.adapterNotice)
        );
      }

      return document;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        isClientStrictPiRequired() ||
        (error as Error & { piRequired?: boolean })?.piRequired === true
      ) {
        throw new Error(
          error instanceof DOMException && error.name === "AbortError"
            ? `Pi initial review timed out after ${getClientPiTimeoutMs()}ms`
            : message
        );
      }

      return {
        source: "local-fallback",
        markdown: createInitialReviewMarkdown(configuredMeeting),
        summary: "Local fallback initialized the meeting review document.",
        adapterNotice: message
      };
    }
  }

  const stopScriptedDemo = useCallback(() => {
    for (const timer of demoTimeoutsRef.current) {
      clearTimeout(timer);
    }
    demoTimeoutsRef.current = [];
    setIsDemoRunning(false);
  }, []);

  function invalidatePendingHeartbeat() {
    heartbeatRunTokenRef.current += 1;
    heartbeatAbortControllerRef.current?.abort();
    heartbeatAbortControllerRef.current = null;
    isHeartbeatRunningRef.current = false;
    setIsHeartbeatRunning(false);
  }

  async function openMeetingLog(id: string) {
    try {
      if (phase === "meeting" && meetingLogIdRef.current !== id) {
        const checkpointed = await checkpointCurrentMeetingBeforeLeaving();
        if (!checkpointed) {
          return;
        }
      }
      const response = await fetch(`/api/meetings/${encodeURIComponent(id)}`);
      if (!response.ok) {
        throw new Error(`Meeting log returned ${response.status}`);
      }
      const snapshot = (await response.json()) as ClientMeetingLogSnapshot;
      setSelectedMeetingLog(snapshot);

      if (snapshot.metadata.status === "ended") {
        invalidatePendingHeartbeat();
        navigateToMeetingReview(id);
        return;
      }

      restoreMeetingFromSnapshot(snapshot);
    } catch (error) {
      setLogStatus(
        `Meeting restore failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function restoreMeetingFromSnapshot(snapshot: ClientMeetingLogSnapshot) {
    invalidatePendingHeartbeat();
    meetingStartInFlightRef.current = false;
    meetingStartAttemptRef.current += 1;
    endingSessionRef.current = false;
    const restoredState = snapshot.metadata.state ?? fallbackStateFromSnapshot(snapshot);
    const restoredMeeting = meetingWithLoggedAgendaState(
      restoredState.meeting,
      snapshot.events
    );
    const restoredTranscript = mergeTranscriptLines(
      restoredState.transcript,
      snapshot.transcript
    );
    const materializedVersions =
      mergeReviewVersions(restoredState.reviewVersions, snapshot.reviewVersions);
    const loggedReviewVersions = heartbeatReviewVersionsFromEvents(
      snapshot.events
    ).filter(
      (loggedVersion) =>
        !materializedVersions.some((version) =>
          isSameMaterializedReviewVersion(version, loggedVersion)
        )
    );
    const restoredVersions = mergeReviewVersions(
      materializedVersions,
      loggedReviewVersions
    );
    const restoredTimeline = mergeTimelineEntriesWithEvents(
      restoredState.timeline,
      snapshot.events
    );
    const restoredCurrentOutput = mergeCurrentOutputWithHeartbeatEvents(
      restoredState.currentOutput,
      restoredState.timeline,
      snapshot.events
    );
    const latestRestoredVersion = restoredVersions[0] ?? null;
    const restoredReviewMarkdown =
      latestRestoredVersion?.markdown ||
      snapshot.metadata.latestReviewMarkdown ||
      restoredState.reviewMarkdown ||
      createInitialReviewMarkdown(restoredMeeting);
    const fallbackReviewVersion: ReviewVersion = {
      id: `${snapshot.metadata.startedAt}-initial-review`,
      timestamp: snapshot.metadata.startedAt,
      source: "initial",
      markdown: restoredReviewMarkdown,
      summary: "Initial meeting review document."
    };
    const effectiveReviewVersions =
      restoredVersions.length > 0 ? restoredVersions : [fallbackReviewVersion];
    const effectiveReviewVersionId =
      latestRestoredVersion?.id ??
      (effectiveReviewVersions.some(
        (version) => version.id === restoredState.currentReviewVersionId
      )
        ? restoredState.currentReviewVersionId
        : effectiveReviewVersions[0]?.id ?? fallbackReviewVersion.id);
    const paused =
      snapshot.metadata.status === "paused" || snapshot.metadata.isPaused;
    const nowMs = Date.now();
    const lastBeat = Math.max(
      restoredState.lastHeartbeatAt || snapshot.metadata.startedAt,
      latestHeartbeatTimestamp(snapshot)
    );
    const nextBeat = paused
      ? restoredState.nextHeartbeatAt
      : nowMs +
        Math.max(
          0,
          restoredMeeting.heartbeatIntervalSeconds * 1000 -
            Math.max(0, nowMs - lastBeat)
        );

    stopMic();
    stopScriptedDemo();
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    transcriptStoreRef.current.replace(restoredTranscript);
    reviewLastUpdatedAtRef.current = latestRestoredVersion?.timestamp ?? nowMs;
    meetingLogIdRef.current = snapshot.metadata.id;
    setMeetingLogId(snapshot.metadata.id);
    setMeeting(restoredMeeting);
    setMeetingDraft(restoredMeeting);
    setAgendaText(restoredMeeting.agenda.map((item) => item.title).join("\n"));
    setParticipantsText(
      restoredMeeting.participants
        .map((participant) =>
          participant.role
            ? `${participant.name} - ${participant.role}`
            : participant.name
        )
        .join("\n")
    );
    setTranscript(restoredTranscript);
    setTranscriptModeState("mic");
    setCurrentOutput(restoredCurrentOutput);
    setTimeline(restoredTimeline);
    setLastHeartbeatAt(lastBeat);
    setNextHeartbeatAt(nextBeat);
    const restoredStartedAt =
      restoredState.meetingStartedAt || snapshot.metadata.startedAt;
    meetingStartedAtRef.current = restoredStartedAt;
    setMeetingStartedAt(restoredStartedAt);
    setHeartbeatCount(
      Math.max(
        restoredState.heartbeatCount,
        heartbeatEventCount(snapshot.events),
        restoredTimeline.length
      )
    );
    isPausedRef.current = paused;
    setIsPaused(paused);
    setReviewMarkdown(restoredReviewMarkdown);
    setReviewVersions(effectiveReviewVersions);
    setCurrentReviewVersionId(effectiveReviewVersionId);
    setActiveAgendaItemId(
      restoredMeeting.agenda.some(
        (item) => item.id === restoredState.activeAgendaItemId && !item.done
      )
        ? restoredState.activeAgendaItemId
        : restoredMeeting.agenda.find((item) => !item.done)?.id ??
          restoredMeeting.agenda[0]?.id ??
          null
    );
    setEphemeralReminder(null);
    setHeartbeatError(null);
    setSelectedMeetingLog(snapshot);
    setIsPastMeetingsOpen(false);
    setLogStatus(`Resumed session: ${snapshot.metadata.id}`);
    setPhaseState("meeting");

    if (!paused) {
      void startMic(restoredMeeting.expectedParticipants);
    }
  }

  async function endMeetingSession() {
    if (isEndingSession || endingSessionRef.current) {
      return;
    }
    endingSessionRef.current = true;
    setIsEndingSession(true);

    const id = await waitForMeetingLogId(meetingLogIdRef, 2500);
    if (!id) {
      endingSessionRef.current = false;
      setIsEndingSession(false);
      setLogStatus("End session blocked: local session log is not ready yet.");
      return;
    }

    if (isHeartbeatRunningRef.current) {
      setLogStatus("Cancelling current heartbeat before ending session...");
      invalidatePendingHeartbeat();
    }

    setLogStatus("Ending session...");
    let meetingEndLogged = false;
    try {
      await stopMicAndFlushFinalSegment();
      stopScriptedDemo();
      const endedAt = Date.now();
      isPausedRef.current = true;
      setIsPaused(true);
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      await flushPendingLogEvents(id);
      const state = buildPersistedMeetingState({
        status: "ended",
        isPaused: true,
        endedAt,
        updatedAt: endedAt
      });
      await sendMeetingLogEvent(id, {
        type: "meeting_ended",
        timestamp: endedAt,
        payload: { endedAt }
      });
      meetingEndLogged = true;
      await sendMeetingState(id, {
        status: "ended",
        isPaused: true,
        endedAt,
        updatedAt: endedAt,
        state
      });
      await refreshPastMeetings();
      setReviewHandoffUrl(`/meetings/${encodeURIComponent(id)}`);
      navigateToMeetingReview(id);
    } catch (error) {
      if (meetingEndLogged) {
        const handoffUrl = `/meetings/${encodeURIComponent(id)}`;
        endingSessionRef.current = false;
        setIsEndingSession(false);
        setReviewHandoffUrl(handoffUrl);
        setLogStatus(
          `Meeting ended; final state save failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return;
      }
      endingSessionRef.current = false;
      setIsEndingSession(false);
      setLogStatus(
        `End session failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const startScriptedDemo = useCallback((
    heartbeatIntervalSeconds = meeting.heartbeatIntervalSeconds
  ) => {
    stopScriptedDemo();
    stopMic();
    setTranscriptModeState("demo");
    setIsDemoRunning(true);
    logMeetingEvent("scripted_demo_started", {
      durationMs: DEMO_DURATION_MS,
      beats: DEMO_SCRIPT.length
    });

    for (const beat of DEMO_SCRIPT) {
      const timer = setTimeout(() => {
        addTranscriptLine(beat.text, beat.speaker, "simulated");
      }, beat.delayMs);
      demoTimeoutsRef.current.push(timer);
    }

    const finalTimer = setTimeout(() => {
      setIsDemoRunning(false);
      demoTimeoutsRef.current = [];
    }, DEMO_DURATION_MS + heartbeatIntervalSeconds * 1000);
    demoTimeoutsRef.current.push(finalTimer);
  }, [
    addTranscriptLine,
    logMeetingEvent,
    meeting.heartbeatIntervalSeconds,
    stopScriptedDemo
  ]);

  const launchLiveDemo = useCallback(async () => {
    if (meetingStartInFlightRef.current) {
      return;
    }
    meetingStartInFlightRef.current = true;
    invalidatePendingHeartbeat();
    const attemptId = meetingStartAttemptRef.current + 1;
    meetingStartAttemptRef.current = attemptId;
    endingSessionRef.current = false;
    setIsInitializingReview(true);
    setHeartbeatError(null);
    const demoMeeting: MeetingConfig = {
      title: "RoomPulse MVP readiness review",
      goal:
        "Leave with owners for mic capture, transcription quality, Pi review latency, markdown rendering, and end-session export.",
      context:
        "RoomPulse is a room-visible AI meeting facilitator. The team is deciding whether the local MVP is ready for a realistic demo: browser microphone capture, local Whisper transcription, speaker clustering, Pi heartbeats, markdown review updates, SQLite sessions, and review/export after ending.",
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
    const initialReview = createPendingReviewMarkdown(demoMeeting);
    const initialVersion: ReviewVersion = {
      id: `${startedAt}-pending-review`,
      timestamp: startedAt,
      source: "initial",
      markdown: initialReview,
      summary: "Strict Pi initialization is running."
    };

    setMeeting(demoMeeting);
    setActiveAgendaItemId(
      demoMeeting.agenda.find((item) => !item.done)?.id ??
        demoMeeting.agenda[0]?.id ??
        null
    );
    setPhaseState("meeting");
    meetingStartedAtRef.current = startedAt;
    setMeetingStartedAt(startedAt);
    setHeartbeatCount(0);
    isPausedRef.current = false;
    setIsPaused(false);
    reviewLastUpdatedAtRef.current = startedAt;
    setReviewMarkdown(initialReview);
    setReviewVersions([initialVersion]);
    setCurrentReviewVersionId(initialVersion.id);
    setEphemeralReminder(null);
    setCurrentOutput({
      source: "pi",
      cards: [
        {
          id: "demo-armed",
          kind: "heartbeat",
          title: "Transcript armed",
          body:
            "Scripted transcript starts in moments; heartbeat facilitation will run through Pi.",
          priority: "medium"
        }
      ],
      summary: "Strict Pi initialization is running.",
      nextHeartbeatHint: `First pulse will arrive at ${demoMeeting.heartbeatIntervalSeconds} seconds.`,
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
    setIsInitializingReview(false);
    const demoStartTimer = setTimeout(
      () => startScriptedDemo(demoMeeting.heartbeatIntervalSeconds),
      120
    );
    demoTimeoutsRef.current.push(demoStartTimer);

    void initializeReviewDocument(demoMeeting)
      .then((initialDocument) => {
        if (
          meetingStartAttemptRef.current !== attemptId ||
          meetingStartedAtRef.current !== startedAt
        ) {
          return;
        }
        const initializedAt = Date.now();
        if (reviewLastUpdatedAtRef.current > startedAt) {
          return;
        }
        const initializedVersion: ReviewVersion = {
          id: `${initializedAt}-initial-review`,
          timestamp: initializedAt,
          source: initialDocument.source,
          markdown: initialDocument.markdown,
          summary: initialDocument.summary
        };
        reviewLastUpdatedAtRef.current = initializedAt;
        setReviewMarkdown(initialDocument.markdown);
        setReviewVersions((versions) => [initializedVersion, ...versions]);
        setCurrentReviewVersionId(initializedVersion.id);
        setCurrentOutput((current) => ({
          source: initialDocument.source,
          cards:
            current?.cards.length
              ? current.cards
              : [
                  {
                    id: "demo-armed",
                    kind: "heartbeat",
                    title: "Transcript armed",
                    body:
                      "Scripted transcript starts in moments; heartbeat facilitation will run through Pi.",
                    priority: "medium"
                  }
                ],
          summary: initialDocument.summary,
          nextHeartbeatHint:
            current?.nextHeartbeatHint ??
            `First pulse will arrive at ${demoMeeting.heartbeatIntervalSeconds} seconds.`,
          reviewMarkdown: initialDocument.markdown,
          agendaActions: current?.agendaActions ?? [],
          uiActions: current?.uiActions ?? [],
          ephemeralReminder: current?.ephemeralReminder ?? null,
          adapterNotice: initialDocument.adapterNotice
        }));
        logMeetingEvent(
          "review_initialized",
          { reviewVersion: initializedVersion },
          initializedAt
        );
      })
      .catch((error) => {
        if (
          meetingStartAttemptRef.current !== attemptId ||
          reviewLastUpdatedAtRef.current > startedAt
        ) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setHeartbeatError(message);
        setLogStatus(`Live demo Pi init failed: ${message}`);
        logMeetingEvent(
          "review_initialization_failed",
          { message },
          Date.now()
        );
      });
  }, [createMeetingLogFor, logMeetingEvent, startScriptedDemo]);

  useEffect(() => {
    const refreshClock = () => {
      setNow(Date.now());
    };
    refreshClock();
    const timer = setInterval(refreshClock, 1000);
    document.addEventListener("visibilitychange", refreshClock);
    window.addEventListener("focus", refreshClock);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshClock);
      window.removeEventListener("focus", refreshClock);
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
      micStopRequestedRef.current = true;
      clearMicReconnectTimer();
      void cleanupMicResources();
    };
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (
      !mediaDevices?.addEventListener ||
      !mediaDevices.removeEventListener
    ) {
      return;
    }

    const handleDeviceChange = () => {
      void restartMicAfterDeviceChange();
    };
    mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, []);

  useEffect(() => {
    if (!isMicRunning) {
      return;
    }
    const client = transcriptionClientRef.current;
    if (typeof client?.configureExpectedParticipants !== "function") {
      return;
    }
    client.configureExpectedParticipants(meeting.expectedParticipants);
  }, [isMicRunning, meeting.expectedParticipants]);

  useEffect(() => {
    return () => {
      stopScriptedDemo();
    };
  }, [stopScriptedDemo]);

  useEffect(() => {
    let active = true;
    let permissionStatus: PermissionStatus | null = null;

    async function readMicPermission() {
      if (!navigator.permissions?.query) {
        if (active) {
          setMicPermissionStatus("permission API unavailable");
        }
        return;
      }

      try {
        const queriedPermissionStatus = await navigator.permissions.query({
          name: "microphone" as PermissionName
        });
        if (!active) {
          return;
        }
        permissionStatus = queriedPermissionStatus;
        const update = () => {
          setMicPermissionStatus(permissionStatus?.state ?? "permission unknown");
        };
        update();
        permissionStatus.onchange = update;
      } catch {
        if (active) {
          setMicPermissionStatus("permission API unavailable");
        }
      }
    }

    void readMicPermission();

    return () => {
      active = false;
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
    if (phase === "dashboard" || phase === "setup") {
      void refreshPastMeetings();
    }
  }, [phase, refreshPastMeetings]);

  useEffect(() => {
    if (phase !== "meeting" || !meetingLogId || endingSessionRef.current) {
      return;
    }

    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }

    const state = buildPersistedMeetingState();
    autosaveTimerRef.current = setTimeout(() => {
      void sendMeetingState(meetingLogId, {
        status: state.status,
        isPaused: state.isPaused,
        updatedAt: state.updatedAt,
        state
      }).catch((error) => {
        setLogStatus(
          `Session save failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, 350);

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [buildPersistedMeetingState, meetingLogId, phase]);

  async function startMeeting() {
    if (meetingStartInFlightRef.current) {
      return;
    }
    meetingStartInFlightRef.current = true;
    invalidatePendingHeartbeat();
    endingSessionRef.current = false;
    const attemptId = meetingStartAttemptRef.current + 1;
    meetingStartAttemptRef.current = attemptId;
    const configuredMeeting = configuredDraftMeeting;
    setIsInitializingReview(true);
    setHeartbeatError(null);
    let initialDocument: InitialReviewDocument;
    try {
      initialDocument = await initializeReviewDocument(configuredMeeting);
    } catch (error) {
      if (meetingStartAttemptRef.current !== attemptId) {
        meetingStartInFlightRef.current = false;
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setHeartbeatError(message);
      setLogStatus(`Meeting start blocked: ${message}`);
      setIsInitializingReview(false);
      meetingStartInFlightRef.current = false;
      return;
    }
    if (meetingStartAttemptRef.current !== attemptId) {
      meetingStartInFlightRef.current = false;
      return;
    }
    setIsInitializingReview(false);
    meetingStartInFlightRef.current = false;

    setMeeting(configuredMeeting);
    setActiveAgendaItemId(
      configuredMeeting.agenda.find((item) => !item.done)?.id ??
        configuredMeeting.agenda[0]?.id ??
        null
    );
    setPhaseState("meeting");
    const startedAt = Date.now();
    const initialReview = initialDocument.markdown;
    const initialVersion: ReviewVersion = {
      id: `${startedAt}-initial-review`,
      timestamp: startedAt,
      source: initialDocument.source,
      markdown: initialReview,
      summary: initialDocument.summary
    };
    meetingStartedAtRef.current = startedAt;
    setMeetingStartedAt(startedAt);
    setHeartbeatCount(0);
    isPausedRef.current = false;
    setIsPaused(false);
    reviewLastUpdatedAtRef.current = startedAt;
    setReviewMarkdown(initialReview);
    setReviewVersions([initialVersion]);
    setCurrentReviewVersionId(initialVersion.id);
    setEphemeralReminder(null);
    setCurrentOutput({
      source: initialDocument.source,
      cards: [
        {
          id: "initial-heartbeat",
          kind: "heartbeat",
          title: "Document ready",
          body:
            "The initialized review document is ready; the next heartbeat will revise it from the full file.",
          priority: "medium"
        }
      ],
      summary: initialDocument.summary,
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
    setTranscriptModeState("mic");
    void startMic(configuredMeeting.expectedParticipants);
    void createMeetingLogFor(configuredMeeting, startedAt, [
      {
        type: "meeting_started",
        timestamp: startedAt,
        payload: { meeting: configuredMeeting, mode: "manual" }
      },
      {
        type: "review_initialized",
        timestamp: startedAt,
        payload: { reviewVersion: initialVersion }
      }
    ]);
  }

  function addDemoLine() {
    const text = demoLine || demoSnippets[transcript.length % demoSnippets.length];
    addTranscriptLine(text, demoSpeaker, "simulated");
    setDemoLine("");
  }

  function clearMicReconnectTimer() {
    if (micReconnectTimerRef.current) {
      clearTimeout(micReconnectTimerRef.current);
      micReconnectTimerRef.current = null;
    }
  }

  function scheduleMicReconnect(expectedParticipants: number) {
    if (
      micStopRequestedRef.current ||
      transcriptModeRef.current !== "mic" ||
      phaseRef.current !== "meeting" ||
      endingSessionRef.current ||
      micReconnectTimerRef.current
    ) {
      return;
    }

    setMicStatus("Reconnecting local transcription stream");
    micReconnectTimerRef.current = setTimeout(() => {
      micReconnectTimerRef.current = null;
      if (
        micStopRequestedRef.current ||
        transcriptModeRef.current !== "mic" ||
        phaseRef.current !== "meeting" ||
        endingSessionRef.current
      ) {
        return;
      }
      void startMic(expectedParticipants);
    }, 100);
  }

  async function startMic(
    expectedParticipants = meeting.expectedParticipants
  ) {
    setTranscriptModeState("mic");

    if (isMicRunning || transcriptionClientRef.current) {
      return;
    }

    clearMicReconnectTimer();
    micStopRequestedRef.current = false;
    const startToken = micStartTokenRef.current + 1;
    micStartTokenRef.current = startToken;
    let client: LocalTranscriptionClient | null = null;
    try {
      setMicStatus("Requesting browser microphone permission");
      client = new LocalTranscriptionClient({
        expectedParticipants,
        speakerLabelOffset: highestSpeakerNumber(
          transcriptStoreRef.current
            .getLines()
            .map((line) => line.speakerLabel)
        ),
        onSegment: (segment) => {
          if (micStartTokenRef.current !== startToken) {
            return;
          }
          const safeSpeakerLabel =
            normalizeSpeakerLabel(segment.speakerLabel) ?? "Speaker 1";
          currentMicSpeakerRef.current = safeSpeakerLabel;
          setCurrentMicSpeaker(safeSpeakerLabel);
          addTranscriptLine(
            segment.text,
            safeSpeakerLabel,
            "speech",
            segment.confidence
          );
        },
        onStatus: (status) => {
          if (micStartTokenRef.current !== startToken) {
            return;
          }
          const observed = status.observedSpeakerLabels;
          if (observed && observed.length > 0) {
            const latest = latestNormalizedSpeakerLabel(observed);
            if (latest) {
              currentMicSpeakerRef.current = latest;
              setCurrentMicSpeaker(latest);
            }
          }
          if (status.status === "closed") {
            setIsMicRunning(false);
            transcriptionClientRef.current = null;
            scheduleMicReconnect(expectedParticipants);
            if (!micStopRequestedRef.current) {
              return;
            }
          }
          setMicStatus(status.message);
        },
        onError: (message) => {
          if (micStartTokenRef.current !== startToken) {
            return;
          }
          setMicStatus(`Local transcription error: ${message}`);
        }
      });
      transcriptionClientRef.current = client;
      await client.start();
      if (
        micStartTokenRef.current !== startToken ||
        transcriptionClientRef.current !== client
      ) {
        await client.stop();
        return;
      }
      setIsMicRunning(true);
    } catch (error) {
      const shouldRetry = isRetryableMicStartError(error);
      micStopRequestedRef.current = !shouldRetry;
      if (transcriptionClientRef.current === client) {
        void cleanupMicResources();
      } else {
        void client?.stop();
      }
      if (micStartTokenRef.current === startToken) {
        setIsMicRunning(false);
        setMicStatus(error instanceof Error ? error.message : String(error));
        if (shouldRetry) {
          scheduleMicReconnect(expectedParticipants);
        }
      }
    }
  }

  function stopMic() {
    micStopRequestedRef.current = true;
    clearMicReconnectTimer();
    micStartTokenRef.current += 1;
    void cleanupMicResources();
    currentMicSpeakerRef.current = "Speaker 1";
    setCurrentMicSpeaker("Speaker 1");
    setIsMicRunning(false);
    setMicStatus("Local transcription idle");
  }

  async function restartMicAfterDeviceChange() {
    if (
      micStopRequestedRef.current ||
      transcriptModeRef.current !== "mic" ||
      phaseRef.current !== "meeting" ||
      endingSessionRef.current ||
      !transcriptionClientRef.current
    ) {
      return;
    }

    micStopRequestedRef.current = true;
    clearMicReconnectTimer();
    micStartTokenRef.current += 1;
    const restartToken = micStartTokenRef.current;
    setIsMicRunning(false);
    setMicStatus("Audio input devices changed; reconnecting local transcription");
    await cleanupMicResources();

    if (
      micStartTokenRef.current !== restartToken ||
      transcriptModeRef.current !== "mic" ||
      phaseRef.current !== "meeting" ||
      endingSessionRef.current
    ) {
      return;
    }

    void startMic(expectedParticipantsRef.current);
  }

  async function stopMicAndFlushFinalSegment() {
    micStopRequestedRef.current = true;
    clearMicReconnectTimer();
    await cleanupMicResources();
    micStartTokenRef.current += 1;
    currentMicSpeakerRef.current = "Speaker 1";
    setCurrentMicSpeaker("Speaker 1");
    setIsMicRunning(false);
    setMicStatus("Local transcription idle");
  }

  async function cleanupMicResources() {
    const client = transcriptionClientRef.current;
    transcriptionClientRef.current = null;
    await client?.stop();
  }

  function updateAgendaItem(id: string, done: boolean) {
    setMeeting((current) => {
      let changed = false;
      const agenda = current.agenda.map((item) => {
        if (item.id !== id) {
          return item;
        }
        if (item.done === done) {
          return item;
        }

        changed = true;
        logMeetingEvent("agenda_manual_update", { itemId: id, done });
        return { ...item, done };
      });

      return changed ? { ...current, agenda } : current;
    });
  }

  function addAgendaItem(title: string, reason: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (agendaCountRef.current >= MAX_AGENDA_ITEMS) {
      setLogStatus(`Agenda limit reached (${MAX_AGENDA_ITEMS} items).`);
      return;
    }
    agendaItemSequenceRef.current += 1;
    agendaCountRef.current += 1;

    const item: AgendaItem = {
      id: `agenda-${Date.now()}-${agendaItemSequenceRef.current}`,
      title: trimmed,
      done: false
    };
    setMeeting((current) => {
      if (current.agenda.length >= MAX_AGENDA_ITEMS) {
        agendaCountRef.current = current.agenda.length;
        return current;
      }
      return {
        ...current,
        agenda: [...current.agenda, item]
      };
    });
    setActiveAgendaItemId((current) => current ?? item.id);
    logMeetingEvent("agenda_item_added", { item, reason });
  }

  function deleteAgendaItem(id: string, reason: string) {
    setMeeting((current) => {
      const deleted = current.agenda.find((item) => item.id === id);
      if (!deleted) return current;
      const agenda = current.agenda.filter((item) => item.id !== id);
      agendaCountRef.current = agenda.length;
      logMeetingEvent("agenda_item_deleted", { item: deleted, reason });
      setActiveAgendaItemId((activeId) =>
        activeId === id
          ? agenda.find((item) => !item.done)?.id ?? agenda[0]?.id ?? null
          : activeId
      );
      return { ...current, agenda };
    });
  }

  function setRuntimeHeartbeatInterval(value: number) {
    const seconds = clampFiniteNumber(
      value,
      meeting.heartbeatIntervalSeconds,
      MIN_HEARTBEAT_INTERVAL_SECONDS,
      MAX_HEARTBEAT_INTERVAL_SECONDS
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
    reviewRestoreSequenceRef.current += 1;
    const restoredVersion: ReviewVersion = {
      id: `${restoredAt}-restored-r${reviewRestoreSequenceRef.current}-${version.id}`,
      timestamp: restoredAt,
      source: "restored",
      markdown: version.markdown,
      summary: `Restored review from ${formatClock(version.timestamp)}.`
    };
    reviewLastUpdatedAtRef.current = restoredAt;
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
    isPausedRef.current = nextPaused;
    setIsPaused(nextPaused);
    if (nextPaused && isHeartbeatRunningRef.current) {
      invalidatePendingHeartbeat();
    }
    logMeetingEvent("meeting_pause_toggled", { paused: nextPaused });
    if (!nextPaused) {
      setNextHeartbeatAt(Date.now() + meeting.heartbeatIntervalSeconds * 1000);
    }
  }

  async function checkpointCurrentMeetingBeforeLeaving(): Promise<boolean> {
    if (phase !== "meeting" || endingSessionRef.current) {
      return true;
    }

    const id = await waitForMeetingLogId(meetingLogIdRef, 2500);
    if (!id) {
      setLogStatus("Session checkpoint blocked: local session log is not ready yet.");
      return false;
    }

    const updatedAt = Date.now();
    const state = buildPersistedMeetingState({
      status: "paused",
      isPaused: true,
      updatedAt
    });
    try {
      await flushPendingLogEvents(id);
      await sendMeetingState(id, {
        status: "paused",
        isPaused: true,
        updatedAt,
        state
      });
      return true;
    } catch (error) {
      setLogStatus(
        `Session checkpoint failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  async function startNewMeetingSetup() {
    if (phase === "meeting") {
      const checkpointed = await checkpointCurrentMeetingBeforeLeaving();
      if (!checkpointed) {
        return;
      }
    }
    invalidatePendingHeartbeat();
    meetingStartInFlightRef.current = false;
    meetingStartAttemptRef.current += 1;
    endingSessionRef.current = false;
    stopMic();
    stopScriptedDemo();
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    transcriptStoreRef.current.clear();
    meetingLogIdRef.current = null;
    pendingLogEventsRef.current = [];
    setMeetingLogId(null);
    setReviewHandoffUrl(null);
    setHeartbeatError(null);
    setEphemeralReminder(null);
    setSelectedMeetingLog(null);
    setIsPastMeetingsOpen(false);
    setShowSettings(false);
    setTranscript([]);
    setTimeline([]);
    setCurrentOutput(null);
    setHeartbeatCount(0);
    setLastHeartbeatAt(0);
    setNextHeartbeatAt(0);
    meetingStartedAtRef.current = 0;
    setMeetingStartedAt(0);
    isPausedRef.current = false;
    setIsPaused(false);
    setMeeting(defaultMeeting);
    setMeetingDraft(defaultMeeting);
    setAgendaText(defaultMeeting.agenda.map((item) => item.title).join("\n"));
    setParticipantsText(
      defaultMeeting.participants
        .map((participant) =>
          participant.role
            ? `${participant.name} - ${participant.role}`
            : participant.name
        )
        .join("\n")
    );
    const initialReview = createInitialReviewMarkdown(defaultMeeting);
    reviewLastUpdatedAtRef.current = Date.now();
    setReviewMarkdown(initialReview);
    setReviewVersions([
      {
        id: "initial-review",
        timestamp: Date.now(),
        source: "initial",
        markdown: initialReview,
        summary: "Initial meeting review document."
      }
    ]);
    setCurrentReviewVersionId("initial-review");
    setActiveAgendaItemId(
      defaultMeeting.agenda.find((item) => !item.done)?.id ??
        defaultMeeting.agenda[0]?.id ??
        null
    );
    setLogStatus("Preparing new meeting.");
    setPhaseState("setup");
  }

  function returnToDashboard() {
    invalidatePendingHeartbeat();
    meetingStartInFlightRef.current = false;
    meetingStartAttemptRef.current += 1;
    stopMic();
    stopScriptedDemo();
    setShowSettings(false);
    setIsPastMeetingsOpen(false);
    setSelectedMeetingLog(null);
    setReviewHandoffUrl(null);
    setPhaseState("dashboard");
    void refreshPastMeetings();
  }

  if (phase === "dashboard") {
    return (
      <main className="app-shell dashboard-shell">
        <header className="app-topbar dashboard-topbar">
          <BrandMark />
          <div className="dashboard-topbar-actions">
            <button
              className="btn outlined"
              type="button"
              onClick={() => void refreshPastMeetings()}
            >
              <MaterialIcon name="refresh" />
              Refresh
            </button>
            <button
              className="btn primary"
              type="button"
              onClick={() => void startNewMeetingSetup()}
            >
              <MaterialIcon name="add" />
              New meeting
            </button>
          </div>
        </header>

        <section className="dashboard-workspace" aria-labelledby="dashboard-title">
          <section className="dashboard-main">
            <div className="section-kicker">Dashboard</div>
            <h1 id="dashboard-title">RoomPulse sessions</h1>
            <p>
              Start a room display, resume an active session, or open the final
              review for an ended meeting.
            </p>
            <div className="dashboard-actions">
              <button
                className="primary-action dashboard-primary-action"
                type="button"
                onClick={() => void startNewMeetingSetup()}
              >
                <MaterialIcon name="add_circle" filled />
                New meeting
              </button>
              <button
                className="btn outlined dashboard-demo-action"
                disabled={isInitializingReview}
                type="button"
                onClick={() => void launchLiveDemo()}
              >
                <MaterialIcon name="movie" />
                {isInitializingReview ? "Starting demo..." : "Launch live demo"}
              </button>
            </div>
            <div className="dashboard-stat-grid" aria-label="Meeting log summary">
              <div>
                <strong>{dashboardStats.total}</strong>
                <span>sessions</span>
              </div>
              <div>
                <strong>{dashboardStats.live}</strong>
                <span>resumable</span>
              </div>
              <div>
                <strong>{dashboardStats.ended}</strong>
                <span>ended</span>
              </div>
            </div>
          </section>

          <PastMeetingPanel
            meetings={pastMeetings}
            selectedMeetingLog={selectedMeetingLog}
            title="Past meetings"
            emptyLabel="No local meeting logs yet."
            onOpen={(id) => void openMeetingLog(id)}
            onRefresh={() => void refreshPastMeetings()}
            onSelect={(id) => void loadPastMeetingLog(id)}
          />
        </section>
      </main>
    );
  }

  if (phase === "setup") {
    return (
      <main className="app-shell setup-shell">
        <header className="app-topbar setup-topbar">
          <button
            aria-label="Back to dashboard"
            className="icon-button"
            type="button"
            disabled={isInitializingReview}
            onClick={returnToDashboard}
          >
            <MaterialIcon name="arrow_back" />
          </button>
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
              void startMeeting();
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
                  max={MAX_EXPECTED_PARTICIPANTS}
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
                  min={MIN_HEARTBEAT_INTERVAL_SECONDS}
                  max={MAX_HEARTBEAT_INTERVAL_SECONDS}
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
            <button
              className="primary-action"
              disabled={isInitializingReview}
              type="submit"
            >
              {isInitializingReview ? "Initializing..." : "Start meeting"}
            </button>
            {heartbeatError ? (
              <p className="setup-error" role="alert">
                {heartbeatError}
              </p>
            ) : null}
          </form>

          <aside className="preview-panel">
            <section className="setup-card demo-launch">
              <div className="setup-card-title">
                <span className="status-dot live" />
                <strong>One-click demo</strong>
              </div>
              <p>
                Jump straight to a launch-readiness meeting with a hard-coded
                transcript stream. Heartbeat reviews, reminders, and agenda
                changes still run through Pi.
              </p>
              <button
                type="button"
                className="demo-launch-button"
                disabled={isInitializingReview}
                onClick={() => void launchLiveDemo()}
              >
                {isInitializingReview ? "Starting demo..." : "Launch live demo"}
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
            <PastMeetingPanel
              meetings={pastMeetings}
              selectedMeetingLog={selectedMeetingLog}
              title="Past meetings"
              emptyLabel="No local meeting logs yet."
              limit={5}
              onOpen={(id) => void openMeetingLog(id)}
              onRefresh={() => void refreshPastMeetings()}
              onSelect={(id) => void loadPastMeetingLog(id)}
            />
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
                  min={MIN_HEARTBEAT_INTERVAL_SECONDS}
                  max={MAX_HEARTBEAT_INTERVAL_SECONDS}
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
                  max={MAX_EXPECTED_PARTICIPANTS}
                  type="number"
                  value={meeting.expectedParticipants}
                  onChange={(event) =>
                    setMeeting((current) => ({
                      ...current,
                      expectedParticipants: clampFiniteNumber(
                        Number(event.target.value),
                        current.expectedParticipants,
                        1,
                        MAX_EXPECTED_PARTICIPANTS
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
          onOpen={(id) => void openMeetingLog(id)}
          onNewMeeting={() => {
            void startNewMeetingSetup();
          }}
        />
      ) : null}

      <section className="meet-subheader">
        <div className="meeting-title-block">
          <div className="meeting-kicker">
            <span className={`status-dot ${isPaused ? "" : "live"}`} />
            <span>{isPaused ? "Meeting paused" : "Meeting live"}</span>
            {isDemoRunning ? <span className="demo-pill">Demo running</span> : null}
            {isHeartbeatRunning ? (
              <span className="demo-pill">Reviewing in background</span>
            ) : null}
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
            <MaterialIcon name={currentOutput?.source === "local-fallback" ? "memory" : "auto_awesome"} />
            {facilitatorSourceLabel(currentOutput?.source)}
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
                  setTranscriptModeState("demo");
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
            {isHeartbeatRunning ? (
              <div className="review-progress-banner" role="status">
                Heartbeat review is running; transcript capture continues live.
              </div>
            ) : null}
            {transcript.length === 0 ? (
              <p className="empty-state">
                Raw transcript will appear here as speech or simulated lines arrive.
              </p>
            ) : (
              transcript.map((line) => (
                <article className="transcript-line" key={line.id}>
                  <div className={`speaker-badge ${speakerBadgeClass(line.speakerLabel)}`}>
                    {speakerBadgeLabel(line.speakerLabel)}
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

          {transcriptMode === "demo" ? (
            <div className="demo-controls">
              <label>
                <span>Demo speaker</span>
                <select
                  value={demoSpeaker}
                  onChange={(event) => setDemoSpeaker(event.target.value)}
                >
                  {Array.from(
                    {
                      length: Math.max(
                        6,
                        Math.min(
                          MAX_EXPECTED_PARTICIPANTS,
                          meeting.expectedParticipants
                        )
                      )
                    },
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
                Add line
              </button>
            </div>
          ) : null}
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
            <span>{facilitatorSourceLabel(currentOutput?.source)}</span>
          </div>
          <div className="review-meta">
            <span>{reviewVersions.length} versions</span>
            <span>{formatElapsed(meetingElapsedSeconds)} elapsed</span>
            {isHeartbeatRunning ? <span>Reviewing latest heartbeat</span> : null}
            {currentOutput?.adapterNotice ? <span>{currentOutput.adapterNotice}</span> : null}
            {heartbeatError ? <span>{heartbeatError}</span> : null}
          </div>
          {currentOutput?.cards.length ? (
            <section className="facilitator-cues" aria-label="Current facilitator cues">
              {currentOutput.cards.map((card) => (
                <article className={`facilitator-cue ${card.priority}`} key={card.id}>
                  <span>{card.kind}</span>
                  <strong>{card.title}</strong>
                  <p>{card.body}</p>
                </article>
              ))}
            </section>
          ) : null}
          {timeline.length > 0 ? (
            <section className="intervention-timeline" aria-label="Prior heartbeat interventions">
              <div className="section-kicker">Prior interventions</div>
              {timeline.slice(0, 3).map((entry) => (
                <p key={entry.id}>
                  <time>{formatClock(entry.timestamp)}</time>
                  {entry.summary}
                </p>
              ))}
            </section>
          ) : null}
          <article className="markdown-document">
            <MarkdownDocument markdown={reviewMarkdown} />
          </article>
          <div className="version-bar" aria-label="Review document version control">
            <button
              disabled={reviewVersions.length < 2}
              type="button"
              onClick={() => {
                const previous = previousReviewVersion(
                  reviewVersions,
                  currentReviewVersionId,
                  reviewMarkdown
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
          onClick={isDemoRunning ? stopScriptedDemo : () => startScriptedDemo()}
        >
          <MaterialIcon name={isDemoRunning ? "stop_circle" : "movie"} filled />
          {isDemoRunning ? "Stop demo" : "Script demo"}
        </button>
        <span className="bottom-divider" />
        <button
          aria-label="Run heartbeat now"
          className="pill-btn primary"
          disabled={
            isHeartbeatRunning || isEndingSession || isInitializingReview || isPaused
          }
          type="button"
          onClick={() => void runHeartbeat()}
        >
          <MaterialIcon name="favorite" filled />
          {isHeartbeatRunning ? "Reviewing..." : "Run heartbeat"}
        </button>
        <span className="bottom-divider" />
        <button
          className="pill-btn danger"
          disabled={isEndingSession}
          type="button"
          onClick={() => {
            void endMeetingSession();
          }}
        >
          <MaterialIcon name="call_end" filled />
          {isEndingSession ? "Ending..." : "End & review"}
        </button>
      </div>

      {reviewHandoffUrl ? (
        <div className="review-handoff" role="status">
          <MaterialIcon name="article" filled />
          <div>
            <span>Meeting ended</span>
            <p>The review and export page is ready.</p>
          </div>
          <a href={reviewHandoffUrl}>Open review/export</a>
        </div>
      ) : null}

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

function PastMeetingPanel({
  meetings,
  selectedMeetingLog,
  title,
  emptyLabel,
  limit,
  onRefresh,
  onSelect,
  onOpen
}: {
  meetings: ClientMeetingLogMetadata[];
  selectedMeetingLog: ClientMeetingLogSnapshot | null;
  title: string;
  emptyLabel: string;
  limit?: number;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const visibleMeetings =
    typeof limit === "number" ? meetings.slice(0, limit) : meetings;

  return (
    <section className="setup-card past-meetings">
      <div className="setup-card-title">
        <strong>{title}</strong>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {visibleMeetings.length === 0 ? (
        <p>{emptyLabel}</p>
      ) : (
        <div className="past-meeting-list">
          {visibleMeetings.map((pastMeeting) => (
            <article className="past-meeting-row" key={pastMeeting.id}>
              <button
                className="past-meeting-select"
                type="button"
                onClick={() => onSelect(pastMeeting.id)}
              >
                <span className={`drawer-dot ${pastMeeting.status}`} />
                <span>
                  <strong>{pastMeeting.title}</strong>
                  <small>
                    {pastMeeting.status} - {pastMeeting.eventCount} events -{" "}
                    {formatClock(pastMeeting.startedAt)}
                  </small>
                </span>
              </button>
              <button
                className="past-meeting-open"
                type="button"
                onClick={() => onOpen(pastMeeting.id)}
              >
                {pastMeeting.status === "ended" ? "Review" : "Resume"}
              </button>
            </article>
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
          <button
            className="btn outlined"
            type="button"
            onClick={() => onOpen(selectedMeetingLog.metadata.id)}
          >
            <MaterialIcon
              name={
                selectedMeetingLog.metadata.status === "ended"
                  ? "article"
                  : "play_arrow"
              }
            />
            {selectedMeetingLog.metadata.status === "ended"
              ? "Open review"
              : "Resume session"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function PastMeetingsDrawer({
  meetings,
  selectedMeetingLog,
  onClose,
  onRefresh,
  onSelect,
  onOpen,
  onNewMeeting
}: {
  meetings: ClientMeetingLogMetadata[];
  selectedMeetingLog: ClientMeetingLogSnapshot | null;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
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
          <button
            aria-label="Close past meetings"
            className="icon-button"
            type="button"
            onClick={onClose}
          >
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
                onClick={() => onOpen(meetingLog.id)}
              >
                <span className={`drawer-dot ${meetingLog.status}`} />
                <span>
                  <strong>{meetingLog.title}</strong>
                  <small>
                    {meetingLog.status} - {formatClock(meetingLog.startedAt)} -{" "}
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
            <button
              className="btn outlined"
              type="button"
              onClick={() => onOpen(selectedMeetingLog.metadata.id)}
            >
              <MaterialIcon
                name={
                  selectedMeetingLog.metadata.status === "ended"
                    ? "article"
                    : "play_arrow"
                }
              />
              {selectedMeetingLog.metadata.status === "ended"
                ? "Open review"
                : "Resume session"}
            </button>
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

async function sendMeetingState(
  meetingLogId: string,
  payload: {
    status?: MeetingStatus;
    isPaused?: boolean;
    endedAt?: number | null;
    updatedAt?: number;
    state?: PersistedMeetingState;
  }
) {
  const response = await fetch(
    `/api/meetings/${encodeURIComponent(meetingLogId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    throw new Error(`Meeting state save returned ${response.status}`);
  }
}

function navigateToMeetingReview(meetingLogId: string) {
  window.location.assign(`/meetings/${encodeURIComponent(meetingLogId)}`);
}

async function waitForMeetingLogId(
  ref: { current: string | null },
  timeoutMs: number
): Promise<string | null> {
  const startedAt = Date.now();
  while (!ref.current && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  }
  return ref.current;
}

function fallbackStateFromSnapshot(
  snapshot: ClientMeetingLogSnapshot
): PersistedMeetingState {
  const meeting = meetingWithLoggedAgendaState(
    snapshot.metadata.meeting,
    snapshot.events
  );
  const reviewMarkdown =
    snapshot.metadata.latestReviewMarkdown ||
    snapshot.reviewVersions[0]?.markdown ||
    createInitialReviewMarkdown(meeting);
  const now = Date.now();
  const lastHeartbeatAt = latestHeartbeatTimestamp(snapshot);

  return {
    status: snapshot.metadata.status,
    meeting,
    transcript: snapshot.transcript,
    reviewMarkdown,
    reviewVersions: snapshot.reviewVersions,
    currentReviewVersionId:
      snapshot.metadata.latestReviewVersionId ??
      snapshot.reviewVersions[0]?.id ??
      `${snapshot.metadata.startedAt}-initial-review`,
    timeline: [],
    lastHeartbeatAt,
    nextHeartbeatAt: lastHeartbeatAt + meeting.heartbeatIntervalSeconds * 1000,
    meetingStartedAt: snapshot.metadata.startedAt,
    heartbeatCount: snapshot.events.filter(
      (event) => event.type === "heartbeat_output"
    ).length,
    isPaused: snapshot.metadata.isPaused,
    currentOutput: null,
    activeAgendaItemId:
      meeting.agenda.find((item) => !item.done)?.id ??
      meeting.agenda[0]?.id ??
      null,
    updatedAt: now,
    endedAt: snapshot.metadata.endedAt
  };
}

function meetingWithLoggedAgendaState(
  meeting: MeetingConfig,
  events: ClientMeetingLogEvent[]
): MeetingConfig {
  let agenda = meeting.agenda;

  for (const event of [...events].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id)
  )) {
    if (event.type === "heartbeat_output") {
      const output = heartbeatOutputFromEvent(event);
      if (output?.agendaActions.length) {
        agenda = applyLoggedAgendaActions(agenda, output.agendaActions);
      }
      continue;
    }

    if (!isRecord(event.payload)) {
      continue;
    }

    if (event.type === "agenda_manual_update") {
      const itemId = stringParam(event.payload.itemId);
      const done = booleanParam(event.payload.done);
      if (itemId && done !== null) {
        agenda = applyLoggedAgendaActions(agenda, [
          { itemId, done, reason: "Logged agenda update." }
        ]);
      }
    }

    if (event.type === "agenda_item_added") {
      const item = agendaItemFromEventPayload(event.payload.item);
      if (
        item &&
        agenda.length < MAX_AGENDA_ITEMS &&
        !agenda.some((candidate) => candidate.id === item.id)
      ) {
        agenda = [...agenda, item];
      }
    }

    if (event.type === "agenda_item_deleted") {
      const item = agendaItemFromEventPayload(event.payload.item);
      if (item) {
        agenda = agenda.filter((candidate) => candidate.id !== item.id);
      }
    }
  }

  return agenda === meeting.agenda ? meeting : { ...meeting, agenda };
}

function applyLoggedAgendaActions(
  agenda: AgendaItem[],
  actions: FacilitatorOutput["agendaActions"]
): AgendaItem[] {
  let changed = false;
  const nextAgenda = agenda.map((item) => {
    const action = actions.find((candidate) => candidate.itemId === item.id);
    if (!action || item.done === action.done) {
      return item;
    }

    changed = true;
    return { ...item, done: action.done };
  });

  return changed ? nextAgenda : agenda;
}

function agendaItemFromEventPayload(value: unknown): AgendaItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = stringParam(value.id);
  const title = stringParam(value.title);
  const done = booleanParam(value.done);
  if (!id || !title || done === null) {
    return null;
  }

  return { id, title, done };
}

export function mergeTimelineEntriesWithEvents(
  stateTimeline: TimelineEntry[],
  events: Array<Pick<ClientMeetingLogEvent, "id" | "type" | "timestamp" | "payload">>
): TimelineEntry[] {
  const byKey = new Map<string, TimelineEntry>();

  for (const entry of stateTimeline) {
    byKey.set(timelineEntryRestoreKey(entry), entry);
  }
  for (const entry of timelineEntriesFromHeartbeatEvents(events)) {
    byKey.set(timelineEntryRestoreKey(entry), entry);
  }

  return Array.from(byKey.values()).sort(
    (left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id)
  );
}

function timelineEntriesFromHeartbeatEvents(
  events: Array<Pick<ClientMeetingLogEvent, "id" | "type" | "timestamp" | "payload">>
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const event of events) {
    const output = heartbeatOutputFromEvent(event);
    if (!output) {
      continue;
    }

    entries.push({
      id: event.id,
      timestamp: event.timestamp,
      source: output.source,
      cards: output.cards,
      summary: output.summary,
      reviewMarkdown: output.reviewMarkdown,
      reminder: output.ephemeralReminder
    });
  }

  return entries;
}

function timelineEntryRestoreKey(entry: TimelineEntry): string {
  return [
    entry.timestamp,
    entry.source,
    entry.summary,
    entry.reviewMarkdown ?? "",
    entry.reminder ?? ""
  ].join("\u0001");
}

export function latestHeartbeatTimestamp(
  snapshot: {
    events: Array<Pick<ClientMeetingLogEvent, "type" | "timestamp">>;
    metadata?: Pick<ClientMeetingLogMetadata, "startedAt">;
  },
  fallback = snapshot.metadata?.startedAt ?? 0
): number {
  return snapshot.events.reduce(
    (latest, event) =>
      event.type === "heartbeat_output"
        ? Math.max(latest, event.timestamp)
        : latest,
    fallback
  );
}

function heartbeatEventCount(
  events: Array<Pick<ClientMeetingLogEvent, "type">>
): number {
  return events.filter((event) => event.type === "heartbeat_output").length;
}

export function latestHeartbeatOutputFromEvents(
  events: Array<Pick<ClientMeetingLogEvent, "type" | "timestamp" | "payload">>
): FacilitatorOutput | null {
  let latest: { timestamp: number; output: FacilitatorOutput } | null = null;

  for (const event of events) {
    const output = heartbeatOutputFromEvent(event);
    if (!output) {
      continue;
    }
    if (!latest || event.timestamp >= latest.timestamp) {
      latest = { timestamp: event.timestamp, output };
    }
  }

  return latest?.output ?? null;
}

function heartbeatReviewVersionsFromEvents(
  events: Array<Pick<ClientMeetingLogEvent, "type" | "timestamp" | "payload">>
): ReviewVersion[] {
  const versions: ReviewVersion[] = [];

  for (const event of events) {
    const output = heartbeatOutputFromEvent(event);
    if (!output) {
      continue;
    }

    versions.push({
      id: heartbeatReviewVersionId(event) ?? `${event.timestamp}-heartbeat-review`,
      timestamp: event.timestamp,
      source: output.source,
      markdown: output.reviewMarkdown,
      summary: output.summary
    });
  }

  return versions;
}

function heartbeatReviewVersionId(
  event: Pick<ClientMeetingLogEvent, "payload">
): string | null {
  return isRecord(event.payload) ? stringParam(event.payload.reviewVersionId) : null;
}

function isSameMaterializedReviewVersion(
  materialized: ReviewVersion,
  logged: ReviewVersion
): boolean {
  return (
    materialized.id === logged.id ||
    (materialized.timestamp === logged.timestamp &&
      materialized.markdown === logged.markdown)
  );
}

export function mergeCurrentOutputWithHeartbeatEvents(
  stateCurrentOutput: FacilitatorOutput | null,
  stateTimeline: TimelineEntry[],
  events: Array<Pick<ClientMeetingLogEvent, "type" | "timestamp" | "payload">>
): FacilitatorOutput | null {
  const eventOutput = latestHeartbeatOutputFromEvents(events);
  const timelineOutput = latestHeartbeatOutputFromTimeline(stateTimeline);
  if (!eventOutput) {
    return stateCurrentOutput ?? timelineOutput;
  }

  const latestEventAt = latestHeartbeatTimestamp({ events }, -1);
  const latestStateAt = latestTimelineTimestamp(stateTimeline, -1);
  if (latestEventAt >= latestStateAt) {
    return eventOutput;
  }

  return stateCurrentOutput ?? timelineOutput ?? eventOutput;
}

function latestHeartbeatOutputFromTimeline(
  timeline: TimelineEntry[]
): FacilitatorOutput | null {
  const latest = timeline.reduce<TimelineEntry | null>(
    (currentLatest, entry) =>
      !currentLatest || entry.timestamp >= currentLatest.timestamp
        ? entry
        : currentLatest,
    null
  );
  if (!latest) {
    return null;
  }

  return capFacilitatorOutput({
    source: latest.source,
    cards: latest.cards.slice(0, MAX_HEARTBEAT_OUTPUT_CARDS),
    summary: latest.summary,
    nextHeartbeatHint: "Continue.",
    reviewMarkdown: latest.reviewMarkdown ?? "",
    agendaActions: [],
    uiActions: [],
    ephemeralReminder: latest.reminder ?? null
  });
}

function latestTimelineTimestamp(
  timeline: TimelineEntry[],
  fallback: number
): number {
  return timeline.reduce(
    (latest, entry) => Math.max(latest, entry.timestamp),
    fallback
  );
}

function heartbeatOutputFromEvent(
  event: Pick<ClientMeetingLogEvent, "type" | "payload">
): FacilitatorOutput | null {
  if (event.type !== "heartbeat_output" || !isRecord(event.payload)) {
    return null;
  }

  return facilitatorOutputFromValue(event.payload.output);
}

function facilitatorOutputFromValue(value: unknown): FacilitatorOutput | null {
  if (!isRecord(value)) {
    return null;
  }
  const source = facilitatorSourceFromValue(value.source);
  if (
    !source ||
    typeof value.summary !== "string" ||
    typeof value.reviewMarkdown !== "string"
  ) {
    return null;
  }

  return capFacilitatorOutput({
    source,
    cards: Array.isArray(value.cards)
      ? value.cards.filter(isFacilitatorCard).slice(0, MAX_HEARTBEAT_OUTPUT_CARDS)
      : [],
    summary: value.summary,
    nextHeartbeatHint:
      typeof value.nextHeartbeatHint === "string"
        ? value.nextHeartbeatHint
        : "Continue.",
    reviewMarkdown: value.reviewMarkdown,
    agendaActions: normalizeAgendaActions(value.agendaActions),
    uiActions: normalizeUiActions(value.uiActions),
    ephemeralReminder:
      typeof value.ephemeralReminder === "string"
        ? value.ephemeralReminder
        : null,
    adapterNotice:
      typeof value.adapterNotice === "string" ? value.adapterNotice : undefined
  });
}

function facilitatorSourceFromValue(
  value: unknown
): FacilitatorOutput["source"] | null {
  if (value === "pi" || value === "openrouter" || value === "local-fallback") {
    return value;
  }
  return null;
}

function normalizeHeartbeatRouteOutput(value: unknown): FacilitatorOutput | null {
  if (!isRecord(value)) {
    return null;
  }

  const source = facilitatorSourceFromValue(value.source);
  const reviewMarkdown = stringParam(value.reviewMarkdown);
  if (!source || !reviewMarkdown) {
    return null;
  }

  const summary =
    stringParam(value.summary) ?? "Heartbeat updated the shared review document.";
  const nextHeartbeatHint =
    stringParam(value.nextHeartbeatHint) ?? "Continue with the next heartbeat.";
  const cards = Array.isArray(value.cards)
    ? value.cards
        .map(normalizeFacilitatorCard)
        .filter((card): card is FacilitatorOutput["cards"][number] =>
          Boolean(card)
        )
        .slice(0, MAX_HEARTBEAT_OUTPUT_CARDS)
    : [];

  return capFacilitatorOutput({
    source,
    cards:
      cards.length > 0
        ? cards
        : [
            {
              id: `${Date.now()}-normalized-heartbeat`,
              kind: "heartbeat",
              title: "Heartbeat update",
              body: summary,
              priority: "medium"
            }
          ],
    summary,
    nextHeartbeatHint,
    reviewMarkdown,
    agendaActions: normalizeAgendaActions(value.agendaActions),
    uiActions: normalizeUiActions(value.uiActions),
    ephemeralReminder:
      typeof value.ephemeralReminder === "string" && value.ephemeralReminder.trim()
        ? value.ephemeralReminder.trim()
        : null,
    adapterNotice:
      typeof value.adapterNotice === "string" ? value.adapterNotice : undefined
  });
}

function normalizeFacilitatorCard(
  value: unknown
): FacilitatorOutput["cards"][number] | null {
  if (!isFacilitatorCard(value)) {
    return null;
  }

  const title = stringParam(value.title);
  const body = stringParam(value.body);
  if (!title || !body) {
    return null;
  }

  return {
    id: value.id,
    kind: value.kind,
    title,
    body,
    priority: value.priority
  };
}

function normalizeAgendaActions(value: unknown): FacilitatorOutput["agendaActions"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => {
      const itemId = stringParam(item.itemId);
      const done = booleanParam(item.done);
      const reason = stringParam(item.reason);
      if (!itemId || done === null || !reason) {
        return null;
      }

      return { itemId, done, reason };
    })
    .filter((item): item is FacilitatorOutput["agendaActions"][number] =>
      Boolean(item)
    );
}

function normalizeUiActions(value: unknown): UiAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => {
      if (!isKnownUiTool(item.tool) || !isRecord(item.parameters)) {
        return null;
      }
      const reason = stringParam(item.reason) ?? "Agent proposed a UI action.";
      return {
        tool: item.tool,
        parameters: item.parameters,
        reason
      };
    })
    .filter((item): item is UiAction => Boolean(item));
}

function isKnownUiTool(value: unknown): value is UiAction["tool"] {
  return (
    value === "add_agenda_item" ||
    value === "set_agenda_item" ||
    value === "delete_agenda_item" ||
    value === "send_room_reminder" ||
    value === "update_review_document"
  );
}

function isFacilitatorCard(value: unknown): value is FacilitatorOutput["cards"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isFacilitatorCardKind(value.kind) &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    (value.priority === "low" ||
      value.priority === "medium" ||
      value.priority === "high")
  );
}

function isFacilitatorCardKind(
  value: unknown
): value is FacilitatorOutput["cards"][number]["kind"] {
  return (
    value === "heartbeat" ||
    value === "participation" ||
    value === "risk" ||
    value === "agenda" ||
    value === "decision" ||
    value === "action" ||
    value === "drift" ||
    value === "reminder"
  );
}

function mergeTranscriptLines(
  stateLines: TranscriptLine[],
  eventLines: TranscriptLine[]
): TranscriptLine[] {
  const byId = new Map<string, TranscriptLine>();
  for (const line of [...stateLines, ...eventLines]) {
    byId.set(line.id, line);
  }
  return Array.from(byId.values()).sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id)
  );
}

function mergeReviewVersions(
  stateVersions: ReviewVersion[],
  eventVersions: ReviewVersion[]
): ReviewVersion[] {
  const byId = new Map<string, ReviewVersion>();
  for (const version of [...stateVersions, ...eventVersions]) {
    byId.set(version.id, version);
  }
  return Array.from(byId.values()).sort(
    (left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id)
  );
}

export function previousReviewVersion(
  versions: ReviewVersion[],
  currentId: string,
  currentMarkdown: string
): ReviewVersion | undefined {
  const historical = versions.filter((version) => version.source !== "restored");
  const restoredSourceId = restoredHistoricalVersionId(currentId, historical);
  const activeHistoricalId = restoredSourceId ?? currentId;
  const activeIndex = historical.findIndex(
    (version) => version.id === activeHistoricalId
  );
  if (activeIndex >= 0) {
    return historical[activeIndex + 1];
  }
  return historical.find((version) => version.markdown !== currentMarkdown);
}

function restoredHistoricalVersionId(
  currentId: string,
  historical: ReviewVersion[]
): string | undefined {
  const marked = currentId.match(/^\d+-restored-r\d+-(.+)$/)?.[1];
  if (marked) return marked;

  const sequenced = currentId.match(/^\d+-restored-\d+-(.+)$/)?.[1];
  if (sequenced && historical.some((version) => version.id === sequenced)) {
    return sequenced;
  }

  return currentId.match(/^\d+-restored-(.+)$/)?.[1];
}

async function runLocalHeartbeatInBrowser(input: ReturnType<typeof createHeartbeatInput>) {
  const { runLocalFacilitation } = await import("@/lib/facilitator");
  return runLocalFacilitation(input);
}

function normalizeMeetingDraft(
  draft: MeetingConfig,
  agendaText: string,
  participantsText: string
): MeetingConfig {
  return {
    ...draft,
    title: draft.title.trim() || defaultMeeting.title,
    goal: draft.goal.trim() || defaultMeeting.goal,
    context: draft.context.trim(),
    expectedParticipants: clampFiniteNumber(
      draft.expectedParticipants,
      1,
      1,
      MAX_EXPECTED_PARTICIPANTS
    ),
    heartbeatIntervalSeconds: clampFiniteNumber(
      draft.heartbeatIntervalSeconds,
      MIN_HEARTBEAT_INTERVAL_SECONDS,
      MIN_HEARTBEAT_INTERVAL_SECONDS,
      MAX_HEARTBEAT_INTERVAL_SECONDS
    ),
    agenda: parseAgenda(agendaText),
    participants: parseParticipants(participantsText)
  };
}

function normalizeInitialReviewDocument(
  value: unknown,
  meeting: MeetingConfig
): InitialReviewDocument {
  if (!isRecord(value)) {
    return {
      source: "local-fallback",
      markdown: createInitialReviewMarkdown(meeting),
      summary: "Local fallback initialized the meeting review document."
    };
  }

  const source =
    value.source === "pi" || value.source === "openrouter"
      ? value.source
      : "local-fallback";
  return {
    source,
    markdown:
      typeof value.markdown === "string" && value.markdown.trim()
        ? value.markdown
        : createInitialReviewMarkdown(meeting),
    summary:
      typeof value.summary === "string" && value.summary.trim()
        ? value.summary
        : "Initialized the meeting review document.",
    adapterNotice:
      typeof value.adapterNotice === "string" ? value.adapterNotice : undefined
  };
}

function facilitatorSourceLabel(
  source: FacilitatorOutput["source"] | undefined
): string {
  if (source === "pi") return "Pi · GPT-5.5 fast";
  if (source === "openrouter") return "OpenRouter";
  return "Local";
}

function createPendingReviewMarkdown(meeting: MeetingConfig): string {
  const agendaItems = meeting.agenda.length
    ? meeting.agenda.map((item) => `- [ ] ${item.title}`).join("\n")
    : "- [ ] Open discussion";
  const participants = meeting.participants.length
    ? meeting.participants
        .map((participant) =>
          participant.role
            ? `- ${participant.name} - ${participant.role}`
            : `- ${participant.name}`
        )
        .join("\n")
    : `- Expected voices: ${meeting.expectedParticipants}`;

  return [
    `# ${meeting.title}`,
    "",
    "## Goal",
    meeting.goal,
    "",
    "## Agenda",
    agendaItems,
    "",
    "## Participants",
    participants,
    "",
    "## Strict Pi initialization",
    "The live demo has started. The Pi agent is generating the initial markdown document and will replace this placeholder when the strict initialization call returns.",
    "",
    "## Live notes",
    "- Transcript is starting now."
  ].join("\n");
}

function parseAgenda(value: string): AgendaItem[] {
  const items = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_AGENDA_ITEMS);

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
    .slice(0, MAX_PARTICIPANT_ENTRIES)
    .map((line) => {
      const [name, role] = line.split(/\s+-\s+/, 2);
      return {
        name,
        role
      };
    });
}

function clampFiniteNumber(
  value: number,
  fallback: number,
  min: number,
  max?: number
): number {
  const finiteValue = Number.isFinite(value) ? value : fallback;
  const floored = Math.max(min, Math.floor(finiteValue));
  return typeof max === "number" ? Math.min(max, floored) : floored;
}

function stringParam(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function reviewMarkdownFromOutput(output: FacilitatorOutput): string {
  const reviewAction = [...(output.uiActions ?? [])]
    .reverse()
    .find((action) => action.tool === "update_review_document");
  return stringParam(reviewAction?.parameters.markdown) ?? output.reviewMarkdown;
}

function reminderFromOutput(output: FacilitatorOutput): string | null {
  const reminderAction = [...(output.uiActions ?? [])]
    .reverse()
    .find((action) => action.tool === "send_room_reminder");
  return stringParam(reminderAction?.parameters.message);
}

function booleanParam(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isClientStrictPiRequired(): boolean {
  return process.env.NEXT_PUBLIC_ROOMPULSE_REQUIRE_PI === "1";
}

function strictPiFallbackMessage(label: string, adapterNotice?: string): string {
  return `${label} required but route returned local fallback${
    adapterNotice ? `: ${adapterNotice}` : "."
  }`;
}

function getClientPiTimeoutMs(): number {
  const configured = Number(
    process.env.NEXT_PUBLIC_ROOMPULSE_PI_TIMEOUT_MS ??
      process.env.ROOMPULSE_PI_TIMEOUT_MS
  );
  if (Number.isFinite(configured) && configured >= 1_000) {
    return configured;
  }

  return DEFAULT_CLIENT_PI_TIMEOUT_MS;
}

function isRetryableMicStartError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error))
    .toLowerCase();
  return (
    message.includes("could not connect to") ||
    message.includes("websocket") ||
    message.includes("local transcription")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Los_Angeles"
  }).format(new Date(timestamp));
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function latestNormalizedSpeakerLabel(labels: string[]): string | null {
  for (let index = labels.length - 1; index >= 0; index -= 1) {
    const label = normalizeSpeakerLabel(labels[index]);
    if (label) {
      return label;
    }
  }

  return null;
}

function highestSpeakerNumber(labels: string[]): number {
  return labels.reduce((highest, label) => {
    const normalizedLabel = normalizeSpeakerLabel(label);
    const match = normalizedLabel?.match(/^Speaker (\d+)$/);
    const value = match ? Number(match[1]) : 0;
    return Number.isFinite(value) ? Math.max(highest, value) : highest;
  }, 0);
}
