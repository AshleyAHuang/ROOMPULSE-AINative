import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { MeetingConfig } from "./facilitator";

export interface MeetingLogMetadata {
  id: string;
  title: string;
  goal: string;
  startedAt: number;
  updatedAt: number;
  eventCount: number;
  meeting: MeetingConfig;
}

export interface MeetingLogEvent {
  id: string;
  type: string;
  timestamp: number;
  payload: unknown;
}

export interface MeetingLogSnapshot {
  metadata: MeetingLogMetadata;
  events: MeetingLogEvent[];
}

export async function createMeetingLog(
  meeting: MeetingConfig,
  startedAt = Date.now()
): Promise<MeetingLogMetadata> {
  const id = createMeetingId(startedAt, meeting.title);
  const metadata: MeetingLogMetadata = {
    id,
    title: meeting.title,
    goal: meeting.goal,
    startedAt,
    updatedAt: startedAt,
    eventCount: 0,
    meeting
  };

  await mkdir(meetingDir(id), { recursive: true });
  await writeMetadata(metadata);
  await writeFile(eventsPath(id), "", { flag: "a" });
  return metadata;
}

export async function appendMeetingLogEvent(
  meetingId: string,
  event: Omit<MeetingLogEvent, "id">
): Promise<MeetingLogEvent> {
  const metadata = await readMeetingMetadata(meetingId);
  const logEvent: MeetingLogEvent = {
    id: randomUUID(),
    type: event.type,
    timestamp: event.timestamp,
    payload: event.payload
  };

  await writeFile(eventsPath(meetingId), `${JSON.stringify(logEvent)}\n`, {
    flag: "a"
  });
  await writeMetadata({
    ...metadata,
    updatedAt: Math.max(metadata.updatedAt, logEvent.timestamp),
    eventCount: metadata.eventCount + 1
  });

  return logEvent;
}

export async function listMeetingLogs(): Promise<MeetingLogMetadata[]> {
  await mkdir(logRoot(), { recursive: true });
  const entries = await readdir(logRoot(), { withFileTypes: true });
  const metadata = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readMeetingMetadata(entry.name).catch(() => null))
  );

  return metadata
    .filter((entry): entry is MeetingLogMetadata => entry !== null)
    .sort((left, right) => right.startedAt - left.startedAt);
}

export async function readMeetingLog(
  meetingId: string
): Promise<MeetingLogSnapshot> {
  const metadata = await readMeetingMetadata(meetingId);
  const rawEvents = await readFile(eventsPath(meetingId), "utf8").catch(() => "");
  const events = rawEvents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MeetingLogEvent);

  return {
    metadata,
    events
  };
}

function createMeetingId(startedAt: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "meeting";
  return `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${slug}-${randomUUID().slice(0, 8)}`;
}

async function readMeetingMetadata(
  meetingId: string
): Promise<MeetingLogMetadata> {
  return JSON.parse(await readFile(metadataPath(meetingId), "utf8")) as MeetingLogMetadata;
}

async function writeMetadata(metadata: MeetingLogMetadata): Promise<void> {
  await writeFile(
    metadataPath(metadata.id),
    `${JSON.stringify(metadata, null, 2)}\n`
  );
}

function meetingDir(meetingId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(meetingId)) {
    throw new Error("Invalid meeting id");
  }
  return join(logRoot(), meetingId);
}

function logRoot(): string {
  if (process.env.NODE_ENV === "test" && process.env.ROOMPULSE_LOG_DIR) {
    return process.env.ROOMPULSE_LOG_DIR;
  }

  return join(process.cwd(), ".roompulse", "meetings");
}

function metadataPath(meetingId: string): string {
  return join(meetingDir(meetingId), "metadata.json");
}

function eventsPath(meetingId: string): string {
  return join(meetingDir(meetingId), "events.jsonl");
}
