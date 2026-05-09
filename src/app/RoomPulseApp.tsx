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
  createHeartbeatInput,
  createInitialReviewMarkdown,
  getAgendaProgress,
  type AgendaItem,
  type FacilitatorOutput,
  type MeetingConfig,
  type ReviewVersion,
  type TimelineEntry,
  type TranscriptLine
} from "@/lib/facilitator";
import { createParticipationStatus } from "@/lib/speaker-tracker";
import { LocalTranscriptionClient } from "@/lib/local-transcription-client";
import { TranscriptStore } from "@/lib/transcript-store";

type Phase = "setup" | "meeting";
type TranscriptMode = "demo" | "mic";

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
  const [isPaused, setIsPaused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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

  const transcriptStoreRef = useRef(new TranscriptStore());
  const transcriptionClientRef = useRef<LocalTranscriptionClient | null>(null);
  const currentMicSpeakerRef = useRef("Speaker 1");
  const isHeartbeatRunningRef = useRef(false);
  const transcriptFeedRef = useRef<HTMLDivElement | null>(null);

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
      transcriptStoreRef.current.addLine({
        speakerId,
        speakerLabel,
        text: trimmed,
        source,
        confidence
      });
      setTranscript(transcriptStoreRef.current.getLines());
    },
    []
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
    },
    []
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
      ephemeralReminder: null
    });
    setLastHeartbeatAt(startedAt);
    setNextHeartbeatAt(
      startedAt + configuredMeeting.heartbeatIntervalSeconds * 1000
    );
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
  }

  function togglePause() {
    const nextPaused = !isPaused;
    setIsPaused(nextPaused);
    if (!nextPaused) {
      setNextHeartbeatAt(Date.now() + meeting.heartbeatIntervalSeconds * 1000);
    }
  }

  if (phase === "setup") {
    return (
      <main className="app-shell setup-shell">
        <section className="setup-hero" aria-labelledby="setup-title">
          <div className="brand-row">
            <span className="status-dot" />
            <span>Mode 2 shared room display</span>
          </div>
          <h1 id="setup-title">RoomPulse</h1>
          <p>
            Feed the room context, then put this on a shared monitor. The
            heartbeat loop wakes the facilitator and keeps raw transcript,
            agenda, and participation visible.
          </p>
        </section>

        <section className="setup-grid" aria-label="Meeting setup">
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
              <span>Start meeting</span>
              <span aria-hidden="true">{"->"}</span>
            </button>
          </form>

          <aside className="preview-panel">
            <div className="section-kicker">Display preview</div>
            <div className="preview-metric">
              <strong>{meetingDraft.heartbeatIntervalSeconds}s</strong>
              <span>heartbeat interval</span>
            </div>
            <div className="preview-metric">
              <strong>{meetingDraft.expectedParticipants}</strong>
              <span>expected voices</span>
            </div>
            <div className="preview-copy">
              <span>Pi adapter</span>
              <p>
                The server route calls <code>runPiHeartbeat(input)</code> on every
                pulse. Strict mode surfaces missing Pi auth instead of using
                local fallback.
              </p>
            </div>
            <div className="preview-copy">
              <span>Local transcription</span>
              <p>
                Mic mode streams browser audio to local Whisper transcription
                and Speaker N clustering.
              </p>
            </div>
          </aside>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell room-shell">
      <header className="meeting-topbar">
        <div className="meeting-controls">
          <button type="button" onClick={togglePause}>
            {isPaused ? "Resume" : "Pause"}
          </button>
          <button type="button" onClick={() => void runHeartbeat()}>
            {isHeartbeatRunning ? "Reviewing..." : "Run heartbeat"}
          </button>
        </div>
        <div className="meeting-title-block">
          <div className="brand-row">
            <span className={`status-dot ${isPaused ? "" : "live"}`} />
            <span>{isPaused ? "Meeting paused" : "Meeting live"}</span>
          </div>
          <h1>{meeting.title}</h1>
          <p>{meeting.goal}</p>
        </div>
        <div className="meeting-status">
          <span>{isMicRunning ? "Microphone live" : "Microphone not live"}</span>
          <strong>{isPaused ? "Paused" : `${countdownSeconds}s`}</strong>
          <button type="button" onClick={() => setShowSettings((value) => !value)}>
            Settings
          </button>
        </div>
        {showSettings ? (
          <aside className="settings-popover" aria-label="Meeting settings">
            <label>
              <span>Heartbeat interval</span>
              <input
                min={15}
                step={5}
                type="number"
                value={meeting.heartbeatIntervalSeconds}
                onChange={(event) =>
                  setMeeting((current) => ({
                    ...current,
                    heartbeatIntervalSeconds: clampFiniteNumber(
                      Number(event.target.value),
                      current.heartbeatIntervalSeconds,
                      15
                    )
                  }))
                }
              />
            </label>
            <label>
              <span>Expected participants</span>
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
            </label>
          </aside>
        ) : null}
      </header>

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
                  <span>{line.speakerLabel}</span>
                  <p>{line.text}</p>
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
          <section className="agenda-card" aria-label="Agenda">
            <div className="section-kicker">Agenda</div>
            <strong>{progressPercent}% complete</strong>
            <div className="agenda-list">
              {meeting.agenda.map((item) => (
                <label className="agenda-item" key={item.id}>
                  <input
                    checked={item.done}
                    type="checkbox"
                    onChange={(event) => updateAgendaItem(item.id, event.target.checked)}
                  />
                  <span>{item.title}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="participation-card" aria-label="Participation">
            <div className="section-kicker">Participation</div>
            <strong>
              {participation.observed} of {participation.expected} heard
            </strong>
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

          <section className="reminder-dock" aria-label="Heartbeat reminder">
            <div className="section-kicker">Reminder</div>
            {ephemeralReminder ? (
              <p>{ephemeralReminder}</p>
            ) : (
              <p className="quiet-reminder">
                No room-facing reminder on this heartbeat.
              </p>
            )}
          </section>
        </aside>
      </section>
    </main>
  );
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
