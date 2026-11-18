# Secure remote access: Vercel studio, local Docker backend

Status: **not deployed and not connected.** No remote access is set up, and no production environment variable exists. The local stack works without them.

## Split of responsibilities

- The studio (Next.js) can run on Vercel. Analysis never runs there.
- Inference, the job queue, model files, sample videos, outputs and the SQLite database stay on the Mac in the Docker stack `smashlab-ai`.
- No remote path to the Mac exists. The backend listens on `localhost` only.
- Browsers never receive the backend address the studio server uses, and never receive the API token.

## Request paths

| Path | Route | Credential |
| --- | --- | --- |
| Studio page | Vercel | site sign-in cookie, when `SMASHLAB_SITE_PASSWORD` is set |
| JSON calls: health, samples, jobs, results, artifacts, corrections, evaluation | browser → `/api/backend/...` on the studio server → `SMASHLAB_API_URL` | the studio server adds `Authorization: Bearer` from `SMASHLAB_API_TOKEN` |
| Sample video and annotated video | same proxy, streamed; `Range` and `If-Range` are passed through | as above |
| The user's own MP4 or MOV | browser calls `/api/upload-session`, receives a single-use ticket, then sends the file straight to `SMASHLAB_PUBLIC_API_URL/api/v1/analyses` with header `X-SmashLab-Upload-Ticket` | upload ticket |
| AI Coach | `/api/ai/chat` on the studio server | site sign-in; Azure OpenAI receives derived metrics only |

A serverless function cannot take a 200 MB upload or wait for minutes of inference. The proxy therefore refuses multipart uploads (415 `use_direct_upload`), and only the backend starts inference.

## Controls in the code

- **Backend token.** When `SMASHLAB_API_TOKEN` is set, every `/api/v1` route needs `Authorization: Bearer <token>`. `/health` then returns only `{"status": ...}` to a caller without credentials.
- **Forwarded requests.** When no token is set, a request carrying any of `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `X-Forwarded-Host` or `CF-Ray` is refused. A proxied or forwarded request therefore cannot expose an unauthenticated API by accident.
- **Upload tickets.** HMAC-SHA256, keyed from the token. Each ticket has an expiry (`SMASHLAB_TICKET_TTL_S`, default 300 s) and a nonce, and it can be redeemed once. Spent nonces are remembered in process memory; a restart forgets them, but tickets still expire within the TTL.
- **CORS.** Only the origins in `SMASHLAB_CORS_ORIGINS` may call the backend from a browser. Direct uploads from Vercel need the production origin listed there.
- **Studio server.** `src/lib/server/backend.ts` is marked `server-only`. It reads only the `SMASHLAB_*` variables, none of which has a `NEXT_PUBLIC_` prefix.
- **Proxy allowlist.** `src/lib/auth/proxy-rules.ts` permits `GET /health` and `GET`/`POST` on `/api/v1/*`. It rejects empty, `.` and `..` segments, `%` and `\` in paths, and multipart POST.
- **Site sign-in.** One shared password, compared in constant time. The session is a signed, HTTP-only, `SameSite=Lax` cookie, marked `Secure` over https. A failed attempt is delayed. There are no per-user accounts and no lock-out.
- **Jobs.** One worker runs one job at a time. A job that a restart interrupts is queued again at startup, so it does not wait for its lease to expire.
- **Offline behaviour.** When Docker is unreachable, the proxy answers 503 `backend_offline` and the studio shows "Local AI backend offline".

## Environment variables (names only)

Values are never written to git, to this document or to the browser. Generate secrets with `openssl rand -hex 32`.

| Variable | Set in | Purpose |
| --- | --- | --- |
| `SMASHLAB_API_URL` | studio (`.env.local`, Vercel) | backend origin as the studio server reaches it. Default `http://localhost:8000`. |
| `SMASHLAB_API_TOKEN` | studio and backend (`.env`, Vercel) | shared bearer token. Use the same value on both sides. |
| `SMASHLAB_PUBLIC_API_URL` | studio | origin browsers upload to. Empty means `SMASHLAB_API_URL`. |
| `SMASHLAB_SITE_PASSWORD` | studio (Vercel) | turns on sign-in. Required on any public URL. |
| `SMASHLAB_SESSION_SECRET` | studio (Vercel) | at least 32 random characters. Required when the site password is set. |
| `SMASHLAB_CORS_ORIGINS` | backend (`.env` for compose) | comma-separated browser origins allowed to call the backend. Add the Vercel origin. |
| `SMASHLAB_TICKET_TTL_S` | backend | upload ticket lifetime in seconds. Default 300. |

## Local development (unchanged)

```bash
docker compose -p smashlab-ai -f docker-compose.yml up -d --build
npm run dev          # http://localhost:3000
```

Leave `SMASHLAB_API_TOKEN` and `SMASHLAB_SITE_PASSWORD` empty for the open local setup. To test the production path, set the same token on the backend and in `.env.local`, then restart both.

## Vercel (planned, not deployed)

1. Link the existing project and add the server-side variables above, marked as sensitive.
2. Add the production origin to `SMASHLAB_CORS_ORIGINS` on the Mac and recreate the backend container.
3. Deploy to production only after the owner approves.

## Approval gates

The owner must approve each of these before the assistant does it:

- a production deployment to Vercel, and production environment variables there.

## Open decisions and risks

1. **Remote access is not designed yet.** Any future remote path needs its own decision. The product rule in `AGENTS.md` allows video uploads only to the local backend on `localhost`, so a remote upload would need that rule changed first.
2. **Media through a serverless proxy.** A serverless function's duration limit may cut long video streams. That would need a different media path before any remote use.
3. **Mac availability.** Analyses run only while the Mac is awake and Docker is running.
4. **One operator.** One shared token and one site password. There are no per-user accounts, roles or per-user session separation.
5. **Login throttling.** A failed password attempt is delayed, but there is no lock-out or rate limit.
