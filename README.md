# 🚀 Sufi Gateway API

A self-hosted AI API gateway you deploy to **Vercel** in a few minutes.
It gives your friends (and any app) one OpenAI-compatible + Anthropic-compatible
endpoint, with your provider keys kept secret on the server.

```text
Friends' apps ──(sufi-ai-…)──►  Vercel /v1  ──►  OpenAI / OpenRouter / Anthropic / any compatible API
                                   │
                                   ├── Postgres (Neon): admins, keys, usage
                                   └── per-key limits: RPM / RPD / TPD
```

## 🛠️ Deployment notes (read if you fork this)

Vercel's Node builder has sharp edges this repo already solves:

1. **ESM local imports** — Vercel transpiles each API file separately, so
   extensionless imports like `../lib/app` crash with `ERR_MODULE_NOT_FOUND`.
   Fix: `npm run build:fn` (runs on `postinstall`) bundles `scripts/entry.ts`
   into `api/_bundle.mjs` with esbuild, and the function imports that one file.
2. **Routing** — `api/[...route]` only matches a single segment, and nested
   catch-alls are ignored. Fix: `vercel.json` rewrites **every** path to
   `/api/index`; Vercel preserves the original URL, and `api/index.mjs` maps
   `/v1/*` onto the Hono routes at `/api/v1/*`.
3. **Handler signature** — the function exports the Web `fetch` handler
   (`export const fetch`). A bare default export receives `(req, res)` and breaks
   Hono with `this.raw.headers.get is not a function`.
4. **SSO Protection** — keep **Vercel Authentication OFF** for this project,
   otherwise `*.vercel.app` URLs answer `deployment_authentication_required`
   instead of your API.

## ✨ What it does

- **Admin login** with scrypt-hashed passwords and JWT sessions.
- **Unlimited API keys**, each with its own provider, provider keys, limits,
  routing (ordered/random), streaming toggle and usage counters.
- **Three request formats on one key:** `/v1/chat/completions`,
  `/v1/responses`, `/v1/messages`.
- **`GET /v1/models`** filtered per key, synced from the provider.
- **Streaming (SSE)** translated into the caller's format.
- **Failover:** 401/403/402/408/429/5xx/timeout -> next provider key; 400/404 stops.
- **Server-side RPM / RPD / TPD** enforced in Postgres under an advisory lock.

## 1️⃣ Database

Neon (or any Postgres): copy the connection string. Tables are created on the
first request — no migration step.

## 2️⃣ Vercel

Import this repo on <https://vercel.com/new> (framework: *Other*, no build
command). Keep the project name `sufi-gateway-api` for the default URL.

| Env var | Notes |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `ENCRYPTION_KEY` | `openssl rand -base64 48` |
| `SETUP_TOKEN` | one-time code for the first admin |
| `PUBLIC_BASE_URL` | `https://sufi-gateway-api.vercel.app` |

## 3️⃣ First admin

```bash
curl -X POST https://sufi-gateway-api.vercel.app/api/setup \
  -H 'content-type: application/json' \
  -d '{"setupToken":"YOUR_SETUP_TOKEN","email":"you@example.com","password":"at-least-8-chars"}'
```

Then rotate `SETUP_TOKEN` in Vercel — a second admin can never be created.

## 4️⃣ Use it

```bash
curl https://sufi-gateway-api.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer sufi-ai-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

## 🧪 Local development

```bash
cp .env.example .env      # DATABASE_URL, secrets, ALLOW_LOCAL_PROVIDER=true
npm install
npm run db:init
npm run dev               # http://localhost:3000
npm test                  # unit tests
bash tests/e2e.sh         # full flow against a mock provider
```

## 🔐 Security

- Provider keys encrypted at rest (AES-256-GCM); only `••••1234` is returned.
- API keys stored as SHA-256 hashes; shown once.
- Parameterised SQL everywhere; scrypt (N=16384) passwords.
- Provider base URLs must be `https://` (SSRF guard).
- Login rate limited per IP (20 / 15 min).
