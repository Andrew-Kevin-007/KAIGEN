"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { NotDeployed } from "@/components/NotDeployed";
import { WalletError } from "@/components/WalletError";
import { Walkthrough } from "@/components/Walkthrough";
import { isAccountId } from "@/lib/account";
import { describedBy } from "@/lib/aria";
import { DEPLOYMENTS } from "@/lib/config";
import { kizashiRole } from "@/lib/deployments";
import { errorText } from "@/lib/errors";
import { latestOnly } from "@/lib/latest";
import { KIZASHI_ID, hasContract, isEra, rpcNetworkProblem, view, yoctoToNear, type Era, type QueuedWithdrawal, type VaultConfig } from "@/lib/near";
import { NETWORK } from "@/lib/network";
import { accountFromSearch } from "@/lib/onboarding";
import { isMissingView, lockdownOf, vaultShapeProblem } from "@/lib/vault-shape";
import { useWallet } from "@/lib/wallet";

const RANK: Record<Era, number> = { Calm: 0, Warning: 1, Kaigen: 2 };

/** Share of the 24 hour limit already used, as 0 to 100. A zero or unreadable limit reads as nothing used. */
function usedPercent(spent: string, limit: string): number {
  try {
    const cap = BigInt(limit);
    if (cap <= 0n) return 0;
    const pct = Number((BigInt(spent) * 1000n) / cap) / 10;
    return Math.min(100, Math.max(0, pct));
  } catch {
    return 0;
  }
}

interface Loaded {
  account: string;
  config: VaultConfig;
  keys: string[];
  /** Daily keys the vault no longer serves whose deletion from the account is not confirmed; null when this vault's build has no such view. */
  revoked: string[] | null;
  /** Keys this vault put on intents.near, which lockdown must also remove; null when the vault has no such view. */
  intents: string[] | null;
  queue: QueuedWithdrawal[];
  spent: string;
  /** What Kizashi says now. The vault only learns it when someone calls `trip`. */
  kizashiEra: Era;
}

/** A view an older vault build may not have: its answer, or null when the vault says the method does not exist. Any other failure is thrown. */
async function optionalKeyList(id: string, method: string, signal: AbortSignal): Promise<unknown> {
  try {
    return await view<unknown>(id, method, {}, signal);
  } catch (e) {
    if (isMissingView(e)) return null;
    throw e;
  }
}

const fmtDelay = (secs: number) => {
  if (secs < 60) return `${secs} s`;
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  return secs % 3600 === 0 ? `${secs / 3600} h` : `${(secs / 3600).toFixed(1)} h`;
};
const fmtTime = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString();

export default function VaultPage() {
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [vault, setVault] = useState<Loaded | null>(null);
  const wallet = useWallet();
  const [tripState, setTripState] = useState<"idle" | "sending" | "sent">("idle");
  const [tripError, setTripError] = useState("");
  // Only the newest lookup, and the trip for the vault now on screen, may change the page; anything older is dropped.
  const [lookups] = useState(latestOnly);
  const [trips] = useState(latestOnly);
  const inFlight = useRef<AbortController | null>(null);

  // Leaving the page ends any lookup still waiting on the network.
  useEffect(
    () => () => {
      lookups.invalidate();
      trips.invalidate();
      inFlight.current?.abort();
    },
    [lookups, trips],
  );

  async function trip(id: string) {
    const current = trips.begin();
    setTripState("sending");
    setTripError("");
    try {
      // `trip` reserves 200 Tgas for its callback, so the transaction carries 250.
      await wallet.call({ receiver: id, method: "trip", gasTgas: 250 });
      if (current()) setTripState("sent");
    } catch (err) {
      if (!current()) return;
      setTripState("idle");
      setTripError(errorText(err, "The wallet did not complete the request."));
    }
  }

  function lookup(e: FormEvent) {
    e.preventDefault();
    void runLookup(account);
  }

  // /start (and any link) can open this page with ?account=<vault>: fill the box and read it once.
  useEffect(() => {
    const id = accountFromSearch(window.location.search);
    if (!id) return;
    setAccount(id);
    void runLookup(id);
    // Once, on arrival: runLookup only uses state that never changes identity (latestOnly handles and refs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runLookup(raw: string) {
    const id = raw.trim().toLowerCase();
    // A new lookup replaces the old one: its answer, its network calls and the trip state that belonged to its vault.
    inFlight.current?.abort();
    const current = lookups.begin();
    trips.invalidate();
    setError("");
    setVault(null);
    setTripState("idle");
    setTripError("");
    if (!isAccountId(id)) {
      setBusy(false);
      return setError("That is not a valid NEAR account name.");
    }
    setBusy(true);
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    try {
      // Ask the RPC which network it serves before reading anything from it: a testnet node must never be shown as production.
      const wrongNetwork = await rpcNetworkProblem(ctrl.signal);
      if (wrongNetwork) throw new Error(wrongNetwork);
      if (!(await hasContract(id, ctrl.signal))) throw new Error("No contract is deployed on that account, so it is not a vault.");
      const [config, keys, queue, spent, revoked, intents] = await Promise.all([
        view<unknown>(id, "config", {}, ctrl.signal),
        view<unknown>(id, "daily_keys", {}, ctrl.signal),
        view<unknown>(id, "queue", {}, ctrl.signal),
        view<unknown>(id, "spent_24h", { token: null }, ctrl.signal),
        optionalKeyList(id, "revoked_keys", ctrl.signal),
        optionalKeyList(id, "intents_keys", ctrl.signal),
      ]);
      // A contract that answers these views with something else is not a KAIGEN vault. Checked before any field is read.
      const problem = vaultShapeProblem({ config, keys, queue, spent, revoked, intents });
      if (problem) throw new Error(problem);
      const vaultConfig = config as VaultConfig;
      const kizashiEra = await view<unknown>(vaultConfig.kizashi, "era", {}, ctrl.signal);
      if (!isEra(kizashiEra)) throw new Error("Kizashi returned an era this page does not know.");
      if (!current()) return;
      setVault({
        account: id,
        config: vaultConfig,
        keys: keys as string[],
        revoked: (revoked ?? null) as string[] | null,
        intents: (intents ?? null) as string[] | null,
        queue: queue as QueuedWithdrawal[],
        spent: spent as string,
        kizashiEra,
      });
    } catch (err) {
      if (current()) setError(errorText(err, "That vault could not be read."));
    } finally {
      if (current()) setBusy(false);
    }
  }

  const lockdown = vault ? lockdownOf({ era: vault.config.era, daily: vault.keys.length, revoked: vault.revoked?.length ?? null, intents: vault.intents?.length ?? null }) : null;
  const role = vault ? kizashiRole(vault.config.kizashi, DEPLOYMENTS) : "other";
  const used = vault ? usedPercent(vault.spent, vault.config.daily_limit) : 0;

  return (
    <div className="container page">
      <header className="page-head reading">
        <h1>Look up a vault</h1>
        <p className="lead">Read-only. Enter a vault account to see its era, limits, keys and queued withdrawals.</p>
      </header>

      {!KIZASHI_ID && (
        <div style={{ marginBottom: "1.5rem" }}>
          <NotDeployed>Kizashi is not deployed yet on {NETWORK}. You can still read any vault, but none of them can be checked against this site&apos;s Kizashi.</NotDeployed>
        </div>
      )}

      <p className="sr-only" role="status">
        {vault ? `Loaded ${vault.account}. Era ${vault.config.era}. ${vault.keys.length} daily keys, ${vault.queue.length} queued withdrawals.` : ""}
      </p>

      <form className="inline-form reading" onSubmit={lookup} noValidate>
        <div className="field-group">
          <label className="label" htmlFor="vault-account">
            Vault account
          </label>
          <input
            id="vault-account"
            className="field"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder={NETWORK === "testnet" ? "name.testnet" : "name.near"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            aria-invalid={Boolean(error) && !vault}
            aria-describedby={describedBy(Boolean(error) && !vault && "lookup-error")}
          />
        </div>
        {/* Not disabled while looking: a lookup that hangs can be started again, and the newer one wins. */}
        <button type="submit" className="btn btn-secondary" disabled={!account.trim()}>
          {busy ? "Looking..." : "Look up"}
        </button>
      </form>

      {error && (
        <div className="reading" style={{ marginTop: "1.25rem" }}>
          <p id="lookup-error" role="alert" className="callout" data-tone="invalid">
            {error}
          </p>
        </div>
      )}

      {busy && !vault && (
        <p className="small body" style={{ marginTop: "1.25rem" }}>
          Loading...
        </p>
      )}

      {vault && (
        <div className="section" style={{ marginTop: "3rem" }}>
          <div className="panel" aria-label="Vault summary" role="group">
            <div className="split">
              <span className="mono">{vault.account}</span>
              <span className="chip" data-tone={lockdown?.tone}>
                {lockdown?.label}
              </span>
            </div>
            <dl className="kv">
              <div className="wide">
                <dt>Follows Kizashi</dt>
                <dd>
                  <span className="mono">{vault.config.kizashi}</span>
                  <span className="small body" style={{ display: "block", fontWeight: 400 }}>
                    {role === "production"
                      ? "This site's Kizashi."
                      : role === "drill"
                        ? "The drill Kizashi: a rehearsal, not production."
                        : KIZASHI_ID
                          ? `Not the Kizashi this site watches (${KIZASHI_ID}). The era above comes from a contract this site cannot vouch for.`
                          : "This site has no Kizashi to check it against yet, so the era above comes from a contract this site cannot vouch for."}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Classical daily keys</dt>
                <dd>{vault.keys.length}</dd>
              </div>
              <div>
                <dt>Queued withdrawals</dt>
                <dd>{vault.queue.length}</dd>
              </div>
              <div>
                <dt>24 hour limit</dt>
                <dd>{yoctoToNear(vault.config.daily_limit, 2)} NEAR</dd>
              </div>
              <div>
                <dt>Used in the last 24 hours</dt>
                <dd>
                  {yoctoToNear(vault.spent, 2)} NEAR ({used}%)
                </dd>
              </div>
              <div className="wide">
                <dt>Withdrawal delay</dt>
                <dd>
                  {fmtDelay(vault.config.effective_delay_secs)}
                  {vault.config.effective_delay_secs !== vault.config.delay_secs ? (
                    <span className="small body" style={{ display: "block", fontWeight: 400 }}>
                      Doubled from {fmtDelay(vault.config.delay_secs)} because the era is not calm.
                    </span>
                  ) : (
                    <span className="small body" style={{ display: "block", fontWeight: 400 }}>
                      Larger sends wait this long, and the admin can cancel until then.
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          <section className="stack" aria-labelledby="keys-h">
            <h2 id="keys-h">Classical daily keys</h2>
            {vault.keys.length === 0 ? (
              <p className="body">None. Either none were added, or this vault has already locked down.</p>
            ) : (
              <ul className="rows">
                {vault.keys.map((k) => (
                  <li key={k}>
                    <span className="mono">{k}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="stack" aria-labelledby="queue-h">
            <h2 id="queue-h">Queued withdrawals</h2>
            {vault.queue.length === 0 ? (
              <p className="body">Nothing waiting.</p>
            ) : (
              <ul className="rows">
                {vault.queue.map((w) => (
                  <li key={w.id}>
                    <span className="row-title">
                      <span className="num">{w.token ? `${w.amount} of ${w.token}` : `${yoctoToNear(w.amount, 2)} NEAR`}</span>
                    </span>
                    <span className="row-detail">
                      To <span className="mono">{w.to}</span>
                    </span>
                    <span className="small body">Unlocks {fmtTime(w.unlocks_at)}. The admin can cancel until then.</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {RANK[vault.kizashiEra] > RANK[vault.config.era] || (vault.kizashiEra === "Kaigen" && vault.keys.length > 0) ? (
            <section className="panel reading" aria-labelledby="trip-h">
              <span className="chip" data-tone="warning" style={{ justifySelf: "start" }}>
                Behind the era
              </span>
              <h2 id="trip-h" data-trip-heading>
                Trip this vault
              </h2>
              <p className="body">
                Kizashi says <strong>{vault.kizashiEra}</strong>, and this vault has not caught up. Anyone can call <span className="mono">trip</span>: it reads the era from Kizashi
                and, at kaigen, deletes this vault&apos;s classical keys. You pay only the gas.
              </p>
              <div className="actions">
                {wallet.account ? (
                  <button type="button" className="btn" onClick={() => trip(vault.account)} disabled={tripState === "sending"}>
                    {tripState === "sending" ? "Waiting for your wallet..." : "Trip now"}
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={wallet.connect} disabled={wallet.busy} aria-describedby={describedBy(wallet.error && "trip-wallet-error")}>
                    Connect a wallet to trip
                  </button>
                )}
              </div>
              <WalletError id="trip-wallet-error" />
              {tripState === "sent" && (
                <p role="status" className="callout" data-tone="valid">
                  Sent. Look the vault up again in a minute to see its keys gone.
                </p>
              )}
              {tripError && (
                <p role="alert" className="callout" data-tone="invalid">
                  {tripError}
                </p>
              )}
            </section>
          ) : null}
        </div>
      )}

      <Walkthrough />
    </div>
  );
}
