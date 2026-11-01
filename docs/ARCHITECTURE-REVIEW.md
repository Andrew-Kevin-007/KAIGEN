# KAIGEN architecture review

30 Oct 2026. Read-only review of seven slices (Kizashi, Mamori spend path, Mamori trip path, protocol and crypto, off-chain jobs, app, ops and mainnet), each followed by a verifier who tried to refute the high-severity findings. Nothing was built, run or deployed; test results come from `judge-report.json` (contracts 54, scripts 6, jobs 62, app typecheck and units pass).

## Verdict

The design is sound and the core claim logic is carefully built. **It is not ready for the irreversible mainnet lock.** Not because of one flaw, but because the lock is a one-way door over a contract that holds the bounty, and three things around that door do not exist yet: tooling to deploy and lock on mainnet, a payout path that cannot strand funds, and a pre-lock gate that checks what init was given. Nothing here suggests the idea is wrong; it says the last mile has not been walked once.

No finding survived verification as critical. Nine are high after verification: six confirmed by a verifier (K1, S1, APP-1, APP-2, OPS-1, OPS-3) and three raised by a verifier as missed issues (S-queue, PQ-86, INIT-GATE), which the table labels.

## Architecture as it is

| Part | Job | Trusted for |
| --- | --- | --- |
| Kizashi (`contracts/kizashi`, 287 lines) | Holds public omen keys, verifies a signed claim, raises the era (Calm, Warning, Kaigen, never back), pays a bounty | The era. Its keys are deleted after init, so it cannot be fixed |
| Mamori (`contracts/mamori`, 576 lines) | Per-vault guard: ML-DSA admin, classical daily function-call keys, 24h cap, delayed withdrawals, strikes, `trip` | Enforcing the era on one account |
| `scripts/` | Derives omen keys from public seeds (RFC 9380), signs claims | Making "nobody holds the omen" checkable |
| `jobs/` | Keeper, Hinomi index, watchers, fire test, verify, testnet harness | Nothing on-chain; it only calls permissionless methods and checks |
| `app/` | Era page, vault lookup, key and backup flow, bounty top-up | Reading the chain; signing goes through the user's wallet |

Trust chain: a signature from an omen key, checked on-chain by Kizashi, raises the era; anyone then calls `trip()` on a vault, which reads Kizashi's era and deletes the vault's recorded classical keys. The contracts trust only signatures, and the off-chain parts are replaceable.

## What is strong (protect these)

- The claim message names the Kizashi account, omen id and claimant, byte-identical in `scripts/claim.mjs:12` and `kizashi/lib.rs:254`, so a copied signature cannot redirect the bounty. secp256k1 requires low-s and a strict `v` (`lib.rs:268-273`).
- Kizashi writes the death record and era before building the payout promises (`lib.rs:134-165`), so a failed payout cannot undo the lockdown. The era only rises (`lib.rs:23,141`).
- `trip()` is permissionless and idempotent; a failed key delete re-records the key for the next trip (`mamori/lib.rs:310-315, 527-542, 377-381`). Production fails closed if Kizashi cannot be read (`:321`).
- Refusals return a value rather than panicking, so strikes persist (`mamori/lib.rs:258-269, 490-510`). `assert_daily_key` requires predecessor, signer and a recorded key (`:454-460`).
- Deploy and init go in one transaction, so nobody can front-run init (`jobs/src/testnet.mjs:90-91`). The ML-DSA key is added before the classical key is deleted, so a rejected PQ signature leaves the classical key in place (`:100-107`).
- `jobs` fails closed: an unknown era stops the keeper pass, and a check that could not run counts as FAIL (`keeper.mjs:9-21`, `verify.mjs:11,27`). Fire-test evidence is re-read from the chain at the recorded block.
- Backup crypto: AES-256-GCM, random salt and IV, PBKDF2-SHA256 at 600k, iteration bound on load, and a verify step that decrypts the real file (`app/lib/backup.ts`, `migrate/page.tsx:105-110`). Create vault is honestly switched off rather than faked.
- Build inputs are pinned: exact toolchain, `--locked`, scoped `--cfg near` (`rust-toolchain.toml`, `Makefile:11`, `.cargo/config.toml`).

## Verified findings

Verdict column: what the verifier concluded after re-reading the code. "Reported" means a reviewer raised it and it was not independently checked (medium and low items were not sent to a verifier).

### High after verification

| Id | Where | Finding | Fix |
| --- | --- | --- | --- |
| K1 | `kizashi/lib.rs:160-181` | USDC payout is fire-and-forget: the claimant is not registered with the token, `ft_transfer`'s result is dropped (`let _`), no event, `ft_balance_of` gets 5 Tgas. A failed leg strands USDC, and with no keys nothing can retry it. Confirmed. | Chain `storage_deposit` before `ft_transfer`, add a resolve callback with success and failure events, raise gas, measure on the real USDC |
| S1 | `mamori/lib.rs:279-306` | The 24h cap does not apply to `request_withdraw` or `execute`; the only brake is the delay (floor 300 s). A hijacked daily key can queue the whole balance and anyone can execute it at unlock unless a live admin cancels. Confirmed. | Count queued amounts against the same cap or cap pending value; delay of at least 24h on mainnet with a watcher |
| S-queue | `mamori/lib.rs:55-61, 192-197, 499-506` | Reported by a verifier, not separately verified: a withdrawal records no requesting key. Burning or removing a hijacked key leaves its queued withdrawals live; only `lock_down` clears the queue. | Record the key per withdrawal and cancel its entries when the key is removed or burned |
| APP-1 | `app/next.config.ts:18,33,57`, `Nav.tsx:28` | The strict CSP on `/migrate` does not isolate the seed. The nav reaches it by soft navigation, so it keeps the open page's document and policy and any wallet code already loaded. Needs a hostile script on an open page first. Confirmed. | Reach `/migrate` by full page load only, add COOP `same-origin`, or serve it from its own origin; nonce-based script-src, `connect-src 'none'` |
| APP-2 | `app/lib/topup.ts:49,81` | The top-up destination is the first 1Click token with symbol USDC on near, never compared with Kizashi's configured token; the recipient is an unchecked env var. A mismatch delivers funds Kizashi never counts, unrecoverable once keys are gone. Confirmed. | Fail closed unless network, recipient code hash and asset id equal Kizashi's `usdc_token`, and the era is not Kaigen |
| OPS-1 | `jobs/src/testnet.mjs:19-20,54,221`, `Makefile:4` | No mainnet deploy or lock tooling exists. Kizashi was never rehearsed with zero keys (its full-access key is never deleted in the harness). Confirmed. | A phased mainnet script with a stop gate per phase; rehearse delete-all-keys on a testnet Kizashi and confirm views and a third-party claim still work |
| OPS-3 | `testnet.mjs:91` (`usdc: null`) | The funded USDC path was never run on a chain before the point of no return. Failure is bounty loss, not bricking, since claim writes state first. Confirmed. | Gate the lock on a registered Kizashi, a nonzero `ft_balance_of`, a real payout, and an unregistered-claimant case |
| PQ-86 | `README.md:118,144` | The kill gate (ML-DSA key deletes the classical full-access key) was proven only on testnet protocol 88; mainnet is 86 and the README says only "should support it". If mainnet rejects it, deleting the classical key bricks a vault. Raised by a verifier. | Run gate G1 on a mainnet drill account before anything else |
| INIT-GATE | `kizashi/lib.rs:109-123` | Immutable init arguments (`usdc`, omen list) have no pre-lock check. A wrong or mistyped token address makes the USDC leg fail silently forever. Raised by a verifier; matches K6. | A pre-lock gate: `omens()`, `era()`, `bounty()`, `storage_balance_of` for USDC, and an empty access-key list |

### Medium after verification (downgraded from high)

| Id | Finding |
| --- | --- |
| K2 | `reset()` is public and unguarded under `feature = "drill"` (`kizashi/lib.rs:228-237`). Exposure needs a drill wasm on mainnet; whether the exported wrapper is also cfg-gated was not checked. Fix: require a `.testnet` account id and fail the pre-deploy step if the wasm exports `reset`. |
| S2 | Keys added outside the guard survive `trip`; `init` cannot list keys. The risk is the deploy procedure, not the contract. Fix: a deploy and monitor check that the access-key list equals the admin key plus recorded keys, and state "post-quantum-only" as conditional on it. |
| S3 | 64 dust sends fill the window, then honest keys earn strikes and burn (`mamori/lib.rs:26, 477-482`). Needs a compromised key; costs availability, not funds. Fix: time-bucket entries, no strike for "too many sends", a minimum amount. |
| F1 | Era cache and lockdown share one receipt, so a gas overflow reverts both. Key counts are capped (8 daily, 8 intents), leaving roughly 40 Tgas of margin by the verifier's arithmetic. |
| F2 | The vault era is stale until someone calls `trip`. `trip` is permissionless; this is a liveness and honesty gap (the keeper must run), not a code bug. |
| P1 | `scripts/omens.mjs check` does not flag an extra team-held omen. The live `jobs/src/verify.mjs:83-86` does fail on an extra omen; whether verify is a required gate before key deletion was not read. |
| J-hash | `verify.mjs` never hash-checks the drill vault code. |
| J-net | `verify.mjs` takes the expected network from the file under test, and never reads Kizashi's balance, so an unfunded zero-key Kizashi passes. |
| J-rpc | The keeper uses one RPC host and no jitter; a stalled node delays a pass, and failed vaults retry next pass. |
| J-watch | Watcher alerts also print and set exit code 2 on outflow, but the first NEAR/Solana sighting sets a baseline without alerting and "unreadable" does not change the exit code. |
| OPS-2/4/5/6/7 | The tested wasm is a drill build while the locked one is prod; key deletion needs one atomic transaction plus a post-check; cross-machine hash reproducibility is unproven (no path remap); the global-contract path (G2) is untested; `make verify` is a single command trusting one RPC. |

### Reported, not independently verified (medium and low)

- Kizashi: a failed NEAR payout is unrecoverable and unreported (K3); the first claim of any omen takes the whole pot, and top-ups after the last omen are locked (K4); omen keys are not validated for point validity or known drill keys (K5); sha256-not-keccak and no network tag in the message are undocumented or missing (K7, P4); a misattached constant comment (K8).
- Mamori: honest overspend or an unconfigured token (limit 0) earns strikes; queue slot exhaustion and squatting (32 junk requests block honest ones); Warning queues requests that can never execute; phantom keys re-recorded after a failed delete; no test of lockdown at maximum load.
- Protocol: drill omens print as init JSON identical in shape to production; one derivation implementation with no visible test vector; the testnet proof used team-held drill keys, so production keys have never been exercised on chain; the README does not state the no-keys, no-upgrade design; the reviewer flagged that the README's review text at lines 119 and 133 contradicts the testnet proof (I did not re-read those lines to check the wording).
- Jobs: Hinomi can publish a false zero; mainnet keys come from a hot env var and plaintext seeds, and the default network is mainnet; the keeper reports "tripped" on submission, not on lockdown; an empty vault list reads as success; watcher fetches have no timeout; fire-test verification needs archival data.
- App: passphrase strength is length-only (offline brute force of an exfiltrated backup); the backup is write-only and nothing in the app restores it; the Create vault design has no wallet, no outcome handling; the refund address is unvalidated; the public quote and status routes can burn the server's 1Click quota; stale-data and mainnet configuration gaps.

### Refuted or reduced to nothing

| Id | Claim | Why it fell |
| --- | --- | --- |
| Mamori F4 | A failed AddKey can unrecord an already-live key | `add_daily_key` panics if the key is already recorded (`mamori/lib.rs:178`, test `tests.rs:138`), so a live recorded key cannot be re-added. Refuted. |
| Jobs F2 | Fire-test files sort as strings | Writers zero-pad to four digits (`bin.mjs:97,103`, `testnet.mjs:188`). Only a hand-named `10.json` would misorder. Low. |
| Mamori F3 | Keys are forgotten before deletion is confirmed | `assert_daily_key` requires membership (`:460`), so an unrecorded live key is refused at once. Low: a misleading view only. |

## What was not verified

- The drill flag: `Cargo.toml` defaults and whether the macro-generated `reset` export is gated. Nobody read the Cargo features.
- Host semantics of `ed25519_verify` (strict or not) and `ecrecover`, the `near-sdk` version, and gas on real mainnet USDC.
- Mamori lines 140-300's interaction with `intents.near` (the real method names are gate G4), and `ml_dsa_verify` on mainnet.
- The top-up page UI, `@fastnear/wallet` and `@fastnear/ml-dsa-65` internals, and whether the ML-DSA wasm needs `wasm-unsafe-eval` under the strict CSP.
- Anything outside the named slices. A mainnet deploy script may exist elsewhere in the repo; the reviewer of that slice did not search for one.
- No test, build or chain call was run in this review.

## Open questions for the team

1. Should the first claim of a Warning-level omen take the whole bounty, or should it be split by level (K4)?
2. Is the 5-minute delay floor acceptable as a production setting, or should production `init` enforce 24h (S1)?
3. After the lock, what is the incident plan if a Kizashi bug is found? Nothing can be fixed; the honest options are a new contract with a new address and an announcement.
4. Will the keeper run before the break, and who pays its gas? A stale vault era is bounded by the cap and strikes, not eliminated (F2).
