// Local Ollama provider for the AI Coach. Azure OpenAI stays the default. SMASHLAB_COACH_PROVIDER=ollama sends the same
// instructions and the same derived metrics to an Ollama server on this computer, through its OpenAI-compatible
// /v1/chat/completions endpoint. The base URL must be an address of this computer, so the analysis data never leaves
// it. No new package: the reply is written as an AI SDK UI message stream with the "ai" package the route already uses.
// Kept free of server-only imports so the rules can be tested directly.
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
// Created locally from qwen2.5:7b with num_ctx 8192 (docs/AI_COACH.md). The plain tag keeps Ollama's 2,048-token
// context and would cut the coach prompt (about 4,600 tokens) without a warning.
export const OLLAMA_DEFAULT_MODEL = "qwen2.5-7b-8k";

/** Addresses of this computer. host.docker.internal is Docker Desktop's name for the Mac that runs the containers. */
const THIS_COMPUTER = new Set(["127.0.0.1", "localhost", "[::1]", "host.docker.internal"]);
const ANSWER_ID = "coach-answer";

export type CoachProvider =
  | { kind: "azure" }
  | { kind: "ollama"; baseUrl: string; model: string };

export class CoachProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoachProviderError";
  }
}

/** Azure unless SMASHLAB_COACH_PROVIDER says ollama. Invalid settings throw instead of silently changing provider. */
export function resolveCoachProvider(env: Record<string, string | undefined>): CoachProvider {
  const name = (env.SMASHLAB_COACH_PROVIDER ?? "").trim().toLowerCase();
  if (name === "" || name === "azure") return { kind: "azure" };
  if (name !== "ollama") {
    throw new CoachProviderError(`SMASHLAB_COACH_PROVIDER must be "azure" or "ollama", not "${name}".`);
  }
  let url: URL;
  try {
    url = new URL(env.OLLAMA_BASE_URL?.trim() || OLLAMA_DEFAULT_BASE_URL);
  } catch {
    throw new CoachProviderError("OLLAMA_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "http:" || !THIS_COMPUTER.has(url.hostname)) {
    throw new CoachProviderError(
      "OLLAMA_BASE_URL must point to this computer (http://127.0.0.1, http://localhost, http://[::1] or http://host.docker.internal).",
    );
  }
  return { kind: "ollama", baseUrl: url.origin, model: env.OLLAMA_MODEL?.trim() || OLLAMA_DEFAULT_MODEL };
}

export type OllamaChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** The instructions, then the text of each conversation turn. Nothing else from the UI message is sent. */
export function ollamaChatMessages(instructions: string, messages: UIMessage[]): OllamaChatMessage[] {
  const turns: OllamaChatMessage[] = [];
  for (const message of messages) {
    const content = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
    if (content) turns.push({ role: message.role === "assistant" ? "assistant" : "user", content });
  }
  return [{ role: "system", content: instructions }, ...turns];
}

type EventLine = { text: string } | "end" | null;

function parseEventLine(raw: string): EventLine {
  const line = raw.trim();
  if (!line.startsWith("data:")) return null;
  const payload = line.slice("data:".length).trim();
  if (payload === "[DONE]") return "end";
  const event = JSON.parse(payload) as {
    error?: { message?: string };
    choices?: Array<{ delta?: { content?: unknown } }>;
  };
  if (event.error) throw new Error(event.error.message ?? "Ollama returned an error.");
  const content = event.choices?.[0]?.delta?.content;
  return typeof content === "string" && content.length > 0 ? { text: content } : null;
}

/** The text deltas of an OpenAI-compatible server-sent event stream, as they arrive. Lines may split across chunks. */
export async function* ollamaTextDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = parseEventLine(line);
        if (event === "end") return;
        if (event) yield event.text;
      }
    }
    buffer += decoder.decode();
    const last = parseEventLine(buffer);
    if (last && last !== "end") yield last.text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * The coach answer from a local Ollama server, as the same UI message stream the studio already reads from Azure.
 * Upstream errors are reported with the caller's message only; server details stay in the server log.
 */
export function ollamaCoachResponse(options: {
  provider: { baseUrl: string; model: string };
  instructions: string;
  messages: UIMessage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
  headers?: HeadersInit;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => string;
}): Response {
  const send = options.fetchImpl ?? fetch;
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const response = await send(`${options.provider.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: options.provider.model,
          messages: ollamaChatMessages(options.instructions, options.messages),
          stream: true,
          max_tokens: options.maxOutputTokens,
          temperature: 0.2,
        }),
        signal: options.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Ollama answered with HTTP ${response.status}.`);
      }
      writer.write({ type: "start" });
      writer.write({ type: "text-start", id: ANSWER_ID });
      for await (const text of ollamaTextDeltas(response.body)) {
        writer.write({ type: "text-delta", id: ANSWER_ID, delta: text });
      }
      writer.write({ type: "text-end", id: ANSWER_ID });
      writer.write({ type: "finish" });
    },
    onError: options.onError ?? (() => "The local AI Coach is unavailable."),
  });
  return createUIMessageStreamResponse({ stream, headers: options.headers });
}
