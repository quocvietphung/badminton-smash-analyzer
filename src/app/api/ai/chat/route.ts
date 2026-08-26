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

export const maxDuration = 30;
export const runtime = "nodejs";

const strokeSchema = z.object({
  index: z.number().int().min(1).max(10_000),
  hitter: z.enum(["A", "B"]),
  strokeType: z.enum(["smash", "drop_shot", "clear", "drive", "overhead_control", "unknown"]),
  label: z.string().trim().max(120),
  evidence: z.number().min(0).max(100),
  certainty: z.enum(["likely", "possible", "unknown"]),
  swingIntensity: z.number().min(0).max(100),
  postureScore: z.number().min(0).max(100),
  reason: z.string().trim().max(360),
  family: z.enum(["overhead_attack", "overhead_control", "lateral", "unknown"]).optional(),
  position: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }).optional(),
});

const analysisSchema = z.object({
  source: z.enum(["none", "demo", "live", "history"]),
  capturedAt: z.string().max(64),
  calibrated: z.boolean(),
  strokes: z.array(strokeSchema).max(40),
  movement: z.object({
    A: z.number().min(0).max(2_000),
    B: z.number().min(0).max(2_000),
  }),
  summary: z.object({
    headline: z.string().trim().max(240),
    insight: z.string().trim().max(800),
    averageEvidence: z.number().min(0).max(100),
  }).nullable(),
});

const requestSchema = z.object({
  messages: z.array(z.object({
    id: z.string().max(180),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.unknown()).max(12),
  })).min(1).max(30),
  analysis: analysisSchema,
});

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
  try {
    if (!sameOrigin(request)) {
      return Response.json({ message: "Nguồn yêu cầu không hợp lệ." }, { status: 403 });
    }
    const rateLimit = await checkAiRateLimit(request);
    if (!rateLimit.allowed) {
      return Response.json(
        { message: "Bạn đã gửi quá nhiều yêu cầu. Hãy thử lại sau vài phút." },
        { status: 429, headers: rateLimitHeaders(rateLimit) },
      );
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 80_000) {
      return Response.json({ message: "Dữ liệu chat quá lớn." }, { status: 413 });
    }

    const body = requestSchema.parse(await request.json());
    const messages = sanitizeMessages(body.messages);
    if (!messages.length) {
      return Response.json({ message: "Nội dung yêu cầu trống." }, { status: 400 });
    }
    const retrievalQuery = buildRetrievalQuery(latestUserQuestion(messages), body.analysis);
    const knowledge = retrieveKnowledge(retrievalQuery);

    const result = streamText({
      model: getAzureChatModel(),
      instructions: buildAnalysisInstructions(body.analysis, knowledge),
      messages: await convertToModelMessages(messages),
      maxOutputTokens: getChatMaxOutputTokens(),
    });

    return result.toUIMessageStreamResponse({
      headers: { "Cache-Control": "no-store", ...rateLimitHeaders(rateLimit) },
      onError: (error) => {
        console.error("SmashLab Azure chat failed", error);
        return "Trợ lý AI tạm thời không phản hồi. Vui lòng thử lại.";
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ message: "Dữ liệu phân tích hoặc chat không hợp lệ." }, { status: 400 });
    }
    if (error instanceof AiConfigurationError) {
      return Response.json({ message: error.message }, { status: 503 });
    }
    console.error("SmashLab AI route failed", error);
    return Response.json({ message: "Không thể kết nối trợ lý Azure AI." }, { status: 500 });
  }
}
