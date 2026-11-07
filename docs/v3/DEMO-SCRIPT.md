# KAIGEN v3: 90-second demo script

Status: draft, 2026-11-04. Testnet and local sandbox only. No audit. Not run on mainnet.

Citations in brackets name the source file. Paths are repo-relative. Every command below exists in `jobs/src/bin.mjs`. Every number is from a source file listed in section 4, except the testnet result, which is the owner's statement and is marked as such in that row.

Decisions already made by the owner: the video leads with the calibrated attacker (attack 2), then the burned-key and strike story (attack 1), then the cage-check going red and green on a planted key (attack 8). Kizashi is optional and is kept out of the narration.

Two things the script has to work around, both found while writing it:

- Planting a key on testnet: until now no command did. Attack 8's planted-key step existed only in the Rust sandbox test [tests-integration/tests/attacks/attack_8.rs]. Attack 2 has no testnet command [tests-integration/tests/attacks/attack_2.rs] and stays a sandbox shot. Attack 8 can be shown LIVE on testnet: `plant-key` ran on testnet on 2026-11-07 against a production-mode vault. A planted classical full-access key made `cage-check` RED on ARCH-2.8-1 (exit 1), and removing it made `cage-check` GREEN (exit 0) [TESTNET-REHEARSAL.md, third run]. The owner runs these commands, in this order, on a fresh production-mode vault from the `prodvault` step below [jobs/src/plantkey.mjs, jobs/src/bin.mjs]:
  - `node jobs/src/bin.mjs plant-key <vault> --kind ed25519-full|null-allowance` (dry run). Add `--yes` to send. It signs with the vault's ML-DSA admin seed, so it needs `KAIGEN_TESTNET_DIR` (or `--admin-seed-file`) pointing at the folder whose `admin-seeds.json` holds that vault's seed. The planted key's secret goes to `planted-keys.json` in that folder and is never printed. It prints the public key and the exact `cage-check` command to run next. Expected: `ed25519-full` red on ARCH-2.8-1; `null-allowance` red on ARCH-2.8-3, -5 and -6.
  - `node jobs/src/bin.mjs plant-key <vault> --remove <publickey> --yes` takes it off again (it refuses the admin's own key and a recorded agent key). Then `node jobs/src/bin.mjs cage-check <vault> --rpc https://rpc.testnet.fastnear.com --wasm out/prod/mamori.wasm` is expected to be GREEN (exit 0). Use the exact `cage-check` command that `plant-key` prints, since it also passes the admin handle. `cage-check` is read-only.
- The testnet vault from `testnet` is a drill build with a 10-second withdrawal delay [jobs/src/testnet.mjs, `init` call with `delay_secs: 10`]. Do not describe a 24-hour lock on a drill vault. The 24-hour figures are sandbox figures. A production-build vault with the real 24-hour delay is made by `prodvault`. It was run on testnet on 2026-11-07 (`pv-45cbcb96.kaigen-funder-ee0d56.testnet`, cage-check GREEN on all 15 conditions) [TESTNET-REHEARSAL.md, third run; jobs/src/prodvault.mjs]. Its withdrawal delay is 24 h, so the demo vault cannot finish a withdrawal inside a demo. Run the live attack 8 steps as follows (the owner runs them, not the script):
  - `node jobs/src/bin.mjs prodvault --kizashi <drill Kizashi account> --funder-file <FILE> --yes` (without `--yes` it is a dry run). It follows a drill Kizashi, not the production omens. The `out/prod/mamori.wasm` build must exist (`make build`). It needs a funded testnet account file (JSON with `account_id` and `private_key`, about 5 NEAR available) and `KAIGEN_TESTNET_DIR` set to a `.kaigen-testnet*` folder or one outside the repository (it refuses a folder inside the repository that .gitignore does not cover). It creates `pv-<8 hex>.<funder>` with 4.9 NEAR, deploys `out/prod/mamori.wasm` with `init` in the same transaction (24-hour delay, 1 NEAR daily limit), makes a fresh ML-DSA-65 key the only full-access key, adds one agent daily key and allowlists one supplier (`--supplier`, default `supplier.<funder>`, which must exist before a payment), then runs `cage-check` and prints GREEN, RED or UNKNOWN per row.
  - What it does not cover, and prints each time: the Kizashi is the drill/testnet one you pass, not the production omens; no payment, strike or fire test is run; the cage-check is one block in time. The admin is compared by the handle the ML-DSA library derives, so no stand-in admin is used. The agent key is in `prodvault-<vault>.json` in the secrets folder; `demo` has not been tried against it (its steps assume the drill build's 10-second delay), so the strike and burn story is still planned on the drill rehearsal vault.

---

## 1. Shot list (timestamp | what is on screen | exact command or action | voice-over)

| Timestamp | What is on screen | Exact command or action | Voice-over line |
|---|---|---|---|
| 0:00 to 0:08 | Title card "KAIGEN v3". Then `docs/v3/ATTACK-RESULTS.md`, opened at the caveat line (line 3). | Open the file in a viewer. No command. [docs/v3/ATTACK-RESULTS.md, line 3] | "This shows what a daily key on a NEAR vault can lose." |
| 0:08 to 0:28 | `docs/v3/ATTACK-RESULTS.md` section 3, table 2a. Caption: "local sandbox, measured". | Scroll to section 3 "Attack 2" and hold on table 2a. No live command: attack 2 is a sandbox test only. [ATTACK-RESULTS.md section 3; tests-integration/tests/attacks/attack_2.rs] | "This attacker reads the vault's free check view, then sends exactly the cap. On a local sandbox it lost one cap, 1 NEAR, in 21 blocks, with zero strikes. The strike counter did not stop it." |
| 0:28 to 0:38 | Section 3, table 2c. Caption: "local sandbox, one chain day later". | Scroll to 2c. No command. [ATTACK-RESULTS.md section 3, 2c] | "A day later, with nobody cancelling, it took 11 NEAR in one 24-hour window. That is the cap plus the pending limit, which is the bound." |
| 0:38 to 0:58 | Terminal with the `demo` output. Lines read "HELD" or "BROKE" per step. | `node jobs/src/bin.mjs demo`, with the environment in section 3 set beforehand. [jobs/src/bin.mjs, `demo` command] | "A scripted agent, after an injected instruction, tries to drain the vault. A normal payment still goes through. The vault refuses each attack, counts strikes, and burns the key on the third. The next try with that key is refused." |
| 0:58 to 0:68 | Section 9 of `docs/v3/ATTACK-RESULTS.md`: the attack 8 table. Caption: "local sandbox, stand-in admin key, not a production result". | Scroll to section 9 and hold on the table. Optional live step: see the note under the table in section 2. [ATTACK-RESULTS.md section 9] | "The cage check reads the vault's keys. With a full-access key planted, it goes red and names that key. With the key removed, it goes green. This ran on a local sandbox with a stand-in admin key." |
| 0:68 to 0:80 | Pre-recorded output of the testnet rehearsal: the last block of `testnet` output (vault line, 10 demo rows, two `PASS` fire-test lines). | Play the pre-recorded clip. Do not run `testnet` live in the take. [jobs/src/bin.mjs, `testnet` command; jobs/src/testnet.mjs `renderRehearsal`] | "On testnet, on 2026-11-04, the drill build ran the same demo. Ten of ten steps held, and both drill fire tests passed." |
| 0:80 to 0:90 | Title card with the caveat text from section 5. | No command. | "Testnet only. No audit. Not run on mainnet. The attack numbers come from one local sandbox. The commands and numbers are in the repository." |

Total narration is about 190 words. At normal pace this is about 80 seconds, leaving room for the screen changes.

---

## 2. Notes on individual shots

**0:38 to 0:58, the `demo` run.** Expected output has 10 step rows, then `vault balance ... -> ...`, `reached the attacker: 0 ...`, and `RESULT: every attack was stopped.` [jobs/src/demo.mjs `renderDemo`; jobs/src/testnet.mjs step count]. The 10 steps are: honest payment, wrapper refusal, queued withdrawal, admin cancel, execute of the cancelled request, three strike attacks, key burned, and the burned key tried again [jobs/src/demo.mjs]. The strikes are at attacks 1 to 3 and the key is burned on attack 3 [jobs/src/demo.mjs, `maxStrikes = 3`]. The demo waits up to 40 seconds for the key to disappear (20 tries, 2 seconds apart) [jobs/src/demo.mjs `wait` default].

**0:58 to 0:68, the cage-check.** The planted-key red and green steps are measured only on the sandbox [docs/v3/ATTACK-RESULTS.md section 9]. A live `cage-check` on the testnet vault is optional. The command is `node jobs/src/bin.mjs cage-check <vault> --rpc https://rpc.testnet.fastnear.com` [jobs/src/bin.mjs; jobs/src/testnet.mjs `TESTNET_RPC`]. The testnet vault is a drill build, and the checker marks `drill_build: true` as RED on row ATTEST-2 [jobs/src/cage.mjs, line 188]. So the expected live result is exit 1 with ATTEST-2 red. Do not present that as a failure. Say aloud that a drill build is marked red on purpose, or drop the live step. Note that `docs/v3/ATTEST-CHECK.md` section 2.1 describes drill builds differently from the code. Resolve the wording before recording.

**0:68 to 0:80, the rehearsal clip.** The output block the owner should capture is what `renderRehearsal` prints: the kizashi and vault account lines, the demo rows, the `PASS` or `FAIL` line for each fire test, and a `RESULT:` line [jobs/src/testnet.mjs `renderRehearsal`]. That `RESULT:` line says "the lockdown and every attack defence worked on a real chain". Crop it if the wording overstates the run for the video. The `testnet` output also prints "testnet kizashi <account>". Kizashi is out of the narration, so crop or accept that one line.

**Fallback, 15 seconds.** Use this if `demo` has not printed its first step within 15 seconds, or has not finished after about 45 seconds. Cut to the saved output of an earlier `demo` run if one exists. If none exists, cut to the table below and read it:

> On a local sandbox, with ten strikes allowed, the key was off the account one block after the burn decision, 46 blocks after the first attempt. Nothing reached the attacker.

Source: [docs/v3/ATTACK-RESULTS.md section 2, attack 1c: "blocks, burn decision to key off the account" 1; "blocks, first attempt to key off the account" 46; "funds moved to the attacker (NEAR)" 0].

---

## 3. Commands and environment

Run from the repository root. Real commands only.

| Step | Command or setting | Source |
|---|---|---|
| Rehearsal (before recording, not in the take) | `node jobs/src/bin.mjs testnet`, with `KAIGEN_TESTNET_DIR` set to the rehearsal folder. Optional `KAIGEN_FUNDER_FILE` (a funded testnet account file outside the repo). | jobs/src/bin.mjs `testnet` command; jobs/src/testnet.mjs `provision` |
| Strike and burn story | `node jobs/src/bin.mjs demo`. Needs `DEMO_VAULT`, `DEMO_SUPPLIER`, `DEMO_ADMIN_SEEDS` (path to the admin seeds file), `AGENT_DAILY_KEY` (the agent's private key, from the rehearsal folder). Optional `DEMO_ATTACKER` (set it to `kaigen-attacker.testnet`; the default is `attacker.near`), `DEMO_PAY` (default 0.001 NEAR). | jobs/src/bin.mjs `demo` command; jobs/src/testnet.mjs `rehearse` |
| Deployments file for `demo` | `demo` calls `load()`, which reads `deployments.json` (or the path in `KAIGEN_DEPLOYMENTS`). It must say `"network": "testnet"` and the testnet RPC `https://rpc.testnet.fastnear.com`. The example file says mainnet. Do not use the example. | jobs/src/bin.mjs `load()`; deployments.example.json; jobs/src/testnet.mjs `TESTNET_RPC` |
| Cage check (optional live step) | `node jobs/src/bin.mjs cage-check <vault> --rpc https://rpc.testnet.fastnear.com`. Adding `--wasm out/drill/mamori.wasm` pins the code hash so row ARCH-2.8-8 is checked and not UNKNOWN. Exit codes: 0 green, 1 red, 3 unknown. | jobs/src/cage.mjs `CAGE_USAGE`, `exitCodeOf`; jobs/src/bin.mjs |
| Attack 2 | No command. Show the sandbox table. | docs/v3/ATTACK-RESULTS.md section 3 |
| Attack 8 | Live testnet steps in the blockers section, or the sandbox table as the fallback. | docs/v3/ATTACK-RESULTS.md section 9; TESTNET-REHEARSAL.md third run |

The `recycle` command deletes the testnet accounts in the rehearsal folder and sends their balances back to the funder [jobs/src/testnet.mjs `recycle`]. It also deletes the vault. Run it after the take, never before.

---

## 4. Numbers to read out

Only measured numbers are listed. Each one is labelled with where it was measured. Nothing here is a projection.

| Number | Value | Where it was measured | Source |
|---|---|---|---|
| Attack 2, loss | 1 NEAR, equal to one cap, 0 strikes | local sandbox | ATTACK-RESULTS.md section 3, 2a |
| Attack 2, sends and blocks | 4 sends, 5 `check` calls, 21 blocks from first to last send | local sandbox | ATTACK-RESULTS.md section 3, 2a |
| Attack 2c, loss in one day window | 11 NEAR in one 24-hour window, equal to cap plus pending limit | local sandbox | ATTACK-RESULTS.md section 3, 2c |
| Bound | C + P = 11 NEAR (cap 1 NEAR, pending limit 10 NEAR, the default 10 times the cap) | local sandbox configuration; the formula is general | ATTACK-RESULTS.md section 1 header table; docs/v3/LOSS-BOUND.md section 1 |
| Attack 1a, burn timing (3 strikes) | key off the account 1 block after the burn decision, 11 blocks (1.389 chain seconds) after the first attempt; 0 NEAR to the attacker | local sandbox | ATTACK-RESULTS.md section 2, 1a |
| Attack 1c, burn timing (10 strikes) | key off the account 1 block after the burn decision, 46 blocks (5.807 chain seconds) after the first attempt; 0 NEAR to the attacker | local sandbox | ATTACK-RESULTS.md section 2, 1c |
| Attack 8, cage check | Clean: exit 0 GREEN. Planted ed25519 full-access key: exit 1 RED, ARCH-2.8-1. Key removed: exit 0 GREEN. Planted null-allowance key: exit 1 RED, ARCH-2.8-3 and ARCH-2.8-6. Removed: exit 0 GREEN. Checker run time 360 to 467 ms wall. Stand-in admin, not a production result. | local sandbox | ATTACK-RESULTS.md section 9 |
| Testnet rehearsal, 2026-11-04 | 10 of 10 demo steps held; both drill fire tests passed; v3 drill build | testnet, one run | Owner's statement for this script. Two fire-test records dated 2026-11-04 exist in the rehearsal folder (0001 and 0002, no `.failed` file). The run transcript is not in the repository, so the 10 of 10 result could not be checked from a file. The 10 steps are counted in jobs/src/demo.mjs. |
| Property test, loss bound | 4,000 seeds, 0 violations | off-chain property test, not a chain | docs/v3/LOSS-BOUND.md section 4, soak row |
| Property test, stretch sweep and policy paths | 4,000 seeds, 0 violations (default build) | off-chain property test, not a chain | docs/v3/LOSS-BOUND.md section 9.4, soak row |

Do not read out gas or allowance figures; they are not needed for the 90 seconds. Do not read out any figure that is not in the table above.

---

## 5. Caveat line (say it aloud, at 0:80)

"Testnet only. No audit. Not run on mainnet. The attack numbers come from one local sandbox, with a stand-in admin key."

Source: [docs/v3/ATTACK-RESULTS.md, line 3 and section 13; docs/v3/README.md status line].

Words and claims to avoid in narration: "novel", "first", "unique", "unbreakable", "secure" as a superlative, any comparison with other wallets or projects, "24-hour lock" for the testnet vault, "production" for any result, and "anyone can execute" (see checklist item 5).

---

## 6. Pre-recording checklist

1. **Funding.** The rehearsal creates four sub-accounts from the funder: kizashi 3 NEAR, vault 4.3 NEAR, keeper 0.6 NEAR, supplier 0.1 NEAR, which is 8 NEAR plus gas. The public faucet gives one account about 10 NEAR per IP per 12 hours [jobs/src/testnet.mjs `subAccount` calls and `faucetAccount` comment]. Fund the funder before the run, or set `KAIGEN_FUNDER_FILE` to a funded account file outside the repository.
2. **`KAIGEN_TESTNET_DIR` set** to the rehearsal folder. The default is `.kaigen-testnet` at the repository root [jobs/src/bin.mjs `testnet` command]. Both `.kaigen-testnet/` and `.kaigen-testnet*/` are gitignored [.gitignore].
3. **Deployments file for `demo`.** Point `KAIGEN_DEPLOYMENTS` at a testnet copy, not the example. The example says mainnet and `demo` reads the network and RPC from it [jobs/src/bin.mjs `load()`; deployments.example.json].
4. **`demo` environment.** Set `DEMO_ATTACKER` to `kaigen-attacker.testnet`, the account the rehearsal uses. The default `attacker.near` is not a testnet account name [jobs/src/bin.mjs; jobs/src/testnet.mjs `rehearse`].
5. **The post-cancel execute.** The rehearsal signs that execute from an unrelated keeper account. `demo` does not pass that option, so it signs with the agent key [jobs/src/testnet.mjs `rehearse` anyoneCall; jobs/src/bin.mjs `demo` command]. The step name on screen says "anyone executes". Keep the narration to "the cancelled withdrawal cannot be executed".
6. **Re-arming.** `demo` burns the agent key. The rehearsal adds it back through the admin and the fire-test re-arm [jobs/src/testnet.mjs `rehearse`; jobs/src/chain.mjs `rearm`]. A bare second `demo` after a burn has no key to use. This was not checked against a run. Do a dry run: `testnet`, then `demo`, in that order, and confirm the second command works before recording.
7. **Failed fire tests.** If a fire test fails, the drill is left in kaigen and the next run stops at its preflight check [jobs/src/firetest.mjs `runFireTest` comment, `preflight` step]. Record from a fresh rehearsal folder, not a folder with a failed run in it.
8. **Drill build present.** `out/drill/kizashi.wasm` and `out/drill/mamori.wasm` must exist. They were present on 2026-11-04 [directory listing of out/drill]. The Makefile does not build the drill build. The Cargo flags are in README.md ("Build" note, `--features drill`) and the author has not confirmed them as written [README.md, drill build note]. The rehearsal used the built files, so do not rebuild them before the take.
9. **Terminal font size.** No source sets this. Choose a size that keeps the `HELD` and `BROKE` lines and the exit codes readable on the recording.
10. **No keys on screen.** Never show the contents of `.kaigen-testnet*/` or `.kaigen-testnet-v3/`. That includes `accounts.json`, `state.json`, `admin-seeds.json`, `drill-omen-secrets.json`, and `funder.json` [jobs/src/testnet.mjs `provision` and `saveKeys`]. Never print the value of `AGENT_DAILY_KEY`, `DEMO_ADMIN_SEEDS`, or `KEEPER_PRIVATE_KEY`. Set the variables without echoing them, and do not run `cat` or `type` on any file in those folders during the take. Clear the scrollback before recording. Check the `testnet` output for keys before using it; the tool prints step names, account names and transaction hashes.
11. **Captions on the sandbox shots.** Attack 2 and attack 8 must carry the caption "local sandbox". Attack 8 must also carry "stand-in admin, not a production result" [docs/v3/ATTACK-RESULTS.md section 9].
12. **Testnet cage-check wording.** Decide before recording whether the live `cage-check` step stays in. A drill vault is red on ATTEST-2 [jobs/src/cage.mjs line 188], and `docs/v3/ATTEST-CHECK.md` section 2.1 says something different. Do not show a red result without the sentence that explains it.
13. **Withdrawal delay on testnet.** The rehearsal vault has a 10-second delay [jobs/src/testnet.mjs]. Do not say "24-hour lock" on screen or in the narration for testnet.
14. **Stale text on screen.** The root README.md judge step 4 said the testnet rehearsal was "Not run for v3". It now records the 2026-11-04 runs and the 2026-11-07 and 2026-11-08 `stretchdrill` runs [README.md, Judge demo step 4; TESTNET-REHEARSAL.md]. Check any other page shown in the take for the old wording before recording.
15. **Time budget.** The sources bound the waits (40 seconds for the demo's key burn, up to 60 seconds for each fire-test poll) but do not record the total run time [jobs/src/demo.mjs; jobs/src/firetest.mjs `waitFor`]. Time the dry run and use the fallback if the live take is longer than planned.
16. **Recording the rehearsal clip.** Save the rehearsal output to a file outside the gitignored folders, and only after checking it for keys (item 10). That saved file is the source for the 0:68 clip and the fallback.

---

## 7. Not covered by this script

- Attack 2 on testnet: no command exists, so it is shown from the sandbox. Attack 8 can be shown live on testnet (see the blockers section); the sandbox table is the fallback.
- Attacks 3 to 7 and 9: not in the video. They are in docs/v3/ATTACK-RESULTS.md.
- Kizashi: not narrated. It appears on screen in the rehearsal output.
- Mainnet: not run. The mainnet tooling is dry-run by default and was not used here [jobs/src/bin.mjs `mainnet` command; docs/v3/README.md].
