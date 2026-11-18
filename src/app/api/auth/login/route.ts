import { createSessionValue, passwordMatches, SESSION_COOKIE, SESSION_TTL_S } from "@/lib/auth/site-session";
import { ConfigurationError, readBackendConfig } from "@/lib/server/backend";
import { jsonError } from "@/lib/server/site-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Signs the studio in with the site password. The password is compared in constant time; a failed attempt waits
// before it answers, which slows guessing. The cookie is HTTP-only, SameSite=Lax, and Secure on https.
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return jsonError(403, "invalid_origin", "Invalid request origin.");
  }
  let config;
  try {
    config = readBackendConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) return jsonError(503, "site_login_misconfigured", error.message);
    throw error;
  }
  if (!config.sitePassword || !config.sessionSecret) {
    return Response.json({ required: false, authenticated: true }, { headers: { "cache-control": "no-store" } });
  }
  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const given = typeof body?.password === "string" ? body.password : "";
  if (!given || given.length > 200 || !passwordMatches(config.sitePassword, given)) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return jsonError(401, "invalid_password", "The password is not correct.");
  }
  const value = createSessionValue(config.sessionSecret, Math.floor(Date.now() / 1000));
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const response = Response.json(
    { required: true, authenticated: true },
    { headers: { "cache-control": "no-store" } },
  );
  response.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}${secure}`,
  );
  return response;
}
