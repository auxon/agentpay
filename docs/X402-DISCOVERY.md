# Registering agentpay and Fuse with x402 discovery indexes

This is the exact registration surface for **x402 v2** (the protocol now run by the [x402 Foundation](https://github.com/x402-foundation/x402); originally [coinbase/x402](https://github.com/coinbase/x402), documented at [x402.org](https://x402.org)).

agentpay stays on **Bitcoin SV**. The registered CAIP-2 id is `bsv:mainnet` ([`bsv` namespace](https://namespaces.chainagnostic.org/bsv/caip2)). Do **not** advertise the Bitcoin-family genesis `bip122:000000000019d6689c085ae165831e93` — that string is shared with BTC and BCH.

Live worker (no deploy from this change set): `https://entangleit.com/api/agentpay`.

## What to point an indexer at

| Resource | URL | What a crawler should do |
| --- | --- | --- |
| agentpay well-known catalog | `https://entangleit.com/api/agentpay/.well-known/x402` | GET (free). x402scan-compatible `{ version, resources[] }`, plus facilitator URLs and prices. |
| agentpay Bazaar-style catalog | `https://entangleit.com/api/agentpay/discovery/resources` | GET. Spec §8 shape: `{ x402Version, items[], pagination }`. Filter with `type`, `network`, `scheme`, `payTo`, `limit`, `offset`. |
| agentpay paid LLM | `https://entangleit.com/api/agentpay/x402/chat` | GET or unpaid POST → HTTP **402** + `PAYMENT-REQUIRED` (base64 `PaymentRequired`). |
| agentpay paid extract | `https://entangleit.com/api/agentpay/x402/extract` | Same 402 probe. |
| Fuse well-known (canonical LLM) | `https://entangleit.com/fuse/.well-known/x402` | GET. Fuse owns this document; agentpay lists it for convenience. |
| Fuse chat | `https://entangleit.com/fuse/v1/chat/completions` | Unpaid POST → 402. |
| Fuse extract | `https://entangleit.com/fuse/v1/extract` | Unpaid POST → 402. |
| agentpay BSV facilitator | `POST …/api/agentpay/x402/verify` · `POST …/x402/settle` · `GET …/x402/supported` | Spec §7. Aliases: `/verify`, `/settle`, `/supported`, and CDP-style `/v2/x402/verify` + `/v2/x402/settle`. |

`GET /api/agentpay/health` repeats the facilitator and discovery URLs under `x402`.

## 402 challenge (what indexers must parse)

Unpaid `GET`/`POST` on `/x402/chat` and `/x402/extract` returns:

- Status `402`
- Header `PAYMENT-REQUIRED: base64(JSON(PaymentRequired))` (canonical v2 wire location)
- JSON body equal to that object (clients that do not read the header)

Decoded `PaymentRequired`:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://entangleit.com/api/agentpay/x402/chat",
    "description": "Pay-per-call LLM (Fuse) over x402 v2 / BSV exact",
    "mimeType": "application/json",
    "serviceName": "agentpay",
    "tags": ["llm", "chat", "bsv", "x402"],
    "iconUrl": "https://entangleit.com/agentpay/icon.png"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "bsv:mainnet",
      "amount": "600",
      "asset": "BSV",
      "payTo": "<site wallet P2PKH>",
      "maxTimeoutSeconds": 900,
      "extra": {
        "chain": "bsv",
        "unit": "satoshi",
        "lockingScriptHex": "76a914…88ac",
        "perCallSats": 600,
        "payloadFormat": { "kind": "p2pkh-rawtx" },
        "paymentFlow": "upfront",
        "assetTransferMethod": "p2pkh-rawtx",
        "invoiceId": "inv_…",
        "expiresAt": "2026-10-20T00:00:00.000Z",
        "model": "fuse-fast"
      }
    }
  ],
  "extensions": { "bazaar": { "info": { "input": { "type": "http", "method": "POST", "bodyType": "json", "body": {} }, "output": { "type": "json" } }, "schema": {} } }
}
```

`amount` is satoshis as a **string**. `payTo` is a stable merchant P2PKH (the site wallet), not a per-invoice key — indexers that filter by `payTo` keep working. Replay is the settled txid, not address uniqueness.

Paying clients retry with `PAYMENT-SIGNATURE` (and we also accept the v1 `X-PAYMENT` alias). Success carries `PAYMENT-RESPONSE` (and `X-PAYMENT-RESPONSE`).

## Index-by-index registration

### x402scan ([docs/DISCOVERY.md](https://github.com/Merit-Systems/x402scan/blob/main/docs/DISCOVERY.md))

1. Prefer OpenAPI if you have it. agentpay does not ship `/openapi.json` for these routes; use well-known + probe.
2. Register the well-known URL: `https://entangleit.com/api/agentpay/.well-known/x402`.
3. Confirm a probe of `POST https://entangleit.com/api/agentpay/x402/chat` (empty JSON body, no auth) returns **402** with a non-empty `accepts` array and `extensions.bazaar.info`.
4. Repeat for `/x402/extract`.
5. For Fuse, register `https://entangleit.com/fuse/.well-known/x402` and probe the two Fuse URLs above. Runtime 402 is authoritative over the static list.
6. If the product UI still has “endpoint-only” paste, use the four resource URLs in the table.

x402scan marks listings **skipped** when `accepts` is empty or bazaar input schema is missing. Both agentpay paid routes emit them.

### Paymentscan

1. Add the origin `https://entangleit.com`.
2. Point the crawler at `/api/agentpay/.well-known/x402` and `/fuse/.well-known/x402`.
3. If the form asks for a “sample 402 URL”, use `https://entangleit.com/api/agentpay/x402/chat`.
4. Network filter: `bsv:mainnet`. Asset: `BSV`. Scheme: `exact`.
5. Facilitator (optional, for verify/settle of BSV payments): `https://entangleit.com/api/agentpay/x402`.

### agentic.market / CDP Bazaar

CDP’s Bazaar (`GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/…` and the [discover-services](https://docs.cdp.coinbase.com/x402/buyer/discover-services) SDK) indexes resources that settle **through the CDP facilitator**. That facilitator’s production networks are EVM (Base, Polygon, …) and Solana — **not BSV**.

So:

- You **cannot** get an automatic CDP Bazaar listing from BSV `/settle` traffic. There is no CDP `network=bsv:mainnet` catalog.
- Manual / community listing on agentic.market (when they accept a URL): submit `https://entangleit.com/api/agentpay/.well-known/x402` and the Fuse well-known. Describe the rail as `exact` / `bsv:mainnet` / asset `BSV`.
- If a listing form requires a USDC `eip155:8453` accept, skip it — we do not advertise a fake EVM rail.

To appear in CDP Bazaar you would need a second `accepts[]` entry on a CDP-supported network (out of scope; agentpay does not take USDC).

### x402.org facilitator discovery

The public `https://x402.org/facilitator` is testnet-only (Base Sepolia, Solana Devnet). Do not register BSV mainnet there.

Use agentpay’s own facilitator for BSV:

```http
GET  /api/agentpay/x402/supported
POST /api/agentpay/x402/verify
POST /api/agentpay/x402/settle
```

Body for verify/settle is the spec wrapper `{ x402Version: 2, paymentPayload, paymentRequirements }`.

## Fuse vs agentpay (who to list)

| Listing | Owner | `payTo` | When to use |
| --- | --- | --- | --- |
| Fuse chat / extract | Fuse | Fuse’s merchant address | Direct pay-per-call LLM. Canonical for “Fuse”. |
| agentpay `/x402/chat` · `/x402/extract` | agentpay | agentpay site wallet | Generic x402 clients that want the same models without an `agp_…` key. Price is Fuse sats + the broadcast fee. agentpay then pays Fuse from the treasury. |
| agentpay MCP / `/agent/chat` | agentpay | n/a (prepaid wallet) | Not an x402 resource. Do not submit these to 402 indexers. |

Wallet-gated routes (`/agent/chat`, MCP `chat`) stay on the prepaid USD ledger. Their 402s are `approval_required` / insufficient balance — **not** x402 `PaymentRequired`. Do not register them as x402 resources.

## Headers (v2 + v1 aliases)

| Role | v2 (send this) | v1 alias (also accepted / also written) |
| --- | --- | --- |
| Challenge | `PAYMENT-REQUIRED` | (v1 put requirements in the body; we still echo the JSON body) |
| Payment | `PAYMENT-SIGNATURE` | `X-PAYMENT` |
| Settlement | `PAYMENT-RESPONSE` | `X-PAYMENT-RESPONSE` |

## What does not apply to BSV

These v2 spec items are EVM/Solana-shaped and are **not** implemented as-is:

- **EIP-3009 / Permit2 `payload.authorization`** — BSV `exact` carries a signed raw transaction (`payload.rawtx` / `txHex`), discriminator `extra.payloadFormat.kind = "p2pkh-rawtx"` ([BRC-166](https://brc.bsvb.net/brc/166)).
- **`authorization` payment flow as the only flow** — BSV has no pull-settlement primitive. We advertise `extra.paymentFlow: "upfront"`. `/verify` is still implemented (read-only) so servers that call verify-then-settle keep working.
- **Per-invoice receiving keys (BRC-166 §5.4)** — we use a stable `payTo` so indexers can filter by merchant address. Replay is the settled txid (`ap_x402_payments`).
- **CDP facilitator + Bazaar auto-index** — no BSV network on the CDP facilitator (see above).
- **`bip122:<genesis>` as a network id** — refused. Ambiguous with BTC/BCH.
- **Asset-as-contract-address** — native BSV uses asset `"BSV"` (and we still accept legacy `native:BSV`). There is no ERC-20 contract id.
- **Facilitator `signers` for `eip155:*` / `solana:*`** — we only advertise `bsv:*` (the site wallet address).

## Operator checklist (after a future deploy)

1. `curl -sI https://entangleit.com/api/agentpay/x402/chat` → `402` + `PAYMENT-REQUIRED`.
2. `curl -s https://entangleit.com/api/agentpay/.well-known/x402` → four resource URLs.
3. `curl -s https://entangleit.com/api/agentpay/x402/supported` → `kinds[0].network === "bsv:mainnet"`.
4. Paste the well-known URL into x402scan / Paymentscan.
5. Do **not** run `migrations/2026-10-20-ap-sends-wallet-dest.sql` on prod (table already exists). This work adds no schema.
