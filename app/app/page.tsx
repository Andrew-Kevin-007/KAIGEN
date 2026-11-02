"use client";

import { useEffect, useState } from "react";
import { DrillTable } from "@/components/DrillTable";
import { DEPLOYMENTS } from "@/lib/config";
import { DRILL_KIZASHI_ID, KIZASHI_ID, chainId, isEra, view, yoctoToNear, type Bounty, type Era, type Omen } from "@/lib/near";
import { NETWORK, networkProblem, type Network } from "@/lib/network";

// Every state names the contract it belongs to, so switching networks can never show the other one's data.
type State =
  | { status: "unconfigured" }
  | { status: "loading"; contract: string }
  | { status: "error"; contract: string; message: string }
  // `stale` is set when the latest refresh failed: the last good reading stays on screen, flagged.
  | { status: "ready"; contract: string; network: Network; era: Era; omens: Omen[]; bounty: Bounty; stale?: string };

const POLL_MS = 30_000;

const COPY: Record<Era, { line: string; detail: string }> = {
  Calm: {
    line: "No omen has broken.",
    detail: "Vaults keep their classical daily keys, each capped by its 24 hour limit and withdrawal delay.",
  },
  Warning: {
    line: "An early-warning omen has broken.",
    detail: "Vault sends and withdrawal requests are paused, and queued withdrawals stay frozen. The admin can still cancel them. Post-quantum admin keys are unaffected.",
  },
  Kaigen: {
    line: "An omen key has broken.",
    detail: "Anyone can now call trip on a vault. It deletes that vault's classical keys, leaving the post-quantum admin key.",
  },
};

const NAMES = [
  { jp: "兆し", rom: "Kizashi", what: "The omen registry. Decides the era from a signature nobody can fake." },
  { jp: "守り", rom: "Mamori", what: "The guard on each vault. Caps, delays, and the lockdown itself." },
  { jp: "火の見", rom: "Hinomi", what: "The lookout. Watches how much value still sits behind classical keys." },
  { jp: "改元", rom: "Kaigen", what: "The change of era. Classical keys out, post-quantum keys only." },
];

function useKizashi(contract: string): State {
  const [state, setState] = useState<State>(contract ? { status: "loading", contract } : { status: "unconfigured" });

  useEffect(() => {
    if (!contract) {
      setState({ status: "unconfigured" });
      return;
    }
    setState({ status: "loading", contract });
    const ctrl = new AbortController();
    let inFlight = false;
    const load = async () => {
      // A slow read is allowed to finish; aborting it every tick would leave the page loading forever.
      if (inFlight) return;
      inFlight = true;
      try {
        // Ask the RPC which network it serves before reading anything from it. A mismatch drops any earlier reading
        // too: a testnet node must never be the source of what the page shows as production.
        const problem = networkProblem(NETWORK, await chainId(ctrl.signal));
        if (problem) {
          setState({ status: "error", contract, message: problem });
          return;
        }
        const [era, omens, bounty] = await Promise.all([
          view<unknown>(contract, "era", {}, ctrl.signal),
          view<Omen[]>(contract, "omens", {}, ctrl.signal),
          view<Bounty>(contract, "bounty", {}, ctrl.signal),
        ]);
        if (!isEra(era)) throw new Error(`Kizashi returned an unrecognised era (${JSON.stringify(era)})`);
        // The chain id was checked against NETWORK above, so the reading is from that network.
        setState({ status: "ready", contract, network: NETWORK, era, omens, bounty });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        const message = (e as Error).message;
        // One failed refresh must not erase the last known era from a safety dashboard.
        setState((prev) => (prev.status === "ready" && prev.contract === contract ? { ...prev, stale: message } : { status: "error", contract, message }));
      } finally {
        inFlight = false;
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      clearInterval(id);
      ctrl.abort();
    };
  }, [contract]);

  // Until the effect runs for a new contract, never show the previous one's reading.
  if (!contract) return { status: "unconfigured" };
  return state.status !== "unconfigured" && state.contract === contract ? state : { status: "loading", contract };
}

export default function EraPage() {
  // With only a drill Kizashi configured (a testnet rehearsal), open on it, clearly labelled Drill.
  const [drill, setDrill] = useState(!KIZASHI_ID && Boolean(DRILL_KIZASHI_ID));
  const contract = drill ? DRILL_KIZASHI_ID : KIZASHI_ID;
  const state = useKizashi(contract);
  const ready = state.status === "ready" ? state : null;

  return (
    <div className="container page">
      <header className="page-head reading" aria-live="polite">
        <p className="caption">
          {ready ? "Reading" : "Set up for"} NEAR {NETWORK}
          {contract && (
            <>
              {" · "}
              <span className="mono">{contract}</span>
            </>
          )}
        </p>
        <h1>
          {drill ? "Drill era: " : "Current era: "}
          {ready ? ready.era : state.status === "loading" ? "loading" : state.status === "error" ? "unavailable" : "not deployed yet"}
        </h1>
        {ready ? (
          <>
            <p className="lead">{COPY[ready.era].line}</p>
            <p className="body">{COPY[ready.era].detail}</p>
          </>
        ) : state.status === "unconfigured" ? (
          <p className="lead">
            When a key breaks, your vault adapts. Kizashi is not deployed yet on {NETWORK}, so there is no live era to show. This page reads it from the chain once it is live.
            {DEPLOYMENTS.drillRecord ? " Until then, the recorded drill below is a real run." : ""}
          </p>
        ) : state.status === "error" ? (
          <p className="lead error">Could not read Kizashi: {state.message}</p>
        ) : null}
        {ready?.stale && (
          <p role="status" className="callout" data-tone="warning">
            <strong>Showing the last reading.</strong>
            <span>The latest refresh failed: {ready.stale}</span>
          </p>
        )}
        <div className="actions">
          <a className="btn" href="/migrate">
            Protect an account
          </a>
          {DRILL_KIZASHI_ID && KIZASHI_ID && (
            <div role="group" aria-label="Network" className="actions">
              <button type="button" className={`btn btn-compact ${drill ? "btn-secondary" : ""}`} aria-pressed={!drill} onClick={() => setDrill(false)}>
                Production
              </button>
              <button type="button" className={`btn btn-compact ${drill ? "" : "btn-secondary"}`} aria-pressed={drill} onClick={() => setDrill(true)}>
                Drill
              </button>
            </div>
          )}
        </div>
      </header>

      {drill && (
        <div className="callout reading" data-tone="warning" style={{ marginBottom: "1.25rem" }}>
          <strong>Drill.</strong>
          <span>These omens belong to us and are used for the weekly fire test. Nothing here means the production omen has broken.</span>
        </div>
      )}

      {ready && (
        <>
          <section className="section" aria-labelledby="omens-h">
            <div className="stack-sm reading">
              <h2 id="omens-h">Omens</h2>
              <p className="body">Public keys nobody holds. A valid signature from one proves its curve can be broken.</p>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Omen</th>
                  <th scope="col">Curve</th>
                  <th scope="col">Raises era to</th>
                  <th scope="col">Status</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {ready.omens.map((o) => (
                  <tr key={o.id}>
                    <td data-label="Omen">{o.id}</td>
                    <td data-label="Curve">{o.curve === "Ed25519" ? "ed25519" : "secp256k1"}</td>
                    <td data-label="Raises era to">{o.level}</td>
                    <td data-label="Status">
                      <span className="chip" data-tone={o.death ? "invalid" : "valid"}>
                        {o.death ? "Broken" : "Intact"}
                      </span>
                    </td>
                    <td data-label="Detail">
                      {o.death ? (
                        <>
                          Block {Number(o.death.block).toLocaleString("en-US")} by <span className="mono">{o.death.claimant}</span>
                        </>
                      ) : (
                        <span className="mono">{o.public_key.slice(0, 24)}...</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="section" aria-labelledby="bounty-h">
            <div className="panel reading">
              <h2 id="bounty-h">Bounty</h2>
              <p className="figure">{yoctoToNear(ready.bounty.near, 2)} NEAR</p>
              <p className="body">
                Paid to whoever proves an omen broke
                {ready.bounty.usdc_token ? ", together with the contract's USDC." : "."} Anyone can add to it.
              </p>
              <div className="actions">
                <a className="btn btn-secondary btn-compact" href="/bounty">
                  Add to the bounty
                </a>
              </div>
            </div>
          </section>
        </>
      )}

      <DrillTable />

      <section className="section" aria-labelledby="names-h">
        <h2 id="names-h">Four parts, four names</h2>
        <ul className="rows reading">
          {NAMES.map((n) => (
            <li key={n.rom}>
              <span className="row-title">
                <span>{n.rom}</span>
                <span lang="ja" className="small body">
                  {n.jp}
                </span>
              </span>
              <span className="row-detail">{n.what}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section reading" aria-labelledby="limits-h">
        <h2 id="limits-h">What KAIGEN does not cover</h2>
        <p className="body">
          Validator signing keys stay classical until about the end of 2027. The Chain Signatures master key and bridge treasuries on other chains have no post-quantum
          timeline. An omen proves a curve can be broken, not who broke it or how widely. If no omen ever breaks, the daily caps and delays are what protect you.
        </p>
      </section>
    </div>
  );
}
