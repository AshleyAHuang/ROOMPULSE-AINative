import {
  runLocalFacilitation,
  type FacilitatorOutput,
  type HeartbeatInput
} from "./facilitator";

const PI_TIMEOUT_MS = 6500;

interface PiModule {
  createAgentSession: (options?: {
    cwd?: string;
    noTools?: "all" | "builtin";
    thinkingLevel?: string;
  }) => Promise<{
    session: {
      prompt: (text: string) => Promise<void>;
      state: {
        messages: unknown[];
      };
    };
  }>;
}

export async function runPiHeartbeat(
  input: HeartbeatInput
): Promise<FacilitatorOutput> {
  try {
    const output = await withTimeout(runPiSession(input), PI_TIMEOUT_MS);
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

  const pi = (await import("@earendil-works/pi-coding-agent")) as PiModule;
  const { session } = await pi.createAgentSession({
    cwd: process.cwd(),
    noTools: "all",
    thinkingLevel: "off"
  });

  const chunks: string[] = [];
  const maybeSubscribable = session as unknown as {
    subscribe?: (listener: (event: unknown) => void) => void;
  };

  maybeSubscribable.subscribe?.((event) => {
    const delta = readTextDelta(event);
    if (delta) {
      chunks.push(delta);
    }
  });

  await session.prompt(buildPiPrompt(input));

  const text = chunks.join("").trim() || extractAssistantText(session.state.messages);
  return parsePiOutput(text);
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
