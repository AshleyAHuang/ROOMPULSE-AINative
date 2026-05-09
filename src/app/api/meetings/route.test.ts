import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "./route";

let logDir = "";

const validMeeting = {
  title: "Logged meeting",
  goal: "Persist events",
  context: "Local storage",
  agenda: [{ id: "a1", title: "Discuss logs", done: false }],
  expectedParticipants: 2,
  participants: [],
  heartbeatIntervalSeconds: 30
};

describe("/api/meetings", () => {
  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "roompulse-api-logs-"));
    process.env.ROOMPULSE_LOG_DIR = logDir;
  });

  afterEach(async () => {
    delete process.env.ROOMPULSE_LOG_DIR;
    if (logDir) {
      await rm(logDir, { force: true, recursive: true });
    }
  });

  it("creates and lists local meeting logs", async () => {
    const createResponse = await POST(jsonRequest({ meeting: validMeeting }));

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.title).toBe("Logged meeting");

    const listResponse = await GET();
    await expect(listResponse.json()).resolves.toMatchObject({
      meetings: [{ id: created.id, title: "Logged meeting" }]
    });
  });

  it("returns 400 for invalid meeting payloads", async () => {
    const response = await POST(jsonRequest({ meeting: null }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid meeting payload"
    });
  });
});

function jsonRequest(payload: unknown): Request {
  return new Request("http://localhost/api/meetings", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" }
  });
}
