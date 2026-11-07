# KAIGEN v2 to v3: changes, breaking change, and checked claims

Status: 2026-11-03. Testnet only. No audit. Nothing here has run on mainnet. Each claim cites the file it came from, in square brackets. Code facts were also grepped in `contracts/mamori/src/lib.rs` and `contracts/kizashi/src/lib.rs` at HEAD 44227f2.

## 1. Breaking change: redeploy, do not upgrade

- **Mamori.** The stored layout changed. `Withdrawal` gained `expires_at`, and a new state field `requested_by_key` (prefix k) was added. A v2 vault that holds queue entries cannot read them. v3 vaults must be deployed fresh. [V3-MAMORI-PROGRESS.md steps 1 and 3]
- **Kizashi.** A new state field `usdc_epoch: u64` was added. A v2-testnet instance cannot be upgraded in place. Redeploy. [V3-KIZASHI-PROGRESS.md step 2]
- **Fallback.** The git tag `v2-testnet` holds the v2 code. The M1 log rebuilt it from `git archive` and it passed the same burn tests. [git tag -l; V3-M1-PROGRESS.md (c)]
- **Build artefact.** `out/prod/mamori.wasm` (323,974 bytes) is not a build of the `v2-testnet` tag. Burned keys were removed from it, but a burned key's queued withdrawals stayed queued. Do not use it as a reference for either version. [V3-M1-PROGRESS.md (d)]
- **v3 builds have run on testnet, in rehearsals only.** The drill and production-mode builds ran on testnet on 2026-11-04, 2026-11-07 and 2026-11-08. The attack numbers are sandbox numbers. [TESTNET-REHEARSAL.md; ATTACK-RESULTS.md section 13]

## 2. Mamori behaviour changes

| Area | v2 | v3 | Source |
|---|---|---|---|
| Strike counting | A policy refusal of `send_small` counted, including cap used up by earlier spend. | Only refusals that can never succeed count: `not_allowlisted` and `over_cap_total`. `cap_exhausted` does not count. | ATTEST-CHECK.md section 4; ARCHITECTURE.md 2.1 |
| Strike window | 24 h, fixed. | Unchanged. The cumulative count (Q4) is not implemented. | ROADMAP.md Q4; ATTACK-RESULTS.md 11.4 |
| Queue expiry | None. | `expires_at` = unlock + 24 h. `execute` refuses an expired request. | V3-MAMORI-PROGRESS.md step 1; lib.rs `EXECUTE_WINDOW_SECS` |
| Purge and cancel | `cancel(id)`. | Adds `cancel_all()` (admin, returns count) and `purge_expired()` (anyone, returns count). | V3-MAMORI-PROGRESS.md step 2 |
| Per-key limits | Account-wide only. | Per key, with n recorded keys: `MAX_QUEUE / n` requests, `pending / n` queued value, `pending / n` requested per 24 h. The account-wide limits still apply. | LOSS-BOUND.md section 1; V3-MAMORI-PROGRESS.md step 3 |
| Revoked key | `add_daily_key` accepted any key. | Refuses a key that is revoked but not yet deleted from the account. | V3-W2-EDITH-PROGRESS.md M4a |
| Views | Config and key views. | Adds `attest()` and `check(key, asset, amount, to)`. | ATTEST-CHECK.md sections 2 and 3 |
| Reason codes | Text only. | Ten stable codes. The text is unchanged. Two per-key share texts are new. | ATTEST-CHECK.md section 4; V3-MAMORI-PROGRESS.md step 3 |
| Events | `kaigen` NEP-297 envelope, version 1.0.0. | Same envelope and version. Fields added (`reason_code`, `spent_after`, `token`, `amount`, `to`, `count`, `trigger`). New event `send_failed`. | ATTEST-CHECK.md section 5 |
| `request_withdraw` | Returns U64. Refusals panic and are uncounted. | Unchanged (Q-ABI kept). | ROADMAP.md Q-ABI |
| Delay floor | 24 h in production builds. | Unchanged. The loss bound depends on it. | ARCHITECTURE.md 2; LOSS-BOUND.md 1 |
| Non-zero allowance | Enforced. | Unchanged. Regression test added. | ARCHITECTURE.md 2.5 |
| `ft_transfer_call` | Not called. | Still not called. No new value-moving export. | ARCHITECTURE.md 2.3, 2.6 |

**Stretch items (built, 2026-11-04; run on a testnet drill vault on 2026-11-07 and 2026-11-08, with the limits in LOSS-BOUND.md section 9.5).** Policy path: `set_policy_account`, four `propose_*` methods, a permissionless `apply` after `delay_secs`, `cancel_proposal`. The policy actor is an account identified by predecessor, not a function-call key on the vault; this departs from ARCHITECTURE.md section 6 (STRETCH-DESIGN.md D1). Sweep path: `set_safe_account` (after the delay), up to 4 watchers, `set_emergency` (at most 7 days), and `sweep_to_safe(id)` with no destination argument. Bound: C + P unchanged; executes plus sweeps at most 2P; everything that leaves the vault at most C + 2P; sweeps go only to the admin-set safe account [LOSS-BOUND.md sections 9.2 and 9.3; STRETCH-DESIGN.md sections 1 and 2].

Two v2 facts that v3 does not change: the stored `max_strikes` range is 1 to 10 [lib.rs `set_max_strikes`], and the default pending limit is 10 times the cap [lib.rs `PENDING_LIMIT_MULTIPLE` = 10].

## 3. Kizashi change

- **Race fix.** `on_usdc_balance` now refuses a token balance read that was ordered under an older `usdc_epoch`. `claim` and `retry_payout` pass the epoch they saw. The epoch rises when an in-flight payout is reported as landed, and when `release_stale` frees a reservation. [V3-KIZASHI-PROGRESS.md step 2]
- **ABI.** Public methods and views are unchanged. The private callback `on_usdc_balance` gained an `epoch` argument. Nothing in `jobs/` or `app/` calls it. [V3-KIZASHI-PROGRESS.md step 2]
- **Residuals** (not fixed): a reservation released by the 10 minute timeout can still be double-spent by a read ordered after the release. A NEAR refund that beats its callback can let a second claim sweep refunded NEAR, and the callback books an unbacked debt. This is pinned by a test and deliberately not fixed in the contract: a hold-back fix strands a top-up and adds state, and the contract cannot tell a refund from an equal top-up. The evidence and the three-order model are in [KIZASHI-REFUND-ORDER.md]. No code change, so the Kizashi wasm is unchanged [docs/internal/V3-OPEN-KIZASHI-PROGRESS.md step 5]. Clippy was not run. [V3-KIZASHI-PROGRESS.md step 3]
- **Status.** Kizashi stays optional. [ROADMAP.md Q8; THREAT-MODEL.md section 6]

## 4. Tooling and checks added

- **cage-check.** `node jobs/src/bin.mjs cage-check <account>`. 15 rows: ARCH-2.8-1 to 8, ATTEST-1 and ATTEST-2, and ATTEST-3 to 7 (safe account, policy actors, emergency window, safe-account change, proposals; the last five cover the stretch settings) [jobs/src/cage.mjs]. Exit 0 is GREEN, 1 is RED, 3 is UNKNOWN (a row could not be checked, for example a v2 vault with no `attest()`). Exit 2 is not described in the sources. `--stand-in-admin` passes an ed25519 admin in the sandbox; the output is then marked "not a production result". [V3-W2-CAGE-PROGRESS.md; ATTACK-RESULTS.md attack 8]
- **Row 2 is UNKNOWN when the admin is given as a full ML-DSA public key.** The hash format is not in the sources. [V3-W2-CAGE-PROGRESS.md step 3 (a)]
- **Attack suite.** `tests-integration/tests/attacks/`, run against a WSL sandbox. The timed test is `#[ignore]`. [V3-W3-ATTACKS-PROGRESS.md; ATTACK-RESULTS.md section 14]
- **Sandbox.** nearcore 2.14.0, protocol 88, `init --fast` (128 ms blocks), WSL distro `kaigen-sandbox`. The vault admin is ed25519. [V3-M1-PROGRESS.md step 1; ATTACK-RESULTS.md section 0]
- **Property tests.** `contracts/mamori/src/tests/loss_bound.rs`, a seeded generator (proptest is not in the lock file). [LOSS-BOUND.md section 4]
- **Mutation checks.** Sixteen mutations of `lib.rs`, in 20 runs. [LOSS-BOUND.md section 5]

## 5. Old README claims checked against the sources and code

Items 1 to 7 were wrong or stale against the v3 sources and were fixed in the README. Item 8 was confirmed.

1. The old banner said "testnet-proven". v3 has sandbox results only. v2 has testnet drill records. [LANDSCAPE.md section 3]
2. "Pending limit zero for a token with no daily limit." This holds only by default. The admin can set a pending limit for a token with no cap, and then that token can be queued. [LOSS-BOUND.md E2]
3. The line-number tables (for example `lib.rs` line 703 for `refuse`) were taken from v2 on 1 Nov 2026. They are removed. LOSS-BOUND.md gives line numbers at an older hash, which is also stale. Use function names.
4. Gap id `G2` in the old README meant "storage cost, about 3 NEAR per vault". ROADMAP.md uses `G2` for global-contract publishing on mainnet. The old meaning is kept below, marked unverified, and the id clash is noted.
5. The old "What makes KAIGEN unique" heading made a novelty framing. It is renamed. No novelty claim is made. [NOVELTY-CLAIMS.md section 3]
6. The refusal sequence diagram listed only dust and no-limit refusals as uncounted. `cap_exhausted` is uncounted too. [ATTEST-CHECK.md section 4]
7. The old test counts (Kizashi 60, Mamori 78, app 62, jobs 149, scripts 20) were from v2. Replaced with: Mamori 230 default and 226 drill, Kizashi 104 default and 105 drill [KIZASHI-REFUND-ORDER.md, 2026-11-07], jobs 358 with 2 skipped [owner's run, 2026-11-07]. [V3-W2-EDITH-PROGRESS.md; V3-KIZASHI-PROGRESS.md; V3-W2-CAGE-PROGRESS.md] The app and scripts counts are not re-run and are removed.
8. Allowlist size (32) and omen cap (8) are not in the design docs. They were confirmed by grep of `MAX_ALLOWED` (32) and `MAX_OMENS` (8) in the code, at HEAD 44227f2.
9. The three "Key Code" excerpts were v2 code with v2 line numbers. They are replaced by a list of function names. The code excerpt for `emit_refused` no longer matches the v3 signature, which takes the call.
10. The old "Fixed in the current code" list and the old omen-limits paragraph were kept in the README and marked unverified, not removed. The K3 gap row and the old G2 storage row were restored after a first pass dropped them.

## 6. Old README claims that could not be verified against the v3 sources

These are kept in the README, marked with an HTML comment where they appear. They were not deleted. Each needs a source or a removal before submission.

- Track ids `security` and `open`, and the build window of 19 Oct to 14 Nov 2026. ROADMAP.md gives a submission window of 1 Nov to 14 Nov (from the plan). The source file `HACKATHON.md` is not in the repository.
- The GitHub source URL, the demo post placeholder and the landing page template.
- Fire-test records `fire-tests/0001.json` to `0004.json` and their contents. The v2 drill accounts `kizashi.kaigen-g1-0170217f.testnet` and `vault.kaigen-g1-0170217f.testnet`.
- The "Without KAIGEN" column of the problem table. It describes the design premise and was not measured.
- Omen details: the claim message layout beyond the domain string `KAIGEN/v1/claim` (verified in code), `ecrecover` on chain, secp256k1 signing sha256, the payout rules (including "the whole bounty to the first claimant"), and the USDC leg.
- "Anyone can call `trip`". The v3 code has `trip(&self)` with no admin argument, but the body was not read for this. The event `trip` is confirmed by ATTEST-CHECK.md.
- The "Fixed in the current code" list (K1, K2, K3, K5, S-queue, S1, S3, APP-1). Only the Kizashi race and the Mamori queue and counting changes are confirmed by the v3 logs.
- Kizashi key checks (`require_usable_ed25519`), the retry order (first come), and the K1 to K6 and S-queue fixed-item list.
- Gaps G2 (about 3 NEAR storage per vault), G3 (wallet-signed ML-DSA enrolment), G7 (Hinomi). ARCHITECTURE.md says Hinomi is out of scope for v3.
- Open gaps from the old table: intents starvation, one `trip` may not finish, RPC host and unsigned gate file, `deployments.json` missing from the repo, the `KIZASHI_CODE_HASH` 503 rule, the 1Click USDC asset id.
- The app: pages, headers (COOP and CORP), top-up routes and the 503 rule, Next.js 16, React 19, and the package list.
- Tooling: `make` targets, `node jobs/src/bin.mjs judge`, `judge-report.json`, `mainnet gates|plan|execute|lock` commands, `fire-test` records written by the CLI, and the `verify` command. ROADMAP.md confirms only that `jobs/src/mainnet.mjs` is dry-run by default.
- Versions: Rust 1.99.1, Node v24.11.1 and the npm packages listed under Tech Stack. `near-sdk` 5.30 is confirmed by V3-W2-EDITH-PROGRESS.md.
- The `AWS_LC_SYS_PREBUILT_NASM` Windows setting is confirmed by the LOSS-BOUND.md rerun command.
- Reproducible builds on one machine.
- The `docs/ARCHITECTURE-REVIEW.md` reference (file present, not read for v3).
- "Every decision by Kevin Andrew A" and the AI-written-code statement. Owner statements, not checked against code.
- Licence: `LICENSE` is MIT (verified from the file).

## 7. Design-draft statements now known to be wrong or open

- "No contract code of v3 exists yet" (THREAT-MODEL.md, status line). Wrong.
- "near-sdk 5.30 PublicKey has no ML-DSA variant" and "a contract cannot verify an ML-DSA signature" (ARCHITECTURE.md 2.2, THREAT-MODEL.md sections 6 and 7). The progress log reports `CurveType::MLDSA65` and `env::ml_dsa_verify` in the locked near-sdk 5.30. What the host returns for an ML-DSA signer is still unverified.
- "The 5 minute delay floor" (ARCHITECTURE.md and PLAN). Stale. The floor is 24 h.
- `revoke_all_agent_keys()` (ARCHITECTURE.md 3, ROADMAP.md). Not in the milestone logs. The implemented lockdown is `lock_down`. `sweep_to_safe` is now built (section 2, stretch items).
