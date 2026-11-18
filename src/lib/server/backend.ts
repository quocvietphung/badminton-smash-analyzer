import "server-only";

// Server-side configuration for the local AI backend and the site sign-in. Nothing here is sent to the browser.
// Browser-visible variables (NEXT_PUBLIC_*) are never used for secrets.

export type BackendConfig = {
  apiUrl: string;
  apiToken: string | null;
  publicApiUrl: string | null;
  sitePassword: string | null;
  sessionSecret: string | null;
};

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function originOf(raw: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(`${name} must be an absolute http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(`${name} must use http or https.`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function readBackendConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const apiUrl = originOf(env.SMASHLAB_API_URL?.trim() || "http://localhost:8000", "SMASHLAB_API_URL");
  const publicRaw = env.SMASHLAB_PUBLIC_API_URL?.trim() || "";
  const sitePassword = env.SMASHLAB_SITE_PASSWORD || null;
  const sessionSecret = env.SMASHLAB_SESSION_SECRET || null;
  if (sitePassword && (!sessionSecret || sessionSecret.length < 32)) {
    throw new ConfigurationError("SMASHLAB_SESSION_SECRET must be set (at least 32 characters) when a site password is set.");
  }
  return {
    apiUrl,
    apiToken: env.SMASHLAB_API_TOKEN || null,
    publicApiUrl: publicRaw ? originOf(publicRaw, "SMASHLAB_PUBLIC_API_URL") : null,
    sitePassword,
    sessionSecret,
  };
}
