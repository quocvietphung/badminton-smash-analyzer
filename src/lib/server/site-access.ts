import "server-only";

import { readBackendConfig, ConfigurationError } from "@/lib/server/backend";
import { SESSION_COOKIE, readCookie, verifySessionValue } from "@/lib/auth/site-session";

const NO_STORE = { "cache-control": "no-store" };

export function jsonError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers: { ...NO_STORE, ...headers } });
}

/** Null when the request may continue; otherwise the response to return. Without a site password, login is off (local use). */
export async function requireSiteSession(request: Request): Promise<Response | null> {
  let config;
  try {
    config = readBackendConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return jsonError(503, "site_login_misconfigured", "The site sign-in is not configured on the server.");
    }
    throw error;
  }
  if (!config.sitePassword || !config.sessionSecret) return null;
  const cookie = readCookie(request.headers.get("cookie") ?? "", SESSION_COOKIE);
  if (verifySessionValue(config.sessionSecret, cookie, Math.floor(Date.now() / 1000))) return null;
  return jsonError(401, "site_auth_required", "Sign in to use SmashLab.");
}
