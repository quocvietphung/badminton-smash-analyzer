// Number check for Coach answers. Every number in an answer should come from the analysis (the coach dataset and the
// snapshot), from the question the person typed, or from the badminton knowledge base. A number found in none of them
// is listed as "not found in the data", so a reader can see what the model may have invented. A number followed by a
// physical speed unit (km/h, m/s, mph) is flagged on its own: this build never measures physical shuttle speed.
// The check is deterministic and runs in the browser after an answer is complete.

export type NumberSource = "analysis" | "question" | "knowledge";

export type KnownNumbers = { values: Map<NumberSource, number[]> };

export type NumberFinding = { text: string; context: string };

export type NumberCheckResult = {
  status: "ok" | "warning" | "empty";
  checked: number;
  matched: number;
  matchedBy: Record<NumberSource, number>;
  unmatched: NumberFinding[];
  physicalSpeeds: NumberFinding[];
};

const PHYSICAL_SPEED = /(\d+(?:[.,]\d+)?)\s*(km\/h|kmh|kph|mph|m\/s)(?![a-z])/gi;
const URL = /https?:\/\/\S+/g;
const NUMBER = /(?<![\p{L}\p{N}_.,/-])(\d+(?:[.,]\d+)*)(\s?%)?(?![\p{L}\p{N}_])/gu;
const LIST_MARKER = /^\s*\d+[.)]\s/;

function walk(value: unknown, out: number[], depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.push(value);
    return;
  }
  if (typeof value === "string") {
    numbersInText(value).forEach((item) => out.push(...item.values));
    return;
  }
  if (Array.isArray(value)) {
    out.push(value.length);
    value.forEach((item) => walk(item, out, depth + 1));
    return;
  }
  if (typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) => walk(item, out, depth + 1));
  }
}

/** Shares (0 to 1) also count as percentages, and the P1/P2 difference of each player value counts as known. */
function derived(values: number[], players: Record<string, unknown> | null): number[] {
  const out = [...values];
  for (const value of values) {
    if (value > 0 && value <= 1) out.push(value * 100);
  }
  if (players) {
    const [first, second] = Object.values(players);
    const left: number[] = [];
    const right: number[] = [];
    walkPaired(first, second, left, right);
    left.forEach((value, index) => {
      out.push(Math.abs(value - right[index]));
      out.push(value + right[index]);
    });
  }
  return out;
}

function walkPaired(a: unknown, b: unknown, left: number[], right: number[], depth = 0): void {
  if (depth > 6 || a === null || b === null || a === undefined || b === undefined) return;
  if (typeof a === "number" && typeof b === "number") {
    left.push(a);
    right.push(b);
    return;
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of Object.keys(a as object)) {
      walkPaired((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], left, right, depth + 1);
    }
  }
}

/** Collects the numbers each source supplies. Analysis sources are JSON values; question and knowledge are text. */
export function collectKnownNumbers(sources: { analysis?: unknown[]; question?: string[]; knowledge?: string[] }): KnownNumbers {
  const analysis: number[] = [];
  let players: Record<string, unknown> | null = null;
  for (const item of sources.analysis ?? []) {
    walk(item, analysis);
    if (item && typeof item === "object" && "players" in (item as object)) {
      const candidate = (item as { players?: unknown }).players;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) players = candidate as Record<string, unknown>;
    }
  }
  const fromText = (texts: string[] | undefined) => (texts ?? []).flatMap((text) => numbersInText(text).flatMap((item) => item.values));
  return {
    values: new Map<NumberSource, number[]>([
      ["analysis", derived(analysis, players)],
      ["question", fromText(sources.question)],
      ["knowledge", fromText(sources.knowledge)],
    ]),
  };
}

type Token = { text: string; values: number[]; decimals: number; percent: boolean; index: number };

/** Each number of a text with its possible values: "1.267" may be 1.267 or 1267, "27,55" is 27.55. */
export function numbersInText(text: string): Token[] {
  const tokens: Token[] = [];
  const clean = text.replace(URL, (url) => " ".repeat(url.length));
  const lines = clean.split("\n");
  let offset = 0;
  for (const raw of lines) {
    // A list marker ("1. ", "2) ") is numbering, not a value: its digits become spaces so the indices stay the same.
    const lineText = raw.replace(LIST_MARKER, (marker) => marker.replace(/\d/g, " "));
    for (const match of lineText.matchAll(NUMBER)) {
      const body = match[1];
      const values = interpretations(body);
      if (!values.length) continue;
      const decimals = Math.min(...values.map((value) => decimalsOf(body, value)));
      tokens.push({ text: match[0].trim(), values, decimals, percent: Boolean(match[2]), index: offset + (match.index ?? 0) });
    }
    offset += raw.length + 1;
  }
  return tokens;
}

function interpretations(body: string): number[] {
  const separators = body.match(/[.,]/g) ?? [];
  if (!separators.length) return [Number(body)];
  const lastSep = Math.max(body.lastIndexOf("."), body.lastIndexOf(","));
  const kinds = new Set(separators);
  if (kinds.size === 2) {
    const decimal = body.charAt(lastSep);
    const thousands = decimal === "." ? "," : ".";
    return [Number(body.split(thousands).join("").replace(decimal, "."))];
  }
  const groups = body.split(separators[0] ?? ".");
  const out: number[] = [];
  const asThousands = groups.slice(1).every((group) => group.length === 3) && (groups[0] ?? "").length <= 3;
  if (asThousands) out.push(Number(groups.join("")));
  if (groups.length === 2) out.push(Number(`${groups[0]}.${groups[1]}`));
  return out.filter((value) => Number.isFinite(value));
}

function decimalsOf(body: string, value: number): number {
  if (Number.isInteger(value)) return 0;
  const lastSep = Math.max(body.lastIndexOf("."), body.lastIndexOf(","));
  return lastSep >= 0 ? body.length - lastSep - 1 : 0;
}

function matches(token: Token, known: number[]): boolean {
  const tolerance = 0.5 * 10 ** -token.decimals + 1e-9;
  for (const value of token.values) {
    for (const item of known) {
      if (Math.abs(item - value) <= tolerance) return true;
      if (token.percent && Math.abs(item * 100 - value) <= tolerance) return true;
    }
  }
  return false;
}

/** Small counts (0 to 3) and calendar years are too generic to check. */
function generic(token: Token): boolean {
  return token.values.every((value) => (Number.isInteger(value) && value <= 3) || (Number.isInteger(value) && value >= 1900 && value <= 2100));
}

function context(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

export function checkAnswerNumbers(answer: string, known: KnownNumbers): NumberCheckResult {
  const matchedBy: Record<NumberSource, number> = { analysis: 0, question: 0, knowledge: 0 };
  const unmatched: NumberFinding[] = [];
  const physicalSpeeds: NumberFinding[] = [];
  for (const match of answer.replace(URL, (url) => " ".repeat(url.length)).matchAll(PHYSICAL_SPEED)) {
    physicalSpeeds.push({ text: match[0].trim(), context: context(answer, match.index ?? 0, match[0].length) });
  }
  let checked = 0;
  for (const token of numbersInText(answer)) {
    if (generic(token)) continue;
    checked += 1;
    const source = (["analysis", "question", "knowledge"] as const).find((name) => matches(token, known.values.get(name) ?? []));
    if (source) matchedBy[source] += 1;
    else unmatched.push({ text: token.text, context: context(answer, token.index, token.text.length) });
  }
  const matched = matchedBy.analysis + matchedBy.question + matchedBy.knowledge;
  const status = checked === 0 && physicalSpeeds.length === 0 ? "empty" : unmatched.length || physicalSpeeds.length ? "warning" : "ok";
  return { status, checked, matched, matchedBy, unmatched, physicalSpeeds };
}
