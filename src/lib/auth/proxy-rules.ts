// Which backend requests the studio may forward. Pure, so the allowlist is tested directly.
// The proxy never forwards multipart uploads: videos go straight to the API with an upload ticket, because a
// serverless function cannot accept a video of up to 200 MB.

const ALLOWED_EXACT = new Set(["health"]);
const ALLOWED_PREFIX = "api/v1/";
const ALLOWED_METHODS = new Set(["GET", "POST"]);

export function isAllowedBackendRequest(segments: string[], method: string): boolean {
  if (!ALLOWED_METHODS.has(method)) return false;
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || /[\\%]/.test(segment)) return false;
  }
  const path = segments.join("/");
  if (ALLOWED_EXACT.has(path)) return method === "GET";
  return path.startsWith(ALLOWED_PREFIX);
}

/** Media paths stream for minutes, so they get no fetch timeout. JSON calls do. */
export function isMediaPath(segments: string[]): boolean {
  const path = segments.join("/");
  return /\/(artifacts|source|video|thumbnail)(\/|$)/.test(path);
}
