import type { DrillRecord } from "@/lib/deployments";
import { DEPLOYMENTS } from "@/lib/config";

const EXPLORER = { mainnet: "https://nearblocks.io/txns/", testnet: "https://testnet.nearblocks.io/txns/" } as const;
const short = (h: string) => `${h.slice(0, 8)}...${h.slice(-6)}`;
const blockText = (n: number) => n.toLocaleString("en-US");

interface Tx {
  label: string;
  hash: string;
}
interface Row {
  step: string;
  detail: string;
  state: string;
  txs: Tx[];
}

/** One transaction per vault. With a single drill vault the vault name adds nothing, so the label is just the action. */
const perVault = (label: string, byVault: Record<string, string>, many: boolean): Tx[] =>
  Object.entries(byVault).map(([vault, hash]) => ({ label: many ? `${label} ${vault.split(".")[0]}` : label, hash }));

/** Step 1 is the drill armed and calm; each later step is something the chain recorded. */
function rowsOf(r: DrillRecord): Row[] {
  const many = r.vaults.length > 1;
  const vaults = many ? "The drill vaults" : "The drill vault";
  const s = many ? "" : "s"; // the verb agrees with "vault" or "vaults"
  return [
    { step: "Armed", detail: `${vaults} held a classical daily key and the drill Kizashi was calm.`, state: "Calm", txs: [] },
    { step: "An omen signs a claim", detail: `The drill omen key signs; Kizashi checks it on-chain (block ${blockText(r.claimBlock)}).`, state: "Kaigen", txs: [{ label: "claim", hash: r.claimTx }] },
    { step: "Anyone calls trip", detail: `${vaults} read${s} the era from Kizashi and delete${s} the classical key.`, state: "Tripping", txs: perVault("trip", r.tripTxs, many) },
    { step: "Classical keys are gone", detail: `Checked against the chain at block ${blockText(r.verifiedBlock)}. Only the post-quantum admin key is left.`, state: "Post-quantum only", txs: [] },
    { step: "A post-quantum send works", detail: `${vaults} still move${s} funds, signed by the ML-DSA-65 admin key.`, state: "Post-quantum only", txs: perVault("send", r.pqSendTxs, many) },
    {
      step: "Reset and re-arm",
      detail: `The drill build resets and re-arms ${many ? "the vaults" : "the vault"}, so the drill can be run again from calm.`,
      state: "Calm",
      txs: [...(r.resetTx ? [{ label: "reset", hash: r.resetTx }] : []), ...perVault("re-arm", r.rearmTxs, many)],
    },
  ];
}

/**
 * The latest recorded fire drill, from the deployment settings, as a static table. Every link is a real transaction
 * on the network the record belongs to. It is a drill, never the production omen. With no record there is a plain
 * sentence saying so, not a sample.
 */
export function DrillTable() {
  const r = DEPLOYMENTS.drillRecord;
  if (!r) {
    return (
      <section className="section" aria-labelledby="drill-h">
        <div className="stack-sm reading">
          <p className="caption">Fire drill · none recorded yet</p>
          <h2 id="drill-h">A whole lockdown, from a real run</h2>
          <p className="body">No fire drill has been recorded for this deployment yet. When one is, each of its steps appears here with a link to its transaction.</p>
        </div>
      </section>
    );
  }
  const explorer = r.network ? EXPLORER[r.network] : null;
  const rows = rowsOf(r);
  return (
    <section className="section" aria-labelledby="drill-h">
      <div className="stack-sm reading">
        <p className="caption">
          Fire drill #{r.seq} · {r.network ?? "network unknown"} · recorded, not live
        </p>
        <h2 id="drill-h">A whole lockdown, from a real run</h2>
        {r.failedStep ? (
          <p className="callout" data-tone="warning" role="status">
            <strong>Drill #{r.seq} did not finish.</strong>
            <span>The step &ldquo;{r.failedStep}&rdquo; failed, so no table of a finished lockdown is shown for it.</span>
          </p>
        ) : (
          <p className="body">
            A drill omen is claimed, a drill vault is tripped, and the result is checked on chain. This is the record of drill #{r.seq}, run with the drill build (the one that can reset).
            {explorer ? " Each link is a real transaction you can open." : " The network of these accounts is not known, so the transactions are listed without links."} It is a drill: nothing here
            means the production omen has broken.
          </p>
        )}
      </div>
      {!r.failedStep && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">What happened</th>
              <th scope="col">Vault state</th>
              <th scope="col">Transactions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.step}>
                <td data-label="Step">
                  {i + 1}. {row.step}
                </td>
                <td data-label="What happened">{row.detail}</td>
                <td data-label="Vault state">{row.state}</td>
                <td data-label="Transactions">
                  {row.txs.length === 0
                    ? "None"
                    : row.txs.map((t) => (
                        <span key={`${t.label}-${t.hash}`} style={{ display: "block" }}>
                          {t.label}{" "}
                          {explorer ? (
                            <a className="link mono" href={`${explorer}${t.hash}`} target="_blank" rel="noopener noreferrer">
                              {short(t.hash)}
                            </a>
                          ) : (
                            <span className="mono">{short(t.hash)}</span>
                          )}
                        </span>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
