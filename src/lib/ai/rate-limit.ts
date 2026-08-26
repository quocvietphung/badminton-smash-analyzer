import "server-only";

import { createHash } from "node:crypto";

const RATE_LIMIT = 12;
const WINDOW_SECONDS = 5 * 60;
const UPSTASH_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("TTL", KEYS[1])
return {count, ttl}
`;

type MemoryEntry = { count: number; resetAt: number };
type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  source: "upstash" | "memory";
};

const rateState = globalThis as typeof globalThis & {
  smashLabAiRates?: Map<string, MemoryEntry>;
};
const rates = rateState.smashLabAiRates ?? new Map<string, MemoryEntry>();
rateState.smashLabAiRates = rates;

function clientKey(request: Request) {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "local";
  const salt = process.env.AI_RATE_LIMIT_SALT
    || process.env.AZURE_RESOURCE_NAME
    || "smashlab-pose-lite";
  return createHash("sha256").update(`${salt}:${address}`).digest("hex").slice(0, 32);
}

function checkMemoryLimit(key: string): RateLimitResult {
  const now = Date.now();
  if (rates.size > 1_000) {
    rates.forEach((entry, entryKey) => {
      if (entry.resetAt <= now) rates.delete(entryKey);
    });
  }
  const current = rates.get(key);
  if (!current || current.resetAt <= now) {
    const resetAt = now + WINDOW_SECONDS * 1_000;
    rates.set(key, { count: 1, resetAt });
    return { allowed: true, limit: RATE_LIMIT, remaining: RATE_LIMIT - 1, resetAt, source: "memory" };
  }
  current.count += 1;
  return {
    allowed: current.count <= RATE_LIMIT,
    limit: RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - current.count),
    resetAt: current.resetAt,
    source: "memory",
  };
}

async function checkUpstashLimit(key: string): Promise<RateLimitResult | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(["EVAL", UPSTASH_SCRIPT, "1", `smashlab:ai:${key}`, String(WINDOW_SECONDS)]),
    cache: "no-store",
    signal: AbortSignal.timeout(1_800),
  });
  if (!response.ok) throw new Error(`Upstash rate limit returned ${response.status}`);
  const payload = await response.json() as { result?: [number | string, number | string] };
  const count = Number(payload.result?.[0]);
  const ttl = Number(payload.result?.[1]);
  if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
    throw new Error("Upstash rate limit returned an invalid payload");
  }
  return {
    allowed: count <= RATE_LIMIT,
    limit: RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - count),
    resetAt: Date.now() + Math.max(0, ttl) * 1_000,
    source: "upstash",
  };
}

export async function checkAiRateLimit(request: Request): Promise<RateLimitResult> {
  const key = clientKey(request);
  try {
    return await checkUpstashLimit(key) ?? checkMemoryLimit(key);
  } catch (error) {
    console.error("Shared AI rate limiter unavailable; using local fallback", error);
    return checkMemoryLimit(key);
  }
}

export function rateLimitHeaders(result: RateLimitResult) {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1_000)),
    "X-RateLimit-Source": result.source,
  };
}
