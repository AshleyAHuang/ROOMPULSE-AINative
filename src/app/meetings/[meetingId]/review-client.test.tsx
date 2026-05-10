import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MeetingReviewClient from "./review-client";
import type { MeetingLogSnapshot } from "@/lib/meeting-log-store";

const timestamp = Date.UTC(2026, 4, 10, 18, 0, 0);

const snapshot: MeetingLogSnapshot = {
  metadata: {
    id: "meeting-1",
    title: "!!!",
    goal: "Verify review controls.",
    startedAt: timestamp,
    updatedAt: timestamp + 60_000,
    endedAt: timestamp + 120_000,
    status: "ended",
    isPaused: true,
    eventCount: 2,
    meeting: {
      title: "!!!",
      goal: "Verify review controls.",
      context: "",
      agenda: [{ id: "a1", title: "Review", done: true }],
      expectedParticipants: 1,
      participants: [],
      heartbeatIntervalSeconds: 30
    },
    state: null,
    latestReviewMarkdown: "# Latest review",
    latestReviewVersionId: "review-1"
  },
  events: [],
  transcript: [
    {
      id: "line-1",
      speakerId: "speaker-1",
      speakerLabel: "Speaker 1",
      text: "Export this transcript.",
      timestamp,
      source: "speech",
      confidence: 0.9
    }
  ],
  reviewVersions: [
    {
      id: "review-1",
      timestamp,
      source: "pi",
      markdown: "# Latest review",
      summary: "Latest."
    }
  ]
};

describe("MeetingReviewClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("copies transcript through the DOM fallback when clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand
    });

    render(<MeetingReviewClient snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: /copy transcript/i }));

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(screen.getByRole("status")).toHaveTextContent("Copied transcript");
    });
  });

  it("falls back to DOM copy when clipboard write is rejected", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand
    });

    render(<MeetingReviewClient snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: /copy latest review/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("# Latest review");
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(screen.getByRole("status")).toHaveTextContent("Copied review");
    });
  });

  it("uses the materialized newest review version before stale metadata", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const recoveredSnapshot: MeetingLogSnapshot = {
      ...snapshot,
      metadata: {
        ...snapshot.metadata,
        latestReviewMarkdown: "# Stale metadata review",
        latestReviewVersionId: "stale-review"
      },
      reviewVersions: [
        {
          id: "newest-review",
          timestamp: timestamp + 30_000,
          source: "pi",
          markdown: "# Materialized newest review",
          summary: "Newest."
        },
        ...snapshot.reviewVersions
      ]
    };

    render(<MeetingReviewClient snapshot={recoveredSnapshot} />);

    expect(
      screen.getByRole("heading", { name: /materialized newest review/i })
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: /stale metadata review/i })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /copy latest review/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("# Materialized newest review");
    });
  });

  it("does not render arbitrary label digits as review speaker badges", () => {
    const roomLabelSnapshot: MeetingLogSnapshot = {
      ...snapshot,
      transcript: [
        {
          ...snapshot.transcript[0],
          id: "line-room-2026",
          speakerId: "room-2026",
          speakerLabel: "Room 2026",
          text: "The room number should not become a speaker badge."
        }
      ]
    };

    render(<MeetingReviewClient snapshot={roomLabelSnapshot} />);

    expect(screen.getByText("Room 2026")).toBeVisible();
    expect(screen.queryByText("S2026")).not.toBeInTheDocument();
    expect(screen.getByText("S1")).toBeVisible();
  });

  it("keeps oversized canonical speaker numbers from overflowing review badges", () => {
    const hugeSpeakerSnapshot: MeetingLogSnapshot = {
      ...snapshot,
      transcript: [
        {
          ...snapshot.transcript[0],
          id: "line-huge-speaker",
          speakerId: "speaker-1000000",
          speakerLabel: "Speaker 1000000",
          text: "The full label stays visible, but the badge must stay compact."
        }
      ]
    };

    render(<MeetingReviewClient snapshot={hugeSpeakerSnapshot} />);

    expect(screen.getByText("Speaker 1000000")).toBeVisible();
    expect(screen.queryByText("S1000000")).not.toBeInTheDocument();
    expect(screen.getByText("S99+")).toBeVisible();
  });

  it("treats epoch endedAt as a real meeting end in transcript export text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const epochSnapshot: MeetingLogSnapshot = {
      ...snapshot,
      metadata: {
        ...snapshot.metadata,
        startedAt: 0,
        updatedAt: 60_000,
        endedAt: 0
      },
      transcript: []
    };

    render(<MeetingReviewClient snapshot={epochSnapshot} />);
    fireEvent.click(screen.getByRole("button", { name: /copy transcript/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("Ended:")
      );
    });
    expect(writeText.mock.calls[0]?.[0]).not.toContain("Updated:");
  });

  it("shows a clear copy failure message", async () => {
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false)
    });

    render(<MeetingReviewClient snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: /copy transcript/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Could not copy transcript"
      );
    });
  });

  it("keeps the newest copy toast visible for its full timeout", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<MeetingReviewClient snapshot={snapshot} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy transcript/i }));
      await Promise.resolve();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Copied transcript");

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy latest review/i }));
      await Promise.resolve();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Copied review");

    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Copied review");

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("exports transcript with a stable fallback filename", () => {
    const href = "blob:roompulse";
    const createObjectURL = vi.fn(() => href);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL
    });
    const clickedDownloads: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function click(this: HTMLAnchorElement) {
        clickedDownloads.push(this.download);
      });

    render(<MeetingReviewClient snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: /export transcript/i }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(clickedDownloads).toEqual(["roompulse-meeting-transcript.txt"]);
  });
});
