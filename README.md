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

## ✨ What it does

- **Admin login** with scrypt-hashed passwords and JWT sessions.
- **Unlimited API keys**, each with its own:
  - provider (OpenAI Chat, OpenAI Responses, Anthropic, or any compatible base URL)
  - provider keys (`api.txt` paste or one per line — encrypted with AES-256-GCM)
  - RPM / RPD / TPD limits, enforced server-side
  - routing mode: ordered failover or random key per request
  - streaming on/off (default on)
  - usage: requests, tokens (1K / 1M / 1B formatting), latency
- **Three request formats on the same key:**
  - `POST /v1/chat/completions` (OpenAI Chat)
  - `POST /v1/responses` (OpenAI Responses)
  - `POST /v1/messages` (Anthropic Messages)
- **`GET /v1/models`** – the models your provider exposes, filtered per key.
- **Streaming (SSE)** translated into the format the caller expects.
- **Failover:** 401/403/402/408/429/5xx/timeout tries the next provider key with the
  same body; 400/404 stops immediately. Failed keys cool down, then recover.
- **Usage dashboard data** per key and in total.

## 🧱 Stack

| Piece | Choice | Why |
|---|---|---|
| Runtime | Vercel Functions (Node 22) | free public HTTPS URL, 300 s limit |
| Framework | Hono | tiny, fast, one catch-all function |
| Database | Neon / Vercel Postgres | serverless-friendly Postgres |
| Auth | jose (HS256 JWT) | no session store needed |
| Crypto | node:crypto | scrypt passwords, AES-256-GCM secrets |

No Redis needed: rate limits are enforced with a Postgres advisory lock inside one
transaction, which is correct under concurrency.

## 1️⃣ Create the database (2 minutes)

1. Go to <https://neon.com> → **New Project** → pick the region closest to you.
2. Copy the **connection string** (starts with `postgres://…?sslmode=require`).

Tables are created automatically on the first request — no migration step.

## 2️⃣ Deploy to Vercel

### Option A — GitHub (recommended)

```bash
# from this folder
git init
git add .
git commit -m "Sufi Gateway API"
git branch -M main
git remote add origin https://github.com/<you>/sufi-gateway-api.git
git push -u origin main
```

Then on <https://vercel.com/new> → **Import** that repo → **Deploy**.
Framework preset: **Other**. Build command: leave empty. Output directory: leave empty.

### Option B — CLI

```bash
npm i -g vercel
vercel            # first deploy, link the project
vercel --prod     # production
```

## 3️⃣ Environment variables (Vercel → Settings → Environment Variables)

| Name | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://…?sslmode=require` | Neon connection string |
| `JWT_SECRET` | output of `openssl rand -base64 48` | admin session signing |
| `ENCRYPTION_KEY` | output of `openssl rand -base64 48` | encrypts provider keys |
| `SETUP_TOKEN` | any long random string | used once to create the admin |
| `PUBLIC_BASE_URL` | `https://sufi-gateway-api.vercel.app` | no trailing slash |

Redeploy after adding them (**Deployments → ⋯ → Redeploy**).

## 4️⃣ Create your admin (once)

Open the app, or:

```bash
curl -X POST https://sufi-gateway-api.vercel.app/api/setup \
  -H 'content-type: application/json' \
  -d '{"setupToken":"YOUR_SETUP_TOKEN","email":"you@example.com","password":"at-least-8-chars"}'
```

You get a JWT back. **Then delete `SETUP_TOKEN` from Vercel** and redeploy — a
second admin can never be created.

## 5️⃣ Use it

```bash
curl https://sufi-gateway-api.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer sufi-ai-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

Point any OpenAI SDK at `https://sufi-gateway-api.vercel.app/v1` and use a
`sufi-ai-…` key as the API key.

## 🧪 Local development

```bash
cp .env.example .env      # fill DATABASE_URL, secrets, ALLOW_LOCAL_PROVIDER=true
npm install
npm run db:init
npm run dev               # http://localhost:3000
npm test                  # unit tests
bash tests/e2e.sh         # full API flow against a mock provider (needs Docker Postgres)
```

## 🔐 Security notes

- Provider keys are encrypted at rest; the API never returns them, only `••••1234`.
- API keys are stored as SHA-256 hashes; the raw key is shown **once**.
- Every query is parameterised; scrypt (N=16384, r=8, p=1) for passwords.
- Provider base URLs must be `https://` (SSRF protection); `ALLOW_LOCAL_PROVIDER=true`
  is only for local testing.
- Login is rate limited per IP (20 attempts / 15 minutes).

## 📚 API reference

### Public (needs `Authorization: Bearer sufi-ai-…`)

| Method | Path | Format |
|---|---|---|
| GET | `/v1/models` | OpenAI list |
| POST | `/v1/chat/completions` | OpenAI Chat |
| POST | `/v1/responses` | OpenAI Responses |
| POST | `/v1/messages` | Anthropic Messages |
| GET | `/v1/me` | key info + today's usage |

### Admin (needs `Authorization: Bearer <jwt>`)

| Method | Path |
|---|---|
| GET | `/api/setup/status` |
| POST | `/api/setup` |
| POST | `/api/auth/login` |
| GET | `/api/admin/providers` · POST · PATCH `/:id` · DELETE `/:id` |
| GET | `/api/admin/providers/:id/models` · POST · PATCH `/:id/models/:modelId` · DELETE |
| GET | `/api/admin/keys` · POST · GET `/:id` · PATCH `/:id` · DELETE `/:id` |
| POST | `/api/admin/keys/:id/revoke` · `/activate` |
| GET/POST | `/api/admin/keys/:id/credentials` |
| PATCH/DELETE | `/api/admin/keys/:id/credentials/:credentialId` |
| POST | `/api/admin/keys/:id/credentials/test` |
| GET | `/api/admin/keys/:id/models` · POST `.../models/sync` · PATCH `.../models` |
| GET | `/api/admin/keys/:id/usage?days=30` |
| POST | `/api/admin/playground/chat` |
| GET | `/api/admin/usage/summary?days=14` · `/api/admin/usage/logs` |
| GET/PUT | `/api/admin/settings` |

## ⚠️ Limits of the free tier

- Vercel Hobby: **300 s** per function, ~4.5 MB request body.
- Neon free plan: compute sleeps when idle, so the first request after a pause is slower.
- For heavy production traffic, move the same code to a real VPS (`npm run dev` behind
  Caddy) — nothing needs to change.
