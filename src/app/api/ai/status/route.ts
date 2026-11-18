import { chatModelLabel } from "@/lib/ai/chat-model";
import { requireSiteSession } from "@/lib/server/site-access";

export const runtime = "nodejs";

/** Which model the AI Coach uses on this server. Read from configuration, so the label is never guessed. */
export async function GET(request: Request) {
  const signedOut = await requireSiteSession(request);
  if (signedOut) return signedOut;
  return Response.json(
    { provider: "azure", model: chatModelLabel() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
