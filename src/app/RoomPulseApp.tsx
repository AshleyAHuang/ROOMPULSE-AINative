"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createHeartbeatInput,
  getAgendaProgress,
  type AgendaItem,
  type FacilitatorOutput,
  type MeetingConfig,
  type TimelineEntry,
  type TranscriptLine
} from "@/lib/facilitator";
import {
  SpeakerTracker,
  createParticipationStatus,
  extractVoiceFeaturesFromFrequencyData
} from "@/lib/speaker-tracker";
import { TranscriptStore } from "@/lib/transcript-store";

type Phase = "setup" | "meeting";
type TranscriptMode = "demo" | "mic";

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  0: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

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
  const [micStatus, setMicStatus] = useState("Mic idle");
  const [currentMicSpeaker, setCurrentMicSpeaker] = useState("Speaker 1");

  const transcriptStoreRef = useRef(new TranscriptStore());
  const speakerTrackerRef = useRef(new SpeakerTracker());
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const featureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentMicSpeakerRef = useRef("Speaker 1");
  const isHeartbeatRunningRef = useRef(false);

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

  const runHeartbeat = useCallback(async () => {
    if (isHeartbeatRunningRef.current || phase !== "meeting") {
      return;
    }

    const heartbeatNow = Date.now();
    const input = createHeartbeatInput({
      meeting,
      transcript,
      observedSpeakerLabels,
      lastHeartbeatAt,
      now: heartbeatNow,
      priorInterventions: timeline
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
          priorInterventions: timeline
        })
      });

      if (!response.ok) {
        throw new Error(`Heartbeat route returned ${response.status}`);
      }

      const output = (await response.json()) as FacilitatorOutput;
      setCurrentOutput(output);
      setTimeline((entries) => [
        {
          id: `${heartbeatNow}-${entries.length + 1}`,
          timestamp: heartbeatNow,
          source: output.source,
          cards: output.cards,
          summary: output.summary
        },
        ...entries
      ]);
      setLastHeartbeatAt(heartbeatNow);
      setNextHeartbeatAt(
        Date.now() + meeting.heartbeatIntervalSeconds * 1000
      );
    } catch (error) {
      setHeartbeatError(error instanceof Error ? error.message : String(error));
      setCurrentOutput(await runLocalHeartbeatInBrowser(input));
      setLastHeartbeatAt(heartbeatNow);
      setNextHeartbeatAt(
        Date.now() + meeting.heartbeatIntervalSeconds * 1000
      );
    } finally {
      setIsHeartbeatRunning(false);
      isHeartbeatRunningRef.current = false;
    }
  }, [
    lastHeartbeatAt,
    meeting,
    observedSpeakerLabels,
    phase,
    timeline,
    transcript
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
      nextHeartbeatAt > 0 &&
      now >= nextHeartbeatAt &&
      !isHeartbeatRunningRef.current
    ) {
      void runHeartbeat();
    }
  }, [nextHeartbeatAt, now, phase, runHeartbeat]);

  useEffect(() => {
    return () => {
      stopMic();
    };
  }, []);

  function startMeeting() {
    const configuredMeeting: MeetingConfig = {
      ...meetingDraft,
      title: meetingDraft.title.trim() || defaultMeeting.title,
      goal: meetingDraft.goal.trim() || defaultMeeting.goal,
      context: meetingDraft.context.trim(),
      expectedParticipants: Math.max(1, meetingDraft.expectedParticipants),
      heartbeatIntervalSeconds: Math.max(
        15,
        meetingDraft.heartbeatIntervalSeconds
      ),
      agenda: parseAgenda(agendaText),
      participants: parseParticipants(participantsText)
    };

    setMeeting(configuredMeeting);
    setPhase("meeting");
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
      nextHeartbeatHint: "Use Run heartbeat now for a live demo check."
    });
    const startedAt = Date.now();
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
    const speechWindow = window as SpeechWindow;
    const SpeechRecognition =
      speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setMicStatus("Web Speech API is not available in this browser");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const frequencyData = new Uint8Array(analyser.frequencyBinCount);
      const timeDomainData = new Uint8Array(analyser.fftSize);

      featureTimerRef.current = setInterval(() => {
        analyser.getByteFrequencyData(frequencyData);
        analyser.getByteTimeDomainData(timeDomainData);
        const features = extractVoiceFeaturesFromFrequencyData(
          frequencyData,
          timeDomainData,
          audioContext.sampleRate
        );
        const cluster = speakerTrackerRef.current.assignSpeaker(features);
        currentMicSpeakerRef.current = cluster.label;
        setCurrentMicSpeaker(cluster.label);
      }, 900);

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.onresult = (event) => {
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (!result.isFinal) {
            continue;
          }

          addTranscriptLine(
            result[0].transcript,
            currentMicSpeakerRef.current,
            "speech",
            result[0].confidence
          );
        }
      };
      recognition.onerror = (event) => {
        setMicStatus(`Mic transcription error: ${event.error}`);
      };
      recognition.onend = () => {
        setMicStatus("Mic transcription stopped");
      };

      recognition.start();
      recognitionRef.current = recognition;
      audioContextRef.current = audioContext;
      mediaStreamRef.current = stream;
      setTranscriptMode("mic");
      setMicStatus("Mic transcription running");
    } catch (error) {
      setMicStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function stopMic() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;

    if (featureTimerRef.current) {
      clearInterval(featureTimerRef.current);
      featureTimerRef.current = null;
    }

    mediaStreamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    mediaStreamRef.current = null;

    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }

  function updateAgendaItem(id: string, done: boolean) {
    setMeeting((current) => ({
      ...current,
      agenda: current.agenda.map((item) =>
        item.id === id ? { ...item, done } : item
      )
    }));
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
          <form className="setup-panel" onSubmit={(event) => event.preventDefault()}>
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
            <button className="primary-action" type="button" onClick={startMeeting}>
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
                pulse and falls back locally when Pi auth or runtime is missing.
              </p>
            </div>
            <div className="preview-copy">
              <span>Diarization MVP</span>
              <p>
                Browser audio features cluster approximate voices into Speaker N
                labels. Demo mode can add transcript lines without mic access.
              </p>
            </div>
          </aside>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell room-shell">
      <header className="room-header">
        <div>
          <div className="brand-row">
            <span className="status-dot live" />
            <span>Heartbeat facilitator live</span>
          </div>
          <h1>{meeting.title}</h1>
          <p>{meeting.goal}</p>
        </div>
        <div className="heartbeat-console" aria-label="Heartbeat status">
          <span>{isHeartbeatRunning ? "Running" : "Next pulse"}</span>
          <strong>{isHeartbeatRunning ? "..." : `${countdownSeconds}s`}</strong>
          <button type="button" onClick={() => void runHeartbeat()}>
            Run heartbeat now
          </button>
        </div>
      </header>

      <section className="display-grid">
        <section className="facilitator-stage" aria-label="Current facilitator cards">
          <div className="stage-heading">
            <div>
              <div className="section-kicker">Current facilitator cards</div>
              <h2>Room cues</h2>
            </div>
            <span>{currentOutput?.source === "pi" ? "Pi" : "Local fallback"}</span>
          </div>

          <div className="card-stack">
            {(currentOutput?.cards ?? []).map((card) => (
              <article
                className={`facilitator-card priority-${card.priority}`}
                key={card.id}
              >
                <span>{card.kind}</span>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            ))}
          </div>

          {currentOutput?.adapterNotice ? (
            <p className="adapter-notice">{currentOutput.adapterNotice}</p>
          ) : null}
          {heartbeatError ? (
            <p className="adapter-notice">Browser fallback used: {heartbeatError}</p>
          ) : null}
        </section>

        <aside className="side-panel participation-panel">
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
          <p>
            {participation.reminder ??
              "Every expected voice has appeared in the speaker clusters."}
          </p>
          <div className="speaker-list">
            {observedSpeakerLabels.length === 0 ? (
              <span>No speakers observed yet</span>
            ) : (
              observedSpeakerLabels.map((label) => <span key={label}>{label}</span>)
            )}
          </div>
        </aside>

        <section className="transcript-panel" aria-label="Live raw transcript">
          <div className="panel-toolbar">
            <div>
              <div className="section-kicker">Live raw transcript</div>
              <h2>Transcript stream</h2>
            </div>
            <div className="mode-switch" aria-label="Transcript mode">
              <button
                className={transcriptMode === "demo" ? "active" : ""}
                type="button"
                onClick={() => setTranscriptMode("demo")}
              >
                Demo
              </button>
              <button
                className={transcriptMode === "mic" ? "active" : ""}
                type="button"
                onClick={() => void startMic()}
              >
                Mic
              </button>
            </div>
          </div>

          <div className="transcript-feed">
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
          <p className="mic-status">
            {micStatus}. Current audio cluster: {currentMicSpeaker}
            <button type="button" onClick={stopMic}>
              Stop mic
            </button>
          </p>
        </section>

        <aside className="side-panel agenda-panel">
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
        </aside>

        <section className="timeline-panel" aria-label="Prior interventions">
          <div className="panel-toolbar">
            <div>
              <div className="section-kicker">Timeline</div>
              <h2>Prior interventions</h2>
            </div>
            <span>{timeline.length} pulses</span>
          </div>
          <div className="timeline-list">
            {timeline.length === 0 ? (
              <p className="empty-state">Heartbeat history will collect here.</p>
            ) : (
              timeline.map((entry) => (
                <article className="timeline-entry" key={entry.id}>
                  <time>{formatClock(entry.timestamp)}</time>
                  <strong>{entry.source === "pi" ? "Pi" : "Local fallback"}</strong>
                  <p>{entry.summary}</p>
                </article>
              ))
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

async function runLocalHeartbeatInBrowser(input: ReturnType<typeof createHeartbeatInput>) {
  const { runLocalFacilitation } = await import("@/lib/facilitator");
  return runLocalFacilitation(input);
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

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}
