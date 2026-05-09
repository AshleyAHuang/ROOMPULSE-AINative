import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPiHeartbeat } from "./pi-adapter";
import {
  createInitialReviewMarkdown,
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
  currentReviewMarkdown: createInitialReviewMarkdown(meeting),
  reviewVersions: [],
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
      id: "gpt-5.5"
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
    expect(modelRegistry.find).toHaveBeenCalledWith("openai-codex", "gpt-5.5");
    expect(SessionManager.inMemory).toHaveBeenCalledWith(process.cwd());
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        authStorage,
        modelRegistry,
        model: { provider: "openai-codex", id: "gpt-5.5" },
        sessionManager,
        noTools: "all",
        thinkingLevel: "minimal"
      })
    );
  });

  it("falls back locally with a clear auth notice when Codex auth is unavailable", async () => {
    modelRegistry.hasConfiguredAuth.mockReturnValue(false);

    const output = await runPiHeartbeat(heartbeatInput);

    expect(output.source).toBe("local-fallback");
    expect(output.adapterNotice).toContain("OpenAI Codex auth is not configured");
    expect(createAgentSession).not.toHaveBeenCalled();
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
