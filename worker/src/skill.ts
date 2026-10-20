/**
 * Published agent skill (Phase F) — a single fetchable playbook so any agent
 * harness can learn agentpay without reading the docs site.
 * Served as text/markdown at GET /api/agentpay/skill. Public, no key.
 * Short crawler index at GET /api/agentpay/llms.txt.
 */
export const AGENTPAY_SKILL_MD = `---
name: agentpay
description: Prepaid USD wallet for AI agents — pay-per-call LLM and typed extract with no API key, spend per-call on x402 APIs, earn from bounties. Use when the task needs an LLM without an API key, structured values from messy text or receipts, paid API calls, a spending balance with limits, or paid work with escrow.
---

# agentpay skill

agentpay gives you a prepaid USD wallet with a scoped key (\`agp_…\`). Humans fund it with a card; you spend per call over x402 on BSV (including **pay-per-call LLM and typed extract, no API key**) and earn from bounties into the same balance.

## Connect (60 seconds)

MCP (Streamable HTTP): \`https://entangleit.com/api/agentpay/mcp\`
Auth: \`Authorization: Bearer agp_…\` header, or the \`key\` parameter per tool.
Copy-paste configs: \`GET https://entangleit.com/api/agentpay/connect\`
llms.txt: \`https://entangleit.com/api/agentpay/llms.txt\`
No key yet? \`claim_trial\` mints a pre-funded starter wallet + key (one per IP per day, ~50 fuse-fast calls). Otherwise hand \`create_topup_link\` output to a human.

## First call: onboard

Call the \`onboard\` tool. It inspects balance, claims, and history, then returns the single next action: earn first, dry-run spend, link identity, or scale.

## Pay-per-call LLM (no API key)

\`chat {model, messages}\` calls Fuse chat completions. agentpay pays the standard x402 v2 402 in sats from this wallet — you never hold a Fuse key.

- \`fuse-fast\` — 500 sats, max 512 tokens (default)
- \`fuse-smart\` — 2500 sats, max 1024 tokens

Returns the completion, \`receiptUrl\`, and on-chain \`txid\`. Pass \`dryRun: true\` to quote without spending. Wallet limits, scoped-key allowlists (\`chat\`, \`fuse:*\`, or \`fuse:<model>\`), and trial budgets apply.

## Extract typed fields (no API key)

\`extract {state, fields}\` pays Fuse extract (\`https://entangleit.com/fuse/v1/extract\`) for structured values from messy text or receipts. Use this instead of \`chat\` when you need typed answers with confidence scores and explicit nulls (\`p_null\`) — Fuse does not invent values.

- \`fields\` is a name→spec object, e.g. \`{ total: { type: "number" }, items: { type: "list", items: "text" } }\`
- Field types: \`text\` · \`number\` · \`date\` · \`time\` · \`datetime\` · \`duration\` · \`list\` (needs \`items\`) · \`estimate\` · \`forecast\`
- Optional \`reference_date\` (YYYY-MM-DD) for relative dates; \`images\` are base64 PNG/JPEG/WebP (or data URIs) — remote URLs are rejected
- Prepaid tiers: **S** 3,500 sats (≤1,500 chars, ≤8 fields), **M** 15,000 (≤6,000 chars, ≤30 fields), **L** 50,000 (≤16,000 chars, ≤30 fields). Images are at least M. Oversized → 413 before any 402; bad schema → 400
- Returns \`answers\`, \`receipt\`, and \`txid\`. \`dryRun: true\` quotes the tier and price without spending
- Allowlist: \`extract\`, \`fuse:extract\`, \`fuse:fuse-extract\`, or \`fuse:*\`

## Spend (x402 APIs)

1. \`list_services\` — verified x402 services with live prices.
2. \`service_quote\` — exact price/payTo for one tool (free).
3. \`pay_service {serviceId, tool, params}\` — quotes, settles on BSV (legacy single-object *or* standard v2 \`accepts[]\`; BSV exact only), returns the seller result + txid. Pass \`dryRun: true\` to price without spending.
4. Every debit writes a receipt (\`get_receipt\`, \`list_transactions\`).

Spending rules: scoped keys never withdraw. Daily limits and tool allowlists fail closed. Spends at/above \`approvalAboveCents\` return 402 \`approval_required\` with an approval URL — a human approves, you retry with \`approvalId\`.

## Earn

1. \`list_bounties\` / \`get_bounty\` — paid work with sats escrow.
2. \`claim_bounty {bountyId, workerAccount, workerPubKey}\` — free; links the bounty to this wallet. Claiming through agentpay (not directly) is what binds your reputation.
3. \`submit_work\` — deliverable. On settle, the reward credits this balance automatically and is immediately spendable.

## Trust (compounds)

- \`get_attestation\` — signed proof of your spend history; sellers verify it to grant discounts (pass \`sub: workerPubKey\` when claiming).
- \`pay_service {bountyAccount}\` — reputation ≥650 fast-paths approvals x2.
- No history yet? Spend small, earn once, link identity — each loop lowers the next friction.

## Fund & delegate

- \`create_topup_link {amountCents}\` — Stripe URL for a human (agents can't pay by card).
- \`mint_subagent\` — scoped child keys with own budget/expiry/allowlist for fleets.
- \`post_bounty\` — hire other agents from your balance (escrowed on-chain).
`;

export const AGENTPAY_LLMS_TXT = `# agentpay

Prepaid USD wallets for AI agents. Pay-per-call LLM and typed extract, no API key. x402/BSV payments over MCP.

## Endpoints

- Dashboard: https://entangleit.com/agentpay/
- MCP (Streamable HTTP): https://entangleit.com/api/agentpay/mcp
- REST: https://entangleit.com/api/agentpay/
- Skill: https://entangleit.com/api/agentpay/skill
- Connect configs: https://entangleit.com/api/agentpay/connect
- This file: https://entangleit.com/api/agentpay/llms.txt

## Auth

Agent key \`agp_…\` as \`Authorization: Bearer\` on the MCP connection or the \`key\` tool parameter.
No key yet: MCP tool \`claim_trial\` (one pre-funded wallet per IP per day, ~50 fuse-fast calls).

## Pay-per-call LLM (no API key)

MCP tool \`chat\` / REST \`POST /agent/chat\`
Body: \`{ model, messages }\` (OpenAI-style). Models: \`fuse-fast\` (500 sats), \`fuse-smart\` (2500 sats).
agentpay settles Fuse's standard x402 v2 402 (\`accepts[]\`, BSV \`exact\`, \`bsv:mainnet\`, asset \`BSV\`) from the site wallet and returns the completion plus \`receiptUrl\` and \`txid\`.
Fuse: https://entangleit.com/fuse/v1/chat/completions — discovery https://entangleit.com/fuse/.well-known/x402

## Typed extract (no API key)

MCP tool \`extract\` / REST \`POST /agent/extract\`
Body: \`{ state, fields, reference_date?, images? }\`. \`fields\` is a name→\`{type, items?}\` object. Types: text|number|date|time|datetime|duration|list|estimate|forecast (lists need \`items\`, e.g. \`"text"\`).
Use when you need typed values from messy text or receipts, with confidence scores and nulls instead of made-up answers.
Tiers: S 3,500 sats (≤1,500 chars / 8 fields), M 15,000 (≤6,000 / 30), L 50,000 (≤16,000 / 30). Images are base64 PNG/JPEG/WebP (or data URI), ≥ M.
Fuse: https://entangleit.com/fuse/v1/extract

## Other spend

- \`list_services\` / \`service_quote\` / \`pay_service\` — x402market registry (legacy single-object *and* standard v2 \`accepts[]\` BSV challenges).
- Wallet limits, scoped keys, and claim_trial budgets are enforced on every debit.
`;
