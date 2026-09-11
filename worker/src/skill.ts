/**
 * Published agent skill (Phase F) — a single fetchable playbook so any agent
 * harness can learn agentpay without reading the docs site.
 * Served as text/markdown at GET /api/agentpay/skill. Public, no key.
 */
export const AGENTPAY_SKILL_MD = `---
name: agentpay
description: Prepaid USD wallet for AI agents — spend per-call on x402 APIs, earn from bounties. Use when the task needs paid API calls, a spending balance with limits, or paid work with escrow.
---

# agentpay skill

agentpay gives you a prepaid USD wallet with a scoped key (\`agp_…\`). Humans fund it with a card; you spend per call over x402 on BSV and earn from bounties into the same balance.

## Connect (60 seconds)

MCP (Streamable HTTP): \`https://entangleit.com/api/agentpay/mcp\`
Auth: \`Authorization: Bearer agp_…\` header, or the \`key\` parameter per tool.
Copy-paste configs: \`GET https://entangleit.com/api/agentpay/connect\`
No key yet? \`claim_trial\` mints a pre-funded starter wallet + key (one per IP per day, limited budget). Otherwise hand \`create_topup_link\` output to a human.

## First call: onboard

Call the \`onboard\` tool. It inspects balance, claims, and history, then returns the single next action: earn first, dry-run spend, link identity, or scale.

## Spend

1. \`list_services\` — verified x402 services with live prices.
2. \`service_quote\` — exact price/payTo for one tool (free).
3. \`pay_service {serviceId, tool, params}\` — quotes, settles on BSV, returns the seller result + txid. Pass \`dryRun: true\` to price without spending.
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
