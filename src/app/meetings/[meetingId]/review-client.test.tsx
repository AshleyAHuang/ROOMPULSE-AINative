import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
