import { exitCodeOf, isMamori, keyRows, type CageFacts, type CageResult, type KeyRow, type Status } from "@/lib/cage";
import { yoctoToNear } from "@/lib/near";
import { plainFindings } from "@/lib/xray-says";

const TONE: Record<Status, "valid" | "invalid" | "warning"> = { GREEN: "valid", RED: "invalid", UNKNOWN: "warning" };
const MAX_KEYS_SHOWN = 100;

function headline(result: CageResult, mamori: boolean): string {
  const red = result.conditions.filter((c) => c.status === "RED");
  const unknown = result.conditions.filter((c) => c.status === "UNKNOWN");
  const total = result.conditions.length;
  if (result.verdict === "RED") return `${red.length} of ${total} conditions fail: ${red.map((c) => c.id).join(", ")}.${unknown.length ? ` ${unknown.length} could not be checked.` : ""}`;
  if (result.verdict === "UNKNOWN") return `Nothing is red, but ${unknown.length} of ${total} conditions could not be checked. This is not a clean bill.`;
  return `All ${total} conditions hold at this block${mamori ? "" : ""}.`;
}

function KeyLine({ row }: { row: KeyRow }) {
  if (row.kind === "full") {
    return (
      <li>
        <span className="row-title">
          <span className="mono">{row.key}</span>
          <span className="chip" data-tone={row.curve === "classical" ? "invalid" : "warning"}>
            Full access
          </span>
        </span>
        <span className="small body">{row.curve === "classical" ? "Classical key type." : "Post-quantum key type (ML-DSA)."} Can do anything the account can.</span>
      </li>
    );
  }
  if (row.kind === "unknown") {
    return (
      <li>
        <span className="row-title">
          <span className="mono">{row.key}</span>
          <span className="chip" data-tone="warning">
            Unknown permission
          </span>
        </span>
      </li>
    );
  }
  return (
    <li>
      <span className="row-title">
        <span className="mono">{row.key}</span>
        <span className="chip">Function call</span>
      </span>
      <dl className="xr-meta">
        <div>
          <dt>Receiver</dt>
          <dd className="mono">{row.receiver || "none"}</dd>
        </div>
        <div>
          <dt>Allowed methods</dt>
          <dd className="mono">{row.methods.length ? row.methods.join(", ") : "any method (none listed)"}</dd>
        </div>
        <div>
          <dt>Allowance</dt>
          <dd>{row.allowance === null ? "unlimited" : /^\d+$/.test(row.allowance) ? `${yoctoToNear(row.allowance, 4)} NEAR` : row.allowance}</dd>
        </div>
      </dl>
    </li>
  );
}

export function XrayReport({ facts, result }: { facts: CageFacts; result: CageResult }) {
  const mamori = isMamori(facts);
  const rows = keyRows(facts.keys);
  const exit = exitCodeOf(result);
  const codeHash = facts.acc.global_contract_hash ?? facts.acc.code_hash;
  const noCode = !facts.acc.global_contract_hash && !facts.acc.global_contract_account_id && /^1+$/.test(facts.acc.code_hash);
  const sentences = plainFindings(rows, mamori);
  const attested = result.info.attest === "present" && mamori;
  const attestRaw = facts.attest.raw as { config?: Record<string, unknown>; drill_build?: boolean } | undefined;

  return (
    <div className="section" style={{ marginTop: "3rem" }}>
      <div className="panel" role="group" aria-label="X-ray verdict" data-verdict={result.verdict}>
        <div className="split">
          <span className="mono">{facts.account}</span>
          <span className="chip" data-tone={mamori ? "valid" : undefined}>
            {mamori ? "Mamori vault" : "Not a Mamori vault"}
          </span>
        </div>
        <div className="xr-verdict" data-tone={TONE[result.verdict]}>
          <span className="figure">{result.verdict}</span>
          <span className="chip" data-tone={TONE[result.verdict]}>
            cage-check exit {exit}
          </span>
        </div>
        <p className="body">{headline(result, mamori)}</p>
        <ul className="xr-says">
          {sentences.map((s) => (
            <li key={s} className="body">
              {s}
            </li>
          ))}
        </ul>
        <dl className="kv">
          <div className="wide">
            <dt>Code on the account</dt>
            <dd className="mono">{noCode ? "none" : codeHash}</dd>
          </div>
          <div>
            <dt>Read at final block</dt>
            <dd>{facts.block.height.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>attest()</dt>
            <dd>{attested ? (attestRaw?.drill_build ? "answers (drill build)" : "answers") : "not available"}</dd>
          </div>
          {result.info.delay_secs !== null && (
            <div>
              <dt>Withdrawal delay</dt>
              <dd>{result.info.delay_secs} s</dd>
            </div>
          )}
          {result.info.era && (
            <div>
              <dt>Era (as the vault recorded it)</dt>
              <dd>{result.info.era}</dd>
            </div>
          )}
        </dl>
      </div>

      <section className="stack" aria-labelledby="xr-keys-h">
        <h2 id="xr-keys-h">Access keys ({rows.length})</h2>
        {rows.length === 0 ? (
          <p className="body">None.</p>
        ) : (
          <ul className="rows">
            {rows.slice(0, MAX_KEYS_SHOWN).map((r) => (
              <KeyLine key={r.kind === "function-call" ? r.key : r.key} row={r} />
            ))}
          </ul>
        )}
        {rows.length > MAX_KEYS_SHOWN && <p className="small body">Showing the first {MAX_KEYS_SHOWN} of {rows.length}. The verdict above reads all of them.</p>}
      </section>

      <section className="stack" aria-labelledby="xr-rows-h">
        <h2 id="xr-rows-h">The {result.conditions.length} conditions</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Condition</th>
              <th scope="col">Status</th>
              <th scope="col">What was read</th>
            </tr>
          </thead>
          <tbody>
            {result.conditions.map((c) => (
              <tr key={c.id}>
                <td data-label="Condition">
                  <span className="mono">{c.id}</span>
                  <br />
                  {c.name}
                </td>
                <td data-label="Status">
                  <span className="chip" data-tone={TONE[c.status]}>
                    {c.status}
                  </span>
                </td>
                <td data-label="What was read" className="mono">
                  {c.detail}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="stack" aria-labelledby="xr-limits-h">
        <h2 id="xr-limits-h">What this cannot see</h2>
        <ul className="xr-says">
          {result.limits.map((l) => (
            <li key={l} className="body small">
              {l}
            </li>
          ))}
          <li className="body small">UNKNOWN is shown wherever a condition could not be read from the browser. It is never shown as green.</li>
        </ul>
      </section>
    </div>
  );
}
