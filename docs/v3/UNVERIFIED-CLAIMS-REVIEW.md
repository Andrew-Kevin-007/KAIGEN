# UNVERIFIED claims review

Scope: every claim in `docs/v3/CHANGES-V2-TO-V3.md` section 6, and every `<!-- UNVERIFIED ... -->` marker in `README.md`, plus a few unmarked README statements that the same evidence contradicts (marked "unmarked" below).

Method: read-only local commands and file reads only. No network, no builds, no tests run (cargo and rustup are not installed on this machine: `cargo: command not found`). Verdicts are about what the repository says and contains. A VERIFIED row means the code path or record exists and matches the claim; it does not mean the behaviour was executed.

Repository state: this review was written at HEAD `2c7138d`. The first pass read `ec7aa71`. Since then `README.md` changed (row 68 below now matches the evidence) and the working tree has uncommitted edits in `jobs/src/stretchdrill.mjs` and two new `jobs/src/stretch*.mjs` files, which this review did not read or use.

## Summary

| Verdict | Count |
| --- | --- |
| VERIFIED | 56 |
| CONTRADICTED | 7 |
| NOT VERIFIABLE FROM THE REPO | 24 |
| Total rows | 87 |

Rows 68 (README line 602) was CONTRADICTED at `ec7aa71` and is VERIFIED at HEAD after the README was corrected. It is counted as VERIFIED.

## Kevin must decide these

Each entry is a CONTRADICTED or NOT VERIFIABLE row, with a proposed replacement sentence. Accept or reject each. The replacements claim nothing beyond the cited evidence.

1. Row 1, track ids. Replace with: "Track: `security` (AI Security & Defense), fallback `open` (Open Innovation), as listed on the organiser's page: [link to add]."
2. Row 2, build window. Replace with: "Submission window: 1 Nov to 14 Nov 2026 (UTC), per the internal plan. The organiser's announcement is not in this repository."
3. Row 3, source URL. Open `https://github.com/Andrew-Kevin-007/KAIGEN` logged out and confirm it is public. The `origin` remote matches it.
4. Row 4, demo post. Replace the placeholder with the post URL after publishing, or delete the line.
5. Row 5, landing page template. Replace with: "Landing page: Next.js (`site/package.json`). Template origin: [Kevin to state]." Note `site/` has no tracked files in git.
6. Row 7, "proven on testnet". Replace with: "The v2 drill records `fire-tests/0001.json` to `0004.json` report every step ok. The transactions are not re-checked here."
7. Row 8, "v2 contract, not redeployed for v3". Replace with: "The v2 drill account names appear in `fire-tests/0001.json` to `0004.json`. Whether those accounts still hold v2 code is not checked here."
8. Row 9, "Without KAIGEN" column. Replace with: "The 'Why it survives today' column states the design premise. It has not been measured."
9. Row 14, USDC leg not run on chain. Replace with: "None of the six fire-test records has a USDC step. Whether the USDC leg ever ran on a chain is not checked here."
10. Row 20, "K1 to K6 fixed". Replace with: "K1, K2, K3 and K5 have code paths and labelled tests. K4 and K6 are not confirmed. ROADMAP.md marks the item 'Partly'."
11. Row 27, G2 storage "about 3 NEAR". Replace with: "Each vault deploys the Mamori code: 432,906 bytes in `out/prod/mamori.wasm`. At 0.00001 NEAR per byte that is about 4.33 NEAR of storage per vault, before the vault's own state. Not measured on chain."
12. Row 37, 1Click asset id "assumed". Replace with: "A top-up is refused unless the quoted asset id equals `nep141:<Kizashi's usdc_token>`. It is not checked against the 1Click token list."
13. Row 38, intents starvation. Replace with: "If every `intents.near` removal keeps failing, intents keys may not be removed. The gas figures come from the unit-test VM and are not measured on a chain."
14. Row 39, two claims reading the full balance. Replace with: "`usdc_epoch` and in-flight reservations address the stale-read case in code. The exact two-claim case has not been run."
15. Row 42, rustup on first use. Replace with: "`rust-toolchain.toml` pins 1.99.1. Whether rustup installs it automatically was not checked here."
16. Row 43, "the author used Node v24.11.1". Replace with: "The repository does not pin a Node version. This copy runs Node v24.11.1."
17. Row 44, "author's Windows machine has no make". Delete, or replace with: "`make` is optional. The Makefile covers the same steps as plain commands."
18. Row 46, "reproducible on one machine". Replace with: "Two wasm builds in this folder have the same SHA-256. A second build has not been run."
19. Row 48, AI-written code and owner decisions. Replace with: "All 37 commits are authored by Kevin Andrew A. Whether and how AI tools were used is not recorded in the repository."
20. Row 50, G3 wallet-signed ML-DSA add-key. Replace with: "The wallet-signed path to add an ML-DSA key is not in the app and has no test in the repository."
21. Row 53, Create vault "not run against a chain". Replace with: "The Create vault page has not been run against a chain, as far as the repository records show."
22. Row 55, landing page being redesigned. Replace with: "The landing page in `site/` is described here only as the landing page." (Or state the redesign status.)
23. Row 56, `motion` in App stack. Replace with: "App: Next.js 16, React 19, `@fastnear/wallet`, `@defuse-protocol/one-click-sdk-typescript` (per `app/package.json`)."
24. Row 59, "classical keys stay until someone deletes them". Replace with: "This is a general NEAR premise, not checked against the repository." (Or cite the NEAR access-key documentation.)
25. Row 60, "the sandbox admin was ed25519" context, README line 48, "Often a classical full-access key". Replace with: "General premise, not checked against the repository."
26. Row 70, exact sandbox test command. Replace with: "Sandbox test command: to be confirmed by running it on the sandbox."
27. Row 72b, "The author did not run this command". Replace with: "The drill build command is not in the Makefile. It has not been run in this repository."
28. Row 80, "No gas measurement on a real mainnet or testnet chain" (unmarked). Replace with: "No gas measurement on mainnet. Testnet gas figures are recorded in `docs/v3/GLOBAL-CONTRACT.md` and `docs/v3/TESTNET-REHEARSAL.md`."
29. Row 81, global-contract 1,024-byte measurement record (unmarked). Replace with: "The measurement is written up in `docs/v3/GLOBAL-CONTRACT.md`. Its JSON record is not in this copy (`data/` is git-ignored and absent)."
30. Row 82, "Nothing is deployed to mainnet". Replace with: "No mainnet deployment record is in this repository."
31. Row 83, "This folder is not a git repository". Replace with: "This folder is a git repository (branch `main`, 37 commits, earliest 1 Nov 2026). Tag `v2-testnet` marks the v2 code."

## Table

Columns: id | claim (short quote) | verdict | evidence (file:line or command) | Kevin still checks.

### A. CHANGES-V2-TO-V3.md section 6, and README markers

| id | claim | verdict | evidence | Kevin still checks |
| --- | --- | --- | --- | --- |
| 1 | Track ids `security`, `open` (README:69) | NOT VERIFIABLE FROM THE REPO | `HACKATHON.md` absent (`ls`). No other track list was searched. | Copy the ids from the organiser's rules page. |
| 2 | Build window 19 Oct to 14 Nov 2026 (README:619) | NOT VERIFIABLE FROM THE REPO | 19 Oct source is `HACKATHON.md`, absent. `docs/v3/ROADMAP.md:9` gives 1 Nov 00:00 UTC to 14 Nov 23:59 UTC from `docs/PLAN-submission-and-mainnet.md` (30 Oct). | Confirm the organiser's dates. |
| 3 | GitHub source URL (README:21) | NOT VERIFIABLE FROM THE REPO | `git remote -v`: origin is `https://github.com/Andrew-Kevin-007/KAIGEN.git`, matching README. Public access not checked (no network). | Open it logged out. |
| 4 | Demo post placeholder (README:21) | NOT VERIFIABLE FROM THE REPO | Placeholder `<!-- DEMO POST URL ... -->` present at README:21. No URL in repo. | Add the URL after publishing. |
| 5 | Landing page template (README:617) | NOT VERIFIABLE FROM THE REPO | `git ls-files site` returns 0 files. `site/package.json` names no template. | State the template origin. |
| 6 | Fire-test records 0001 to 0004 and their contents (README:390, 601) | VERIFIED | Each file has 8 steps, all `ok: true`, with claim, trip, PQ-send, reset and re-arm hashes (`fire-tests/0001.json` to `0004.json`). `git diff --quiet v2-testnet -- fire-tests/000N.json` shows all four identical to the `v2-testnet` tag. | Look up the transaction hashes on a NEAR testnet explorer. |
| 7 | "proven on testnet (fire-tests/0001.json to 0004.json)" (README:76) | NOT VERIFIABLE FROM THE REPO | Records say `ok: true`. On-chain outcome not checked (no network). | Explorer lookup. |
| 8 | v2 drill accounts `kizashi.kaigen-g1-0170217f.testnet`, `vault.kaigen-g1-0170217f.testnet` (README:234-235; CHANGES 6) | NOT VERIFIABLE FROM THE REPO | Names appear in `fire-tests/0001.json` to `0004.json` (`git grep 0170217f`). Whether the accounts still hold v2 code: not in repo. | Chain check. |
| 9 | "Without KAIGEN" column of the problem table (CHANGES 6) | CONTRADICTED | README table header (README:31) is `Failure mode | Why it survives today | What KAIGEN does`. No "Without KAIGEN" column exists. No measurement of the premise column found in the repo (not exhaustively searched). | Accept the replacement in item 8. |
| 10 | Omen claim message layout beyond `KAIGEN/v1/claim` (README:90) | VERIFIED | `contracts/kizashi/src/lib.rs:15` (`CLAIM_DOMAIN`), `:734-736` (`{domain}\n{contract}\n{omen_id}\n{claimant}`), `:554-556` (`claim_message` view). | None. |
| 11 | `ecrecover` on chain for secp256k1 (README:221) | VERIFIED | `contracts/kizashi/src/lib.rs:753` calls `env::ecrecover`. Host semantics come from near-sdk, not in repo. | None. |
| 12 | secp256k1 signs the sha256 digest, not keccak (README:221, 224) | VERIFIED | `lib.rs:751` `env::sha256_array(message)`; doc comment `lib.rs:286-288`. | None. |
| 13 | First claim takes the whole balance, including a warning-level omen (README:406; CHANGES 6) | VERIFIED | Doc `lib.rs:293-294`. `claim()` `lib.rs:302-345` has no level check on payout; level only raises era (`lib.rs:316-318`). | None. |
| 14 | "USDC leg not run on chain" (README:79; CHANGES 6) | NOT VERIFIABLE FROM THE REPO | None of `fire-tests/0001.json` to `0006.json` has a USDC step. `jobs/src/testnet.mjs:91` deploys Kizashi with `usdc: null`. `docs/ARCHITECTURE-REVIEW.md` OPS-3 says it was never run. Absence not proven. | Check explorer for `ft_transfer` from the Kizashi account. |
| 15 | `trip` callable by anyone (README:35, 91) | VERIFIED | `contracts/mamori/src/lib.rs:930` `pub fn trip(&self)`, no `assert_admin` in body (`:930-935`). `docs/v3/ATTEST-CHECK.md:137` lists the `trip` event. | None. |
| 16 | Fixed: K1 payout registration and events (README:408) | VERIFIED | `lib.rs:666-690` `start_usdc_payout` chains `storage_deposit` then `ft_transfer`; `lib.rs:415-445` `on_usdc_paid`; events `lib.rs:759-770`. Test label `kizashi/src/tests.rs:343`. Not run. | None for code presence. |
| 17 | Fixed: K2 reset only in drill (README:408) | VERIFIED | `lib.rs:560-572` `#[cfg(feature = "drill")]` and `.testnet` require. `contracts/kizashi/Cargo.toml` drill feature. Test `tests.rs:745`. | None. |
| 18 | Fixed: K3 `retry_payout` for owed payouts (README:408) | VERIFIED | `lib.rs:458-493` `retry_payout`; `lib.rs:415-445` records owed; test `tests.rs:548`. | None. |
| 19 | Fixed: K5 init key checks (README:408) | VERIFIED | `lib.rs:262-279` (length, all-zero, `require_usable_ed25519`, duplicate id and key); test `tests.rs:819`. | None. |
| 20 | "Fixed in the current code: K1 to K6" (CHANGES 6; ROADMAP row 3) | CONTRADICTED | `docs/v3/ROADMAP.md:15` status "Partly... K1 to K6 and the pre-deploy script not checked there". `K6` is defined nowhere in the repo (only `docs/ARCHITECTURE-REVIEW.md:50` "matches K6"). README's fixed list omits K4 and K6. | Accept item 10. |
| 21 | Fixed: S-queue, requesting key recorded and queue cancelled on burn (README:408) | VERIFIED | `mamori/src/lib.rs:784-786` `requested_by`; `:521` `cancel_queued_by` on key removal; `:1702` on burn; `:1636` definition. Test `mamori/src/tests.rs:1549`. | None. |
| 22 | Fixed: S1 pending limit on queued value (README:408) | VERIFIED | `mamori/src/lib.rs:781-786` (`queue_room`, `take_request_budget`); `:1550-1592`, `:1600`. Test `tests.rs:1382`. | None. |
| 23 | Fixed: S3 send-window bucketing and minimum send (README:408) | VERIFIED | `lib.rs:35` `MAX_WINDOW_ENTRIES = 64`; `:41` `DEFAULT_MIN_SEND`; dust handling `:708-719`. Test `tests.rs:1628`. | None. |
| 24 | Fixed: APP-1 `/migrate` headers (README:408) | VERIFIED | `app/lib/security-headers.ts:21-22` COOP and CORP `same-origin`; `app/lib/nav.ts:14` `fullLoad`; `app/components/Nav.tsx:23-24`. Tests `app/lib/security-headers.test.ts:31-36`, `app/lib/nav.test.ts:5`. Not run. | None for presence. |
| 25 | Kizashi key checks `require_usable_ed25519` (CHANGES 6) | VERIFIED | `lib.rs:726-731`; called at `lib.rs:272`. | None. |
| 26 | Retry order is first come (CHANGES 6; README:434) | VERIFIED | `lib.rs:458-466`: each `retry_payout` pays `min(owed, payable_near())` when it runs. No ordered queue; order is call order. | None. |
| 27 | G2 storage "about 3 NEAR per vault" (README:429; CHANGES 6) | CONTRADICTED | `out/prod/mamori.wasm` = 432,906 bytes (`wc -c`; SHA-256 matches `out/repro/SHA256SUMS`). Rate 1e19 yocto per byte (`jobs/src/globalcontract.mjs:28-29`, i.e. 0.00001 NEAR). 432,906 x 1e19 = 4.33 NEAR. `docs/v3/ARCHITECTURE.md:109` uses a stale 323,974 bytes, which gives 3.24 NEAR and likely explains the old figure. | Accept item 11. |
| 28 | Mamori Warning pauses `send_small` and `request_withdraw`; queue kept, admin cancels (README:91) | VERIFIED | `mamori/src/lib.rs:1458-1460` (`EraNotCalm`), `:776-777`, `:844` (`execute` also paused, not stated in README), `:600` `cancel`. | None. |
| 29 | At Kaigen: classical daily and intents keys deleted, queue discarded (README:91) | VERIFIED | `lib.rs:975-1023` `lock_down`: queue discard, intents keys removed on `intents.near` (`remove_public_key`), daily keys `delete_key`. Wording note: intents keys are removed from `intents.near`, not deleted from the vault account. | Accept wording or change to "removed". |
| 30 | Repeat `trip` until `intents_keys()` and `daily_keys()` are empty (README:91) | VERIFIED | `lib.rs:926-929` doc comment; `on_era` `:951-953` schedules `lock_down`. | None. |
| 31 | Drill `reset` refused on non-`.testnet` accounts (README:261) | VERIFIED | `lib.rs:560-572`; `Cargo.toml` drill feature. | None. |
| 32 | Omen keys cannot be reused; dead omen cannot claim again (README:260) | VERIFIED | Duplicate id and key `lib.rs:275-279`; all-zero `:266`; small-order and non-canonical `:726-731`; dead-omen check `lib.rs:306`. | None. |
| 33 | One `trip` may not finish a lockdown (README:437) | VERIFIED | `lib.rs:926-929` doc; `LOCK_DOWN_GAS` 150 Tgas `lib.rs:61`; `take_while(has_fanout_gas)` in `lock_down`. | None. |
| 34 | Lock reads the chain through one RPC host; gate file unsigned (README:438) | VERIFIED | `jobs/src/mainnet.mjs:545-557` `lockKizashi` uses one `rpc` (from `jobs/src/bin.mjs:55-62` `load()`). `jobs/src/verify.mjs:414-419` `writeGate` writes plain JSON; grep for `sign` in `verify.mjs` finds nothing. | None. |
| 35 | `deployments.json` not committed (README:439) | VERIFIED | `.gitignore:23`; `git ls-files deployments.json` returns nothing. A local copy exists (testnet). | None. |
| 36 | `KIZASHI_CODE_HASH` unset gives 503 (README:440) | VERIFIED | `app/lib/topup-guard.ts:58-60`; `app/.env.example:12`. | None. |
| 37 | 1Click USDC asset id "assumed, not checked" (README:441) | CONTRADICTED | `app/lib/topup-guard.ts:78-79` refuses unless the quoted asset equals `nep141:${usdc_token}` from Kizashi. `app/lib/topup.ts:35-38` fetches the live token list, but the check is against Kizashi, not the list entry. | Accept item 12. |
| 38 | Intents keys can starve if removals keep failing; gas from unit VM (README:436) | NOT VERIFIABLE FROM THE REPO | Mechanism present: intents first, `take_while` on gas (`mamori/src/lib.rs:~1000-1012`), failed key re-recorded (`:1158`). Gas figures are unit-test results, not run here. | Testnet or sandbox run. |
| 39 | Two claims close together can both read full balance (README:433) | NOT VERIFIABLE FROM THE REPO | Mechanism: `usdc_epoch` (`kizashi/src/lib.rs:300-303`), `in_flight` (`:112`, `:217`), `on_usdc_balance` `:357-414`. The exact case was not re-checked (README says so). Tests not run. | Run the Kizashi test for this case. |
| 40 | Failed `ft_balance_of` held as read to repeat; no automatic retry (README:435) | VERIFIED | `lib.rs:369-375` `record_unread` and `payout_failed`; comment `lib.rs:369-371`: `retry_payout` is the only path. | None. |
| 41 | Rust 1.99.1 pin (README:465, 506; CHANGES 6) | VERIFIED | `rust-toolchain.toml:2` `channel = "1.99.1"`; `out/repro/repro-manifest.json` records `rustc 1.99.1`. `cargo` not run. | None. |
| 42 | rustup installs the toolchain on first use (README:506) | NOT VERIFIABLE FROM THE REPO | `rustup: command not found` on this machine. rustup behaviour is outside the repo. | Confirm on a clean machine. |
| 43 | "the author used Node v24.11.1" (README:507; CHANGES 6) | NOT VERIFIABLE FROM THE REPO | No `engines`, `.nvmrc` or `.node-version` in the repo (`find`). This copy's `node --version` prints v24.11.1. | Accept item 16. |
| 44 | `make` optional; author's Windows machine has no make (README:508) | NOT VERIFIABLE FROM THE REPO | Author's machine not in repo. `Makefile:1` comment says the same, which is not evidence. | Accept item 17. |
| 45 | `AWS_LC_SYS_PREBUILT_NASM` setting (README:509; CHANGES 6) | VERIFIED | `Makefile:2`; `docs/v3/LOSS-BOUND.md:117` rerun command sets it. | None. |
| 46 | Reproducible builds on one machine (README:443; CHANGES 6) | NOT VERIFIABLE FROM THE REPO | `out/prod/*.wasm` and `out/repro/prod/*.wasm` have equal SHA-256 (checked). Manifest git commit `cb62c80`; only `kizashi/src/tests.rs` changed since then. No second build run (builds not allowed). | Second build, e.g. `scripts/repro-build.ps1`. |
| 47 | `docs/ARCHITECTURE-REVIEW.md` reference (README:617) | VERIFIED | File exists, dated 30 Oct 2026, findings table present (`docs/ARCHITECTURE-REVIEW.md`). | None. |
| 48 | Kevin owns every decision; AI-written code statement (README:617; CHANGES 6) | NOT VERIFIABLE FROM THE REPO | All 37 commits authored "Kevin Andrew A" (`git log --all`). `git log --all --format=%B` contains 0 "Co-authored-by" lines. Authorship and decision ownership not recorded. | Accept item 19. |
| 49 | Licence MIT (CHANGES 6) | VERIFIED | `LICENSE:1-3`: "MIT License", "Copyright (c) 2026 Kevin Andrew A". | None. |
| 50 | Wallet-signed ML-DSA add-key path untested; harness uses a classical key (README:430) | NOT VERIFIABLE FROM THE REPO | No add-key code in `app/` (grep for AddKey/add_key). `jobs/src/testnet.mjs:108` deletes the vault's classical key in the rehearsal harness. "Untested" is an absence claim. | Accept item 20. |
| 51 | G7 Hinomi: out of scope for v3; source of accounts not chosen (README:432) | VERIFIED | `docs/v3/ARCHITECTURE.md:13` "Out of scope for v3". `deployments.example.json` `hinomi`: `accountsFile: null`, `accounts: []`. Note: `jobs/src/bin.mjs:70` still has a `hinomi` command. | None. |
| 52 | "A signed gate file for `make verify`" is not built (README:456) | VERIFIED | `jobs/src/verify.mjs:414-419` writes plain JSON; no signing code in `verify.mjs`. | None. |
| 53 | Create vault page "has not been run against a chain" (README:455) | NOT VERIFIABLE FROM THE REPO | Page exists (`app/app/vault/create/page.tsx`). No run record in repo; `data/` absent. | Accept item 21. |
| 54 | Create vault "enabled on testnet only, mainnet stays off" (README:455) | VERIFIED | `app/lib/vault-create.ts:17` `createVaultGuard`: testnet enabled, other networks off. `app/DEPLOY.md:26` confirms the old flag is gone. Note: `app/.env.example:19` still lists `NEXT_PUBLIC_VAULT_CREATE`. | None. |
| 55 | Landing page in `site/` "being redesigned" (README:457) | NOT VERIFIABLE FROM THE REPO | `git ls-files site` returns 0. No redesign status in repo. | Accept item 22. |
| 56 | App stack includes `motion` (README:469) | CONTRADICTED | `app/package.json` dependencies: `@defuse-protocol/one-click-sdk-typescript`, `@fastnear/api`, `@fastnear/ml-dsa-65`, `@fastnear/wallet`, `next`, `react`, `react-dom`. No `motion` or `framer-motion`. (`framer-motion` exists only in `.claude/worktrees/landing-merge/app/package.json`, not the main app.) | Accept item 23. |
| 57 | Next.js 16 and React 19 (README:469; CHANGES 6) | VERIFIED | `app/package.json`: `next ^16.4.3`, `react ^19.3.1`. | None. |
| 58 | Package lists for scripts, jobs and app (README:468; CHANGES 6) | VERIFIED | `jobs/package.json` lists all six packages. `scripts/package.json` lists only `@noble/curves` and `@noble/hashes`. App wallet and one-click packages present. | None. |
| 59 | "classical keys stay on the account until someone deletes them" (README:33) | NOT VERIFIABLE FROM THE REPO | General NEAR access-key premise. Repo has no source for it. | Accept item 24. |
| 60 | "Often a classical full-access key" (README:48) | NOT VERIFIABLE FROM THE REPO | General premise. README:5 says the sandbox used an ed25519 stand-in. | Accept item 25. |
| 61 | `node jobs/src/bin.mjs judge` writes `judge-report.json`; PASS or SKIPPED (README:600) | VERIFIED | `jobs/src/bin.mjs:31-35` writes `judge-report.json`; `jobs/src/judge.mjs:85-108` uses SKIPPED and PASS; `.gitignore:17`. | None. |
| 62 | Fire-test records written by the CLI (CHANGES 6) | VERIFIED | Command is `firetest` (`jobs/src/bin.mjs:114-134`), writes `fire-tests/NNNN.json`. There is no `fire-test` command. | Accept naming correction in README if wanted. |
| 63 | `mainnet gates | plan | execute | lock`, `--i-understand-this-is-irreversible`, key file (README:565-ish; CHANGES 6) | VERIFIED | `jobs/src/bin.mjs:498-516` and `:570`; `jobs/src/help.mjs`. | None. |
| 64 | `verify` command reads `deployments.json` (CHANGES 6) | VERIFIED | `jobs/src/bin.mjs:58-60` via `load()`, path from `:55`. | None. |
| 65 | `jobs/src/mainnet.mjs` is dry-run by default (CHANGES 6; ROADMAP) | VERIFIED | `docs/v3/ROADMAP.md:59`; `jobs/src/mainnet.mjs:8`, `:441`, `:543`. | None. |
| 66 | Make targets: build, verify, verify-prelock, predeploy, repro-build (README:520s, 565s) | VERIFIED | `Makefile:10-12` (build), `:23-26` (verify), `:29-32` (verify-prelock), `:37-40` (predeploy), `:18-19` (repro-build; `scripts/repro-build.ps1` exists). | None. |
| 67 | `testnet` command makes throwaway sub-accounts, prints addresses, nothing committed (README:239) | VERIFIED | `bin.mjs:138`; `jobs/src/testnet.mjs:43` and `:55` log account ids; `.gitignore` excludes `.kaigen-testnet/`. | None. |
| 68 | "Not run for v3" for `testnet` (README:602, corrected at HEAD) | VERIFIED | Was CONTRADICTED at `ec7aa71`: `docs/v3/TESTNET-REHEARSAL.md:1-3` and `:42` record v3 runs on 2026-11-04 (second on commit `cb62c80`, funder `kaigen-funder-a00266`). README at HEAD now says "Run for v3 on 2026-11-04 (twice)". | None. |
| 69 | `/migrate`: admin key made in browser, encrypted backup required before anything else (README:605) | VERIFIED | Route `app/app/migrate/page.tsx`. Step order `Key, Backup, Verify, Vault` (`app/app/migrate/MigrateClient.tsx:14`). "Before anything else" is stronger than the order: Key comes first. | Choose wording: "before the vault step". |
| 70 | Exact sandbox test command (README:561) | NOT VERIFIABLE FROM THE REPO | `tests-integration/` and `sandbox/start.ps1` exist. The command was not run. | Run on the sandbox. |
| 71 | Long timed attack: `cargo test -- --ignored`, about 100 minutes (README:561s) | VERIFIED | `tests-integration/tests/attacks/timed.rs:43` `#[ignore = "... about 100 minutes ..."]`. | None. |
| 72 | Drill build: `--features drill` on kizashi and mamori, `--cfg near`, not in Makefile (README:576) | VERIFIED | `Makefile` has no `out/drill` target; `contracts/kizashi/Cargo.toml` and `contracts/mamori/Cargo.toml` drill features; `.cargo/config.toml` sets `--cfg near`. | None. |
| 73 | "The author did not run this command as written" (README:576) | NOT VERIFIABLE FROM THE REPO | Author's action; no record either way. | Accept item 27. |
| 74 | `npm run dev` in `app/` and `site/` (README:537) | VERIFIED | `app/package.json` and `site/package.json` both have `"dev": "next dev"`. | None. |
| 75 | Install: `npm ci` in jobs, scripts, app (README:520) | VERIFIED | `jobs/package-lock.json`, `scripts/package-lock.json`, `app/package-lock.json` tracked (`git ls-files`). | None. |
| 76 | `.env*` git-ignored except `.env.example`; `NEXT_PUBLIC_KIZASHI_ID`, `ONECLICK_JWT` (README:528) | VERIFIED | `.gitignore:4-5`; `app/.env.example` has both variables. | None. |
| 77 | Without `NEXT_PUBLIC_KIZASHI_ID` the app says "not deployed yet" (README:528) | VERIFIED | `app/.env.example:1` and `app/DEPLOY.md:8` state it. App code path not searched beyond this. | None. |
| 78 | Unit-tested in v3: signature verification (README:76) | VERIFIED | Tests `contracts/kizashi/src/tests.rs:85`, `:103`, `:120`, `:135` (ed25519 and secp256k1). Not run. | None. |
| 79 | RFC 9380 hash-to-curve for omen keys (README:223) | VERIFIED | `scripts/omens.mjs:4` (comment), `:27-29` `hashToCurve`. README's "line references" marker not checked. | None. |
| 80 | secp256k1 low-s (README:221) | VERIFIED | `kizashi/src/lib.rs:752-753` comment "reject high-s" and `true` flag; `scripts/claim.mjs:4`, `:19-20` `lowS: true`. | None. |
| 81 | Global-contract 1,024-byte measurement record (README:428, unmarked) | NOT VERIFIABLE FROM THE REPO | `docs/v3/GLOBAL-CONTRACT.md:127` states 0.0001 NEAR per byte measured. Its JSON record is not in this copy (`data/` absent; gitignored). | Accept item 29. |
| 82 | "Nothing is deployed to mainnet" (README:565) | NOT VERIFIABLE FROM THE REPO | No mainnet record in repo; `deployments.json` is testnet. Owner statement. | Accept item 30. |
| 83 | "This folder is not a git repository in the copy I checked" (README:619) | CONTRADICTED | `git log` in this folder: 37 commits on `main`. README claim refers to a different copy at most. | Accept item 31. |
| 84 | Baseline before 19 Oct not shown by history (README:619) | VERIFIED | Earliest commit `33becb5` dated 2026-11-01 (`git log --reverse`). | None. |
| 85 | v2 tag is `v2-testnet` (README:619; CHANGES 6) | VERIFIED | `git tag` lists `v2-testnet` (commit `4fe9845`) and `v3-core-testnet`. | None. |
| 86 | Fire-test records 0001 to 0004 are the v2 tag's files (README:235, 390) | VERIFIED | `git diff --quiet v2-testnet -- fire-tests/000N.json` identical for all four. | None. |

### B. Unmarked README statements contradicted by the same evidence

| id | claim | verdict | evidence | Kevin still checks |
| --- | --- | --- | --- | --- |
| 87 | "No gas measurement on a real mainnet or testnet chain" (README:443, unmarked) | CONTRADICTED | Testnet gas recorded: `docs/v3/GLOBAL-CONTRACT.md:127` (gas 0.000066431 NEAR, protocol 88); `docs/v3/TESTNET-REHEARSAL.md:32` (gas for refused calls). | Accept item 28. |

Note: README line 443 is marked for the reproducibility sentence only. The gas sentence is unmarked.

## Other things noticed, not in scope

- Test counts (README:552-ish and the judge demo table) differ between documents. README says Mamori 230 (226 drill). `docs/v3/ROADMAP.md:16` says 120 (117 drill). `docs/v3/CHANGES-V2-TO-V3.md` section 5 item 7 gives older Kizashi counts. No counts were re-run.
- `app/.env.example:19` still lists `NEXT_PUBLIC_VAULT_CREATE`; `app/DEPLOY.md:26` says the flag is gone.
- `app/DEPLOY.md:65` says the README describes the removed flag. The README does not mention it (`grep -c` = 0).
- README `APP-2 is not listed as fixed`: `app/lib/topup-guard.ts:78-79` contains the check that APP-2 describes. Whether APP-2 is fixed was not decided here.
- `out/repro/SHA256SUMS` has CRLF line endings, so `sha256sum -c` fails on the last line. Hashes were compared by hand and match.
- `scripts/` has no `@fastnear/*` dependency; only `jobs/` does.
