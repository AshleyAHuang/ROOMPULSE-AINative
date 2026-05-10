import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPiHeartbeat, runPiInitialReviewDocument } from "./pi-adapter";
import {
  createInitialReviewMarkdown,
  createUiToolDefinitions,
  type HeartbeatInput,
  type MeetingConfig
} from "./facilitator";

const authStorage = {
  hasAuth: vi.fn(),
  set: vi.fn()
};
const modelRegistry = {
  find: vi.fn(),
  hasConfiguredAuth: vi.fn()
};
const sessionManager = { kind: "in-memory-session-manager" };
const session = {
  subscribe: vi.fn(),
  prompt: vi.fn(),
  dispose: vi.fn(),
  state: {
    messages: []
  }
};

const createAgentSession = vi.fn();
const AuthStorage = {
  create: vi.fn()
};
const ModelRegistry = {
  create: vi.fn()
};
const SessionManager = {
  inMemory: vi.fn()
};

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager
}));

const meeting: MeetingConfig = {
  title: "Launch check",
  goal: "Assign the risk owner",
  context: "RoomPulse should nudge the shared room display.",
  agenda: [{ id: "a1", title: "Risks", done: false }],
  expectedParticipants: 3,
  participants: [],
  heartbeatIntervalSeconds: 30
};

const heartbeatInput: HeartbeatInput = {
  meeting,
  transcript: [],
  transcriptDelta: [],
  participation: {
    expected: 3,
    observed: 1,
    missingCount: 2,
    observedLabels: ["Speaker 1"],
    needsNudge: true,
    reminder:
      "Two expected participants have not appeared in the speaker clusters yet."
  },
  agendaProgress: {
    total: 1,
    completed: 0,
    active: meeting.agenda[0]
  },
  priorInterventions: [],
  priorReminders: [],
  currentReviewMarkdown: createInitialReviewMarkdown(meeting),
  reviewVersions: [],
  uiTools: createUiToolDefinitions(meeting),
  runtime: {
    meetingStartedAt: 1_700_000_000_000,
    meetingElapsedSeconds: 0,
    isPaused: false,
    heartbeatCount: 0
  },
  now: 1_700_000_000_000
};

describe("Pi adapter", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "roompulse-pi-test-"));
    vi.clearAllMocks();
    delete process.env.ROOMPULSE_PI_MODE;
    delete process.env.ROOMPULSE_PI_PROVIDER;
    delete process.env.ROOMPULSE_PI_MODEL;
    delete process.env.ROOMPULSE_PI_THINKING_LEVEL;
    delete process.env.ROOMPULSE_PI_TIMEOUT_MS;
    delete process.env.ROOMPULSE_REQUIRE_PI;
    process.env.ROOMPULSE_CODEX_AUTH_PATH = join(tempDir, "codex-auth.json");

    let configured = false;
    authStorage.hasAuth.mockImplementation((provider: string) => {
      return provider === "openai-codex" && configured;
    });
    authStorage.set.mockImplementation((provider: string) => {
      configured = provider === "openai-codex" || configured;
    });
    AuthStorage.create.mockReturnValue(authStorage);
    ModelRegistry.create.mockReturnValue(modelRegistry);
    modelRegistry.find.mockReturnValue({
      provider: "openai-codex",
      id: "gpt-5.3-codex-spark"
    });
    modelRegistry.hasConfiguredAuth.mockReturnValue(true);
    SessionManager.inMemory.mockReturnValue(sessionManager);
    session.subscribe.mockImplementation((listener: (event: unknown) => void) => {
      listener({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: JSON.stringify({
            cards: [
              {
                kind: "heartbeat",
                title: "Stay focused",
                body: "Keep the room on the risk owner decision.",
                priority: "medium"
              }
            ],
            summary: "One Pi cue generated.",
            nextHeartbeatHint: "Revisit the open risk owner.",
            reviewMarkdown: "# Launch check\n\n### Heartbeat 1\n- Stay focused.",
            agendaActions: [],
            uiActions: [],
            ephemeralReminder: "Keep the room on the risk owner decision."
          })
        }
      });
    });
    session.prompt.mockResolvedValue(undefined);
    createAgentSession.mockResolvedValue({ session });
  });

  afterEach(() => {
    delete process.env.ROOMPULSE_CODEX_AUTH_PATH;
    delete process.env.ROOMPULSE_REQUIRE_PI;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("bridges Codex CLI auth into Pi and starts the configured OpenAI Codex model", async () => {
    writeFileSync(
      process.env.ROOMPULSE_CODEX_AUTH_PATH!,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: jwtWithExpiration(1_900_000_000),
          refresh_token: "refresh-token",
          account_id: "acct_123"
        }
      })
    );

    const output = await runPiHeartbeat(heartbeatInput);

    expect(output.source).toBe("pi");
    expect(AuthStorage.create).toHaveBeenCalledOnce();
    expect(authStorage.set).toHaveBeenCalledWith("openai-codex", {
      type: "oauth",
      access: expect.any(String),
      refresh: "refresh-token",
      expires: 1_900_000_000_000,
      accountId: "acct_123"
    });
    expect(ModelRegistry.create).toHaveBeenCalledWith(authStorage);
    expect(modelRegistry.find).toHaveBeenCalledWith(
      "openai-codex",
      "gpt-5.3-codex-spark"
    );
    expect(SessionManager.inMemory).toHaveBeenCalledWith(process.cwd());
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        authStorage,
        modelRegistry,
        model: { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
        sessionManager,
        noTools: "builtin",
        customTools: expect.any(Array),
        tools: expect.arrayContaining([
          "add_agenda_item",
          "set_agenda_item",
          "delete_agenda_item",
          "send_room_reminder",
          "update_review_document"
        ]),
        thinkingLevel: "minimal"
      })
    );
    expect(createAgentSession.mock.calls[0]?.[0].tools).not.toEqual(
      expect.arrayContaining([
        "request_microphone",
        "stop_microphone",
        "start_scripted_demo",
        "stop_scripted_demo",
        "set_heartbeat_interval",
        "set_expected_participants"
      ])
    );
  });

  it("initializes the pre-meeting markdown document through Pi", async () => {
    writeFileSync(
      process.env.ROOMPULSE_CODEX_AUTH_PATH!,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: jwtWithExpiration(1_900_000_000),
          refresh_token: "refresh-token",
          account_id: "acct_123"
        }
      })
    );
    session.subscribe.mockImplementation((listener: (event: unknown) => void) => {
      listener({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: JSON.stringify({
            summary: "Initialized agenda review.",
            markdown: "# Launch check\n\n## Agenda\n- [ ] Risks"
          })
        }
      });
    });

    const output = await runPiInitialReviewDocument(meeting);

    expect(output).toMatchObject({
      source: "pi",
      summary: "Initialized agenda review.",
      markdown: expect.stringContaining("## Agenda")
    });
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        noTools: "all",
        tools: []
      })
    );
    expect(session.prompt.mock.calls[0]?.[0]).toContain(
      "before the meeting starts"
    );
  });

  it("falls back locally with a clear auth notice when Codex auth is unavailable", async () => {
    modelRegistry.hasConfiguredAuth.mockReturnValue(false);

    const output = await runPiHeartbeat(heartbeatInput);

    expect(output.source).toBe("local-fallback");
    expect(output.adapterNotice).toContain("OpenAI Codex auth is not configured");
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("applies strict Pi tool updates when final JSON times out", async () => {
    process.env.ROOMPULSE_REQUIRE_PI = "1";
    process.env.ROOMPULSE_PI_TIMEOUT_MS = "1000";
    session.subscribe.mockImplementation(() => undefined);
    session.prompt.mockImplementation(async () => {
      const options = createAgentSession.mock.calls[0]?.[0] as {
        customTools?: Array<{
          name: string;
          execute: (
            id: string,
            params: Record<string, unknown>
          ) => Promise<unknown>;
        }>;
      };
      await options.customTools
        ?.find((tool) => tool.name === "update_review_document")
        ?.execute("tool-1", {
          markdown: "# Updated by Pi\n\n- [ ] Risks",
          summary: "Pi updated the markdown through a UI tool."
        });
      await options.customTools
        ?.find((tool) => tool.name === "send_room_reminder")
        ?.execute("tool-2", {
          message: "Ask for the risk owner now."
        });

      return new Promise(() => undefined);
    });

    const output = await runPiHeartbeat(heartbeatInput);

    expect(output.source).toBe("pi");
    expect(output.reviewMarkdown).toContain("Updated by Pi");
    expect(output.ephemeralReminder).toBe("Ask for the risk owner now.");
    expect(output.adapterNotice).toContain("final JSON completed");
  });

  it("throws instead of falling back when Pi is required", async () => {
    process.env.ROOMPULSE_REQUIRE_PI = "1";
    modelRegistry.hasConfiguredAuth.mockReturnValue(false);

    await expect(runPiHeartbeat(heartbeatInput)).rejects.toThrow(
      "Pi adapter required but unavailable"
    );
    expect(createAgentSession).not.toHaveBeenCalled();
  });
});

function jwtWithExpiration(exp: number): string {
  const header = encodeBase64Url({ alg: "none", typ: "JWT" });
  const payload = encodeBase64Url({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123"
    }
  });
  return `${header}.${payload}.signature`;
}

function encodeBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
