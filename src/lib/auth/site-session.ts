// Site sign-in for the studio: a signed, HTTP-only session cookie. Pure functions (node:crypto only), so the rules
// can be tested without Next.js. The password and the secret are read on the server only (see server/backend.ts).
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "smashlab_session";
export const SESSION_TTL_S = 12 * 60 * 60;

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(`smashlab-site:${body}`).digest("base64url");
}

/** A session value "<payload>.<signature>" that expires after ttlS seconds. */
export function createSessionValue(secret: string, nowS: number, ttlS: number = SESSION_TTL_S): string {
  const body = Buffer.from(JSON.stringify({ v: 1, exp: nowS + ttlS })).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function verifySessionValue(secret: string, value: string | undefined, nowS: number): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const [body, signature] = parts;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { v?: unknown; exp?: unknown };
    return payload.v === 1 && typeof payload.exp === "number" && payload.exp > nowS;
  } catch {
    return false;
  }
}

/** Compare two passwords in constant time (digests have equal length, so timingSafeEqual is safe to use). */
export function passwordMatches(expected: string, given: string): boolean {
  const key = "smashlab-password";
  const a = createHmac("sha256", key).update(expected).digest();
  const b = createHmac("sha256", key).update(given).digest();
  return timingSafeEqual(a, b);
}

/** Read one cookie value from a Cookie header. */
export function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
