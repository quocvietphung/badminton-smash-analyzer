import type { AnalysisSnapshot } from "../analysis-types.ts";
import {
  BADMINTON_KNOWLEDGE,
  type KnowledgeChunk,
} from "./badminton-knowledge.ts";

const STOP_WORDS = new Set([
  "ai", "anh", "ban", "bang", "bi", "cai", "cho", "co", "cua", "da",
  "day", "de", "duoc", "gi", "hay", "hien", "khong", "la", "lam", "mot",
  "nay", "nhung", "o", "phan", "sao", "the", "thi", "toi", "trong", "tu",
  "va", "voi",
]);

const SYNONYMS: Record<string, string[]> = {
  smash: ["dap", "dapcau", "overhead"],
  dap: ["smash", "dapcau"],
  drop: ["dropshot", "bonho", "bocau"],
  dropshot: ["drop", "bonho", "bocau"],
  clear: ["phong", "phongcau", "lob"],
  phong: ["clear", "phongcau", "lob"],
  drive: ["tat", "tatcau", "phantat"],
  tat: ["drive", "tatcau", "phantat"],
  tocdo: ["kmh", "speed", "van tốc"],
  kmh: ["tocdo", "speed"],
  quydao: ["duongcau", "diemroi", "tracking"],
  chienthuat: ["rally", "dieucau", "chuoi"],
  tincay: ["evidence", "accuracy", "bangchung"],
  dotincay: ["evidence", "accuracy", "bangchung"],
};

export type RetrievedKnowledge = KnowledgeChunk & { score: number; citation: string };

export function normalizeSearchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/km\s*\/\s*h/g, "kmh")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokensFor(value: string) {
  const base = normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  const joined = base.join("");
  const expanded = new Set(base);
  if (joined) expanded.add(joined);
  [...base, joined].forEach((token) => SYNONYMS[token]?.forEach((synonym) => expanded.add(normalizeSearchText(synonym).replace(/\s/g, ""))));
  return [...expanded];
}

function scoreChunk(chunk: KnowledgeChunk, queryTokens: string[], normalizedQuery: string) {
  const title = normalizeSearchText(chunk.title);
  const tags = normalizeSearchText(chunk.tags.join(" "));
  const content = normalizeSearchText(chunk.content);
  let score = 0;

  for (const token of queryTokens) {
    if (title.includes(token)) score += 5;
    if (tags.includes(token)) score += 4;
    if (content.includes(token)) score += 1.4;
  }

  if (normalizedQuery.length > 7 && title.includes(normalizedQuery)) score += 8;
  if (/kmh|toc do|quy dao|diem roi|cheo|thang/.test(normalizedQuery) && chunk.id === "pose-lite-unavailable-measurements") score += 12;
  if (/accuracy|bang chung|tin cay|evidence/.test(normalizedQuery) && chunk.id === "pose-lite-evidence") score += 10;
  return score;
}

export function buildRetrievalQuery(question: string, snapshot: AnalysisSnapshot) {
  const strokeContext = snapshot.strokes.slice(-12).map((stroke) =>
    `${stroke.label} ${stroke.strokeType} ${stroke.certainty} ${stroke.reason}`,
  ).join(" ");
  return `${question} ${strokeContext}`.trim();
}

export function retrieveKnowledge(query: string, limit = 4): RetrievedKnowledge[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokensFor(query);
  const ranked = BADMINTON_KNOWLEDGE
    .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, queryTokens, normalizedQuery) }))
    .filter((chunk) => chunk.score >= 2.5)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, Math.min(limit, 5)));

  return ranked.map((chunk, index) => ({ ...chunk, citation: `K${index + 1}` }));
}

export function formatKnowledgeContext(chunks: RetrievedKnowledge[]) {
  if (!chunks.length) return "Không tìm thấy đoạn kiến thức phù hợp. Không suy diễn thêm ngoài dữ liệu phiên.";
  return chunks.map((chunk) => {
    const url = chunk.source.url ? `\nURL chính xác: ${chunk.source.url}` : "";
    return `[${chunk.citation}] ${chunk.title}\n${chunk.content}\nTiêu đề nguồn chính xác: ${chunk.source.title}\nĐơn vị: ${chunk.source.publisher}${url}`;
  }).join("\n\n");
}
