import { NextResponse } from "next/server";
import {
  createHeartbeatInput,
  type CreateHeartbeatInputArgs
} from "@/lib/facilitator";
import { runPiHeartbeat } from "@/lib/pi-adapter";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON payload"
      },
      { status: 400 }
    );
  }

  if (!isHeartbeatPayload(payload)) {
    return NextResponse.json(
      {
        error: "Invalid heartbeat payload"
      },
      { status: 400 }
    );
  }

  try {
    const input = createHeartbeatInput(payload);
    const output = await runPiHeartbeat(input);

    return NextResponse.json(output);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Heartbeat failed",
        piRequired: process.env.ROOMPULSE_REQUIRE_PI === "1"
      },
      { status: 500 }
    );
  }
}

function isHeartbeatPayload(value: unknown): value is CreateHeartbeatInputArgs {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isMeeting(value.meeting) &&
    Array.isArray(value.transcript) &&
    value.transcript.every(isTranscriptLine) &&
    Array.isArray(value.observedSpeakerLabels) &&
    value.observedSpeakerLabels.every((label) => typeof label === "string") &&
    isFiniteNumber(value.lastHeartbeatAt) &&
    isFiniteNumber(value.now) &&
    Array.isArray(value.priorInterventions) &&
    (value.currentReviewMarkdown === undefined ||
      typeof value.currentReviewMarkdown === "string") &&
    (value.reviewVersions === undefined || Array.isArray(value.reviewVersions)) &&
    (value.meetingStartedAt === undefined ||
      isFiniteNumber(value.meetingStartedAt)) &&
    (value.isPaused === undefined || typeof value.isPaused === "boolean") &&
    (value.heartbeatCount === undefined || isFiniteNumber(value.heartbeatCount))
  );
}

function isMeeting(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.title === "string" &&
    typeof value.goal === "string" &&
    typeof value.context === "string" &&
    Array.isArray(value.agenda) &&
    value.agenda.every(isAgendaItem) &&
    isFiniteNumber(value.expectedParticipants) &&
    Array.isArray(value.participants) &&
    value.participants.every(isParticipant) &&
    isFiniteNumber(value.heartbeatIntervalSeconds)
  );
}

function isAgendaItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.done === "boolean"
  );
}

function isParticipant(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.role === undefined || typeof value.role === "string")
  );
}

function isTranscriptLine(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.speakerId === "string" &&
    typeof value.speakerLabel === "string" &&
    typeof value.text === "string" &&
    isFiniteNumber(value.timestamp) &&
    isTranscriptSource(value.source) &&
    isFiniteNumber(value.confidence)
  );
}

function isTranscriptSource(value: unknown): boolean {
  return value === "speech" || value === "simulated" || value === "manual";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
