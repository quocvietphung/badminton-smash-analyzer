import { SESSION_COOKIE } from "@/lib/auth/site-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: { code: "invalid_origin", message: "Invalid request origin." } }, { status: 403 });
  }
  const response = Response.json({ required: true, authenticated: false }, { headers: { "cache-control": "no-store" } });
  response.headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return response;
}
