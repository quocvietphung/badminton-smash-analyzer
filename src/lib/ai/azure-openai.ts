import "server-only";

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { createAzure } from "@ai-sdk/azure";

const execFileAsync = promisify(execFile);
const ENTRA_RESOURCE = "https://cognitiveservices.azure.com";
const REFRESH_MARGIN_MS = 5 * 60_000;
let cachedToken: { value: string; expiresAt: number } | null = null;

export class AiConfigurationError extends Error {
  constructor(message = "Trợ lý Azure AI chưa được cấu hình.") {
    super(message);
    this.name = "AiConfigurationError";
  }
}

function requiredEnvironmentValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new AiConfigurationError(`Thiếu biến môi trường ${name}.`);
  return value;
}

/**
 * Entra ID token for the Azure OpenAI resource, from the Azure CLI sign-in on this machine. It is read on the server and
 * never sent to the browser. Production needs an
 * API key or a managed identity instead.
 */
async function entraToken(): Promise<string> {
  if (process.env.AZURE_OPENAI_CREDENTIAL?.trim() === "token-file") return tokenFromFile();
  if (cachedToken && cachedToken.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cachedToken.value;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "az",
      ["account", "get-access-token", "--resource", ENTRA_RESOURCE, "--output", "json"],
      { timeout: 20_000, maxBuffer: 1_000_000 },
    ));
  } catch {
    throw new AiConfigurationError("Không lấy được token Azure. Hãy chạy `az login` trên máy hoặc đặt AZURE_API_KEY.");
  }
  const body = JSON.parse(stdout) as { accessToken?: string; expires_on?: number };
  if (!body.accessToken) throw new AiConfigurationError("Azure CLI không trả về token.");
  const expiresAt = body.expires_on ? body.expires_on * 1000 : Date.now() + 10 * 60_000;
  cachedToken = { value: body.accessToken, expiresAt };
  return body.accessToken;
}

/**
 * The token file written by scripts/azure-token.mjs on the host (bind-mounted read-only into Docker). Read on every call,
 * so a refreshed file is picked up. An expired or missing file fails closed: no token, no call.
 */
async function tokenFromFile(): Promise<string> {
  const path = process.env.AZURE_OPENAI_TOKEN_FILE?.trim();
  if (!path) throw new AiConfigurationError("AZURE_OPENAI_TOKEN_FILE is not set.");
  let body: { accessToken?: string; expiresOn?: string };
  try {
    body = JSON.parse(await readFile(path, "utf8")) as { accessToken?: string; expiresOn?: string };
  } catch {
    throw new AiConfigurationError("The Azure token file is missing. Run node scripts/azure-token.mjs on the host.");
  }
  const expires = body.expiresOn ? Date.parse(body.expiresOn) : NaN;
  if (!body.accessToken || !Number.isFinite(expires) || expires - Date.now() < 60_000) {
    throw new AiConfigurationError("The Azure token has expired. Run node scripts/azure-token.mjs on the host.");
  }
  return body.accessToken;
}

export async function getAzureChatModel() {
  if (process.env.AI_ASSISTANT_ENABLED === "false") {
    throw new AiConfigurationError("Trợ lý Azure AI đang tạm tắt.");
  }
  const resourceName = requiredEnvironmentValue("AZURE_RESOURCE_NAME");
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION?.trim() || "v1";
  const apiKey = process.env.AZURE_API_KEY?.trim();
  // Without an API key, every request is re-signed with the CLI token and any api-key header is removed. The
  // placeholder only satisfies the provider's constructor check and is never sent.
  const signedFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("api-key");
    headers.set("Authorization", `Bearer ${await entraToken()}`);
    return fetch(input, { ...init, headers });
  };
  const azure = apiKey
    ? createAzure({ resourceName, apiKey, apiVersion })
    : createAzure({ resourceName, apiVersion, apiKey: "entra-cli-placeholder", fetch: signedFetch });

  return azure.chat(requiredEnvironmentValue("AZURE_OPENAI_DEPLOYMENT"));
}

export function getChatMaxOutputTokens() {
  const configured = Number(process.env.AI_CHAT_MAX_OUTPUT_TOKENS);
  if (!Number.isFinite(configured)) return 480;
  return Math.min(Math.max(Math.round(configured), 128), 800);
}
