import {
  convertToModelMessages,
  streamText,
  type UIMessage,
} from "ai";
import { z } from "zod";
import {
  AiConfigurationError,
  getAzureChatModel,
  getChatMaxOutputTokens,
} from "@/lib/ai/azure-openai";
import { buildAnalysisInstructions } from "@/lib/ai/analysis-instructions";
import {
  buildRetrievalQuery,
  retrieveKnowledge,
} from "@/lib/ai/retrieval";
import { checkAiRateLimit, rateLimitHeaders } from "@/lib/ai/rate-limit";
import type { StudioLanguage } from "@/lib/studio-types";

export const maxDuration = 30;
export const runtime = "nodejs";

const phaseSchema = z.object({
  phase: z.enum(["ready", "loading", "acceleration", "contact_zone", "follow_through", "start", "approach", "hit_balance", "recovery"]),
  score: z.number().min(0).max(100),
  status: z.enum(["good", "review", "missing"]),
});

const movementSchema = z.object({
  index: z.number().int().min(1).max(10_000),
  recordedAt: z.string().max(64),
  // Keep the API compatible with tabs opened before the footwork deployment.
  // Those clients did not send `module`, so their movements are stroke data.
  module: z.enum(["stroke", "footwork"]).default("stroke"),
  technique: z.enum(["smash", "backhand", "drop_shot", "clear", "drive", "overhead_control", "unknown", "split_step", "running_step", "chasse", "cross_behind", "hop_pivot", "lunge", "jump_landing", "scissor_jump", "china_jump", "forehand_forecourt", "backhand_forecourt", "forehand_rearcourt", "backhand_rearcourt", "recovery_to_base", "six_corner_shadow", "footwork_unknown"]),
  label: z.string().trim().max(120),
  evidence: z.number().min(0).max(100),
  overallScore: z.number().min(0).max(100),
  postureScore: z.number().min(0).max(100),
  rhythmScore: z.number().min(0).max(100),
  recoveryScore: z.number().min(0).max(100),
  captureQuality: z.number().min(0).max(100),
  intensity: z.number().min(0).max(100),
  dominantSide: z.enum(["left", "right"]),
  durationMs: z.number().min(0).max(5_000),
  phases: z.array(phaseSchema).max(6),
  metrics: z.object({
    elbowAngle: z.number().min(0).max(220),
    shoulderAngle: z.number().min(0).max(220),
    kneeFlexion: z.number().min(0).max(180),
    trunkRotation: z.number().min(0).max(180),
    contactHeight: z.number().min(0).max(100),
    bodyExtension: z.number().min(0).max(100),
    wristSpeed: z.number().min(0).max(10),
    armAngularSpeed: z.number().min(0).max(3_000),
    balance: z.number().min(0).max(100),
    footSpeed: z.number().min(0).max(20).optional(),
    centerSpeed: z.number().min(0).max(20).optional(),
    stanceWidth: z.number().min(0).max(4).optional(),
    landingSymmetry: z.number().min(0).max(100).optional(),
    travel: z.number().min(0).max(20).optional(),
    verticalBounce: z.number().min(0).max(20).optional(),
    alternation: z.number().min(0).max(100).optional(),
  }),
  strengths: z.array(z.string().trim().max(240)).max(3),
  corrections: z.array(z.string().trim().max(280)).max(4),
  summary: z.string().trim().max(480),
});

const analysisSchema = z.object({
  source: z.enum(["none", "demo", "live", "history"]),
  capturedAt: z.string().max(64),
  // A Vercel alias can switch to a new deployment while an older client bundle
  // is still open. Defaulting this field prevents that stale tab from failing.
  trainingModule: z.enum(["stroke", "footwork"]).default("stroke"),
  drillMode: z.enum(["open", "smash", "backhand", "clear", "drop_shot", "drive", "footwork_auto", "split_step", "running_step", "chasse", "cross_behind", "hop_pivot", "lunge", "jump_landing", "scissor_jump", "china_jump", "forehand_forecourt", "backhand_forecourt", "forehand_rearcourt", "backhand_rearcourt", "recovery_to_base", "six_corner_shadow"]),
  preferredHand: z.enum(["auto", "left", "right"]),
  movements: z.array(movementSchema).max(40),
  summary: z.object({
    headline: z.string().trim().max(240),
    insight: z.string().trim().max(800),
    averageScore: z.number().min(0).max(100),
    consistency: z.number().min(0).max(100),
    strongestPhase: z.string().trim().max(120),
    priority: z.string().trim().max(360),
  }).nullable(),
});

const requestSchema = z.object({
  language: z.enum(["en", "de", "vi"]).default("en"),
  messages: z.array(z.object({
    id: z.string().max(180),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.unknown()).max(12),
  })).min(1).max(30),
  analysis: analysisSchema,
});

const API_COPY: Record<StudioLanguage, {
  invalidOrigin: string;
  rateLimited: string;
  payloadTooLarge: string;
  emptyRequest: string;
  aiUnavailable: string;
  invalidRequest: string;
  notConfigured: string;
  connectionFailed: string;
}> = {
  en: {
    invalidOrigin: "Invalid request origin.",
    rateLimited: "Too many requests. Please try again in a few minutes.",
    payloadTooLarge: "The chat request is too large.",
    emptyRequest: "The request is empty.",
    aiUnavailable: "The AI Coach is temporarily unavailable. Please try again.",
    invalidRequest: "The chat or analysis data is invalid.",
    notConfigured: "The Azure AI Coach is not configured or is temporarily disabled.",
    connectionFailed: "Could not connect to the Azure AI Coach.",
  },
  de: {
    invalidOrigin: "Ungültiger Ursprung der Anfrage.",
    rateLimited: "Zu viele Anfragen. Bitte versuche es in einigen Minuten erneut.",
    payloadTooLarge: "Die Chat-Anfrage ist zu groß.",
    emptyRequest: "Die Anfrage ist leer.",
    aiUnavailable: "AI Coach ist vorübergehend nicht verfügbar. Bitte versuche es erneut.",
    invalidRequest: "Die Chat- oder Analysedaten sind ungültig.",
    notConfigured: "Azure AI Coach ist nicht konfiguriert oder vorübergehend deaktiviert.",
    connectionFailed: "Die Verbindung zu Azure AI Coach konnte nicht hergestellt werden.",
  },
  vi: {
    invalidOrigin: "Nguồn yêu cầu không hợp lệ.",
    rateLimited: "Bạn đã gửi quá nhiều yêu cầu. Hãy thử lại sau vài phút.",
    payloadTooLarge: "Dữ liệu trò chuyện quá lớn.",
    emptyRequest: "Nội dung yêu cầu đang trống.",
    aiUnavailable: "AI Coach tạm thời không phản hồi. Vui lòng thử lại.",
    invalidRequest: "Dữ liệu trò chuyện hoặc phân tích không hợp lệ.",
    notConfigured: "Azure AI Coach chưa được cấu hình hoặc đang tạm tắt.",
    connectionFailed: "Không thể kết nối với Azure AI Coach.",
  },
};

function requestLanguage(request: Request): StudioLanguage {
  const value = request.headers.get("x-smashlab-language");
  return value === "de" || value === "vi" ? value : "en";
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return process.env.NODE_ENV !== "production";
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sanitizeMessages(messages: z.infer<typeof requestSchema>["messages"]) {
  let totalCharacters = 0;
  return messages.slice(-8).flatMap((message) => {
    const text = message.parts.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as Record<string, unknown>;
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text.trim().slice(0, 3_000)]
        : [];
    }).join("\n").trim();

    if (!text || totalCharacters >= 10_000) return [];
    const limitedText = text.slice(0, 10_000 - totalCharacters);
    totalCharacters += limitedText.length;
    return [{
      id: message.id,
      role: message.role,
      parts: [{ type: "text" as const, text: limitedText }],
    }];
  }) satisfies UIMessage[];
}

function latestUserQuestion(messages: UIMessage[]) {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  if (!latest) return "";
  return latest.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ");
}

export async function POST(request: Request) {
  const language = requestLanguage(request);
  const copy = API_COPY[language];
  try {
    if (!sameOrigin(request)) {
      return Response.json({ message: copy.invalidOrigin }, { status: 403 });
    }
    const rateLimit = await checkAiRateLimit(request);
    if (!rateLimit.allowed) {
      return Response.json(
        { message: copy.rateLimited },
        { status: 429, headers: rateLimitHeaders(rateLimit) },
      );
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 80_000) {
      return Response.json({ message: copy.payloadTooLarge }, { status: 413 });
    }

    const body = requestSchema.parse(await request.json());
    const messages = sanitizeMessages(body.messages);
    if (!messages.length) {
      return Response.json({ message: copy.emptyRequest }, { status: 400 });
    }
    const retrievalQuery = buildRetrievalQuery(latestUserQuestion(messages), body.analysis);
    const knowledge = retrieveKnowledge(retrievalQuery);

    const result = streamText({
      model: getAzureChatModel(),
      instructions: buildAnalysisInstructions(body.analysis, knowledge, body.language),
      messages: await convertToModelMessages(messages),
      maxOutputTokens: getChatMaxOutputTokens(),
    });

    return result.toUIMessageStreamResponse({
      headers: { "Cache-Control": "no-store", ...rateLimitHeaders(rateLimit) },
      onError: (error) => {
        console.error("SmashLab Azure chat failed", error);
        return API_COPY[body.language].aiUnavailable;
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.warn("SmashLab AI request validation failed", {
        issues: error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join("."),
        })),
      });
      return Response.json({ message: copy.invalidRequest }, { status: 400 });
    }
    if (error instanceof AiConfigurationError) {
      return Response.json({ message: copy.notConfigured }, { status: 503 });
    }
    console.error("SmashLab AI route failed", error);
    return Response.json({ message: copy.connectionFailed }, { status: 500 });
  }
}
