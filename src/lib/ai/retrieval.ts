import type { AnalysisSnapshot } from "../analysis-types.ts";
import {
  BADMINTON_KNOWLEDGE,
  type KnowledgeChunk,
} from "./badminton-knowledge.ts";
import type { StudioLanguage } from "../studio-types.ts";

const STOP_WORDS = new Set([
  "ai", "anh", "ban", "bang", "bi", "cai", "cho", "co", "cua", "da",
  "day", "de", "duoc", "gi", "hay", "hien", "khong", "la", "lam", "mot",
  "nay", "nhung", "o", "phan", "sao", "the", "thi", "toi", "trong", "tu",
  "va", "voi",
  "a", "an", "and", "are", "can", "does", "for", "from", "how", "in", "is",
  "my", "of", "on", "or", "the", "this", "to", "what", "with",
  "aber", "als", "am", "auf", "aus", "bei", "das", "dein", "der", "die", "ein",
  "eine", "einer", "fur", "hat", "ich", "im", "ist", "mein", "mit", "nicht", "oder",
  "sich", "und", "von", "was", "wie", "zu",
]);

const SYNONYMS: Record<string, string[]> = {
  smash: ["dap", "dapcau", "overhead"],
  schmetterschlag: ["smash", "overhead", "dapcau"],
  dap: ["smash", "dapcau"],
  drop: ["dropshot", "bonho", "bocau"],
  dropshot: ["drop", "bonho", "bocau"],
  clear: ["phong", "phongcau", "lob"],
  phong: ["clear", "phongcau", "lob"],
  drive: ["tat", "tatcau", "phantat"],
  tat: ["drive", "tatcau", "phantat"],
  backhand: ["traitay", "trai tay", "matngoai"],
  ruckhand: ["backhand", "traitay", "matngoai"],
  traitay: ["backhand", "matngoai"],
  hoivi: ["recovery", "thangbang"],
  ruckkehr: ["recovery", "hoivi", "thangbang"],
  xoaythan: ["rotation", "thannguoi"],
  bophap: ["footwork", "splitstep", "chasse", "lunge", "recovery"],
  footwork: ["bophap", "splitstep", "chasse", "lunge", "recovery"],
  beinarbeit: ["footwork", "bophap", "splitstep", "chasse", "lunge", "recovery"],
  lauftechnik: ["footwork", "beinarbeit", "splitstep", "chasse", "lunge"],
  splitstep: ["bophap", "footwork", "buoctach"],
  chasse: ["bophap", "footwork", "buocduoi"],
  lunge: ["bophap", "footwork", "buocchung"],
  ausfallschritt: ["lunge", "footwork", "bophap", "buocchung"],
  tiepdat: ["landing", "thangbang", "footwork"],
  landung: ["landing", "tiepdat", "thangbang", "footwork"],
  tocdo: ["kmh", "speed", "van tốc"],
  kmh: ["tocdo", "speed"],
  quydao: ["duongcau", "diemroi", "tracking"],
  flugbahn: ["quydao", "duongcau", "tracking"],
  treffpunkt: ["tiep xuc", "contact", "racket"],
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
  if (/kmh|speed|geschwindigkeit|toc do|quy dao|flugbahn|diem roi|landepunkt|cheo|thang|tiep xuc|treffpunkt/.test(normalizedQuery) && chunk.id === "motion-limitations") score += 12;
  if (/accuracy|genauigkeit|zuverlassigkeit|bang chung|tin cay|evidence|diem chuyen dong|bewegungsscore/.test(normalizedQuery) && chunk.id === "motion-evidence") score += 10;
  if (/footwork|beinarbeit|lauftechnik|bo phap|split step|chasse|lunge|ausfallschritt|hoi vi|ruckkehr|tiep dat|landung/.test(normalizedQuery) && chunk.id === "bwf-footwork-components") score += 10;
  return score;
}

export function buildRetrievalQuery(question: string, snapshot: AnalysisSnapshot) {
  const strokeContext = snapshot.movements.slice(-12).map((movement) =>
    `${movement.module} ${movement.label} ${movement.technique} ${movement.summary} ${movement.corrections.join(" ")}`,
  ).join(" ");
  return `${question} ${snapshot.trainingModule} ${snapshot.drillMode} ${strokeContext}`.trim();
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

const CONTEXT_COPY: Record<StudioLanguage, {
  empty: string;
  exactUrl: string;
  exactTitle: string;
  publisher: string;
}> = {
  en: {
    empty: "No relevant knowledge passage was found. Do not infer beyond the session data.",
    exactUrl: "Exact URL",
    exactTitle: "Exact source title",
    publisher: "Publisher",
  },
  de: {
    empty: "Es wurde kein passender Wissensabschnitt gefunden. Ziehe keine Schlüsse über die Einheitsdaten hinaus.",
    exactUrl: "Exakte URL",
    exactTitle: "Exakter Quellentitel",
    publisher: "Herausgeber",
  },
  vi: {
    empty: "Không tìm thấy đoạn kiến thức phù hợp. Không suy diễn thêm ngoài dữ liệu phiên.",
    exactUrl: "URL chính xác",
    exactTitle: "Tiêu đề nguồn chính xác",
    publisher: "Đơn vị",
  },
};

export function formatKnowledgeContext(chunks: RetrievedKnowledge[], language: StudioLanguage = "vi") {
  const copy = CONTEXT_COPY[language];
  if (!chunks.length) return copy.empty;
  return chunks.map((chunk) => {
    const url = chunk.source.url ? `\n${copy.exactUrl}: ${chunk.source.url}` : "";
    return `[${chunk.citation}] ${chunk.title}\n${chunk.content}\n${copy.exactTitle}: ${chunk.source.title}\n${copy.publisher}: ${chunk.source.publisher}${url}`;
  }).join("\n\n");
}
