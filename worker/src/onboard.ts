/**
 * Agent onboarding — one tool that answers "what do I do next?".
 *
 * New agents face three unknowns: do I have money, do I have history, and
 * is my work identity linked. nextStep() reduces wallet state to a single
 * stage + concrete action so a first-run agent is productive in one call.
 * Pure logic (no I/O) so it unit-tests without a database.
 */

export interface OnboardState {
  balanceCents: number;
  /** Distinct linked bounty accounts (via agentpay claims). */
  linkedAccounts: number[];
  /** Claimed-but-unsettled + settled links. */
  claims: number;
  /** Settled + credited links (proof of earnings). */
  paidClaims: number;
  /** Wallet has settled payments to attest (spend history). */
  hasHistory: boolean;
}

export type OnboardStage = "earn_first" | "spend_first" | "link_account" | "scale";

export interface OnboardNext {
  stage: OnboardStage;
  headline: string;
  action: string;
  tool: string;
  args?: Record<string, unknown>;
  /** Human step required (agent cannot do this itself). */
  needsHuman?: string;
  then: string;
}

export function nextStep(s: OnboardState): OnboardNext {
  if (s.balanceCents <= 0 && s.paidClaims <= 0) {
    return {
      stage: "earn_first",
      headline: "Zero balance and no earnings yet — earn first, it's free.",
      action: "Browse open bounties and claim one through agentpay (claiming costs nothing).",
      tool: "list_bounties",
      args: { status: "open" },
      then: "claim_bounty with your workerAccount/workerPubKey, do the work, submit_work. The reward lands here on settle — then spend it.",
    };
  }
  if (!s.hasHistory) {
    return {
      stage: "spend_first",
      headline: "Funded but no spend history — validate with a dry run.",
      action: "Quote a service with dryRun:true (free, no debit), then run it for real to start building attestable history.",
      tool: "pay_service",
      args: { dryRun: true },
      then: "Repeat real pay_service calls; get_attestation becomes available and sellers start discounting you.",
    };
  }
  if (s.linkedAccounts.length === 0) {
    return {
      stage: "link_account",
      headline: "Spending history exists but no work identity is linked.",
      action: "Claim your next bounty through agentpay with workerAccount/workerPubKey so reputation fast-paths your approvals.",
      tool: "claim_bounty",
      then: "pay_service with bountyAccount unlocks approval x2 and full bond discounts.",
    };
  }
  return {
    stage: "scale",
    headline: "Earning and spending with linked trust — scale up.",
    action: "Pay with bountyAccount for approval fast-path, post bounties to hire other agents, delegate with mint_subagent.",
    tool: "pay_service",
    args: { bountyAccount: s.linkedAccounts[0] },
    then: "Track everything in list_transactions / my_bounties; top up via create_topup_link when low.",
  };
}
