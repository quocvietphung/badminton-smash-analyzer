import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import {
  CoachProviderError,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  ollamaChatMessages,
  ollamaCoachResponse,
  ollamaTextDeltas,
  resolveCoachProvider,
} from "../src/lib/ai/coach-provider.ts";

function bodyOf(pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

function splitEvery(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += size) pieces.push(text.slice(index, index + size));
  return pieces;
}

const deltaEvent = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const items: string[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

const question = [
  { id: "q1", role: "user", parts: [{ type: "text", text: "Ai di chuyển nhiều hơn?" }] },
] as unknown as UIMessage[];

test("Azure stays the default; Ollama is chosen only by its variable", () => {
  assert.deepEqual(resolveCoachProvider({}), { kind: "azure" });
  assert.deepEqual(resolveCoachProvider({ SMASHLAB_COACH_PROVIDER: " Azure " }), { kind: "azure" });
  assert.deepEqual(resolveCoachProvider({ SMASHLAB_COACH_PROVIDER: "ollama" }), {
    kind: "ollama",
    baseUrl: OLLAMA_DEFAULT_BASE_URL,
    model: OLLAMA_DEFAULT_MODEL,
  });
  assert.deepEqual(
    resolveCoachProvider({
      SMASHLAB_COACH_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://localhost:11500/",
      OLLAMA_MODEL: "qwen2.5:3b",
    }),
    { kind: "ollama", baseUrl: "http://localhost:11500", model: "qwen2.5:3b" },
  );
  assert.deepEqual(
    resolveCoachProvider({ SMASHLAB_COACH_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://host.docker.internal:11434" }),
    { kind: "ollama", baseUrl: "http://host.docker.internal:11434", model: OLLAMA_DEFAULT_MODEL },
  );
});

test("the analysis data can only go to this computer", () => {
  const refused = [
    "http://10.0.0.5:11434",
    "https://127.0.0.1:11434",
    "https://ollama.example.com",
    "http://[::ffff:10.0.0.5]:11434",
    "not a url",
  ];
  for (const base of refused) {
    assert.throws(
      () => resolveCoachProvider({ SMASHLAB_COACH_PROVIDER: "ollama", OLLAMA_BASE_URL: base }),
      CoachProviderError,
      base,
    );
  }
  assert.throws(() => resolveCoachProvider({ SMASHLAB_COACH_PROVIDER: "openai" }), CoachProviderError);
});

test("the prompt is the instructions plus the text of each turn, nothing else", () => {
  const turns = [
    { id: "1", role: "user", parts: [{ type: "text", text: "Ai di chuyển nhiều hơn?" }] },
    { id: "2", role: "assistant", parts: [{ type: "text", text: "P2." }] },
    { id: "3", role: "user", parts: [] },
  ] as unknown as UIMessage[];
  assert.deepEqual(ollamaChatMessages("Chỉ dùng dữ liệu.", turns), [
    { role: "system", content: "Chỉ dùng dữ liệu." },
    { role: "user", content: "Ai di chuyển nhiều hơn?" },
    { role: "assistant", content: "P2." },
  ]);
});

test("text deltas are read across chunk boundaries, and the end marker stops the stream", async () => {
  const text = deltaEvent("Xin ") + deltaEvent("chào") + "data: [DONE]\n\n" + deltaEvent("bị bỏ qua");
  assert.deepEqual(await collect(ollamaTextDeltas(bodyOf(splitEvery(text, 17)))), ["Xin ", "chào"]);
});

test("an error event from the server is raised with its message", async () => {
  const text = `data: ${JSON.stringify({ error: { message: "model not found" } })}\n\n`;
  await assert.rejects(collect(ollamaTextDeltas(bodyOf([text]))), /model not found/);
});

test("the answer is streamed as a UI message stream; an upstream error shows only the caller's message", async () => {
  const seen: Array<{ url: string; body: { stream: boolean; model: string; messages: Array<{ role: string }> } }> = [];
  const working = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const text = deltaEvent("Quả cầu ") + deltaEvent("đi nhanh.") + "data: [DONE]\n\n";
    return new Response(bodyOf(splitEvery(text, 23)), { status: 200 });
  }) as typeof fetch;

  const streamed = await ollamaCoachResponse({
    provider: { baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" },
    instructions: "Chỉ dùng dữ liệu được cung cấp.",
    messages: question,
    maxOutputTokens: 480,
    fetchImpl: working,
  }).text();

  assert.equal(seen[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(seen[0].body.stream, true);
  assert.equal(seen[0].body.model, "qwen2.5:7b");
  assert.deepEqual(seen[0].body.messages.map((message) => message.role), ["system", "user"]);
  assert.match(streamed, /"type":"start"/);
  assert.match(streamed, /"type":"text-start"/);
  assert.match(streamed, /"delta":"Quả cầu "/);
  assert.match(streamed, /"delta":"đi nhanh\."/);
  assert.match(streamed, /"type":"text-end"/);
  assert.match(streamed, /"type":"finish"/);

  const failing = (async () => new Response("internal upstream detail", { status: 500 })) as typeof fetch;
  const failed = await ollamaCoachResponse({
    provider: { baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" },
    instructions: "Chỉ dùng dữ liệu được cung cấp.",
    messages: question,
    maxOutputTokens: 480,
    fetchImpl: failing,
    onError: () => "AI Coach tạm thời không phản hồi.",
  }).text();
  assert.match(failed, /"errorText":"AI Coach tạm thời không phản hồi\."/);
  assert.doesNotMatch(failed, /upstream detail|HTTP 500/);
});

test("a local Ollama answers the coach prompt (runs only when the server and the model are present)", { timeout: 300_000 }, async (t) => {
  const base = process.env.OLLAMA_BASE_URL?.trim() || OLLAMA_DEFAULT_BASE_URL;
  const model = process.env.OLLAMA_MODEL?.trim() || OLLAMA_DEFAULT_MODEL;
  let installed: Array<{ name: string }> = [];
  try {
    const tags = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    installed = ((await tags.json()) as { models?: Array<{ name: string }> }).models ?? [];
  } catch {
    t.skip(`no Ollama server answers at ${base}; start it as described in docs/AI_COACH.md to run this check`);
    return;
  }
  if (!installed.some((item) => item.name === model || item.name === `${model}:latest`)) {
    t.skip(`Ollama answers at ${base}, but the model ${model} is not pulled yet`);
    return;
  }
  const streamed = await ollamaCoachResponse({
    provider: { baseUrl: base, model },
    instructions: "Trả lời bằng tiếng Việt, một câu ngắn.",
    messages: question,
    maxOutputTokens: 60,
  }).text();
  const answer = [...streamed.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`) as string)
    .join("");
  assert.ok(answer.trim().length > 0, "the local model returned no text");
});
