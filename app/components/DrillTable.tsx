import { DRILL_RECORD as R } from "@/lib/drill-record";

const EXPLORER = "https://testnet.nearblocks.io/txns/";
const short = (h: string) => `${h.slice(0, 8)}...${h.slice(-6)}`;

interface Row {
  step: string;
  detail: string;
  state: string;
  txs: { label: string; hash: string }[];
}

// Step 1 is the drill armed and calm; each later step is something the chain recorded.
const ROWS: Row[] = [
  { step: "Armed", detail: "The drill vault holds one classical daily key.", state: "Calm", txs: [] },
  { step: "An omen signs a claim", detail: `The drill omen key signs; Kizashi checks it on-chain (block ${R.claimBlock.toLocaleString("en-US")}).`, state: "Kaigen", txs: [{ label: "claim", hash: R.claimTx }] },
  { step: "Anyone calls trip", detail: "The vault reads the era from Kizashi and deletes its classical key.", state: "Tripping", txs: [{ label: "trip", hash: R.tripTx }] },
  { step: "Classical keys are gone", detail: `Checked against the chain at block ${R.verifiedBlock.toLocaleString("en-US")}. Only the post-quantum admin key is left.`, state: "Post-quantum only", txs: [] },
  { step: "A post-quantum send works", detail: "The vault still moves funds, signed by the ML-DSA-65 admin key.", state: "Post-quantum only", txs: [{ label: "send", hash: R.pqSendTx }] },
  { step: "Reset and re-arm", detail: "The drill build resets and re-arms the vault, so the drill can be run again from calm.", state: "Calm", txs: [{ label: "reset", hash: R.resetTx }, { label: "re-arm", hash: R.rearmTx }] },
];

/** A recorded fire drill as a static table. Every link is a real testnet transaction. It is a drill, never the production omen. */
export function DrillTable() {
  return (
    <section className="section" aria-labelledby="drill-h">
      <div className="stack-sm reading">
        <p className="caption">Fire drill #{R.seq} · testnet · recorded, not live</p>
        <h2 id="drill-h">A whole lockdown, from a real run</h2>
        <p className="body">
          A drill omen is claimed, a drill vault is tripped, and the result is checked on chain. This is the record of drill #{R.seq}, run on testnet on 29 Oct with the drill build
          (the one that can reset). Each link is a real transaction you can open. It is a drill: nothing here means the production omen has broken.
        </p>
      </div>
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
          {ROWS.map((r, i) => (
            <tr key={r.step}>
              <td data-label="Step">
                {i + 1}. {r.step}
              </td>
              <td data-label="What happened">{r.detail}</td>
              <td data-label="Vault state">{r.state}</td>
              <td data-label="Transactions">
                {r.txs.length === 0
                  ? "None"
                  : r.txs.map((t) => (
                      <span key={t.hash} style={{ display: "block" }}>
                        {t.label}{" "}
                        <a className="link mono" href={`${EXPLORER}${t.hash}`} target="_blank" rel="noopener noreferrer">
                          {short(t.hash)}
                        </a>
                      </span>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
