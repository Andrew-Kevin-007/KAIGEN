# Counterparty check (advisory): the agent asks before it pays

Status: implemented in `jobs/src/counterparty.mjs` and `jobs/src/bin.mjs`, unit-tested against a fake chain (`jobs/test/counterparty-signals.test.mjs`) and run against live testnet reads (outputs in `docs/internal/V3-COUNTERPARTY-PROGRESS.md`, which is not tracked). Testnet and mainnet reads only: no signing, no transaction, no write to any chain.

## 1. What this is, and what it is not

**It is advisory.** Before an agent signs a payment it asks "should I pay this account?" and gets `allow`, `warn` or `block`, with every reason and, for every signal, where the data came from and whether it was actually read (`known`) or could not be (`unknown`).

**The vault does not depend on it.** Mamori enforces its limits on chain whether or not anyone ran this: the access key can only call `send_small` and `request_withdraw`, the 24 hour cap, the optional recipient allowlist, the delay queue and the strike counter all run inside the contract (`ARCHITECTURE.md`, `LOSS-BOUND.md`). A hijacked agent that skips this check loses what the contract lets it lose, and no more. The on-chain `check` view (`ATTEST-CHECK.md` section 3) is a separate, also advisory, function about the vault's own rules; it shares no code with this file. This check adds what a contract cannot see about the other side of the payment: the recipient's age, code and reputation. Its value is gas saved and a human told why. It is the first line; the vault is the last.

`unknown` is never `allow`. A signal that could not be read counts as a warning, so an `allow` means every signal was read and none was bad.

## 2. Use

```
node jobs/src/bin.mjs counterparty <vault> <to> [--rpc <url>] [--archival <url>] [--history <file>] [--json]
node jobs/src/bin.mjs counterparty-report <account> --reason <text> --evidence <url-or-tx-hash> [--by <name>]
```

* `--rpc`: the node for current state. Default: `KAIGEN_RPC`, then `rpc` in `deployments.json`, then the testnet node when `deployments.json` says testnet.
* `--archival`: a node that still holds old state (`KAIGEN_ARCHIVAL_RPC`, then `archivalRpc` in `deployments.json`). Without it the age and code-change reads use `--rpc` and are limited to what that node keeps (section 4).
* `--history`: a JSON array of the accounts this agent has paid before. Without it, "past payments" is `unknown`.
* Blocklist file: `KAIGEN_BLOCKLIST`, default `data/blocklist.json` (under `KAIGEN_DATA` if set). Gitignored. It ships absent, which means "nothing reported".
* `KAIGEN_REPORTER`: the default for `--by`.

Exit codes (`counterparty`): **0** allow, **1** block, **3** warn or mostly unknown, **2** usage. `counterparty-report`: 0 written, 2 usage (including a missing or empty `--reason` or `--evidence`), 1 on a file it refused to touch.

As a library: `assessCounterparty({ rpc, archival, vault, to, history, blocklist, minAgeHours, codeChangeHours })` returns `{ verdict, reasons, signals, head, thresholds, unknownCount, unknownDominated, exitCode }`. The original `checkCounterparty` and `guardedSend` are unchanged and still used by `runInjectionDemo`.

## 3. Data sources

Every read is a JSON-RPC read through `jobs/src/rpc.mjs`. The only write is `counterparty-report`, to the local blocklist file.

| Signal | Source | How it is read | Known when | Unknown when | Limits |
|---|---|---|---|---|---|
| Account age | `query view_account` at past block heights, plus block headers for timestamps | First one read at a block just older than the threshold (so an old account is known to be old after one read). Then step back from the head by doubling distances until a block where the account is absent or unreadable, then halve the gap. About 6 reads for an old account to be known old, 20 to 35 for an exact date. Gives up after 60 s and keeps what it proved. | The block just before the first-seen block was readable and had no account (exact age), or a block older than the threshold has the account ("at least X", with the reason it stopped). | The only block it could read is younger than the threshold (lower bound under 168 h), or the node errored before anything was proved. The reason states the lower bound it did reach. | Reaches back only as far as the node keeps state. Measured on `rpc.testnet.fastnear.com`: about 34.9 hours (about 210 000 blocks). An archival node reaches much further but has gaps (section 4). An account deleted and re-created is dated from the creation the search lands on. |
| Contract or not | `query view_account` at the latest final block | `code_hash` of `1111...` means no contract; `global_contract_hash` or `global_contract_account_id` also mean a contract. | The account read succeeded. | The account read failed. | A contract recipient is a warning, not a block: a token or shop contract is a legitimate payee. A named account that does not exist is a block; an unfunded 64-hex implicit account is a warning. |
| Code change | `query view_account` at the latest block and at a block about 24 h earlier | The earlier block is found by estimating from the block rate and correcting (within 15 minutes of the target); the real window is printed. Compare `code_hash` plus the two global-contract fields. | Both reads succeeded. | The node no longer holds the earlier block (the reason says to use `--archival`), or any read failed. | A change warns; it never blocks by itself. A change made and reverted inside the window is not seen. The window is 24 h by default (`codeChangeHours`). |
| Past payments | (1) the agent's own record, passed as `history`; (2) the vault's own events: **not readable** | The recipient is in the record or it is not. Not in it is `warn: first payment`. | A record was given. | No record was given. | **The vault's history cannot be read over JSON-RPC.** The methods `rpc.mjs` wraps (`query`, `block`, `status`, `tx`) have no call that lists an account's receipts or logs; the nearest, `EXPERIMENTAL_changes`, answers one block at a time. Mamori has no `receipts()` view by design (`ATTEST-CHECK.md` section 5, to avoid unbounded storage). Reading the events needs an indexer, which this project does not use. So the answer is only as complete as the record the agent keeps. This is stated from the shape of the API and the contract, not from a failed search. |
| Blocklist | A local JSON file | Exact account match. Every entry carries `account`, `reason`, `evidence` (a URL or a tx hash), `reportedBy`, `reportedAt`. A listed account is `block`, with all of that shown (the first three reports, then a count). | The file was read, or does not exist (nothing reported). | The file exists and is unreadable or malformed: never treated as an empty list. | "Shared" means every agent pointed at the same file (a shared folder, a mounted volume). There are no signatures and no registry contract: anyone who can write the file can add or delete an entry, and a listing is a claim with evidence, not proof. Two `counterparty-report` runs at the same instant can lose one. The file ships empty. |
| Vault allowlist | `call_function allowlist` on the vault | If the vault enforces an allowlist and the recipient is not on it, `block`. | The view answered. | The view failed (not a Mamori vault, or the node errored). | The contract enforces this itself when the payment runs; here it only saves the gas. |

### The sample

The only built-in blocklist entry anywhere in the project is the one `jobs/src/demo.mjs` passes to the attack demo for the attacker account (`"reported for draining agent vaults"`). It is a scripted **sample** for that demo, not a real report, and it is never written to the blocklist file. Nothing in `data/blocklist.json` is seeded.

## 4. Limits, stated plainly

* **History depth.** On the testnet node used (`rpc.testnet.fastnear.com`) the oldest readable block was 34.9 hours behind the head when measured. An account older than that gets "at least 34.9 hours old", which cannot clear the 168 hour threshold, so its age is reported `unknown`. Only an archival node gives an exact age for such an account.
* **The archival node is not complete.** `archival-rpc.testnet.fastnear.com` answered correctly for the recent weeks tested but returned `UNKNOWN_BLOCK` (HTTP 422) and `INTERNAL_ERROR / MissingTrieValue` (HTTP 500) for some older heights. `rpc.mjs` turns every HTTP 500 into a retry and then an error without the body, so the search cannot tell that from an outage: it treats a height that still errors after the retries as unreadable, which can only produce a lower bound ("at least X") or `unknown`, never an exact or "young" claim it did not see. The free archival endpoint also rate-limits: in a burst test of 40 reads, 24 succeeded and 16 came back 429 at both a 0.35 s and a 0.7 s gap, and a 429 is retried with backoff and then counted as an error, not as a property of the height. A run right after another can therefore return `unknown` for age or code change; running it again a minute later gave the full answer. For an account that is old (the live check of `testnet`), the exact-date search can run into the 60 s budget; the answer is then "at least 7.0 days old", known, with the reason it stopped.
* **Chain time, not wall time.** Ages are block timestamp minus block timestamp, not compared with the local clock.
* **Thresholds are choices.** Warn under 168 hours old; a 24 hour code-change window. Neither is a standard. They are parameters (`minAgeHours`, `codeChangeHours`).
* **A block head at a moment.** Reads at different calls can differ by a block or two; each signal says what it read.
* **Advisory.** Nothing here can stop a payment; `guardedSend` can refuse to sign on a `block` and ask a human on a `warn`, and an agent that does not use it is not affected. The vault's enforcement is the same either way.

## 5. Where it is tested

`jobs/test/counterparty.test.mjs` (the original check and `guardedSend`) and `jobs/test/counterparty-signals.test.mjs`: the first-seen search (exact, skipped heights, state thrown away), every signal's known and unknown paths against a fake node behind the real `makeRpc`, the blocklist file (append, evidence required, corrupt file refused), the argument parsers, and the real `bin.mjs` run as a child process against a local fake JSON-RPC server for exit codes 0, 1, 2 and 3.
