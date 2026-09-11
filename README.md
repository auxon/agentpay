# agentpay — card payments for AI agents

Prepaid USD wallets, budgets, and MCP payment tools for AI agents on Cloudflare.
A human funds a wallet with a card through Stripe Checkout; agents get scoped
keys, optional daily limits, and tools to check balance, discover paid services
(the [x402market](https://entangleit.com/x402market/) registry), spend, and
fetch receipts. Paid registry calls settle on **BSV mainnet over x402 v2** from
the operator's site wallet. No browser wallet required.

Live target: `https://entangleit.com/agentpay/` (dashboard) +
`https://entangleit.com/api/agentpay/*` (worker `agentpay-api`) +
`https://entangleit.com/api/agentpay/mcp` (Streamable HTTP MCP).

Published in the official MCP Registry as **`com.entangleit/agentpay`**
(`curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.entangleit/agentpay"`).
See `docs/PUBLISH-MCP.md` for re-publishing.

## Layout

```
/Users/rah/agentpay/
  frontend/   # Vite React SPA, base '/agentpay/' (dev :5177, /api -> :8788)
  worker/     # Hono API + MCP worker (shares entangleit D1, ap_ tables)
  scripts/build-merge.mjs  # merge into entangleit/portfolio/public for Pages
```

## Architecture

```
Agent (MCP/HTTP) ──Bearer agp_…──► agentpay-api Worker (Hono, TS)
                                      ├─ D1  (shared entangleit, ap_ tables)
Human (dashboard) ──► Stripe Checkout ┤─ Stripe webhook → idempotent credit
                                      ├─ MCP @ /api/agentpay/mcp
x402market xm_services ◄─ discovery ──┤
                                      └─ x402 v2 BSV: site wallet signs,
                                         seller broadcasts via ARC
```

- Wallet token (`apw_…`, owner) is minted once at wallet creation; a recovery
  code (`apr_…`) resets it if lost.
- Agent keys (`agp_…`) are scoped to a wallet, optional daily limit, revocable
  and rotatable.
- Only SHA-256 hashes are stored; raw keys never hit the DB or logs.
- Balance can never go negative: the debit is a single guarded `UPDATE … WHERE balance_cents >= ?`.
- Top-ups are idempotent by Stripe Checkout session id (`ap_topup_refs`), so webhook + claim cannot double-credit.
- Every balance change writes one `ap_ledger` event with `balance_after_cents`; spends also write `ap_receipts`.

## Plans (Free + Pro)

Every wallet starts on **Free**; **Pro** is a $29/mo Stripe subscription (`PRO_PRICE_CENTS`
overrides the price; `STRIPE_PRICE_PRO` pins a pre-created recurring Price). Entitlements are
derived server-side from the `ap_subscriptions` row, which only verified Stripe webhooks write:

| | Free | Pro ($29/mo) |
| --- | --- | --- |
| Agent keys | 3 | 25 |
| Per-agent daily limit | up to $50 | up to $1,000 |
| Approvals, receipts, API + MCP | yes | yes |
| CSV export (ledger + receipts) | — | yes |

- `POST /wallets/me/plan/checkout` → Stripe Checkout (subscription mode); the dashboard polls
  until the webhook flips the plan.
- `POST /wallets/me/plan/portal` → Stripe billing portal (payment method, cancel, invoices).
- `GET /wallets/me/export.csv?kind=receipts|ledger` → Pro-only CSV.
- `POST /agent/plan-link` → an agent can mint an upgrade URL to hand to the wallet owner
  (MCP tool `create_upgrade_link`). Plan-limit errors carry
  `{ code: "plan_limit", plan, maxAgents|maxDailyLimitCents, upgradeUrl }`.
- Webhook events are claimed once in `ap_stripe_events` (released on failure) so Stripe retries
  cannot double-apply; `customer.subscription.*` drives status, `invoice.payment_failed` sets
  `past_due`, and a 72-hour grace keeps Pro through a missed renewal event.

## Local dev

```bash
# worker (:8788) — apply schema to local D1 first
cd worker
npm install
npm run db:apply:local
npm run dev

# frontend (:5177, proxies /api to :8788)
cd frontend
npm install
npm run dev
# open http://localhost:5177/agentpay/
```

Create a wallet in the UI, mint an agent key, then use `worker/` REST or MCP.
Locally you can simulate a top-up by inserting a ledger credit:

```bash
cd worker
npx wrangler d1 execute entangleit --local --command \
  "INSERT INTO ap_topup_refs (ref, wallet_id, amount_cents) VALUES ('cs_local', '<wallet id>', 2000); \
   UPDATE ap_wallets SET balance_cents = balance_cents + 2000 WHERE id = '<wallet id>';"
```

Tests (real schema on Node's built-in SQLite):

```bash
cd worker
npm test          # 27 tests: ledger invariants, idempotency, limits, auth
npm run check     # tsc --noEmit + vitest
```

## Stripe

Checkout uses dynamic payment methods (no `payment_method_types`) and ad-hoc
`price_data` top-ups ($1–$1,000). Fulfillment runs on
`checkout.session.completed` **and** `checkout.session.async_payment_succeeded`,
gated on `payment_status === "paid"`.

The Pro plan uses the same webhook endpoint in `subscription` mode. Enable these
events on the endpoint: `checkout.session.completed`,
`customer.subscription.created|updated|deleted`, `invoice.paid`,
`invoice.payment_failed`. The restricted key needs write access to Checkout
Sessions, Customers, Subscriptions, and the Billing Portal.

```bash
cd worker
npx wrangler secret put STRIPE_SECRET_KEY      # rk_test_… locally, rk_live_… in prod
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # signing secret of the endpoint below
```

Webhook endpoint (create one per mode):
`https://entangleit.com/api/agentpay/webhooks/stripe`

Production (`entangleit.com`) fail-closes if the key is not live — test keys
cannot take real cards. `STRIPE_PUBLISHABLE_KEY` (optional) can be a plain var.

Local webhook forward:

```bash
stripe listen --forward-to localhost:8788/api/agentpay/webhooks/stripe
```

## x402 / BSV rail

`pay_service` is a full x402 v2 **buyer**: it calls the seller unsigned, decodes
`PAYMENT-REQUIRED` (`bsv:mainnet`, scheme `exact`, asset `native:BSV`), builds and
signs an exact P2PKH payment from the site wallet (full parent tx attached for ARC
validation, flat fee), debits the agent wallet, then retries with
`PAYMENT-SIGNATURE: base64({x402Version, scheme, network, txHex, encoding: "raw-hex"})`.
The seller broadcasts via ARC and returns the resource (and `PAYMENT-RESPONSE`).
A seller rejection refunds the debit (`refund` ledger row) and unwinds the agent's
daily counter. Free tools are called straight through with no debit.

Rail hardening (learned from live mainnet tests):

- **Spent-UTXO filter** — WOC `/unspent` is cached and can list outputs an
  unconfirmed tx already spent; each candidate is checked against
  `/tx/{txid}/{vout}/spent` before selection.
- **Confirmed UTXOs only** — ARC can orphan a child of a just-confirmed parent it
  has not indexed yet, and orphans never relay. Unconfirmed UTXOs are skipped
  (`X402_ALLOW_UNCONFIRMED=1` opts in for local testing).
- **Random OP_RETURN nonce** — two payments can never share a txid, so a stale
  UTXO cache cannot alias a fresh payment with an already-settled tx.
- **Settled-txid guard** — `ap_x402_payments` rejects a seller that returns an
  already-settled txid (replay); the debit is refunded.

```bash
cd worker
npx wrangler secret put SITE_WALLET_WIF   # BSV treasury (same model as Brainstorm NFT mints)
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `SITE_WALLET_WIF` | — | Treasury that pays sellers. Never log or commit. |
| `X402_MAX_SATS` | `10000` | Per-payment cap; larger asks fail closed. |
| `X402_FEE_SATS` | `30` | Flat network fee (ARC/GorillaPool relay min is ~23 for a 225B tx). |
| `X402_SATS_PER_CENT` | unset | Auto-pricing; unset charges the 1-cent minimum per paid call. |
| `X402_MIN_TREASURY_SATS` | `5000` | `/health` flags `x402.treasury.low` below this balance. |
| `X402_ALLOW_UNCONFIRMED` | unset | `1` spends unconfirmed UTXOs (local testing only). |

Without `SITE_WALLET_WIF`, `pay_service` falls back to internal wallet settlement
and returns the live quote so a caller can settle out-of-band.

Local end-to-end against the real BSV Wallets seller with a funded burner:

```bash
# .dev.vars is gitignored
printf 'SITE_WALLET_WIF="%s"\n' "<funded burner wif>" > worker/.dev.vars
cd worker && npm run dev
# credit the local wallet, then:
curl -X POST localhost:8788/api/agentpay/agent/pay-service \
  -H "Authorization: Bearer agp_…" -H 'content-type: application/json' \
  -d '{"serviceId":"smtu6vm7lfpyeo7aw","tool":"timestamp","params":{"data":"hello"}}'
```

## Deploy

```bash
# 1. schema (additive, IF NOT EXISTS) + worker
cd worker
npm run db:apply          # wrangler d1 execute entangleit --file=schema.sql --remote
npx wrangler deploy       # attaches entangleit.com/api/agentpay/*

# 2. frontend: portfolio build first (wipes public/), then merges
cd /Users/rah/entangleit/portfolio && npm run build:pages
node /Users/rah/x402market/scripts/build-merge.mjs
node /Users/rah/agentpay/scripts/build-merge.mjs
npx wrangler pages deploy public --project-name=richard-hein-portfolio
```

The portfolio `static/_worker.js` has the `/agentpay/` SPA fallback and
`src/components/Nav.jsx` has the nav link (same pattern as `/x402market/`).

## REST API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | — | Service + Stripe + registry status |
| `POST /wallets` | — | Create wallet, returns `token` + `recoveryCode` once |
| `POST /wallets/recover` | recovery code | Reset the wallet token |
| `GET /wallets/me` | `apw_` | Wallet, agents, ledger, receipts |
| `POST /wallets/me/agents` | `apw_` | Mint agent key (`key` shown once) |
| `POST /wallets/me/agents/:id/rotate` | `apw_` | New agent key, old one invalidated |
| `PATCH /wallets/me/agents/:id/policy` | `apw_` | Set approval threshold + tool allowlist |
| `GET /wallets/me/approvals` | `apw_` | Pending and decided approval requests |
| `POST /wallets/me/approvals/:id/approve` · `…/deny` | `apw_` | Decide an approval |
| `POST /wallets/me/agents/:id/revoke` | `apw_` | Revoke an agent |
| `POST /wallets/me/topup` | `apw_` | Stripe Checkout URL |
| `POST /wallets/me/topup/claim` | `apw_` | Credit after Checkout return |
| `POST /wallets/me/plan/checkout` | `apw_` | Pro subscription Checkout URL |
| `POST /wallets/me/plan/portal` | `apw_` | Stripe billing portal URL |
| `GET /wallets/me/export.csv?kind=` | `apw_` | Pro: CSV of receipts or ledger |
| `POST /agent/plan-link` | `agp_` | Upgrade URL an agent can hand to the owner |
| `POST /wallets/me/attestations` · `POST /agent/attestation` | owner / `agp_` | Signed proof-of-spend attestation |
| `GET /attestations/key` · `POST /attestations/verify` | — | Public key + verification (offline capable) |
| `GET/PUT/DELETE /wallets/me/webhooks` · `…/webhooks/rotate` · `…/webhooks/test` · `…/webhooks/redeliver` | `apw_` | Alert webhook config, rotation, test, redelivery |
| `POST /wallets/me/reports` · `GET /wallets/me/reports` · `POST …/reports/:token/revoke` | `apw_` | Pro: shareable spend report links |
| `GET /reports/:token` | — | Public report (JSON or HTML) |
| `POST /wallets/me/agents/:id/subagents` | `apw_` | Dashboard variant of sub-agent minting |
| `POST/GET /agent/subagents` · `POST /agent/subagents/:id/revoke` | `agp_` | Delegate + manage scoped child keys |
| `GET /services` · `GET /services/:id` · `GET /services/:id/quote?tool=` | — | x402market discovery + live 402 quote |
| `GET /agent/me` | `agp_` | Balance + agent identity |
| `POST /agent/spend` | `agp_` | Debit + receipt |
| `POST /agent/topup-link` | `agp_` | Checkout URL to hand to a human |
| `POST /agent/pay-service` | `agp_` | Quote, charge, settle x402 on BSV, return seller result |
| `GET /agent/transactions` · `GET /agent/receipts/:id` | `agp_` | History |
| `GET /bounties` · `GET /bounties/:id` | — | BSVBounties marketplace listings (proxied) |
| `POST /bounties/:id/claim` · `POST /bounties/:id/submit` | `agp_` | Claim + submit work, linked to this wallet |
| `GET /agent/bounties` | `agp_` | Claims made through agentpay, with settle status |
| `POST /agent/bounties` | `agp_` | Post a bounty funded from the balance, escrowed on-chain |
| `GET /agent/bounties/escrows` | `agp_` | Funded bounties: escrow address, txids, pending errors |
| `POST /agent/bounties/:id/settle` · `…/retry` | `agp_` | Poster decides (paid/refunded); or retry a blocked payout |
| `POST /internal/bounty-event` | shared secret | BSVBounties settle callback (payout trigger/credit) |
| `POST /webhooks/stripe` | Stripe sig | Idempotent top-up fulfillment |

## MCP tools

`health` · `get_balance` · `create_topup_link` · `create_upgrade_link` ·
`mint_subagent` · `list_subagents` · `revoke_subagent` · `get_attestation` ·
`list_services` · `service_quote` · `spend` · `pay_service` · `get_receipt` ·
`list_transactions` · `list_bounties` · `get_bounty` · `claim_bounty` ·
`submit_work` · `my_bounties` · `post_bounty` · `settle_bounty` · `my_escrows`

Public tools need no auth. Wallet tools take the agent key as
`Authorization: Bearer agp_…` on the MCP connection or as the `key` parameter.
`spend` and `pay_service` accept `approvalId`; when an agent's policy threshold
is crossed they return 402 `approval_required` with an approval URL, and the
retry settles once a human approves.

Cursor / any MCP client:

```json
{
  "mcpServers": {
    "agentpay": {
      "url": "https://entangleit.com/api/agentpay/mcp",
      "headers": { "Authorization": "Bearer agp_…" }
    }
  }
}
```

## Rules this repo follows

- `StripeClient` instances only; dynamic payment methods.
- Webhooks required; fulfillment gated on `payment_status`; event/session-id idempotency.
- Guarded atomic debits; no overdraft, no negative balances, ever.
- Agent keys and wallet tokens stored hashed; raw values shown once. Recovery codes hashed too.
- Every spend = ledger event + receipt; every top-up = ledger event; failed x402 = one refund keyed by receipt id.
- x402 payloads carry the full v2 envelope; signed txs attach their parent tx; the seller broadcasts via ARC (agentpay never broadcasts).
- x402 buys only confirmed UTXOs, never reuses a txid (random OP_RETURN nonce), and refunds exactly once per charge (refund keyed by receipt id, replay guard on settled txids).
- Agent policies are enforced server-side: tool allowlists and approval thresholds apply to both `spend` and `pay_service`. Approvals are consumed exactly once and only at settlement, so a funding failure never burns a human approval.

## Treasury operations

`GET /health` reports `x402.treasury` (address, sats, threshold, `low`) from a
5-minute cache built on spent-filtered UTXOs. Fund the site wallet before it
drops below `X402_MIN_TREASURY_SATS` (default `5000`) or paid calls start
failing with a funding error. Threshold banding: each 10-sat tool costs 10 sats
plus the flat fee (30 sats default), so 5,000 sats ≈ 125 calls of headroom.
- Secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SITE_WALLET_WIF`) never in git; production never charges test mode.

## Agent economy primitives

**Sub-agent budgets (delegation).** A top-level agent mints scoped child keys —
own lifetime budget, expiry, daily limit, tool allowlist — and can list/revoke
them. Children cannot mint children; revoking a parent revokes its children.
Budget or expiry exhaustion fails closed (`subagent_budget` / `subagent_expired`)
and writes receipts exactly like any other spend. Plan caps count children.

**Alerts (webhook + email).** Per-wallet webhook with HMAC-signed deliveries
(`X-Agentpay-Signature: sha256=HMAC(secret, timestamp.body)`) for
`approval_required`, `approval_decided`, `spend`, `low_balance`, and
`budget_exhausted`. Failures land in a delivery log with one-click redelivery;
when `RESEND_API_KEY` is set, approvals and low balances also email the wallet
owner.

**Shareable spend reports (Pro).** `POST /wallets/me/reports` mints a revocable,
expiring token that renders totals, per-service spend, and receipts as JSON or a
standalone HTML page — ready to send to a client.

**Proof-of-spend attestations.** `POST /agent/attestation` returns an ECDSA
P-256 / SHA-256 signature over the wallet's settled activity (payments, distinct
services, spend, refunds, bounty payouts + earned cents, first/last payment). Sellers verify offline with the
public key from `GET /attestations/key`, or via `POST /attestations/verify`, and
can price trust (discounts for proven payers). Signing uses the
`ATTESTATION_KEY_JWK` secret and is skipped entirely when unset.

**Earning (BSVBounties bridge).** Agents browse and claim paid work on
[BSVBounties](https://entangleit.com/bsvbounties) with the same key they spend:
`list_bounties` → `claim_bounty` → `submit_work`. A claim made through agentpay
is linked to the wallet; when bsv-bounties settles the bounty it posts a signed
event to `POST /internal/bounty-event` and the reward is credited to the wallet
balance (sats → cents at `BOUNTY_SATS_PER_CENT`, default 40000 = $25/BSV).
Credits are idempotent on `bounty:<id>`, so settle replays cannot double-pay.

**Posting with on-chain escrow.** `post_bounty` debits the wallet and broadcasts
a real sats escrow from the treasury to a fresh per-bounty key (AES-GCM
encrypted under `BOUNTY_ESCROW_KEY`), then lists it on BSVBounties under the
`agentpay` funding rail. `settle_bounty` (paid/refunded) makes bsv-bounties emit
the settle event; agentpay then spends the escrow output: paid sends the worker
their net (their balance via a treasury sweep, or a raw BSV `payoutAddress`)
plus the platform fee (`BOUNTY_FEE_BPS`, default 2%), refunded sweeps it back and
re-credits the poster. Blocked payouts (missing address, index lag) land in
`my_escrows` as `payout_pending` and clear with `…/retry`.

**Selling to agents.** The companion **x402 Seller Kit** turns any API into a
paid x402 endpoint in minutes and lists it in
[x402market](https://entangleit.com/x402market/); agents pay it with
`pay_service`. For a zero-ops hosted endpoint (auth injection, replay guard,
analytics), use the [x402 Gateway](https://entangleit.com/x402gateway/).

## Roadmap

- Multi-rail settlement beyond BSV (for sellers that advertise other x402 networks).
- Key expiry + rotation schedules for top-level agents (children already expire).
- Cascading budgets: let a parent's daily limit account for its sub-agents' spend.
- Nested delegation (sub-agents minting sub-agents) with intersected scopes.
