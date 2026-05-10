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
    delete process.env.ROOMPULSE_OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ROOMPULSE_OPENROUTER_BASE_URL;
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
    delete process.env.ROOMPULSE_OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ROOMPULSE_OPENROUTER_BASE_URL;
    vi.unstubAllGlobals();
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
      "gpt-5.5"
    );
    expect(SessionManager.inMemory).toHaveBeenCalledWith(process.cwd());
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        authStorage,
        modelRegistry,
        model: { provider: "openai-codex", id: "gpt-5.5" },
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
        thinkingLevel: "off"
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

  it("parses the first complete Pi JSON object without swallowing trailing diagnostics", async () => {
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
          delta: [
            "Here is the strict heartbeat JSON.\n",
            JSON.stringify({
              cards: [
                {
                  kind: "heartbeat",
                  title: "Use the current review",
                  body: "Trailing diagnostics should not poison the JSON object.",
                  priority: "medium"
                }
              ],
              summary: "One valid JSON object was parsed.",
              nextHeartbeatHint: "Continue.",
              reviewMarkdown:
                "# Launch check\n\nKeep this {literal brace} text in markdown.",
              agendaActions: [],
              uiActions: [],
              ephemeralReminder: null
            }),
            "\nDiagnostics: ",
            JSON.stringify({ ignored: true })
          ].join("")
        }
      });
    });

    const output = await runPiHeartbeat(heartbeatInput);

    expect(output.source).toBe("pi");
    expect(output.summary).toBe("One valid JSON object was parsed.");
    expect(output.reviewMarkdown).toContain("{literal brace}");
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

  it("does not render empty Pi cards as room-facing facilitator output", async () => {
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
            cards: [
              {
                kind: "heartbeat",
                title: "   ",
                body: "   ",
                priority: "medium"
              }
            ],
            summary: "Malformed Pi cue.",
            reviewMarkdown: "# Launch check\n\nNo usable room cue."
          })
        }
      });
    });

    const output = await runPiHeartbeat(heartbeatInput);

    expect(output.source).toBe("local-fallback");
    expect(output.adapterNotice).toContain("no usable cards");
    expect(output.cards.every((card) => card.title.trim() && card.body.trim()))
      .toBe(true);
  });

  it("falls back when Pi JSON omits the required review markdown", async () => {
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
            cards: [
              {
                kind: "heartbeat",
                title: "Review missing",
                body: "This response forgot the markdown document.",
                priority: "medium"
              }
            ],
            summary: "Malformed Pi review.",
            nextHeartbeatHint: "Retry."
          })
        }
      });
    });

    const output = await runPiHeartbeat(heartbeatInput);

    expect(output.source).toBe("local-fallback");
    expect(output.adapterNotice).toContain(
      "Pi response did not include reviewMarkdown"
    );
    expect(output.reviewMarkdown).toContain("RoomPulse revises the full document");
  });

  it("ignores malformed Pi agenda actions instead of defaulting them complete", async () => {
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
            cards: [
              {
                kind: "agenda",
                title: "Agenda status",
                body: "Only valid agenda actions should be applied.",
                priority: "medium"
              }
            ],
            summary: "Agenda update.",
            reviewMarkdown: "# Launch check\n\nAgenda update.",
            agendaActions: [
              { itemId: "a1", reason: "Missing done should be ignored." },
              { itemId: " ", done: true, reason: "Blank id should be ignored." },
              { itemId: "a1", done: true, reason: "Valid completion." }
            ],
            uiActions: [],
            ephemeralReminder: null
          })
        }
      });
    });

    const output = await runPiHeartbeat(heartbeatInput);

    expect(output.agendaActions).toEqual([
      {
        itemId: "a1",
        done: true,
        reason: "Valid completion."
      }
    ]);
  });

  it("returns strict Pi tool updates before final prompt resolution", async () => {
    process.env.ROOMPULSE_REQUIRE_PI = "1";
    process.env.ROOMPULSE_PI_TIMEOUT_MS = "1000";
    session.subscribe.mockImplementation(() => undefined);
    let resolvePrompt: (() => void) | undefined;
    let promptResolved = false;
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
        ?.find((tool) => tool.name === "set_agenda_item")
        ?.execute("tool-0", {
          itemId: "a1",
          done: true,
          reason: "The room resolved the risk-owner agenda item."
        });
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

      await new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
      promptResolved = true;
    });

    const output = await runPiHeartbeat(heartbeatInput);

    expect(promptResolved).toBe(false);
    expect(output.source).toBe("pi");
    expect(output.cards[0]?.title).toBe("Pi tools applied");
    expect(output.reviewMarkdown).toContain("Updated by Pi");
    expect(output.agendaActions).toContainEqual({
      itemId: "a1",
      done: true,
      reason: "The room resolved the risk-owner agenda item."
    });
    expect(output.ephemeralReminder).toBe("Ask for the risk owner now.");
    expect(output.uiActions.map((action) => action.tool)).toEqual([
      "set_agenda_item",
      "update_review_document",
      "send_room_reminder"
    ]);
    expect(output.adapterNotice).toContain("RoomPulse UI tool");
    expect(session.dispose).toHaveBeenCalledOnce();

    resolvePrompt?.();
  });

  it("rejects empty Pi cards in strict mode instead of showing blank cues", async () => {
    process.env.ROOMPULSE_REQUIRE_PI = "1";
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
            cards: [
              {
                kind: "reminder",
                title: "",
                body: "",
                priority: "high"
              }
            ],
            summary: "Malformed Pi cue.",
            reviewMarkdown: "# Launch check\n\nNo usable room cue."
          })
        }
      });
    });

    await expect(runPiHeartbeat(heartbeatInput)).rejects.toThrow(
      "Pi adapter required but unavailable: Pi response contained no usable cards"
    );
  });

  it("runs heartbeat reviews through OpenRouter tool calls", async () => {
    process.env.ROOMPULSE_PI_PROVIDER = "openrouter";
    process.env.ROOMPULSE_PI_MODEL = "openai/gpt-4o-mini";
    process.env.ROOMPULSE_OPENROUTER_API_KEY = "openrouter-key";
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: "function",
                  function: {
                    name: "update_review_document",
                    arguments: JSON.stringify({
                      markdown: "# Updated by OpenRouter\n\n- [ ] Risks",
                      summary: "OpenRouter updated the markdown."
                    })
                  }
                },
                {
                  type: "function",
                  function: {
                    name: "send_room_reminder",
                    arguments: JSON.stringify({
                      message: "Invite Speaker 2 before closing."
                    })
                  }
                }
              ]
            }
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await runPiHeartbeat(heartbeatInput);

    expect(output.source).toBe("openrouter");
    expect(output.cards[0]?.title).toBe("OpenRouter tools applied");
    expect(output.cards[0]?.body).toContain("OpenRouter updated");
    expect(output.nextHeartbeatHint).toContain("OpenRouter");
    expect(output.reviewMarkdown).toContain("Updated by OpenRouter");
    expect(output.ephemeralReminder).toBe("Invite Speaker 2 before closing.");
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer openrouter-key"
        })
      })
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1].body);
    expect(requestBody.model).toBe("openai/gpt-4o-mini");
    expect(requestBody.tools.map((tool: { function: { name: string } }) => tool.function.name))
      .toContain("update_review_document");
  });

  it("falls back when OpenRouter returns an unusable review tool call", async () => {
    process.env.ROOMPULSE_PI_PROVIDER = "openrouter";
    process.env.ROOMPULSE_OPENROUTER_API_KEY = "openrouter-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    type: "function",
                    function: {
                      name: "update_review_document",
                      arguments: JSON.stringify({
                        summary: "OpenRouter forgot the markdown body."
                      })
                    }
                  }
                ]
              }
            }
          ]
        })
      )
    );

    const output = await runPiHeartbeat(heartbeatInput);

    expect(output.source).toBe("local-fallback");
    expect(output.adapterNotice).toContain(
      "OpenRouter returned invalid parameters for update_review_document"
    );
  });

  it("initializes review markdown through OpenRouter JSON output", async () => {
    process.env.ROOMPULSE_PI_PROVIDER = "openrouter";
    process.env.ROOMPULSE_OPENROUTER_API_KEY = "openrouter-key";
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "OpenRouter initialized the review.",
                markdown: "# OpenRouter review\n\n## Agenda\n- [ ] Risks"
              })
            }
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await runPiInitialReviewDocument(meeting);

    expect(output).toMatchObject({
      source: "openrouter",
      summary: "OpenRouter initialized the review.",
      markdown: expect.stringContaining("## Agenda")
    });
    expect(createAgentSession).not.toHaveBeenCalled();
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1].body);
    expect(requestBody.response_format).toEqual({ type: "json_object" });
  });

  it("falls back when OpenRouter initial review is not valid JSON", async () => {
    process.env.ROOMPULSE_PI_PROVIDER = "openrouter";
    process.env.ROOMPULSE_OPENROUTER_API_KEY = "openrouter-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [
            {
              message: {
                content: "# Raw markdown without the required JSON envelope"
              }
            }
          ]
        })
      )
    );

    const output = await runPiInitialReviewDocument(meeting);

    expect(output.source).toBe("local-fallback");
    expect(output.markdown).toBe(createInitialReviewMarkdown(meeting));
    expect(output.adapterNotice).toContain(
      "Pi initial review was not valid JSON"
    );
  });

  it("throws in strict mode when OpenRouter initial review is missing markdown", async () => {
    process.env.ROOMPULSE_REQUIRE_PI = "1";
    process.env.ROOMPULSE_PI_PROVIDER = "openrouter";
    process.env.ROOMPULSE_OPENROUTER_API_KEY = "openrouter-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ summary: "Missing markdown." })
              }
            }
          ]
        })
      )
    );

    await expect(runPiInitialReviewDocument(meeting)).rejects.toThrow(
      "Pi adapter required but unavailable: Pi initial review did not include markdown"
    );
  });

  it("marks RoomPulse UI tool results as turn-terminating", async () => {
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

    await runPiHeartbeat(heartbeatInput);
    const options = createAgentSession.mock.calls[0]?.[0] as {
      customTools?: Array<{
        name: string;
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ terminate?: boolean }>;
      }>;
    };
    const toolParams: Record<string, Record<string, unknown>> = {
      add_agenda_item: { title: "Budget", reason: "The room added budget." },
      set_agenda_item: { itemId: "a1", done: true, reason: "Covered." },
      delete_agenda_item: { itemId: "a1", reason: "Merged into another item." },
      send_room_reminder: { message: "Invite Speaker 2.", tone: "quiet" },
      update_review_document: { markdown: "# Done", summary: "Done" }
    };

    for (const tool of options.customTools ?? []) {
      await expect(
        tool.execute(`tool-${tool.name}`, toolParams[tool.name] ?? {})
      ).resolves.toMatchObject({ terminate: true });
    }
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
