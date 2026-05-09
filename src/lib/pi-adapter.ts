import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  runLocalFacilitation,
  type FacilitatorOutput,
  type HeartbeatInput
} from "./facilitator";

const DEFAULT_PI_TIMEOUT_MS = 25_000;
const DEFAULT_CODEX_PROVIDER = "openai-codex";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_THINKING_LEVEL = "minimal";
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface PiModel {
  provider: string;
  id: string;
}

interface PiAuthStorage {
  hasAuth: (provider: string) => boolean;
  set: (provider: string, credential: PiOAuthCredential) => void;
}

interface PiModelRegistry {
  find: (provider: string, modelId: string) => PiModel | undefined;
  hasConfiguredAuth?: (model: PiModel) => boolean;
}

interface PiOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  [key: string]: unknown;
}

interface PiModule {
  AuthStorage: {
    create: () => PiAuthStorage;
  };
  createAgentSession: (options?: {
    authStorage?: PiAuthStorage;
    cwd?: string;
    model?: PiModel;
    modelRegistry?: PiModelRegistry;
    noTools?: "all" | "builtin";
    sessionManager?: unknown;
    thinkingLevel?: string;
  }) => Promise<{
    session: {
      prompt: (text: string) => Promise<void>;
      subscribe?: (listener: (event: unknown) => void) => () => void;
      dispose?: () => void;
      messages?: unknown[];
      state?: {
        messages: unknown[];
      };
    };
  }>;
  ModelRegistry: {
    create: (authStorage: PiAuthStorage) => PiModelRegistry;
  };
  SessionManager: {
    inMemory: (cwd?: string) => unknown;
  };
}

export async function runPiHeartbeat(
  input: HeartbeatInput
): Promise<FacilitatorOutput> {
  try {
    const output = await withTimeout(runPiSession(input), getPiTimeoutMs());
    return output;
  } catch (error) {
    const fallback = await runLocalFacilitation(input);
    return {
      ...fallback,
      adapterNotice: `Pi adapter fell back locally: ${errorToMessage(error)}`
    };
  }
}

async function runPiSession(input: HeartbeatInput): Promise<FacilitatorOutput> {
  if (process.env.ROOMPULSE_PI_MODE === "local") {
    throw new Error("ROOMPULSE_PI_MODE=local");
  }

  const config = getPiConfig();
  const pi = (await import(
    "@earendil-works/pi-coding-agent"
  )) as unknown as PiModule;
  const authStorage = pi.AuthStorage.create();

  if (config.provider === DEFAULT_CODEX_PROVIDER) {
    importCodexCliAuth(authStorage, config.codexAuthPath);
  }

  const modelRegistry = pi.ModelRegistry.create(authStorage);
  const model = modelRegistry.find(config.provider, config.model);

  if (!model) {
    throw new Error(
      `Pi model ${config.provider}/${config.model} is not available in the installed Pi SDK.`
    );
  }

  if (!isModelAuthConfigured(authStorage, modelRegistry, model)) {
    throw new Error(buildMissingAuthMessage(config.provider));
  }

  const cwd = process.cwd();
  const { session } = await pi.createAgentSession({
    authStorage,
    cwd,
    model,
    modelRegistry,
    noTools: "all",
    sessionManager: pi.SessionManager.inMemory(cwd),
    thinkingLevel: config.thinkingLevel
  });

  const chunks: string[] = [];
  const unsubscribe = session.subscribe?.((event) => {
    const delta = readTextDelta(event);
    if (delta) {
      chunks.push(delta);
    }
  });

  try {
    await session.prompt(buildPiPrompt(input));

    const text =
      chunks.join("").trim() ||
      extractAssistantText(session.state?.messages ?? session.messages ?? []);
    return parsePiOutput(text);
  } finally {
    unsubscribe?.();
    session.dispose?.();
  }
}

interface PiConfig {
  provider: string;
  model: string;
  thinkingLevel: PiThinkingLevel;
  codexAuthPath: string;
}

function getPiConfig(): PiConfig {
  return {
    provider: process.env.ROOMPULSE_PI_PROVIDER || DEFAULT_CODEX_PROVIDER,
    model: process.env.ROOMPULSE_PI_MODEL || DEFAULT_CODEX_MODEL,
    thinkingLevel: parseThinkingLevel(process.env.ROOMPULSE_PI_THINKING_LEVEL),
    codexAuthPath:
      process.env.ROOMPULSE_CODEX_AUTH_PATH ||
      join(homedir(), ".codex", "auth.json")
  };
}

function parseThinkingLevel(value: string | undefined): PiThinkingLevel {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }

  return DEFAULT_THINKING_LEVEL;
}

function getPiTimeoutMs(): number {
  const configured = Number(process.env.ROOMPULSE_PI_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured >= 1_000) {
    return configured;
  }

  return DEFAULT_PI_TIMEOUT_MS;
}

function importCodexCliAuth(
  authStorage: PiAuthStorage,
  codexAuthPath: string
): void {
  if (
    process.env.ROOMPULSE_IMPORT_CODEX_CLI_AUTH === "0" ||
    authStorage.hasAuth(DEFAULT_CODEX_PROVIDER)
  ) {
    return;
  }

  const credential = readCodexCliCredential(codexAuthPath);
  if (credential) {
    authStorage.set(DEFAULT_CODEX_PROVIDER, credential);
  }
}

function readCodexCliCredential(codexAuthPath: string): PiOAuthCredential | null {
  if (!existsSync(codexAuthPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(codexAuthPath, "utf8")) as {
      auth_mode?: unknown;
      tokens?: {
        access_token?: unknown;
        refresh_token?: unknown;
        account_id?: unknown;
      };
    };
    const access = parsed.tokens?.access_token;
    const refresh = parsed.tokens?.refresh_token;

    if (
      parsed.auth_mode !== "chatgpt" ||
      typeof access !== "string" ||
      typeof refresh !== "string"
    ) {
      return null;
    }

    const accountId =
      typeof parsed.tokens?.account_id === "string"
        ? parsed.tokens.account_id
        : extractCodexAccountId(access);

    return {
      type: "oauth",
      access,
      refresh,
      expires: extractJwtExpirationMs(access) ?? Date.now(),
      ...(accountId ? { accountId } : {})
    };
  } catch {
    return null;
  }
}

function extractJwtExpirationMs(token: string): number | null {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;

  if (typeof exp === "number" && Number.isFinite(exp)) {
    return exp * 1000;
  }

  if (typeof exp === "string") {
    const parsed = Number(exp);
    return Number.isFinite(parsed) ? parsed * 1000 : null;
  }

  return null;
}

function extractCodexAccountId(token: string): string | null {
  const auth = decodeJwtPayload(token)?.[CODEX_AUTH_CLAIM];

  if (!auth || typeof auth !== "object") {
    return null;
  }

  const accountId = (auth as { chatgpt_account_id?: unknown })
    .chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0
    ? accountId
    : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isModelAuthConfigured(
  authStorage: PiAuthStorage,
  modelRegistry: PiModelRegistry,
  model: PiModel
): boolean {
  return (
    modelRegistry.hasConfiguredAuth?.(model) ??
    authStorage.hasAuth(model.provider)
  );
}

function buildMissingAuthMessage(provider: string): string {
  if (provider === DEFAULT_CODEX_PROVIDER) {
    return [
      "OpenAI Codex auth is not configured for Pi.",
      "Run `codex login` so RoomPulse can import ~/.codex/auth.json,",
      "or run `npx pi /login` and select ChatGPT Plus/Pro (Codex)."
    ].join(" ");
  }

  return `Pi provider ${provider} does not have configured auth.`;
}

function buildPiPrompt(input: HeartbeatInput): string {
  return `You are RoomPulse, a visible in-room meeting facilitator. No private notes and no voice output.

Return strict JSON only, matching:
{
  "cards": [{"kind":"heartbeat|participation|risk|agenda|decision|action|drift|reminder","title":"short","body":"one room-visible sentence","priority":"low|medium|high"}],
  "summary": "one sentence",
  "nextHeartbeatHint": "one sentence"
}

Meeting context:
${JSON.stringify(input, null, 2)}

Keep cards concise. Prefer reminders, concerns, agenda drift, open decisions, action items, and participation nudges.`;
}

function parsePiOutput(text: string): FacilitatorOutput {
  const jsonText = extractJsonObject(text);
  const parsed = JSON.parse(jsonText) as Omit<FacilitatorOutput, "source">;

  return {
    source: "pi",
    cards: parsed.cards.map((card, index) => ({
      id: `${Date.now()}-pi-${index + 1}`,
      kind: card.kind,
      title: card.title,
      body: card.body,
      priority: card.priority
    })),
    summary: parsed.summary,
    nextHeartbeatHint: parsed.nextHeartbeatHint
  };
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Pi response did not contain JSON");
  }

  return text.slice(start, end + 1);
}

function extractAssistantText(messages: unknown[]): string {
  const lastMessage = [...messages].reverse().find((message) => {
    return JSON.stringify(message).includes("assistant");
  });

  if (!lastMessage) {
    return "";
  }

  const serialized = JSON.stringify(lastMessage);
  const textMatches = [...serialized.matchAll(/"text":"([^"]+)"/g)];
  return textMatches
    .map((match) => match[1])
    .join("")
    .replaceAll("\\n", "\n")
    .replaceAll('\\"', '"');
}

function readTextDelta(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const serialized = event as {
    type?: string;
    assistantMessageEvent?: {
      type?: string;
      delta?: string;
    };
  };

  if (
    serialized.type === "message_update" &&
    serialized.assistantMessageEvent?.type === "text_delta"
  ) {
    return serialized.assistantMessageEvent.delta ?? null;
  }

  return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Pi heartbeat timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
