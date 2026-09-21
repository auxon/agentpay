# Google sign-in for the AgentPay dashboard

The dashboard supports "Sign in with Google" alongside the existing
create-wallet / enter-token / recover flows. It uses Google Identity Services'
**ID-token flow**: the browser receives a signed JWT from Google and sends it
to the worker, which verifies the signature locally. No client secret, no
OAuth redirect.

## 1. Google Cloud Console setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials.
2. **Create Credentials → OAuth client ID** → application type **Web application**.
3. Under **Authorized JavaScript origins**, add:
   - `https://entangleit.com` (production)
   - `http://localhost:5177` (local dev — the frontend dev server)
4. Copy the **Client ID** (looks like `…apps.googleusercontent.com`).

No client secret is needed — it is never used. You can leave the OAuth consent
screen in its default "External / Testing" state while developing.

## 2. Configure the worker

```bash
cd worker
# secret (recommended for live) or plain var:
npx wrangler secret put GOOGLE_CLIENT_ID
# or add to wrangler.toml under [vars]:
# GOOGLE_CLIENT_ID = "…apps.googleusercontent.com"
```

When `GOOGLE_CLIENT_ID` is unset, the Google button is hidden and the auth
endpoints return `501 { "error": "Google login is not configured" }`.

## 3. Apply the schema

The `ap_users` table maps a Google identity to a wallet:

```bash
cd worker
npm run db:apply          # remote — wrangler d1 execute entangleit --file=schema.sql --remote
npm run db:apply:local    # local dev
```

The migration is additive (`CREATE TABLE IF NOT EXISTS`) and safe to rerun.

## 4. Deploy

```bash
cd worker && npx wrangler deploy
# then the normal frontend build/merge flow in the README
```

## How it works

- `GET /auth/google/config` → `{ configured, clientId }`. The frontend
  lazy-loads `https://accounts.google.com/gsi/client` and renders the GIS
  button **only when configured**.
- `POST /auth/google` with `{ idToken }` verifies the token (see below).
  - **New identity**: mints a wallet via `createWallet` (name/email from the
    Google profile) and inserts the `ap_users` row. Returns `{ token,
    walletId, name, email, isNew: true, recoveryCode }` — the recovery code is
    shown once, matching the create-wallet flow.
  - **Returning identity**: updates the stored name/email and **rotates the
    wallet token** (only the new hash is kept), so every Google login issues a
    fresh `apw_…` token. The recovery code still works.
- `POST /auth/google/link` with `{ idToken, walletToken }` attaches a wallet
  created the old way to the Google identity (idempotent per `sub`). After
  linking, Google sign-in lands on that wallet.

Frontend notes:

- The GIS button is rendered by Google; the callback posts the ID token via
  the existing `api()` helper and stores the returned **wallet token** under
  the existing `agentpay_token` key — exactly like the other flows.
- The ID token is kept in component state only, to power "link an existing
  wallet" while signed in. It is never written to localStorage or logged.
- Sign-out clears localStorage, resets state, and calls
  `google.accounts.id.disableAutoSelect()`.

## Security notes

- Verification (`worker/src/google.ts`): decode JWT → fetch Google's RS256
  keys (`https://www.googleapis.com/oauth2/v3/certs`, cached 1h) → WebCrypto
  signature check → enforce `iss` (`accounts.google.com` /
  `https://accounts.google.com`), `aud === GOOGLE_CLIENT_ID`, `exp` in the
  future (60s leeway), non-empty `sub`.
- Only `sub`, `email`, and `name` are stored. Raw ID tokens, wallet tokens,
  and agent keys never touch the DB or logs (tokens are SHA-256 hashed; raw
  values are shown once, same as existing conventions).
- `walletToken` on the link endpoint goes through the same hash-match check
  as `requireWallet` (active wallets only).
- Google owns identity; the wallet token remains the bearer credential for
  all owner routes.
