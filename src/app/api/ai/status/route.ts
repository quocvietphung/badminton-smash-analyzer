import { chatModelLabel } from "@/lib/ai/chat-model";
import { CoachProviderError, resolveCoachProvider } from "@/lib/ai/coach-provider";
import { requireSiteSession } from "@/lib/server/site-access";

export const runtime = "nodejs";

/** Which model the AI Coach uses on this server. Read from configuration, so the label is never guessed. */
export async function GET(request: Request) {
  const signedOut = await requireSiteSession(request);
  if (signedOut) return signedOut;
  try {
    const provider = resolveCoachProvider(process.env);
    const label = provider.kind === "ollama"
      ? { provider: "ollama", model: provider.model }
      : { provider: "azure", model: chatModelLabel() };
    return Response.json(label, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof CoachProviderError) {
      return Response.json({ provider: "invalid", model: null }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
