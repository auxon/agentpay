# MCP Registry publishing — agentpay

**Status: PUBLISHED.** `com.entangleit/agentpay` v0.1.0 is live in the official
registry (namespace verified for `entangleit.com`):

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.entangleit/agentpay"
```

## What was set up (and where it lives)

| Piece | Location | Notes |
| --- | --- | --- |
| `server.json` | `~/agentpay/server.json` | Remote server metadata (100-char description limit!). |
| Publisher CLI | `~/agentpay/.tools/mcp-publisher` | v1.8.1 darwin-arm64, gitignored. |
| Auth keypair | `~/agentpay/.mcp-registry/key.pem` | **Secret.** Ed25519 private key for domain auth. Gitignored. |
| Verification file | `entangleit.com/.well-known/mcp-registry-auth` | Public key only; source: `entangleit/portfolio/static/.well-known/`. |
| Discovery card | `entangleit.com/.well-known/mcp.json` | Machine-readable endpoint card for crawlers. |

The registry supports **domain-based HTTP auth**: the public key is hosted at
`/.well-known/mcp-registry-auth`, and the CLI signs a challenge with the private
key — no browser, no DNS change.

## Re-publishing (version bumps)

```bash
cd ~/agentpay
# 1. edit version (and anything else) in server.json
./.tools/mcp-publisher validate
PRIVATE_KEY="$(openssl pkey -in .mcp-registry/key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
./.tools/mcp-publisher login http --domain entangleit.com --private-key "$PRIVATE_KEY"
./.tools/mcp-publisher publish
```

Do not commit `key.pem` or `.tools/`. Back up `key.pem` somewhere safe; if it is
lost, generate a new pair, redeploy the new `.well-known/mcp-registry-auth`
(public key), log in, and publish again.

## Rules learned

- `description` must be **≤ 100 characters** (validation is strict).
- `name` must be the reverse-DNS namespace you authenticated (`com.entangleit/*`).
- The remote URL must be publicly reachable
  (`https://entangleit.com/api/agentpay/mcp` — verified in production).

## Directory listings beyond the official registry

PulseMCP, Glama, and others ingest the official registry automatically; no extra
submission is normally needed. For Smithery/mcp.so, reuse this blurb:

> agentpay — card-funded prepaid wallets for AI agents. Top up by card via
> Stripe, mint scoped agent keys with daily limits and approval gates, and let
> agents pay any x402 (BSV mainnet) API over MCP with a receipt per call.
> Public discovery tools need no auth. https://entangleit.com/agentpay
