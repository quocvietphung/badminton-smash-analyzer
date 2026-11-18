import { SESSION_COOKIE, readCookie, verifySessionValue } from "@/lib/auth/site-session";
import { ConfigurationError, readBackendConfig } from "@/lib/server/backend";
import { jsonError } from "@/lib/server/site-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tells the studio whether a sign-in is required and whether this browser is signed in. Shows no secret.
export async function GET(request: Request) {
  let config;
  try {
    config = readBackendConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) return jsonError(503, "site_login_misconfigured", error.message);
    throw error;
  }
  const required = Boolean(config.sitePassword && config.sessionSecret);
  const cookie = readCookie(request.headers.get("cookie") ?? "", SESSION_COOKIE);
  const authenticated =
    !required || verifySessionValue(config.sessionSecret as string, cookie, Math.floor(Date.now() / 1000));
  return Response.json({ required, authenticated }, { headers: { "cache-control": "no-store" } });
}
