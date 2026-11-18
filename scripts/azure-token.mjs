// Keeps a short-lived Azure token file for the AI Coach, using the az sign-in on this computer. No API key is used.
// The token file is written under .local/azure-auth/ (git-ignored) and bind-mounted read-only into the web container.
// Usage:  node scripts/azure-token.mjs          refresh every 5 minutes until stopped
//         node scripts/azure-token.mjs --once   write the file once and exit
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, ".local/azure-auth");
const resource = "https://cognitiveservices.azure.com";
const once = process.argv.includes("--once");

function refresh() {
  // The CLI output stays in memory. Tokens are never printed.
  const result = JSON.parse(execFileSync("az", ["account", "get-access-token", "--resource", resource, "--output", "json"], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 100_000, stdio: ["ignore", "pipe", "pipe"],
  }));
  const expiry = Number(result.expires_on);
  if (typeof result.accessToken !== "string" || !Number.isFinite(expiry) || expiry * 1000 < Date.now() + 60_000) {
    throw new Error("invalid or nearly expired token");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = resolve(directory, "token.next.json");
  writeFileSync(temporary, JSON.stringify({ accessToken: result.accessToken, expiresOn: new Date(expiry * 1000).toISOString(), resource }), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, resolve(directory, "token.json"));
  console.log(`Azure token written; expires ${new Date(expiry * 1000).toISOString()}.`);
}

try {
  refresh();
} catch {
  console.error("Azure sign-in unavailable. Run az login on this computer, then retry.");
  process.exit(1);
}
if (!once) {
  const timer = setInterval(() => {
    try {
      refresh();
    } catch {
      console.error("Token refresh failed. Run az login and restart this helper.");
    }
  }, 5 * 60_000);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("Keep this running while you use the AI Coach in Docker (Ctrl+C to stop).");
}
