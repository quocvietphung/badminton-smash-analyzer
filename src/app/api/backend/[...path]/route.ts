import { isAllowedBackendRequest, isMediaPath } from "@/lib/auth/proxy-rules";
import { readBackendConfig } from "@/lib/server/backend";
import { jsonError, requireSiteSession } from "@/lib/server/site-access";

// Forwards allowlisted requests from the studio to the local AI backend. The API token is added here, on the
// server, and never reaches the browser. Media (video, thumbnails, artifacts) streams with byte ranges.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_JSON_BODY_BYTES = 1_000_000;
const JSON_TIMEOUT_MS = 30_000;
const PASSED_REQUEST_HEADERS = ["accept", "content-type", "range", "if-range"];
const PASSED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "content-disposition",
  "etag",
  "last-modified",
];

type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const denied = await requireSiteSession(request);
  if (denied) return denied;
  if (!isAllowedBackendRequest(path, request.method)) {
    return jsonError(404, "not_found", "This backend endpoint is not available through the studio.");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (request.method === "POST" && contentType.startsWith("multipart/form-data")) {
    return jsonError(415, "use_direct_upload", "Videos are sent directly to the backend with an upload ticket.");
  }

  let config;
  try {
    config = readBackendConfig();
  } catch {
    return jsonError(503, "site_login_misconfigured", "The studio server is not configured.");
  }

  const headers = new Headers();
  for (const name of PASSED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (config.apiToken) headers.set("authorization", `Bearer ${config.apiToken}`);

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_JSON_BODY_BYTES) return jsonError(413, "body_too_large", "The request body is too large.");
  }

  const search = new URL(request.url).search;
  const upstreamUrl = `${config.apiUrl}/${path.join("/")}${search}`;
  const timeout = isMediaPath(path) ? undefined : AbortSignal.timeout(JSON_TIMEOUT_MS);
  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: timeout,
    });
    const responseHeaders = new Headers({ "cache-control": "no-store" });
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return jsonError(503, "backend_offline", "Local AI backend offline. Start Docker on the Mac.");
  }
}

export { forward as GET, forward as POST };
