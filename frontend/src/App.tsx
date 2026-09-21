import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  formatCents,
  type AgentInfo,
  type HealthResponse,
  type ReportLinkInfo,
  type ServicesResponse,
  type WalletResponse,
  type WebhookResponse,
} from "./api";

const TOKEN_KEY = "agentpay_token";

/** GIS ID-token callback payload and our /auth/google response shape. */
interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleSignInResult {
  token: string;
  walletId: string;
  name: string;
  email: string;
  isNew: boolean;
  recoveryCode: string | null;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (opts: { client_id: string; callback: (resp: GoogleCredentialResponse) => void }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}

/** Lazy-load the Google Identity Services script (only when login is configured). */
let gsiPromise: Promise<void> | null = null;
function loadGsi(): Promise<void> {
  if (typeof window !== "undefined" && window.google?.accounts?.id) return Promise.resolve();
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google sign-in"));
    document.head.appendChild(script);
  });
  return gsiPromise;
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [data, setData] = useState<WalletResponse | null>(null);
  const [services, setServices] = useState<ServicesResponse | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"wallet" | "agents" | "services">("wallet");
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [highlightApproval, setHighlightApproval] = useState("");
  // Google sign-in state. The ID token lives in component state only — never
  // in localStorage — and is kept solely to power "link an existing wallet".
  const [googleIdentity, setGoogleIdentity] = useState<{ name: string; email: string } | null>(null);
  const [googleIdToken, setGoogleIdToken] = useState<string | null>(null);

  const signOut = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setData(null);
    setGoogleIdentity(null);
    setGoogleIdToken(null);
    setNotice("");
    setError("");
    try {
      window.google?.accounts.id.disableAutoSelect();
    } catch {
      // GIS is optional — sign-out must work without it.
    }
  }, []);

  const refresh = useCallback(
    async (tok: string | null = token) => {
      void api<HealthResponse>("/health")
        .then(setHealth)
        .catch(() => undefined);
      if (!tok) return;
      setLoading(true);
      try {
        setData(await api<WalletResponse>("/wallets/me", { token: tok }));
        setError("");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) signOut();
        else setError(message(err));
      } finally {
        setLoading(false);
      }
    },
    [token, signOut],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const approval = params.get("approval");
    if (approval) {
      setTab("wallet");
      setHighlightApproval(approval);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("topup") === "cancelled" || params.get("topup") === "cancel") {
      window.history.replaceState({}, "", window.location.pathname);
      setNotice("Top-up cancelled — nothing was charged.");
      return;
    }
    if (params.get("topup") !== "success") return;
    const sessionId = params.get("session_id");
    window.history.replaceState({}, "", window.location.pathname);
    if (!sessionId) return;
    void (async () => {
      try {
        const res = await api<{ credited: boolean; amountCents: number; balanceCents: number }>(
          "/wallets/me/topup/claim",
          { method: "POST", token, body: { sessionId } },
        );
        setNotice(
          res.credited
            ? `Top-up credited: ${formatCents(res.amountCents)}. New balance ${formatCents(res.balanceCents)}.`
            : "That top-up was already credited.",
        );
        void refresh();
      } catch (err) {
        setError(message(err));
      }
    })();
  }, [token, refresh]);

  const loadServices = useCallback(async () => {
    try {
      setServices(await api<ServicesResponse>("/services"));
    } catch (err) {
      setError(message(err));
    }
  }, []);

  const startUpgrade = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api<{ url: string }>("/wallets/me/plan/checkout", { method: "POST", token });
      window.location.href = res.url;
    } catch (err) {
      setError(message(err));
    }
  }, [token]);

  useEffect(() => {
    if (tab === "services" && !services) void loadServices();
  }, [tab, services, loadServices]);

  // Pro Checkout return (?plan=success): the webhook activates the plan, so poll
  // briefly instead of assuming the redirect means the subscription is live.
  useEffect(() => {
    if (!token) return undefined;
    const params = new URLSearchParams(window.location.search);
    const planParam = params.get("plan");
    const replace = () => window.history.replaceState({}, "", window.location.pathname);

    if (params.get("upgrade") === "1") {
      replace();
      setNotice("Pro raises agent keys to 25, per-agent daily limits to $1,000, and unlocks CSV export.");
      return undefined;
    }
    if (params.get("billing") === "return") {
      replace();
      return undefined;
    }
    if (planParam === "cancel") {
      replace();
      setNotice("Upgrade cancelled — nothing was charged.");
      return undefined;
    }
    if (planParam !== "success") return undefined;

    replace();
    setNotice("Payment received — activating Pro when Stripe's webhook lands…");
    let tries = 0;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      tries += 1;
      const fresh = await api<WalletResponse>("/wallets/me", { token }).catch(() => null);
      if (fresh) {
        setData(fresh);
        if (fresh.plan.active) {
          setNotice("agentpay Pro is active — higher limits unlocked.");
          return;
        }
      }
      if (tries < 8) setTimeout(() => void tick(), 2500);
      else setNotice("Still waiting on Stripe — hit Refresh in a moment.");
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <a className="brand" href="/agentpay/">
            agent<span>pay</span>
          </a>
          <p className="tagline">Prepaid USD wallets and MCP payment tools for AI agents.</p>
        </div>
        {data && (
          <div className="topRight">
            {googleIdentity && (
              <div className="balance">
                <span className="balanceLabel">Signed in</span>
                <span className="balanceValue">{googleIdentity.name}</span>
              </div>
            )}
            <div className="balance">
              <span className="balanceLabel">Balance</span>
              <span className="balanceValue">{formatCents(data.wallet.balanceCents)}</span>
            </div>
            <button className="ghost" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button className="ghost" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {notice && (
        <div className="banner ok" onClick={() => setNotice("")}>
          {notice}
        </div>
      )}
      {error && (
        <div className="banner bad" onClick={() => setError("")}>
          {error}
        </div>
      )}
      {health?.x402.treasury?.low && (
        <div className="banner warn">
          Site treasury is low: <strong>{health.x402.treasury.sats?.toLocaleString("en-US") ?? "?"} sats</strong>{" "}
          (warn below {health.x402.treasury.thresholdSats.toLocaleString("en-US")}). Paid x402 calls will fail
          until it's funded — send BSV to <code>{health.x402.treasury.address}</code>.
        </div>
      )}

      {!token && (
        <CreateWallet
          onCreated={(tok) => {
            localStorage.setItem(TOKEN_KEY, tok);
            setToken(tok);
          }}
          onGoogleIdentity={(res, idToken) => {
            setGoogleIdentity({ name: res.name, email: res.email });
            setGoogleIdToken(idToken);
          }}
        />
      )}

      {token && googleIdToken && (
        <LinkWallet idToken={googleIdToken} onLinked={() => void refresh()} />
      )}

      {token && data && (
        <>
          <nav className="tabs">
            <button className={tab === "wallet" ? "tab active" : "tab"} onClick={() => setTab("wallet")}>
              Wallet
            </button>
            <button className={tab === "agents" ? "tab active" : "tab"} onClick={() => setTab("agents")}>
              Agents
            </button>
            <button className={tab === "services" ? "tab active" : "tab"} onClick={() => setTab("services")}>
              Services
            </button>
          </nav>

          {tab === "wallet" && (
            <>
              {data.agents.length === 0 && (
                <QuickStartCard
                  data={data}
                  token={token}
                  onChanged={() => void refresh()}
                  onNotice={setNotice}
                  onError={setError}
                />
              )}
              <PlanCard data={data} token={token} onUpgrade={startUpgrade} onError={setError} />
              <ApprovalsCard
                data={data}
                token={token}
                highlightId={highlightApproval}
                onChanged={() => void refresh()}
                onError={setError}
              />
              <TopupCard data={data} token={token} onNotice={setNotice} onError={setError} />
              <AlertsCard
                token={token}
                plan={data.plan}
                onUpgrade={startUpgrade}
                onError={setError}
                onNotice={setNotice}
              />
              <ConnectAgentCard onManageKeys={() => setTab("agents")} />
              <section className="card">
                <h2>
                  Ledger
                  {!data.plan.limits.exportCsv && <span className="pill">CSV export · Pro</span>}
                </h2>
                <LedgerTable
                  data={data}
                  token={token}
                  canExport={data.plan.limits.exportCsv}
                  onUpgrade={startUpgrade}
                  onError={setError}
                />
              </section>
            </>
          )}

          {tab === "agents" && (
            <>
              <AgentsCard
                data={data}
                token={token}
                onChanged={() => void refresh()}
                onError={setError}
                onUpgrade={startUpgrade}
              />
              <ConnectAgentCard onManageKeys={() => setTab("agents")} />
            </>
          )}

          {tab === "services" && (
            <ServicesPanel data={services} onReload={() => void loadServices()} />
          )}
        </>
      )}

      <footer className="footer">
        <span>
          agentpay · <a href="https://github.com/auxon">github.com/auxon</a> · card payments on Cloudflare
        </span>
        <span>
          Part of <a href="https://entangleit.com/">EntangleIT</a>:{" "}
          <a href="https://entangleit.com/x402gateway/">x402 Gateway</a> ·{" "}
          <a href="https://entangleit.com/x402market/">x402market</a> ·{" "}
          <a href="https://entangleit.com/bsvbounties/">BSVBounties</a>
        </span>
      </footer>
    </div>
  );
}

function QuickStartCard({
  data,
  token,
  onChanged,
  onNotice,
  onError,
}: {
  data: WalletResponse;
  token: string;
  onChanged: () => void;
  onNotice: (s: string) => void;
  onError: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const funded = data.wallet.balanceCents >= 500;
  const endpoint = mcpEndpoint();

  async function fund() {
    setBusy(true);
    try {
      const res = await api<{ url: string }>("/wallets/me/topup", {
        method: "POST",
        token,
        body: { amountCents: 500 },
      });
      window.location.href = res.url;
    } catch (err) {
      onError(message(err));
      setBusy(false);
    }
  }

  async function mint() {
    setBusy(true);
    try {
      const res = await api<{ key: string }>("/wallets/me/agents", {
        method: "POST",
        token,
        body: { name: "starter", dailyLimitCents: 500, approvalAboveCents: 100 },
      });
      setKey(res.key);
      onNotice("Starter key minted — paste it into your agent's MCP config below.");
      onChanged();
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card hero">
      <h1>Get an agent spending in 2 minutes</h1>
      <ol className="steps">
        <li className={funded ? "done" : "now"}>
          <strong>Fund $5.00</strong> with a card via Stripe.
          {!funded && (
            <button className="primary" disabled={busy} onClick={() => void fund()}>
              {busy ? "Opening…" : "Fund $5.00"}
            </button>
          )}
        </li>
        <li className={!funded ? "" : key ? "done" : "now"}>
          <strong>Mint a starter key</strong> — $5/day limit, approvals above $1.
          {funded && !key && (
            <button className="primary" disabled={busy} onClick={() => void mint()}>
              {busy ? "Minting…" : "Mint starter key"}
            </button>
          )}
        </li>
        <li className={key ? "now" : ""}>
          <strong>Connect</strong> — paste the key into your agent's MCP config.
        </li>
      </ol>
      {key && (
        <>
          <CopyField label="Starter key (agp_… — shown once)" value={key} />
          <CodeBlock
            code={`claude mcp add --transport http agentpay ${endpoint} \\\n  --header "Authorization: Bearer ${key}"`}
          />
          <p className="fine">
            opencode / Cursor / VS Code / curl variants with this key embedded are in{" "}
            <strong>Connect your agent</strong> below — or hand the key to the agent and tell it to call the{" "}
            <code>onboard</code> tool first.
          </p>
        </>
      )}
    </section>
  );
}

/** GIS "Sign in with Google" button. Renders only when /auth/google/config says configured. */
function GoogleSignInButton({ onSignedIn }: { onSignedIn: (res: GoogleSignInResult, idToken: string) => void }) {
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState("");
  const btnRef = useRef<HTMLDivElement>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await api<{ configured: boolean; clientId: string | null }>("/auth/google/config").catch(
        () => null,
      );
      if (!cfg?.configured || !cfg.clientId || cancelled) return;
      try {
        await loadGsi();
      } catch (err) {
        if (!cancelled) setError(message(err));
        return;
      }
      if (cancelled || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: cfg.clientId,
        callback: (resp: GoogleCredentialResponse) => {
          void (async () => {
            setError("");
            try {
              const res = await api<GoogleSignInResult>("/auth/google", {
                method: "POST",
                body: { idToken: resp.credential },
              });
              onSignedInRef.current(res, resp.credential);
            } catch (err) {
              setError(message(err));
            }
          })();
        },
      });
      setConfigured(true);
      if (btnRef.current) {
        window.google.accounts.id.renderButton(btnRef.current, {
          theme: "outline",
          size: "large",
          text: "signin_with",
          width: 280,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!configured && !error) return null;
  return (
    <div>
      {configured && <div ref={btnRef} />}
      {error && <div className="banner bad">{error}</div>}
    </div>
  );
}

/** Attach a wallet created the old way (token) to the signed-in Google identity. */
function LinkWallet({ idToken, onLinked }: { idToken: string; onLinked: () => void }) {
  const [open, setOpen] = useState(false);
  const [walletToken, setWalletToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api<{ ok: boolean; walletId: string }>("/auth/google/link", {
        method: "POST",
        body: { idToken, walletToken: walletToken.trim() },
      });
      setWalletToken("");
      setOpen(false);
      onLinked();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <button className="ghost" type="button" onClick={() => setOpen(!open)}>
        {open ? "Cancel linking" : "Already have a wallet? Link it to this Google account"}
      </button>
      {open && (
        <form className="form" onSubmit={submit}>
          <label>
            Wallet token (apw_…)
            <input
              value={walletToken}
              onChange={(e) => setWalletToken(e.target.value)}
              placeholder="apw_…"
              required
            />
          </label>
          {error && <div className="banner bad">{error}</div>}
          <button className="primary" disabled={busy} type="submit">
            {busy ? "Linking…" : "Link wallet"}
          </button>
          <p className="fine">Links the wallet to your Google identity — no data moves.</p>
        </form>
      )}
    </section>
  );
}

function CreateWallet({
  onCreated,
  onGoogleIdentity,
}: {
  onCreated: (token: string) => void;
  onGoogleIdentity: (res: GoogleSignInResult, idToken: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ token: string; recoveryCode: string } | null>(null);
  const [showRecover, setShowRecover] = useState(false);
  const [recoverId, setRecoverId] = useState("");
  const [recoverCode, setRecoverCode] = useState("");
  const [recoverBusy, setRecoverBusy] = useState(false);
  const [recoverError, setRecoverError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ token: string; recoveryCode: string }>("/wallets", {
        method: "POST",
        body: { name: name || "My agent wallet", email },
      });
      setCreated({ token: res.token, recoveryCode: res.recoveryCode });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function recover(e: React.FormEvent) {
    e.preventDefault();
    setRecoverBusy(true);
    setRecoverError("");
    try {
      const res = await api<{ token: string }>("/wallets/recover", {
        method: "POST",
        body: { walletId: recoverId.trim(), recoveryCode: recoverCode.trim() },
      });
      onCreated(res.token);
    } catch (err) {
      setRecoverError(message(err));
    } finally {
      setRecoverBusy(false);
    }
  }

  if (created) {
    return (
      <section className="card hero">
        <h1>Wallet created</h1>
        <p>
          Two secrets, each shown <strong>once</strong>. Store both in a password manager: the token opens the
          wallet; the recovery code resets the token if it is ever lost.
        </p>
        <CopyField label="Wallet token (apw_…)" value={created.token} />
        <CopyField label="Recovery code (apr_…)" value={created.recoveryCode} />
        <button className="primary" onClick={() => onCreated(created.token)}>
          I stored both — open my wallet
        </button>
      </section>
    );
  }

  return (
    <section className="card hero">
      <h1>Card payments for AI agents</h1>
      <p>
        Create a wallet, top it up with a card via Stripe, then mint scoped agent keys. Agents spend from the
        wallet through the REST API or MCP — with daily limits, BSV x402 settlement, and a receipt for every call.
      </p>
      <p className="fine">
        Free includes 3 agent keys and $50/agent daily limits. Pro is $29/mo for 25 keys, $1,000/agent limits, and
        CSV export.
      </p>
      <form className="form" onSubmit={submit}>
        <label>
          Wallet name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme agent budget" />
        </label>
        <label>
          Email (optional — for your records)
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ops@example.com"
          />
        </label>
        {error && <div className="banner bad">{error}</div>}
        <button className="primary" disabled={busy} type="submit">
          {busy ? "Creating…" : "Create wallet"}
        </button>
      </form>

      <button className="ghost" type="button" onClick={() => setShowRecover(!showRecover)}>
        {showRecover ? "Cancel recovery" : "Recover an existing wallet"}
      </button>

      <p className="fine">— or —</p>
      <GoogleSignInButton
        onSignedIn={(res, idToken) => {
          // Record the identity + ID token first (never in localStorage);
          // new wallets show the one-time recovery screen before proceeding.
          onGoogleIdentity(res, idToken);
          if (res.isNew && res.recoveryCode) setCreated({ token: res.token, recoveryCode: res.recoveryCode });
          else onCreated(res.token);
        }}
      />

      {showRecover && (
        <form className="form" onSubmit={recover}>
          <label>
            Wallet id
            <input value={recoverId} onChange={(e) => setRecoverId(e.target.value)} placeholder="apw_…" required />
          </label>
          <label>
            Recovery code
            <input
              value={recoverCode}
              onChange={(e) => setRecoverCode(e.target.value)}
              placeholder="apr_…"
              required
            />
          </label>
          {recoverError && <div className="banner bad">{recoverError}</div>}
          <button className="primary" disabled={recoverBusy} type="submit">
            {recoverBusy ? "Recovering…" : "Issue a new wallet token"}
          </button>
        </form>
      )}

      <p className="fine">
        No signup, no password. The wallet token is the credential — the recovery code is the only way back in.
      </p>
    </section>
  );
}

function PlanCard({
  data,
  token,
  onUpgrade,
  onError,
}: {
  data: WalletResponse;
  token: string;
  onUpgrade: () => void;
  onError: (s: string) => void;
}) {
  const plan = data.plan;
  const [busy, setBusy] = useState(false);
  const activeAgents = data.agents.filter((a) => a.active).length;
  const canceled = plan.subscribedPlan === "pro" && !plan.active;

  async function portal() {
    setBusy(true);
    try {
      const res = await api<{ url: string }>("/wallets/me/plan/portal", { method: "POST", token });
      window.location.href = res.url;
    } catch (err) {
      onError(message(err));
      setBusy(false);
    }
  }

  const badge = plan.active ? "Pro" : canceled ? `Pro · ${plan.status}` : "Free";

  return (
    <section className={`card planCard${plan.active ? " pro" : ""}`}>
      <div className="planHead">
        <h2>
          Plan <span className={`pill${plan.active ? " topup" : canceled ? " debit" : ""}`}>{badge}</span>
        </h2>
        {plan.active ? (
          <span className="muted">
            {plan.cancelAtPeriodEnd ? "Cancels" : "Renews"}{" "}
            {plan.currentPeriodEnd ? new Date(plan.currentPeriodEnd).toLocaleDateString() : "—"} ·{" "}
            {activeAgents}/{plan.limits.maxAgents} agent keys
          </span>
        ) : (
          <span className="muted">
            {activeAgents}/{plan.limits.maxAgents} agent keys · daily limits up to{" "}
            {formatCents(plan.limits.maxDailyLimitCents)}/agent
          </span>
        )}
      </div>

      {plan.active ? (
        <>
          <p className="muted">
            Pro is active: {plan.limits.maxAgents} agent keys, {formatCents(plan.limits.maxDailyLimitCents)} per-agent
            daily limits, and CSV export of your ledger and receipts.
          </p>
          <div className="row">
            <button className="ghost" disabled={busy} onClick={() => void portal()}>
              {busy ? "Opening…" : "Manage billing"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            {canceled
              ? "Your Pro subscription is no longer active. Reactivate to restore Pro limits."
              : "You're on Free. Upgrade for teams running agents with real budgets."}
          </p>
          <div className="planGrid">
            <div className="planMini">
              <strong>Free</strong>
              <ul>
                <li>3 agent keys</li>
                <li>$50 per-agent daily limits</li>
                <li>Approvals, receipts, API + MCP</li>
              </ul>
            </div>
            <div className="planMini pro">
              <strong>
                Pro · {formatCents(plan.priceCents)}
                <span className="per">/mo</span>
              </strong>
              <ul>
                <li>25 agent keys</li>
                <li>$1,000 per-agent daily limits</li>
                <li>CSV export of ledger + receipts</li>
              </ul>
            </div>
          </div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={onUpgrade}>
              {canceled ? `Reactivate Pro — ${formatCents(plan.priceCents)}/mo` : `Upgrade to Pro — ${formatCents(plan.priceCents)}/mo`}
            </button>
            {canceled && (
              <button className="ghost" disabled={busy} onClick={() => void portal()}>
                Manage billing
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ExportButtons({ token, onError }: { token: string; onError: (s: string) => void }) {
  const [busy, setBusy] = useState<"receipts" | "ledger" | null>(null);

  async function download(kind: "receipts" | "ledger") {
    setBusy(kind);
    try {
      const res = await fetch(`/api/agentpay/wallets/me/export.csv?kind=${kind}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `agentpay-${kind}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button className="ghost" disabled={busy !== null} onClick={() => void download("receipts")}>
        {busy === "receipts" ? "Exporting…" : "Export receipts CSV"}
      </button>
      <button className="ghost" disabled={busy !== null} onClick={() => void download("ledger")}>
        {busy === "ledger" ? "Exporting…" : "Export ledger CSV"}
      </button>
    </>
  );
}

function ApprovalsCard({
  data,
  token,
  highlightId,
  onChanged,
  onError,
}: {
  data: WalletResponse;
  token: string;
  highlightId: string;
  onChanged: () => void;
  onError: (s: string) => void;
}) {
  const pending = data.approvals.filter((a) => a.status === "pending").length;

  async function decide(id: string, approve: boolean) {
    try {
      await api(`/wallets/me/approvals/${encodeURIComponent(id)}/${approve ? "approve" : "deny"}`, {
        method: "POST",
        token,
        body: approve ? {} : { reason: "denied by owner" },
      });
      onChanged();
    } catch (err) {
      onError(message(err));
    }
  }

  return (
    <section className="card">
      <h2>
        Approvals {pending > 0 && <span className="pill debit">{pending} pending</span>}
      </h2>
      <p className="muted">
        Purchases at or above an agent's approval threshold wait here. Approve one, then the agent retries with
        the <code>approvalId</code> to complete it (single use, 15-minute window).
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Agent</th>
            <th>Amount</th>
            <th>For</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.approvals.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                No approval requests yet.
              </td>
            </tr>
          )}
          {data.approvals.map((a) => {
            const agent = data.agents.find((x) => x.id === a.agentId)?.name ?? "—";
            return (
              <tr key={a.id} className={a.id === highlightId ? "highlight" : ""}>
                <td className="nowrap">{formatWhen(a.createdAt)}</td>
                <td>{agent}</td>
                <td>{formatCents(a.amountCents)}</td>
                <td>
                  {a.description}
                  {a.service ? ` (${a.service}${a.tool ? `/${a.tool}` : ""})` : ""}
                </td>
                <td>
                  <span
                    className={`pill ${
                      a.status === "approved" || a.status === "consumed"
                        ? "topup"
                        : a.status === "pending"
                          ? ""
                          : "debit"
                    }`}
                  >
                    {a.status}
                  </span>
                </td>
                <td className="right">
                  {a.status === "pending" && (
                    <>
                      <button className="primary" onClick={() => void decide(a.id, true)}>
                        Approve
                      </button>{" "}
                      <button className="danger" onClick={() => void decide(a.id, false)}>
                        Deny
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function TopupCard({
  data,
  token,
  onNotice,
  onError,
}: {
  data: WalletResponse;
  token: string;
  onNotice: (s: string) => void;
  onError: (s: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);

  async function topup(amountCents: number) {
    setBusy(true);
    try {
      const res = await api<{ url: string }>("/wallets/me/topup", {
        method: "POST",
        token,
        body: { amountCents },
      });
      window.location.href = res.url;
    } catch (err) {
      onError(message(err));
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Add funds</h2>
      <p className="muted">
        Card payment via Stripe Checkout. The balance is credited the moment the webhook lands.
      </p>
      <div className="row">
        {data.topup.presets.map((cents) => (
          <button key={cents} className="primary" disabled={busy} onClick={() => void topup(cents)}>
            {formatCents(cents)}
          </button>
        ))}
        <span className="rowDivider">or</span>
        <input
          className="inlineInput"
          inputMode="decimal"
          placeholder="$ amount"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <button
          className="ghost"
          disabled={busy || !custom}
          onClick={() => {
            const cents = Math.round(Number.parseFloat(custom) * 100);
            if (!Number.isFinite(cents) || cents < data.topup.minCents || cents > data.topup.maxCents) {
              onError(
                `Enter an amount between ${formatCents(data.topup.minCents)} and ${formatCents(data.topup.maxCents)}.`,
              );
              return;
            }
            void topup(cents);
          }}
        >
          Top up
        </button>
      </div>
      <p className="fine">
        Lifetime top-ups: {formatCents(data.wallet.lifetimeTopupCents)} · {data.wallet.stripeCustomer ? "Stripe customer on file" : "no Stripe customer yet"}
      </p>
      <p className="fine" onClick={() => onNotice("")}>
        Wallet id: <code>{data.wallet.id}</code>
      </p>
    </section>
  );
}

function AlertsCard({
  token,
  plan,
  onUpgrade,
  onError,
  onNotice,
}: {
  token: string;
  plan: WalletResponse["plan"];
  onUpgrade: () => void;
  onError: (s: string) => void;
  onNotice: (s: string) => void;
}) {
  const [data, setData] = useState<WebhookResponse | null>(null);
  const [reports, setReports] = useState<ReportLinkInfo[] | null>(null);
  const [reportBase, setReportBase] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["approval_required", "low_balance"]);
  const [lowBalance, setLowBalance] = useState("5.00");
  const [secret, setSecret] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [attestation, setAttestation] = useState("");
  const [attBusy, setAttBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [hookRes, reportRes] = await Promise.all([
        api<WebhookResponse>("/wallets/me/webhooks", { token }),
        api<{ reports: ReportLinkInfo[]; baseUrl: string }>("/wallets/me/reports", { token }),
      ]);
      setData(hookRes);
      setReports(reportRes.reports);
      setReportBase(reportRes.baseUrl);
      if (hookRes.webhook) {
        setUrl((current) => current || hookRes.webhook!.url);
        setEvents(hookRes.webhook.events);
        setLowBalance((hookRes.webhook.lowBalanceCents / 100).toFixed(2));
      }
    } catch (err) {
      onError(message(err));
    }
  }, [token, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleEvent(name: string) {
    setEvents((list) => (list.includes(name) ? list.filter((e) => e !== name) : [...list, name]));
  }

  async function save() {
    setBusy(true);
    try {
      const cents = Math.round(Number.parseFloat(lowBalance) * 100);
      const res = await api<{ secret?: string }>("/wallets/me/webhooks", {
        method: "PUT",
        token,
        body: { url, events, lowBalanceCents: Number.isFinite(cents) ? cents : undefined },
      });
      if (res.secret) setSecret(res.secret);
      onNotice("Alert webhook saved.");
      await load();
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; statusCode: number | null; error: string }>(
        "/wallets/me/webhooks/test",
        { method: "POST", token },
      );
      if (res.ok) onNotice(`Test event delivered (HTTP ${res.statusCode}).`);
      else onError(`Test failed: ${res.error || `HTTP ${res.statusCode}`}`);
      await load();
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    try {
      const res = await api<{ secret: string }>("/wallets/me/webhooks/rotate", { method: "POST", token });
      setSecret(res.secret);
      onNotice("New signing secret issued — update your receiver.");
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Remove this alert webhook?")) return;
    setBusy(true);
    try {
      await api("/wallets/me/webhooks", { method: "DELETE", token });
      setSecret("");
      setEvents(["approval_required", "low_balance"]);
      onNotice("Webhook removed.");
      await load();
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function redeliver() {
    setBusy(true);
    try {
      const res = await api<{ attempted: number; delivered: number; remaining: number }>(
        "/wallets/me/webhooks/redeliver",
        { method: "POST", token },
      );
      onNotice(`Redelivered ${res.delivered}/${res.attempted} — ${res.remaining} still failing.`);
      await load();
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function createReport() {
    if (!plan.limits.exportCsv) {
      onUpgrade();
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ url: string }>("/wallets/me/reports", {
        method: "POST",
        token,
        body: { label: label || undefined },
      });
      setLabel("");
      await navigator.clipboard.writeText(res.url).catch(() => undefined);
      onNotice("Report link created and copied — anyone with the URL can view it until it expires.");
      await load();
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeReport(reportToken: string) {
    setBusy(true);
    try {
      await api(`/wallets/me/reports/${encodeURIComponent(reportToken)}/revoke`, { method: "POST", token });
      onNotice("Report link revoked.");
      await load();
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function generateAttestation() {
    setAttBusy(true);
    try {
      const res = await api<unknown>("/wallets/me/attestations", {
        method: "POST",
        token,
        body: { days: 30 },
      });
      setAttestation(JSON.stringify(res, null, 2));
      onNotice("Signed attestation generated — share it with sellers, verify at /attestations/verify.");
    } catch (err) {
      onError(message(err));
    } finally {
      setAttBusy(false);
    }
  }

  const failures = data?.deliveries.filter((d) => !d.deliveredAt) ?? [];

  return (
    <section className="card">
      <h2>Alerts &amp; reports</h2>
      <p className="muted">
        Get notified when an agent needs approval or the balance runs low, and turn receipts into a shareable spend
        report for clients.
      </p>

      {secret && (
        <div className="secret">
          <strong>Signing secret — shown once</strong>
          <CopyField label="Webhook secret (awh_…)" value={secret} />
          <span className="fine">
            Verify with HMAC-SHA256(secret, `timestamp.body`) and reject timestamps older than five minutes.
          </span>
        </div>
      )}

      <div className="alertGrid">
        <div>
          <h3 className="miniHead">Webhook</h3>
          <div className="field">
            <label>Delivery URL</label>
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.example.com/agentpay"
              spellCheck={false}
            />
          </div>
          <div className="checks">
            {["approval_required", "approval_decided", "spend", "low_balance"].map((name) => (
              <label key={name}>
                <input type="checkbox" checked={events.includes(name)} onChange={() => toggleEvent(name)} />
                {name}
              </label>
            ))}
          </div>
          <div className="field">
            <label>Low balance threshold ($)</label>
            <input
              className="input"
              value={lowBalance}
              onChange={(e) => setLowBalance(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="row">
            <button className="primary" disabled={busy || !url} onClick={() => void save()}>
              Save webhook
            </button>
            {data?.webhook && (
              <>
                <button className="ghost" disabled={busy} onClick={() => void test()}>
                  Send test
                </button>
                <button className="ghost" disabled={busy} onClick={() => void rotate()}>
                  Rotate secret
                </button>
                <button className="danger" disabled={busy} onClick={() => void remove()}>
                  Remove
                </button>
              </>
            )}
          </div>
          {data?.emailConfigured && <p className="fine">Email alerts are enabled for the wallet's email address.</p>}
          {data?.webhook?.lastError && <div className="banner bad">Last delivery failed: {data.webhook.lastError}</div>}
          {data && data.deliveries.length > 0 && (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Event</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deliveries.slice(0, 6).map((d) => (
                    <tr key={d.id}>
                      <td className="nowrap">{formatWhen(d.createdAt)}</td>
                      <td>
                        <span className="pill">{d.event}</span>
                      </td>
                      <td>
                        {d.deliveredAt ? (
                          <span className="pos">delivered</span>
                        ) : (
                          <span className="neg">{d.error || "pending"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {failures.length > 0 && (
                <button className="ghost" disabled={busy} onClick={() => void redeliver()}>
                  Redeliver failed ({failures.length})
                </button>
              )}
            </>
          )}
        </div>

        <div>
          <h3 className="miniHead">
            Spend reports {!plan.limits.exportCsv && <span className="pill">Pro</span>}
          </h3>
          <p className="fine">
            A read-only URL with totals, spend by service, and receipts for the last 30 days. Revocable any time.
          </p>
          <div className="row">
            <input
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (e.g. Acme Q3)"
            />
            <button className="primary" disabled={busy} onClick={() => void createReport()}>
              {plan.limits.exportCsv ? "Create report link" : "Upgrade to Pro"}
            </button>
          </div>
          {reports && reports.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Expires</th>
                  <th>Views</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.token}>
                    <td>{r.label || "—"}</td>
                    <td className="nowrap">
                      {r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : "never"}
                    </td>
                    <td>{r.views}</td>
                    <td className="right">
                      <button
                        className="ghost"
                        onClick={() => {
                          void navigator.clipboard.writeText(`${reportBase}${r.token}`).catch(() => undefined);
                          onNotice("Report URL copied.");
                        }}
                      >
                        Copy
                      </button>{" "}
                      {r.revoked ? (
                        <span className="pill debit">revoked</span>
                      ) : (
                        <button className="danger" onClick={() => void revokeReport(r.token)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="miniHead" style={{ marginTop: 18 }}>
            Proof of spend
          </h3>
          <p className="fine">
            A signed summary of this wallet's settled activity that any seller can verify. Useful for pricing trust
            or proving an agent's track record.
          </p>
          <div className="row">
            <button className="ghost" disabled={attBusy} onClick={() => void generateAttestation()}>
              {attBusy ? "Signing…" : "Generate signed attestation"}
            </button>
            {attestation && (
              <button
                className="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(attestation).catch(() => undefined);
                  onNotice("Attestation JSON copied.");
                }}
              >
                Copy JSON
              </button>
            )}
          </div>
          {attestation && <pre className="code attestationCode">{attestation}</pre>}
        </div>
      </div>
    </section>
  );
}

function AgentsCard({
  data,
  token,
  onChanged,
  onError,
  onUpgrade,
}: {
  data: WalletResponse;
  token: string;
  onChanged: () => void;
  onError: (s: string) => void;
  onUpgrade: () => void;
}) {
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("");
  const [approvalAbove, setApprovalAbove] = useState("");
  const [allowedTools, setAllowedTools] = useState("");
  const [busy, setBusy] = useState(false);
  const [newAgent, setNewAgent] = useState<{ name: string; key: string } | null>(null);
  const [subFor, setSubFor] = useState<string | null>(null);

  const topLevel = data.agents.filter((a) => !a.subagent);
  const childrenOf = (id: string) => data.agents.filter((a) => a.subagent?.parentAgentId === id);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const limitCents = limit ? Math.round(Number.parseFloat(limit) * 100) : null;
      const approvalCents = approvalAbove ? Math.round(Number.parseFloat(approvalAbove) * 100) : null;
      const tools = allowedTools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api<{ agent: { name: string }; key: string }>("/wallets/me/agents", {
        method: "POST",
        token,
        body: {
          name,
          dailyLimitCents: limitCents,
          approvalAboveCents: approvalCents,
          allowedTools: tools,
        },
      });
      setNewAgent({ name: res.agent.name, key: res.key });
      setName("");
      setLimit("");
      setApprovalAbove("");
      setAllowedTools("");
      onChanged();
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/wallets/me/agents/${encodeURIComponent(id)}/revoke`, { method: "POST", token });
      onChanged();
    } catch (err) {
      onError(message(err));
    }
  }

  async function rotate(id: string) {
    try {
      const res = await api<{ agent: { name: string }; key: string }>(
        `/wallets/me/agents/${encodeURIComponent(id)}/rotate`,
        { method: "POST", token },
      );
      setNewAgent({ name: res.agent.name, key: res.key });
      onChanged();
    } catch (err) {
      onError(message(err));
    }
  }

  return (
    <section className="card">
      <h2>
        Agents
        <span className="pill">
          {data.agents.filter((a) => a.active).length}/{data.plan.limits.maxAgents} keys
        </span>
      </h2>
      <p className="muted">
        Each agent gets its own key, optional daily limit, and shows up in the ledger. Keys are stored hashed —
        copy them once.
      </p>
      {data.agents.filter((a) => a.active).length >= data.plan.limits.maxAgents && (
        <p className="fine">
          {data.plan.id === "pro" ? "Pro" : "Free"} plan limit reached.{" "}
          {data.plan.id !== "pro" && (
            <button className="linkBtn" onClick={onUpgrade}>
              Upgrade to Pro for 25 keys
            </button>
          )}
        </p>
      )}

      {newAgent && (
        <div className="secret">
          <strong>Key for “{newAgent.name}” — shown once</strong>
          <CopyField label="Agent key (agp_…)" value={newAgent.key} />
          <button className="ghost" onClick={() => setNewAgent(null)}>
            Done — hide it
          </button>
        </div>
      )}

      <form className="form inline" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name (e.g. research-bot)" required />
        <input
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          placeholder="Daily limit $ (blank = none)"
          inputMode="decimal"
        />
        <input
          value={approvalAbove}
          onChange={(e) => setApprovalAbove(e.target.value)}
          placeholder="Approval above $ (blank = never)"
          inputMode="decimal"
        />
        <input
          value={allowedTools}
          onChange={(e) => setAllowedTools(e.target.value)}
          placeholder="Allowed tools (svcId:tool, blank = all)"
        />
        <button className="primary" disabled={busy} type="submit">
          {busy ? "Minting…" : "Mint agent key"}
        </button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Key prefix</th>
            <th>Daily limit</th>
            <th>Budget</th>
            <th>Expires</th>
            <th>Approval above</th>
            <th>Scope</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.agents.length === 0 && (
            <tr>
              <td colSpan={9} className="empty">
                No agents yet — mint a key above.
              </td>
            </tr>
          )}
          {topLevel.map((a) => (
            <Fragment key={a.id}>
              <tr>
                <td>{a.name}</td>
                <td>
                  <code>{a.keyPrefix}…</code>
                </td>
                <td>{a.dailyLimitCents === null ? "—" : formatCents(a.dailyLimitCents)}</td>
                <td>—</td>
                <td>—</td>
                <td>{a.approvalAboveCents === null ? "—" : formatCents(a.approvalAboveCents)}</td>
                <td className="scope">{a.allowedTools.length === 0 ? "all" : a.allowedTools.join(", ")}</td>
                <td>{a.active ? "active" : "revoked"}</td>
                <td className="right">
                  {a.active && (
                    <>
                      <button
                        className="ghost"
                        onClick={() => setSubFor(subFor === a.id ? null : a.id)}
                        title="Mint a scoped child key with its own budget"
                      >
                        Sub-agent
                      </button>{" "}
                    </>
                  )}
                  <button className="ghost" onClick={() => void rotate(a.id)}>
                    Rotate
                  </button>{" "}
                  {a.active && (
                    <button className="danger" onClick={() => void revoke(a.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
              {subFor === a.id && (
                <tr className="subRow">
                  <td colSpan={9}>
                    <SubagentForm
                      parentId={a.id}
                      parentName={a.name}
                      token={token}
                      onError={onError}
                      onCreated={(created) => {
                        setSubFor(null);
                        setNewAgent(created);
                        onChanged();
                      }}
                    />
                  </td>
                </tr>
              )}
              {childrenOf(a.id).map((child) => (
                <SubagentRow key={child.id} child={child} busy={busy} onRotate={rotate} onRevoke={revoke} />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SubagentRow({
  child,
  onRotate,
  onRevoke,
}: {
  child: AgentInfo;
  busy: boolean;
  onRotate: (id: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
}) {
  const sub = child.subagent!;
  const pct = sub.budgetCents ? Math.min(100, Math.round((sub.spentCents / sub.budgetCents) * 100)) : null;
  return (
    <tr className={sub.expired ? "subExpired" : undefined}>
      <td>
        <span className="subName">↳ {child.name}</span>
      </td>
      <td>
        <code>{child.keyPrefix}…</code>
      </td>
      <td>{child.dailyLimitCents === null ? "—" : formatCents(child.dailyLimitCents)}</td>
      <td className="nowrap">
        {formatCents(sub.spentCents)} /{" "}
        {sub.budgetCents === null ? "no cap" : formatCents(sub.budgetCents)}
        {pct !== null && (
          <span className="budgetBar" title={`${pct}% of budget spent`}>
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
      </td>
      <td className="nowrap">
        {sub.expiresAt ? (
          sub.expired ? (
            <span className="neg">expired</span>
          ) : (
            new Date(sub.expiresAt).toLocaleString()
          )
        ) : (
          "—"
        )}
      </td>
      <td>{child.approvalAboveCents === null ? "—" : formatCents(child.approvalAboveCents)}</td>
      <td className="scope">{child.allowedTools.length === 0 ? "all" : child.allowedTools.join(", ")}</td>
      <td>{child.active ? "active" : "revoked"}</td>
      <td className="right">
        <button className="ghost" onClick={() => void onRotate(child.id)}>
          Rotate
        </button>{" "}
        {child.active && (
          <button className="danger" onClick={() => void onRevoke(child.id)}>
            Revoke
          </button>
        )}
      </td>
    </tr>
  );
}

function SubagentForm({
  parentId,
  parentName,
  token,
  onCreated,
  onError,
}: {
  parentId: string;
  parentName: string;
  token: string;
  onCreated: (created: { name: string; key: string }) => void;
  onError: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ agent: { name: string }; key: string }>(
        `/wallets/me/agents/${encodeURIComponent(parentId)}/subagents`,
        {
          method: "POST",
          token,
          body: {
            name,
            budgetCents: budget ? Math.round(Number.parseFloat(budget) * 100) : null,
            dailyLimitCents: dailyLimit ? Math.round(Number.parseFloat(dailyLimit) * 100) : null,
            expiresInMinutes: expires ? Math.round(Number.parseFloat(expires)) : null,
          },
        },
      );
      setName("");
      setBudget("");
      setDailyLimit("");
      setExpires("");
      onCreated({ name: res.agent.name, key: res.key });
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form inline subForm" onSubmit={submit}>
      <span className="fine">
        New sub-agent under <strong>{parentName}</strong>
      </span>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Worker name" required />
      <input
        value={budget}
        onChange={(e) => setBudget(e.target.value)}
        placeholder="Lifetime budget $ (blank = no cap)"
        inputMode="decimal"
      />
      <input
        value={dailyLimit}
        onChange={(e) => setDailyLimit(e.target.value)}
        placeholder="Daily limit $ (blank = none)"
        inputMode="decimal"
      />
      <input
        value={expires}
        onChange={(e) => setExpires(e.target.value)}
        placeholder="Expires in minutes (blank = never)"
        inputMode="numeric"
      />
      <button className="primary" disabled={busy} type="submit">
        {busy ? "Minting…" : "Mint sub-agent"}
      </button>
    </form>
  );
}

function LedgerTable({
  data,
  token,
  canExport,
  onUpgrade,
  onError,
}: {
  data: WalletResponse;
  token: string;
  canExport: boolean;
  onUpgrade: () => void;
  onError: (s: string) => void;
}) {
  return (
    <>
      <div className="row ledgerTools">
        {canExport ? (
          <ExportButtons token={token} onError={onError} />
        ) : (
          <button className="ghost" onClick={onUpgrade} title="CSV export is a Pro feature">
            Export CSV · Pro
          </button>
        )}
      </div>
      <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>Kind</th>
          <th>Amount</th>
          <th>Balance after</th>
          <th>Description</th>
          <th>Ref</th>
        </tr>
      </thead>
      <tbody>
        {data.ledger.length === 0 && (
          <tr>
            <td colSpan={6} className="empty">
              No transactions yet. Add funds to get started.
            </td>
          </tr>
        )}
        {data.ledger.map((l) => (
          <tr key={l.id}>
            <td className="nowrap">{formatWhen(l.createdAt)}</td>
            <td>
              <span className={`pill ${l.kind}`}>{l.type === "bounty_payout" ? "bounty" : l.kind}</span>
            </td>
            <td className={l.amountCents < 0 ? "neg" : "pos"}>{formatCents(l.amountCents)}</td>
            <td>{formatCents(l.balanceAfterCents)}</td>
            <td className="desc" title={l.description || undefined}>
              {l.description || "—"}
            </td>
            <td>
              {l.ref ? (
                <code title={l.ref}>{shortRef(l.ref)}</code>
              ) : (
                "—"
              )}
            </td>
          </tr>
        ))}
      </tbody>
      </table>
    </>
  );
}

function ServicesPanel({ data, onReload }: { data: ServicesResponse | null; onReload: () => void }) {
  if (!data) return <section className="card">Loading services…</section>;
  return (
    <section className="card">
      <h2>
        Paid services <button className="ghost" onClick={onReload}>Reload</button>
      </h2>
      <p className="muted">
        Live from the <a href="https://entangleit.com/x402market/">x402market</a> registry. Agents discover them
        with the <code>list_services</code> and <code>service_quote</code> MCP tools, then pay with{" "}
        <code>pay_service</code>.
      </p>
      {!data.registry && (
        <div className="banner bad">Registry not initialized on this database yet — no listings to show.</div>
      )}
      {data.services.length === 0 && data.registry && <p className="muted">No verified services yet.</p>}
      {data.services.map((s) => (
        <div key={s.id} className="service">
          <div className="serviceHead">
            <strong>
              {s.name} {s.featured && <span className="pill topup">featured</span>}
            </strong>
            <span className="muted">
              {s.network || "x402"} · payTo <code>{s.payTo || "—"}</code>
              {s.minPriceSats !== null ? ` · from ${s.minPriceSats} sats` : ""}
            </span>
          </div>
          {s.tagline && <p>{s.tagline}</p>}
          <ul className="tools">
            {s.tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                <span className="muted">
                  {t.method} {t.paid ? `${t.priceSats} sats` : "free"}
                  {t.description ? ` — ${t.description}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

type ClientId = "opencode" | "claude-code" | "claude-desktop" | "cursor" | "vscode" | "curl";

function mcpEndpoint(): string {
  const { hostname, origin } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "http://localhost:8788/api/agentpay/mcp";
  }
  return `${origin}/api/agentpay/mcp`;
}

function ConnectAgentCard({ onManageKeys }: { onManageKeys: () => void }) {
  const [client, setClient] = useState<ClientId>("opencode");
  const [key, setKey] = useState("");
  const endpoint = mcpEndpoint();
  const auth = `Bearer ${key.trim() || "agp_…"}`;

  const snippets: Record<ClientId, { label: string; hint: string; code: string }> = {
    opencode: {
      label: "opencode",
      hint: "~/.config/opencode/opencode.json (global) or opencode.json in a project — then restart opencode.",
      code: `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agentpay": {
      "type": "remote",
      "url": "${endpoint}",
      "enabled": true,
      "headers": { "Authorization": "${auth}" }
    }
  }
}`,
    },
    "claude-code": {
      label: "Claude Code",
      hint: "Run in your terminal, then restart Claude Code.",
      code: `claude mcp add --transport http agentpay ${endpoint} \\
  --header "Authorization: ${auth}"`,
    },
    "claude-desktop": {
      label: "Claude Desktop",
      hint: "~/Library/Application Support/Claude/claude_desktop_config.json (macOS) — then restart Claude.",
      code: `{
  "mcpServers": {
    "agentpay": {
      "url": "${endpoint}",
      "headers": { "Authorization": "${auth}" }
    }
  }
}`,
    },
    cursor: {
      label: "Cursor",
      hint: "~/.cursor/mcp.json (global) or .cursor/mcp.json in a project.",
      code: `{
  "mcpServers": {
    "agentpay": {
      "url": "${endpoint}",
      "headers": { "Authorization": "${auth}" }
    }
  }
}`,
    },
    vscode: {
      label: "VS Code",
      hint: ".vscode/mcp.json in your workspace (or the user-level mcp.json).",
      code: `{
  "servers": {
    "agentpay": {
      "type": "http",
      "url": "${endpoint}",
      "headers": { "Authorization": "${auth}" }
    }
  }
}`,
    },
    curl: {
      label: "curl",
      hint: "Smoke test any Streamable HTTP MCP server from the terminal.",
      code: `curl -s ${endpoint} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -H 'Authorization: ${auth}' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_balance","arguments":{}}}'`,
    },
  };
  const current = snippets[client];

  return (
    <section className="card">
      <h2>Connect your agent</h2>
      <p className="muted">
        agentpay speaks Streamable HTTP MCP. Discovery tools (<code>list_services</code>,{" "}
        <code>service_quote</code>) need no auth; paste an agent key to embed it in every snippet for wallet
        tools and spending.
      </p>
      <div className="keyRow">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="agp_… (optional)"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="ghost" type="button" onClick={onManageKeys}>
          Mint a key
        </button>
        <span className="fine">
          {key.trim()
            ? "The key is embedded in the snippets below — it is never stored by the dashboard."
            : "Without a key, only public tools work."}
        </span>
      </div>
      <div className="clientTabs">
        {(Object.keys(snippets) as ClientId[]).map((id) => (
          <button
            key={id}
            type="button"
            className={client === id ? "tab active" : "tab"}
            onClick={() => setClient(id)}
          >
            {snippets[id].label}
          </button>
        ))}
      </div>
      <p className="fine">{current.hint}</p>
      <CodeBlock code={current.code} />
      <p className="fine">
        Not listed? Any MCP client that supports Streamable HTTP with headers will work against{" "}
        <code>{endpoint}</code>.
      </p>
    </section>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeWrap">
      <button
        className="ghost copyBtn"
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="code">{code}</pre>
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copyField">
      <span className="copyLabel">{label}</span>
      <code>{value}</code>
      <button
        className="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** SQLite `datetime('now')` and ISO strings both parse; never append a second Z. */
function parseDbDate(value: string): Date | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatWhen(value: string): string {
  const d = parseDbDate(value);
  return d ? d.toLocaleString() : "—";
}

/** Keep the ref column readable: Stripe sessions get a label, long refs middle-truncate. */
function shortRef(ref: string): string {
  if (/^cs_[A-Za-z0-9_]+$/.test(ref)) return "Stripe Checkout";
  if (ref.length <= 26) return ref;
  return `${ref.slice(0, 14)}…${ref.slice(-6)}`;
}
