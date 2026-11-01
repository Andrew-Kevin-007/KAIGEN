"use client";

import { useState, type FormEvent } from "react";
import { hasContract, isEra, view, yoctoToNear, type Era, type QueuedWithdrawal, type VaultConfig } from "@/lib/near";
import { useWallet } from "@/lib/wallet";

const RANK: Record<Era, number> = { Calm: 0, Warning: 1, Kaigen: 2 };
const ERA_TONE: Record<Era, "valid" | "warning" | "invalid"> = { Calm: "valid", Warning: "warning", Kaigen: "invalid" };

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
  queue: QueuedWithdrawal[];
  spent: string;
  /** What Kizashi says now. The vault only learns it when someone calls `trip`. */
  kizashiEra: Era;
}

const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;

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

  async function trip(id: string) {
    setTripState("sending");
    setTripError("");
    try {
      // `trip` reserves 200 Tgas for its callback, so the transaction carries 250.
      await wallet.call({ receiver: id, method: "trip", gasTgas: 250 });
      setTripState("sent");
    } catch (err) {
      setTripState("idle");
      setTripError(err instanceof Error ? err.message : String(err));
    }
  }

  async function lookup(e: FormEvent) {
    e.preventDefault();
    const id = account.trim().toLowerCase();
    setError("");
    setVault(null);
    if (!ACCOUNT.test(id)) return setError("That is not a valid NEAR account name.");
    setBusy(true);
    try {
      if (!(await hasContract(id))) throw new Error("No contract is deployed on that account, so it is not a vault.");
      const [config, keys, queue, spent] = await Promise.all([
        view<VaultConfig>(id, "config"),
        view<string[]>(id, "daily_keys"),
        view<QueuedWithdrawal[]>(id, "queue"),
        view<string>(id, "spent_24h", { token: null }),
      ]);
      const kizashiEra = await view<unknown>(config.kizashi, "era");
      if (!isEra(kizashiEra)) throw new Error("Kizashi returned an era this page does not know.");
      // A contract that answers these views with something else is not a KAIGEN vault.
      if (!isEra(config?.era) || !Array.isArray(keys) || !Array.isArray(queue)) throw new Error("That contract does not look like a KAIGEN vault.");
      setVault({ account: id, config, keys, queue, spent, kizashiEra });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const pqOnly = vault ? vault.config.era === "Kaigen" && vault.keys.length === 0 : false;
  const used = vault ? usedPercent(vault.spent, vault.config.daily_limit) : 0;

  return (
    <div className="container page">
      <header className="page-head reading">
        <h1>Look up a vault</h1>
        <p className="lead">Read-only. Enter a vault account to see its era, limits, keys and queued withdrawals.</p>
      </header>

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
            placeholder="name.near"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            aria-invalid={Boolean(error) && !vault}
          />
        </div>
        <button type="submit" className="btn btn-secondary" disabled={busy || !account.trim()}>
          {busy ? "Looking..." : "Look up"}
        </button>
      </form>

      {error && (
        <div className="reading" style={{ marginTop: "1.25rem" }}>
          <p role="alert" className="callout" data-tone="invalid">
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
              <span className="chip" data-tone={pqOnly ? "valid" : ERA_TONE[vault.config.era]}>
                {pqOnly ? "Post-quantum only" : `Era: ${vault.config.era}`}
              </span>
            </div>
            <dl className="kv">
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
                  <button type="button" className="btn" onClick={wallet.connect} disabled={wallet.busy}>
                    Connect a wallet to trip
                  </button>
                )}
              </div>
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
    </div>
  );
}
