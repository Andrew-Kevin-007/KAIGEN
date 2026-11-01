# KAIGEN plan to submission and mainnet

30 Oct 2026. Submission window (HACKATHON.md, Facts): **Sun 1 Nov 2026 00:00 UTC to Sat 14 Nov 2026 23:59 UTC**. Built from `docs/ARCHITECTURE-REVIEW.md` (verified findings only) and the event rules read earlier. Dates are fixed by the organisers: submissions open 1 Nov 00:00 UTC, close **14 Nov 23:59 UTC**; the team plans to submit on 13 Nov.

## Ground rules

1. **The lock is the last thing, never the next thing.** Kizashi's key deletion is irreversible on a contract that holds the bounty. Nothing is locked until every evidence gate below is green.
2. **A testnet-proven submission is eligible** (event rules Q-010: testnet-only projects are eligible for all tracks). So a missed mainnet stage costs polish, not the submission. Never lock under time pressure.
3. **Engineering ends 9 to 10 Nov.** Semester-7 exams run 11 to 20 Nov, and 31 Oct is the last CAT paper, the NBA visit and the paper presentation. The plan is front-loaded accordingly; days after 10 Nov are buffer and submission only.
4. **Only the owner can:** hold funded mainnet keys, move funds, post on X, and press submit. Claude Code does not enter keys or move funds and does not post.
5. Every contract change changes the code hash, so each one is followed by tests, a rebuild and a fresh testnet rehearsal before any mainnet step.

## A. Fix plan, 31 Oct to 13 Nov

Each item lists the finding it closes (ids from the review) and how it is verified.

| Day | Work | Closes | Verified by |
| --- | --- | --- | --- |
| Sat 31 Oct | **Light day.** README: correct the BitMEX line, add a dated prior-art section (Drake 2018, ERC-7826, BitMEX Research April 2026, QCAP), say the build window is the organiser's 19 Oct announcement, state the no-keys no-upgrade design plainly. Host the app against the testnet drill contracts so it never opens on "Not deployed yet". Needs the owner's OK to edit the README. | README findings, empty-state gap | Read the diff; open the hosted page |
| Sun 1 Nov | Kizashi: `storage_deposit` before `ft_transfer`, resolve callback with success and failure events, more gas (K1); owed-payout record with a permissionless retry, or at least an event (K3); `reset` requires a `.testnet` account id (K2); decide the per-omen split and write it down (K4). Add a pre-deploy script: reject known drill keys and small-order points, assert the wasm exports no `reset`, validate the USDC id (K5, K6, INIT-GATE). | K1 K2 K3 K4 K5 K6 INIT-GATE | New unit tests for each; `cargo test --workspace` green |
| Mon 2 Nov | Mamori: count queued amounts against the cap (S1); record the requesting key per withdrawal and cancel its entries when the key is burned or removed (S-queue); time-bucket the send window, no strike for "too many sends", minimum amount (S3); split trip gas so era caching and lockdown do not share one receipt (F1); production `init` enforces the production delay. | S1 S-queue S3 F1 | New tests including max-load lockdown and the dust case |
| Tue 3 Nov | Rebuild both wasm, check the code hash on two machines or one clean container; extend the testnet harness: funded USDC path with a registered and an unregistered claimant, and a **Kizashi with zero keys** (delete its key after init and confirm views and a third-party claim still work). Re-run the whole rehearsal. | OPS-1 OPS-3 OPS-5 | `judge-report.json` regenerated; the zero-key run recorded in a fire-test file |
| Wed 4 Nov | Write the phased mainnet script (stages 0 to 3 below), with a stop gate between phases and a dry-run mode that prints every transaction before sending. Owner funds a small mainnet drill account set. Run **gate G1 on mainnet protocol 86** with a throwaway account. | OPS-1 PQ-86 | Transaction links; the script's own phase log |
| Thu 5 Nov | Create vault: wire the temporary-browser-key fallback (create, add the ML-DSA key, delete the temporary key); test it on the mainnet drill vault. App: reach `/migrate` by full page load, COOP `same-origin`, nonce-based script-src, `connect-src 'none'` (APP-1); passphrase minimum and a word-list suggestion (APP-3). | G3, APP-1, APP-3 | A stranger-style run through the app on the drill vault; CSP header check |
| Fri 6 Nov | Top-up fails closed: network, recipient code hash and asset id equal to Kizashi's `usdc_token`, era not Kaigen (APP-2); refund address validation and rate limit on quote and status routes (APP-6, APP-7). `verify.mjs`: release mode hard-codes mainnet, cross-checks two RPC hosts at one block hash, asserts Kizashi's balance is at least the bounty, hash-checks the drill vault code (J-net, J-hash, J-rpc). | APP-2 APP-6 APP-7 J-net J-hash J-rpc | New tests; `make verify` fails on a deliberately wrong config |
| Sat 7 Nov | Replace the third-party template in `site/` (phone mockups, videos, fonts) with the KAIGEN system. Record the demo from the drill pair: era page, a real migration, a mainnet fire test. | README says the template must not ship | Visual check; no third-party assets left |
| Sun 8 Nov | **Stage 2 and stage 3** (below): production Mamori path and the app on mainnet; production Kizashi deployed and initialised, **not locked**. Run `make verify` against it. | | The verify report |
| Mon 9 Nov | **Evidence gate** (stage 4). A fresh-eyes review of the diff since 30 Oct. Go or no-go for the lock, decided by the owner. | | The checklist below, all green |
| Tue 10 Nov | **Stage 5, the lock**, only on a go. Otherwise declare the fallback (section C). Final `make verify`, then the video and X post draft. | | Empty access-key list on Kizashi; verify green |
| Wed 11 to Fri 13 Nov | Buffer. Exams are running; do only: final README read, hosted demo check, owner posts on X and submits on 13 Nov. | | |

## B. Staged mainnet plan

| Stage | What happens | Irreversible? | Keys used | Go / no-go evidence |
| --- | --- | --- | --- | --- |
| 0. Read-only gates | Mainnet protocol version (86 now), whether `ml_dsa_verify` is live, the exact `intents.near` methods (G4), cost of a global-contract deploy (G2), the Hinomi account source (G7). | No | none | Written results with transaction or RPC evidence |
| 1. Mainnet drill pair | A drill Kizashi and one drill vault on mainnet with small funds, built from the drill wasm. Run G1: an ML-DSA key signs AddKey, DeleteKey and a deploy, and deletes the classical key. Run the whole fire test: claim, trip, keys gone, post-quantum send, reset. | No: drill accounts hold small funds and can be abandoned | A fresh funded throwaway key held by the owner | A mainnet fire-test record that `verify` accepts. **If G1 fails here, stop: the post-quantum admin flow does not work on mainnet and the lock must not happen** |
| 2. Production Mamori and the app | Deploy Mamori per vault (about 3 NEAR of storage each, per the README, unless G2 shows global contracts work), the Create vault path, the hosted app on mainnet. | Per-vault deploys cost funds and cannot be recalled, but hold nothing of anyone's until a user funds a vault | The owner's deploy key, scoped to a dedicated deployer account with limited funds | A stranger completes a vault creation through the app |
| 3. Production Kizashi, unlocked | Deploy and init in **one transaction** from the Kizashi account (as the harness does). Init arguments are checked by the pre-deploy script first: omens re-derived from the public seeds, no extra omen, USDC id correct and Kizashi registered with it, funded bounty. Do **not** delete any key yet. | **Partly**: the init arguments are permanent once keys go, and a wrong init means redeploying a new address | A dedicated Kizashi deployer key, never reused | `make verify` green; `omens()`, `era()`, `bounty()` read back; a claim of a **drill** omen is not possible on this build |
| 4. Evidence gate | Everything below is true at once. | No | none | The checklist below |
| 5. The lock | One atomic transaction carrying DeleteKey for every Kizashi access key, then a post-check that the key list is empty and views still answer. | **Yes, permanent** | The Kizashi deployer key, which this transaction destroys | Owner go decision recorded; post-check output saved |

**Evidence gate (stage 4), all required:**

1. G1 passed on mainnet protocol 86 (stage 1), including the classical key deleted by the ML-DSA key.
2. A zero-key Kizashi was rehearsed on testnet, and a third-party claim still worked.
3. The funded USDC path ran on a chain with a registered claimant and with an unregistered one, and neither strands funds (K1, K3).
4. `make verify` is green in release mode against the production Kizashi: code hashes, omens, no extra omen, no access keys on the locked account, balance at least the bounty, two RPC hosts agreeing at one block.
5. The code hash of the deployed wasm equals a clean rebuild on a second machine or container.
6. The wasm exports no `reset`.
7. The fresh-eyes review of the post-30-Oct diff found nothing high.
8. The mainnet drill pair completed a fire test using the same wasm family.

If any item is red on 10 Nov, **do not lock** (section C).

## C. If a stage is not reached

| Where it stops | What ships | What the README says |
| --- | --- | --- |
| Stage 1 fails (G1 on mainnet) | Testnet-proven submission with the hosted testnet app; the mainnet drill pair stays as evidence of the attempt | "Proven on testnet at protocol 88; the same flow did not pass on mainnet protocol 86, here is the transaction and the reason" |
| Stages 2 to 3 reached, gate not green | Production contracts deployed but **unlocked**; the app labelled as a pre-lock deployment | "Mainnet deployment, not yet locked. The lock waits on: (list of red gate items)" |
| Gate green, owner chooses not to lock | The same, with the lock procedure documented | The owner's reason, plainly |
| Everything green | Locked Kizashi, `make verify` against mainnet in the README | The checklist results with links |

In every case the README keeps the honest status line at the top, the real-product table reflects what is actually live, and drill objects are labelled drill everywhere.

## D. Who does what

**Only the owner:** fund the mainnet accounts and hold the deployer keys; approve each stage's go; decide the per-omen split (K4) and the production delay (S1); approve README edits; post the X thread; press submit.

**Claude Code:** write and test the contract changes; the mainnet script with a dry-run mode; the pre-deploy checks; the Create vault flow; the app hardening; the verify hardening; the site rebuild; regenerate `judge-report.json`; run a fresh-eyes review before the gate. Every command that spends funds is printed first and run by the owner with their own keys.

## E. Decisions needed from the owner

1. K4: split the bounty by omen level, or keep "first claim takes all" and document it?
2. S1: enforce a 24h production withdrawal delay, or keep the 5-minute floor and rely on a watcher?
3. Who runs the keeper before a break, and who pays its gas?
4. May I edit the README on Sat 31 Oct (BitMEX line, prior-art section, window wording)?
5. Costs are unknown until stage 0 and 1 measure them: the Kizashi funding, the bounty seed, and per-vault storage beyond the README's roughly 3 NEAR. Set a ceiling you are comfortable with before stage 1.
