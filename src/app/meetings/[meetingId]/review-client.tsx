"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownDocument from "@/app/MarkdownDocument";
import type { MeetingLogSnapshot } from "@/lib/meeting-log-store";

export default function MeetingReviewClient({
  snapshot
}: {
  snapshot: MeetingLogSnapshot;
}) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const copyMessageTimerRef = useRef<number | null>(null);
  const latestMarkdown = useMemo(() => {
    return (
      snapshot.metadata.latestReviewMarkdown ||
      snapshot.reviewVersions[0]?.markdown ||
      snapshot.metadata.state?.reviewMarkdown ||
      ""
    );
  }, [snapshot]);
  const transcriptText = useMemo(() => formatTranscript(snapshot), [snapshot]);
  const durationSeconds = Math.max(
    0,
    Math.floor(
      ((snapshot.metadata.endedAt ?? snapshot.metadata.updatedAt) -
        snapshot.metadata.startedAt) /
        1000
    )
  );

  useEffect(() => {
    return () => {
      if (copyMessageTimerRef.current !== null) {
        window.clearTimeout(copyMessageTimerRef.current);
      }
    };
  }, []);

  async function copy(label: string, value: string) {
    try {
      await copyText(value);
      setCopyMessage(`Copied ${label}`);
    } catch {
      setCopyMessage(`Could not copy ${label}`);
    }
    if (copyMessageTimerRef.current !== null) {
      window.clearTimeout(copyMessageTimerRef.current);
    }
    copyMessageTimerRef.current = window.setTimeout(() => {
      copyMessageTimerRef.current = null;
      setCopyMessage(null);
    }, 1600);
  }

  function exportTranscript() {
    const blob = new Blob([transcriptText], {
      type: "text/plain;charset=utf-8"
    });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${downloadSlug(snapshot.metadata.title)}-transcript.txt`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  }

  return (
    <main className="app-shell review-route">
      <header className="app-bar">
        <div className="app-bar-left">
          <a className="icon-button" href="/" aria-label="Back to dashboard">
            <MaterialIcon name="arrow_back" />
          </a>
          <BrandMark paused />
        </div>
        <div className="app-bar-right">
          <span className={`session-status ${snapshot.metadata.status}`}>
            {snapshot.metadata.status}
          </span>
        </div>
      </header>

      <section className="review-hero">
        <div>
          <div className="meeting-kicker">
            <span className="status-dot" />
            <span>Meeting review</span>
            <span>{formatElapsed(durationSeconds)} duration</span>
            <span>{snapshot.transcript.length} transcript lines</span>
          </div>
          <h1>{snapshot.metadata.title}</h1>
          <p>{snapshot.metadata.goal}</p>
        </div>
        <div className="review-actions" aria-label="Review actions">
          <a className="pill-btn" href="/">
            <MaterialIcon name="dashboard" />
            Dashboard
          </a>
          <button
            className="pill-btn"
            type="button"
            onClick={() => void copy("transcript", transcriptText)}
          >
            <MaterialIcon name="content_copy" />
            Copy transcript
          </button>
          <button className="pill-btn" type="button" onClick={exportTranscript}>
            <MaterialIcon name="download" />
            Export transcript
          </button>
          <button
            className="pill-btn primary"
            type="button"
            onClick={() => void copy("review", latestMarkdown)}
          >
            <MaterialIcon name="article" />
            Copy latest review
          </button>
        </div>
      </section>

      {copyMessage ? (
        <div className="copy-toast" role="status">
          <MaterialIcon name="check_circle" />
          {copyMessage}
        </div>
      ) : null}

      <section className="review-grid">
        <article className="review-panel room-column" aria-label="Latest review markdown">
          <div className="panel-toolbar">
            <div>
              <div className="section-kicker">AI reviews</div>
              <h2>Latest review document</h2>
            </div>
            <span>{snapshot.reviewVersions.length} versions</span>
          </div>
          <div className="review-meta">
            <span>Started {formatDateTime(snapshot.metadata.startedAt)}</span>
            <span>Updated {formatDateTime(snapshot.metadata.updatedAt)}</span>
          </div>
          <article className="markdown-document review-markdown">
            {latestMarkdown ? (
              <MarkdownDocument markdown={latestMarkdown} />
            ) : (
              <p className="empty-state">No review document was saved.</p>
            )}
          </article>
        </article>

        <aside className="transcript-panel room-column review-transcript" aria-label="Final transcript">
          <div className="panel-toolbar">
            <div>
              <div className="section-kicker">Live raw transcript</div>
              <h2>Transcript</h2>
            </div>
            <span>{snapshot.transcript.length} lines</span>
          </div>
          <div className="transcript-feed">
            {snapshot.transcript.length === 0 ? (
              <p className="empty-state">No transcript lines were captured.</p>
            ) : (
              snapshot.transcript.map((line) => (
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
        </aside>
      </section>
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

function MaterialIcon({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className="material-symbols-outlined">
      {name}
    </span>
  );
}

function formatTranscript(snapshot: MeetingLogSnapshot): string {
  const header = [
    snapshot.metadata.title,
    snapshot.metadata.goal,
    `Started: ${formatDateTime(snapshot.metadata.startedAt)}`,
    snapshot.metadata.endedAt !== null
      ? `Ended: ${formatDateTime(snapshot.metadata.endedAt)}`
      : `Updated: ${formatDateTime(snapshot.metadata.updatedAt)}`,
    ""
  ];
  const lines = snapshot.transcript.map(
    (line) => `[${formatClock(line.timestamp)}] ${line.speakerLabel}: ${line.text}`
  );
  return [...header, ...lines, ""].join("\n");
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some browsers expose navigator.clipboard but reject writes outside
      // secure or focused contexts. Fall through to the DOM copy fallback.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy command failed");
    }
  } finally {
    textarea.remove();
  }
}

function downloadSlug(title: string): string {
  return (
    title
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "roompulse-meeting"
  );
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Los_Angeles"
  }).format(new Date(timestamp));
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles"
  }).format(new Date(timestamp));
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function speakerNumber(label: string): number {
  const match = label.match(/\d+/);
  return match ? Number(match[0]) : 1;
}
