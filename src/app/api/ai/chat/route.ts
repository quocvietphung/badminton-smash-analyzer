import {
  convertToModelMessages,
  streamText,
  type UIMessage,
} from "ai";
import { z } from "zod";
import {
  AiConfigurationError,
  getChatMaxOutputTokens,
} from "@/lib/ai/azure-openai";
import { getChatModel } from "@/lib/ai/chat-model";
import {
  CoachProviderError,
  coachTextResponse,
  ollamaCoachResponse,
  resolveCoachProvider,
} from "@/lib/ai/coach-provider";
import { buildAnalysisInstructions } from "@/lib/ai/analysis-instructions";
import { physicalSpeedFacts, physicalSpeedReply } from "@/lib/ai/physical-speed-answer";
import {
  buildRetrievalQuery,
  retrieveKnowledge,
} from "@/lib/ai/retrieval";
import { checkAiRateLimit, rateLimitHeaders } from "@/lib/ai/rate-limit";
import { requireSiteSession } from "@/lib/server/site-access";
import type { StudioLanguage } from "@/lib/studio-types";
import { videoAnalysisSchema } from "@/lib/video-analysis";

export const maxDuration = 30;
export const runtime = "nodejs";

const requestSchema = z.object({
  language: z.enum(["en", "de", "vi"]).default("en"),
  messages: z.array(z.object({
    id: z.string().max(180),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.unknown()).max(12),
  })).min(1).max(30),
  // Reduced, derived video-analysis results only. The client never sends frames or video.
  analysis: videoAnalysisSchema,
  // The coach-dataset/v1 document of this analysis, from the studio server. Bounded; the model never sees video.
  coachDataset: z.record(z.string(), z.unknown()).nullable().optional(),
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
  signInExpired: string;
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
    signInExpired: "The AI Coach sign-in on this computer has expired. Refresh it and try again.",
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
    signInExpired: "Die Anmeldung des AI Coach auf diesem Rechner ist abgelaufen. Bitte erneuern und erneut versuchen.",
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
    signInExpired: "Phiên đăng nhập AI Coach trên máy này đã hết hạn. Hãy làm mới rồi thử lại.",
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
  const signedOut = await requireSiteSession(request);
  if (signedOut) return signedOut;
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
    // A shuttle km/h or m/s question while the analysis has no physical speed: the answer is written from the data,
    // within the rule of two sentences, and the model is not called (physical-speed-answer.ts).
    const physicalReply = physicalSpeedReply({
      question: latestUserQuestion(messages),
      analysisSelected: body.analysis.source !== "none",
      status: body.analysis.physicalSpeed.status,
      language: body.language,
      facts: physicalSpeedFacts(body.coachDataset ?? null),
    });
    if (physicalReply !== null) {
      return coachTextResponse({
        text: physicalReply,
        headers: { "Cache-Control": "no-store", ...rateLimitHeaders(rateLimit) },
      });
    }
    const retrievalQuery = buildRetrievalQuery(latestUserQuestion(messages), body.analysis);
    const knowledge = retrieveKnowledge(retrievalQuery);
    const instructions = buildAnalysisInstructions(body.analysis, knowledge, body.language, body.coachDataset ?? null);

    const provider = resolveCoachProvider(process.env);
    if (provider.kind === "ollama") {
      // A model on this computer, with the same instructions and derived data. Azure is not called in this mode.
      if (process.env.AI_ASSISTANT_ENABLED === "false") {
        return Response.json({ message: copy.aiUnavailable }, { status: 503 });
      }
      return ollamaCoachResponse({
        provider,
        instructions,
        messages,
        maxOutputTokens: getChatMaxOutputTokens(),
        signal: request.signal,
        headers: { "Cache-Control": "no-store", ...rateLimitHeaders(rateLimit) },
        onError: (error) => {
          console.error("SmashLab local AI chat failed", error);
          return API_COPY[body.language].aiUnavailable;
        },
      });
    }

    const result = streamText({
      model: await getChatModel(),
      instructions,
      messages: await convertToModelMessages(messages),
      maxOutputTokens: getChatMaxOutputTokens(),
    });

    return result.toUIMessageStreamResponse({
      headers: { "Cache-Control": "no-store", ...rateLimitHeaders(rateLimit) },
      onError: (error) => {
        console.error("SmashLab AI chat failed", error);
        if (error instanceof AiConfigurationError && /expired/i.test(error.message)) {
          return API_COPY[body.language].signInExpired;
        }
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
    if (error instanceof CoachProviderError) {
      console.error("SmashLab AI provider settings are invalid:", error.message);
      return Response.json({ message: copy.aiUnavailable }, { status: 503 });
    }
    console.error("SmashLab AI route failed", error);
    return Response.json({ message: copy.connectionFailed }, { status: 500 });
  }
}
