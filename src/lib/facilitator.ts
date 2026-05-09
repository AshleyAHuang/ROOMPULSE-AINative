import { createParticipationStatus, type ParticipationStatus } from "./speaker-tracker";

export type TranscriptSource = "speech" | "simulated" | "manual";

export interface MeetingParticipant {
  name: string;
  role?: string;
}

export interface AgendaItem {
  id: string;
  title: string;
  done: boolean;
}

export interface MeetingConfig {
  title: string;
  goal: string;
  context: string;
  agenda: AgendaItem[];
  expectedParticipants: number;
  participants: MeetingParticipant[];
  heartbeatIntervalSeconds: number;
}

export interface TranscriptLine {
  id: string;
  speakerId: string;
  speakerLabel: string;
  text: string;
  timestamp: number;
  source: TranscriptSource;
  confidence: number;
}

export type FacilitatorCardKind =
  | "heartbeat"
  | "participation"
  | "risk"
  | "agenda"
  | "decision"
  | "action"
  | "drift"
  | "reminder";

export interface FacilitatorCard {
  id: string;
  kind: FacilitatorCardKind;
  title: string;
  body: string;
  priority: "low" | "medium" | "high";
}

export interface TimelineEntry {
  id: string;
  timestamp: number;
  source: FacilitatorOutput["source"];
  cards: FacilitatorCard[];
  summary: string;
}

export interface AgendaProgress {
  total: number;
  completed: number;
  active: AgendaItem | null;
}

export interface HeartbeatInput {
  meeting: MeetingConfig;
  transcript: TranscriptLine[];
  transcriptDelta: TranscriptLine[];
  participation: ParticipationStatus;
  agendaProgress: AgendaProgress;
  priorInterventions: TimelineEntry[];
  now: number;
}

export interface FacilitatorOutput {
  source: "pi" | "local-fallback";
  cards: FacilitatorCard[];
  summary: string;
  nextHeartbeatHint: string;
  adapterNotice?: string;
}

export interface CreateHeartbeatInputArgs {
  meeting: MeetingConfig;
  transcript: TranscriptLine[];
  observedSpeakerLabels: string[];
  lastHeartbeatAt: number;
  now: number;
  priorInterventions: TimelineEntry[];
}

export function createHeartbeatInput({
  meeting,
  transcript,
  observedSpeakerLabels,
  lastHeartbeatAt,
  now,
  priorInterventions
}: CreateHeartbeatInputArgs): HeartbeatInput {
  return {
    meeting,
    transcript,
    transcriptDelta: transcript.filter(
      (line) => line.timestamp > lastHeartbeatAt && line.timestamp <= now
    ),
    participation: createParticipationStatus(
      meeting.expectedParticipants,
      observedSpeakerLabels
    ),
    agendaProgress: getAgendaProgress(meeting.agenda),
    priorInterventions,
    now
  };
}

interface Signal {
  kind: FacilitatorCardKind;
  title: string;
  body: string;
  priority: "low" | "medium" | "high";
  score: number;
  /** Kinds whose presence in recent pulses should suppress this signal. */
  decayAgainst?: FacilitatorCardKind[];
}

const RISK_TERMS: Array<[RegExp, number]> = [
  [/\b(blocker|blocked|stuck|cannot|can't)\b/i, 3],
  [/\b(unresolved|open\s+(risk|issue))\b/i, 3],
  [/\b(risk|concern|issue|problem)\b/i, 2],
  [/\b(tight|behind|slipping|short(\s+on)?|under(\s+water)?)\b/i, 2],
  [/\b(deadline|by\s+(eod|friday|monday|tomorrow)|this\s+week)\b/i, 2]
];

const DECISION_TERMS: Array<[RegExp, number]> = [
  [/\b(decide|decision|sign\s+off)\b/i, 3],
  [/\bwho\s+(owns|will|can)\b/i, 3],
  [/\b(owner|own\s+it|accountable|responsible)\b/i, 2],
  [/\b(agree|agreed|approved|okay\s+with)\b/i, 1]
];

const ACTION_TERMS: Array<[RegExp, number]> = [
  [/\b(i'?ll|i\s+will|i\s+can\s+take)\b/i, 3],
  [/\b(by\s+(eod|tomorrow|next\s+\w+))\b/i, 2],
  [/\b(action\s*item|todo|follow\s*up|next\s+step)\b/i, 2]
];

const DRIFT_TERMS: Array<[RegExp, number]> = [
  [/\b(parking\s+lot|park\s+(this|that|it))\b/i, 3],
  [/\b(side\s+topic|off\s+track|tangent|unrelated)\b/i, 2],
  [/\b(later|next\s+meeting|another\s+time)\b/i, 1],
  [/\b(swag|merch)\b/i, 1]
];

const HEDGE_TERMS = /\b(maybe|kinda|sort\s+of|i\s+guess|not\s+sure|might)\b/gi;

export async function runLocalFacilitation(
  input: HeartbeatInput
): Promise<FacilitatorOutput> {
  const recentKinds = new Set<FacilitatorCardKind>(
    input.priorInterventions
      .slice(0, 2)
      .flatMap((entry) => entry.cards.map((card) => card.kind))
  );

  const heartbeatCard: FacilitatorCard = {
    id: createCardId(input.now, "heartbeat"),
    kind: "heartbeat",
    title: "Heartbeat check",
    body: buildHeartbeatBody(input),
    priority: "medium"
  };

  const signals: Signal[] = [];

  // Participation: scales with how many voices are missing.
  if (input.participation.needsNudge && input.participation.reminder) {
    const missingRatio =
      input.participation.expected === 0
        ? 0
        : input.participation.missingCount / input.participation.expected;
    signals.push({
      kind: "participation",
      title: "Open the floor",
      body: input.participation.reminder,
      priority: missingRatio > 0.4 ? "high" : "medium",
      score: 6 + missingRatio * 4
    });
  }

  // Topic-based signals derived from transcript.
  const focusLines = input.transcriptDelta.length
    ? input.transcriptDelta
    : input.transcript.slice(-6);

  const riskScore = scoreLines(focusLines, RISK_TERMS);
  if (riskScore.total > 0) {
    const quote = trimQuote(riskScore.bestLine?.text);
    signals.push({
      kind: "risk",
      title: "Name the risk",
      body: quote
        ? `Risk surfaced: "${quote}". Clarify owner, impact, and the next concrete mitigation before moving on.`
        : "A risk or unresolved concern is active in the room. Clarify owner, impact, and the next concrete mitigation.",
      priority: riskScore.total >= 4 ? "high" : "medium",
      score: 4 + riskScore.total,
      decayAgainst: ["risk"]
    });
  }

  const decisionScore = scoreLines(focusLines, DECISION_TERMS);
  if (decisionScore.total > 0) {
    const quote = trimQuote(decisionScore.bestLine?.text);
    signals.push({
      kind: "decision",
      title: "Capture the decision",
      body: quote
        ? `Decision in motion: "${quote}". Name the proposed owner and ask for explicit agreement.`
        : "The room is circling a decision. State the proposed owner and ask for explicit agreement.",
      priority: decisionScore.total >= 4 ? "high" : "medium",
      score: 3.5 + decisionScore.total,
      decayAgainst: ["decision"]
    });
  }

  const actionScore = scoreLines(focusLines, ACTION_TERMS);
  if (actionScore.total > 0) {
    const quote = trimQuote(actionScore.bestLine?.text);
    const speaker = actionScore.bestLine?.speakerLabel;
    signals.push({
      kind: "action",
      title: "Lock the action",
      body: quote && speaker
        ? `${speaker} just committed: "${quote}". Write it down with a due date.`
        : "Someone just committed to a next step. Capture owner, deliverable, and due date now.",
      priority: "medium",
      score: 3 + actionScore.total,
      decayAgainst: ["action"]
    });
  }

  const driftScore = scoreLines(focusLines, DRIFT_TERMS);
  if (driftScore.total > 0) {
    signals.push({
      kind: "drift",
      title: "Check agenda drift",
      body:
        "A side topic may be pulling attention away from the goal. Park it unless it changes the current decision.",
      priority: "medium",
      score: 2.5 + driftScore.total,
      decayAgainst: ["drift"]
    });
  }

  // Hedging: when the room hedges a lot, the meeting risks ending without a decision.
  const hedgeMatches = focusLines
    .map((line) => line.text.match(HEDGE_TERMS)?.length ?? 0)
    .reduce((sum, count) => sum + count, 0);
  if (hedgeMatches >= 2 && !recentKinds.has("decision")) {
    signals.push({
      kind: "reminder",
      title: "Push past hedging",
      body: `Heard ${hedgeMatches} hedge phrases since last pulse. Restate the question crisply and ask for a yes or no.`,
      priority: "medium",
      score: 2.2,
      decayAgainst: ["reminder"]
    });
  }

  // Decision lag: a risk was raised in prior pulses but no decision has been captured.
  const priorRisk = input.priorInterventions
    .slice(0, 3)
    .some((entry) => entry.cards.some((card) => card.kind === "risk"));
  const priorDecision = input.priorInterventions
    .slice(0, 3)
    .some((entry) => entry.cards.some((card) => card.kind === "decision"));
  if (priorRisk && !priorDecision && riskScore.total === 0) {
    signals.push({
      kind: "decision",
      title: "Still no owner",
      body: "A risk surfaced earlier but no owner has been captured. Force the decision before the next topic.",
      priority: "high",
      score: 5
    });
  }

  // Agenda focus: low-priority anchor.
  const activeAgenda = input.agendaProgress.active;
  if (activeAgenda) {
    signals.push({
      kind: "agenda",
      title: "Agenda focus",
      body: `Current focus: ${activeAgenda.title}. Keep the room moving toward "${input.meeting.goal}".`,
      priority: "low",
      score: 1.2
    });
  }

  // Apply decay against recent kinds and rank.
  const ranked = signals
    .map((signal) => ({
      ...signal,
      score:
        signal.decayAgainst &&
        signal.decayAgainst.some((kind) => recentKinds.has(kind))
          ? signal.score * 0.45
          : signal.score
    }))
    .sort((a, b) => b.score - a.score);

  const cards: FacilitatorCard[] = [heartbeatCard];
  for (const signal of ranked) {
    if (cards.length >= 5) break;
    cards.push({
      // Suffix with the running index so two signals of the same kind in one
      // pulse (e.g. a fresh decision signal plus the decision-lag card) get
      // unique React keys.
      id: createCardId(input.now, `${signal.kind}-${cards.length}`),
      kind: signal.kind,
      title: signal.title,
      body: signal.body,
      priority: signal.priority
    });
  }

  return {
    source: "local-fallback",
    cards,
    summary: `${input.meeting.title}: ${cards.length} facilitator ${
      cards.length === 1 ? "cue" : "cues"
    } from ${input.transcriptDelta.length} new transcript ${
      input.transcriptDelta.length === 1 ? "line" : "lines"
    }.`,
    nextHeartbeatHint: activeAgenda
      ? `Next check should revisit "${activeAgenda.title}".`
      : "Next check should confirm whether the meeting goal is complete."
  };
}

interface ScoreResult {
  total: number;
  bestLine: TranscriptLine | null;
  bestLineScore: number;
}

function scoreLines(
  lines: TranscriptLine[],
  terms: Array<[RegExp, number]>
): ScoreResult {
  let total = 0;
  let bestLine: TranscriptLine | null = null;
  let bestLineScore = 0;

  for (const line of lines) {
    let lineScore = 0;
    for (const [pattern, weight] of terms) {
      if (pattern.test(line.text)) {
        lineScore += weight;
      }
    }
    total += lineScore;
    if (lineScore > bestLineScore) {
      bestLineScore = lineScore;
      bestLine = line;
    }
  }

  return { total, bestLine, bestLineScore };
}

function trimQuote(text: string | undefined): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 80) return cleaned;
  return `${cleaned.slice(0, 77).trim()}…`;
}

export function getAgendaProgress(agenda: AgendaItem[]): AgendaProgress {
  const completed = agenda.filter((item) => item.done).length;
  const active = agenda.find((item) => !item.done) ?? null;

  return {
    total: agenda.length,
    completed,
    active
  };
}

/**
 * Auto-check agenda items that the room has clearly covered.
 *
 * Heuristic:
 * - Tokenize each item's title (drop stopwords, support singular/plural via stems).
 * - Mark an item done when coverage language appears near its title terms:
 *   "that covers launch risks", "done with owners", "checked off the goal", etc.
 * - Also track the most recent transcript timestamp where any token from each item
 *   appears, so items can be marked done when the room clearly moves to a later
 *   agenda item or wraps up after that item was discussed.
 *
 * Pure function: returns a new agenda array. Caller decides whether to commit.
 */
export function applyAgendaCoverage(
  agenda: AgendaItem[],
  transcript: TranscriptLine[]
): AgendaItem[] {
  if (agenda.length === 0 || transcript.length === 0) {
    return agenda;
  }

  const tokenRegexes = agenda.map((item) => tokenizeTitle(item.title));
  const lastHit = new Array<number>(agenda.length).fill(-Infinity);
  const explicitlyCovered = new Array<boolean>(agenda.length).fill(false);
  let wrapupTime = -Infinity;

  for (const line of transcript) {
    const text = line.text;
    if (AGENDA_WRAPUP_REGEX.test(text)) {
      if (line.timestamp > wrapupTime) wrapupTime = line.timestamp;
    }
    for (let i = 0; i < agenda.length; i += 1) {
      const matched = tokenRegexes[i].some((re) => re.test(text));
      if (matched) {
        if (line.timestamp > lastHit[i]) lastHit[i] = line.timestamp;
      }
      if (matched && isCoverageCueForItem(text, tokenRegexes[i])) {
        explicitlyCovered[i] = true;
      }
    }
  }

  let changed = false;
  const next = agenda.map((item, i) => {
    if (item.done) return item;
    if (explicitlyCovered[i]) {
      changed = true;
      return { ...item, done: true };
    }
    if (lastHit[i] === -Infinity) return item;

    // A later item is more recent — the room has moved on.
    for (let j = i + 1; j < agenda.length; j += 1) {
      if (!agenda[j].done && lastHit[j] > lastHit[i]) {
        changed = true;
        return { ...item, done: true };
      }
    }

    // Wrap-up phrase arrived after the last time this item was mentioned.
    if (wrapupTime > lastHit[i]) {
      changed = true;
      return { ...item, done: true };
    }

    return item;
  });

  return changed ? next : agenda;
}

const AGENDA_STOPWORDS = new Set([
  "and",
  "the",
  "a",
  "an",
  "of",
  "or",
  "in",
  "on",
  "to",
  "for",
  "with",
  "is",
  "are",
  "be",
  "by",
  "at",
  "from",
  "as",
  "that",
  "this",
  "we",
  "our",
  "us",
  "you",
  "your",
  "they",
  "their",
  "it",
  "its"
]);

const AGENDA_WRAPUP_REGEX =
  /\b(anything\s+else|that'?s\s+(it|all|done|covered)|we'?re\s+(done|good|set|all\s+set)|let'?s\s+(wrap|move\s+on)|wrap(ping|ped)?\s+up|moving\s+on|next\s+(item|topic|one|up)|all\s+set)\b/i;

const AGENDA_COVERAGE_REGEX =
  /\b(covered|covers|complete(?:d)?|done\s+with|finished|handled|resolved|closed|checked\s+off|signed\s+off|wrapped\s+up|that'?s\s+(done|covered|complete)|we'?re\s+(good|set|done)\s+on)\b/i;

const AGENDA_COVERAGE_GLOBAL_REGEX =
  /\b(covered|covers|complete(?:d)?|done\s+with|finished|handled|resolved|closed|checked\s+off|signed\s+off|wrapped\s+up|that'?s\s+(done|covered|complete)|we'?re\s+(good|set|done)\s+on)\b/gi;

const NEGATED_COVERAGE_REGEX =
  /\b(not|not\s+yet|haven'?t|hasn'?t|isn'?t|aren'?t|still\s+need\s+to|need\s+to\s+still)\b.{0,32}\b(cover(?:ed)?|complete(?:d)?|done|finish(?:ed)?|handle(?:d)?|resolve(?:d)?|close(?:d)?)\b/i;

function isCoverageCueForItem(text: string, itemTokens: RegExp[]): boolean {
  if (
    !AGENDA_COVERAGE_REGEX.test(text) ||
    NEGATED_COVERAGE_REGEX.test(text)
  ) {
    return false;
  }

  const tokenMatches = itemTokens
    .map((token) => text.search(token))
    .filter((index) => index >= 0);
  if (tokenMatches.length === 0) {
    return false;
  }

  const coverageMatches = Array.from(text.matchAll(AGENDA_COVERAGE_GLOBAL_REGEX));
  return coverageMatches.some((match) =>
    tokenMatches.some((tokenIndex) => Math.abs((match.index ?? 0) - tokenIndex) <= 32)
  );
}

function tokenizeTitle(title: string): RegExp[] {
  const seen = new Set<string>();
  const regexes: RegExp[] = [];
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z\s']/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !AGENDA_STOPWORDS.has(token));

  for (const token of tokens) {
    const stem = token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
    if (seen.has(stem)) continue;
    seen.add(stem);
    regexes.push(new RegExp(`\\b${escapeRegex(stem)}s?\\b`, "i"));
  }

  return regexes;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHeartbeatBody(input: HeartbeatInput): string {
  const deltaCount = input.transcriptDelta.length;
  const speakerCount = input.participation.observed;
  const expected = input.participation.expected;

  return `${deltaCount} new transcript ${deltaCount === 1 ? "line" : "lines"} since the last pulse. ${speakerCount} of ${expected} expected speakers have been heard.`;
}

function createCardId(timestamp: number, suffix: string): string {
  return `${timestamp}-${suffix}`;
}
