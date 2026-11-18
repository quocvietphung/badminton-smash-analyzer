import { readBackendConfig } from "@/lib/server/backend";
import { jsonError, requireSiteSession } from "@/lib/server/site-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Asks the backend for a short-lived, single-use upload ticket and tells the browser where to send the video.
// Large videos never pass through this function: the browser uploads straight to the backend's public origin.
export async function POST(request: Request) {
  const denied = await requireSiteSession(request);
  if (denied) return denied;
  let config;
  try {
    config = readBackendConfig();
  } catch {
    return jsonError(503, "site_login_misconfigured", "The studio server is not configured.");
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${config.apiUrl}/api/v1/upload-tickets`, {
      method: "POST",
      headers: config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return jsonError(503, "backend_offline", "Local AI backend offline. Start Docker on the Mac.");
  }
  if (!upstream.ok) {
    return jsonError(upstream.status, "upload_ticket_failed", "The backend did not issue an upload ticket.");
  }
  const body = (await upstream.json()) as {
    ticket: string | null;
    expires_at: number | null;
    max_bytes: number;
    mode: string;
  };
  const uploadBase = config.publicApiUrl ?? config.apiUrl;
  return Response.json(
    {
      ticket: body.ticket,
      expiresAt: body.expires_at,
      maxBytes: body.max_bytes,
      mode: body.mode,
      uploadUrl: `${uploadBase}/api/v1/analyses`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
