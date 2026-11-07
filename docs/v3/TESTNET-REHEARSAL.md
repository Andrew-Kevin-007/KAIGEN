# Testnet rehearsal record (2026-11-04)

What this is: one run of `node jobs/src/bin.mjs testnet` followed by `node jobs/src/bin.mjs zerokey --yes` on NEAR testnet (protocol 88), using throwaway faucet-funded accounts that hold no value. It is a rehearsal of the DRILL builds: the vault delay is 10 s, not the production 24 h floor, and the Kizashi omens are drill omens, not the production ones. The accounts, keys and seeds stay in a gitignored `.kaigen-testnet*` folder. No audit, no mainnet.

Source of everything below: the run's own console output, run by the project owner's session on 2026-11-04. Transaction hashes can be looked up on a testnet explorer.

## Build under test

| item | value |
|---|---|
| commit | 5107d48 (contracts unchanged since; the stretch-item work was not yet applied) |
| `out/drill/kizashi.wasm` | 260,275 bytes, sha256 810f864b2c6c38947c34bdc9c4d9909c8e21a8e3668657beb9bda6d413eb9c91 |
| `out/drill/mamori.wasm` | 376,035 bytes, sha256 47207e932693b51eb299df8eb703cdbbcae1e316c6985eaf9b7f4705179cb055 |
| accounts | `kizashi.kaigen-funder-ee0d56.testnet`, `vault.kaigen-funder-ee0d56.testnet` |
| vault admin | ML-DSA-65 key, the only full-access key (the classical key was deleted in the run) |

## Result: `testnet` (injection demo and attack steps)

| step | expected | outcome |
|---|---|---|
| honest payment to the supplier | went through | HELD (tx Fcbf21KUzZDXPu8HVKUBsDY8F7ZZrn8mACrzStFqQDDd) |
| agent wrapper signs for the attacker | refused | HELD (refused as reported bad, nonexistent, not allowlisted, never paid before) |
| queue a withdrawal of everything to the attacker | went through (queued) | HELD |
| admin cancels the queued withdrawal | cancelled | HELD |
| anyone executes the cancelled withdrawal | refused | HELD ("no such request") |
| small in-limit send to the attacker | refused | HELD (not on the allowlist, strike 1 of 3) |
| send everything to the attacker | refused | HELD (strike 2 of 3) |
| send more than the daily limit to the supplier | refused | HELD (over the 24 h limit, strike 3 of 3, key burned) |
| the vault burns the agent's key after 3 refused attacks | key gone | HELD (burned on attack 3) |
| the hijacked agent retries with its burned key | refused | HELD (access key does not exist) |

Vault balance 4.296117 to 4.292873 NEAR. Reached the attacker: 0 yoctoNEAR. Gas the refused calls cost the vault: 0.00224 NEAR against a 0.02 NEAR budget.

Fire tests (drill omens): PASS with the ed25519 omen (claim tx GzyhfXutRrNQ9cHa16DjYwjR7YQXhHLwo2yjv9QcTGnF) and PASS with the secp256k1 omen (claim tx Ff6EP1jwzeA7dpd4E88oD6v7vvEEykpNWDsepHkGskmv).

## Result: `zerokey` (a Kizashi with no access keys)

All nine checks passed: preflight (calm, omen alive, Kizashi holds only its own key); delete Kizashi's own full-access key; no keys left; the views still answer; the deleted key can no longer sign; a third party claims with a valid drill omen; the claim raised the era and killed the omen; a third party resets the drill Kizashi; Kizashi is calm again and still has no access keys.

## Second run: the final build, with the stretch items (2026-11-04)

Same commands, on commit cb62c80 and a fresh funder (`kaigen-funder-a00266.testnet`; the first funder's Kizashi had no keys left after its `zerokey`, so its account name could not be reused).

| item | value |
|---|---|
| `out/drill/kizashi.wasm` | 260,275 bytes, sha256 810f864b2c6c38947c34bdc9c4d9909c8e21a8e3668657beb9bda6d413eb9c91 |
| `out/drill/mamori.wasm` | 432,749 bytes, sha256 5a4b09133dc0feddc93f4d69f0c65e2bb77d8feaa6ae4a5d39d78bc2f9c0d882 |
| Kizashi deploy and init | tx BwB9sAxYDvXvjSVGxg9AtrY5NZsxuYxuxE1b32hr8AW |
| Mamori deploy and init | tx DmamTU9mtt86yBwJgnjJ5MeiJHMzYmRXdzARULbXSLSB |
| honest payment | tx 2jjExtnTgWruTLcSwDp2nDw1RhRWbcWdV3NBK5xFpzwk |
| fire test ed25519 omen | claim tx CGTTWSsZeYHMW4mxDFR6zemU4c6ezexGvobhS2dHAbnd |
| fire test secp256k1 omen | claim tx 4q4seLZdZduXKn4CqnDWNwT2s9UmM1nrEy1bf53d5DSc |

All 10 defence steps HELD ("every attack was stopped"), both fire tests PASS, and all 9 `zerokey` checks PASS, as in the first run. The sweep and policy paths are covered by unit tests only; this rehearsal does not call `sweep_to_safe` or `propose_*` on chain.

## Third run: the stretch paths and a production-mode vault (2026-11-07)

Two more commands, both run by the project owner's session on testnet (protocol 88), against the final build (contracts unchanged since cb62c80).

**Production-mode vault** (`prodvault`): `pv-45cbcb96.kaigen-funder-ee0d56.testnet`, the production `out/prod/mamori.wasm` (432,906 bytes, code hash AoxPd3zABfzDRoPsE14ReAzMrzq5o5rMFj8FZXn9zKoQ), deployed and initialised in one transaction with the production 24 h delay, an ML-DSA-65-only admin key, one allowlisted supplier and one agent daily key. `cage-check`: GREEN, all 15 conditions. `plant-key` added an ed25519 full-access key (tx 779ehEJxrqQnc8KrvYPpcBKYkE5LWJWhKPdVxN7YfXv4): `cage-check` went RED on ARCH-2.8-1, exit code 1, naming the key; removing it turned `cage-check` GREEN, exit code 0. It follows a drill Kizashi, not the production omens, and no withdrawal, strike or fire test was run on it.

**`stretchdrill`** on the drill vault `vault.kaigen-funder-a00266.testnet` (delay 10 s). Result: all five steps PASS, "the stretch items worked on a real chain".

| step | evidence |
|---|---|
| 1 safe account | `set_safe_account` accepted, `attest()` shows it waiting, then in force with nothing pending |
| 2 `sweep_to_safe` | tx HRUYgVuSz7RSDp39njLntmCWRoyv2YXW12ssvDiuZcjy; a `sweep_to_safe` event naming the safe account; no `sweep_failed`; every receipt ran on the vault or the safe account only; the safe account received exactly 0.0100 NEAR; the vault fell by 0.010704 NEAR (the amount plus 0.000704 NEAR gas); the request's own payee received nothing; the request left the queue |
| 3 refusals | a stranger calling `sweep_to_safe`: refused by the contract ("admin or watcher only"); the agent's daily key calling it: refused by the access key's permission before the contract ran; `set_safe_account` to the vault itself: refused ("the safe account cannot be the vault itself"); nothing moved, the request stayed queued |
| 4 policy path | `set_policy_account` accepted and shown by `attest()`; `propose_allow_recipient` queued with the allowlist unchanged; `apply` before the wait refused ("still locked"); a second proposal queued and removed with `cancel_proposal`; `apply` after the wait ran the first, the recipient is allowlisted and no proposal waits |
| 5 `cage-check` | 14 of 15 rows GREEN; ATTEST-2 RED by design, because it is a drill build with a delay of seconds |

An extended run on 2026-11-08 added three steps (the policy actor is now a separate account with its own key, `sd-policy`, distinct from the stranger), all PASS:

| step | evidence |
|---|---|
| 6 watcher path | `add_watcher` registered `sd-watcher` (the vault itself is refused as a watcher); with no emergency window the watcher's sweep is refused ("watchers can sweep only in a declared window"); `set_emergency` over 7 days is refused; inside a declared window the watcher's `sweep_to_safe` is accepted (30 Tgas attached, the admin's sweep burnt 5.78 Tgas), the event names the watcher as caller and the safe account as destination, the vault fell by exactly the amount and the watcher paid the gas; the watcher is refused on `set_safe_account`, `set_emergency` and `cancel` ("admin only"); the window ended by itself and the watcher was refused again; after an admin closed a window the watcher was refused; `remove_watcher` emptied `watchers()` |
| 7 remaining proposals | `propose_set_token_limit`, `propose_set_pending_limit` and `propose_add_daily_key` by the policy account were queued with the effect not yet in force, then applied after the wait by a stranger (the keeper) and read back: token limit and pending limit 100000, the daily key listed |
| 8 NEP-141 sweep | with the look-alike token fixture `ft-mock` (not a real token): 100 token units swept, `ft_balance_of` of the safe account 0 to 100 and of the vault 1000 to 900, the sweep event names the token and the safe account, the payee, the stranger and the token contract unchanged; an oversized request (5000 units) went through the contract as `sweep_failed` and every balance was unchanged |

A first run of this command failed step 4 because the check for "apply before the delay is refused" ran about 3.3 s after the proposal's run time (the delay is 10 s and other transactions ran in between). That was a test-ordering bug, confirmed from block timestamps; the check now runs right after the proposal.

Still not covered: the documented failure of a safe account that is not registered with the token (the look-alike fixture has no storage registration, so the failed-transfer path was shown with an oversized request, the same code path); a real NEP-141 token (storage registration, `ft_transfer_call`, real decimals); a watcher's NEP-141 sweep; a sweep of an expired request; and how a real owner holds the policy and watcher keys (here they are files in the gitignored testnet folder, which shows they are distinct keys, not custody). The drill delay is 10 s, not the production 24 h. During the first extended run two checks failed on wrong expectations in the harness (a watcher-signed transaction legitimately executes a receipt on the signing account, and a watcher funded with 0.04 NEAR could not prepay the gas); both were harness fixes, not contract results.

## Not covered

- The production builds were not deployed. The drill builds differ from production by the `drill` feature (a Kizashi `reset`, and a Mamori era that follows Kizashi down).
- Mamori's v3 stretch items (policy-key split, `sweep_to_safe`) were not in this build.
- The `testnet` output was captured with its first lines cut off, so the account-creation and deploy transaction hashes are not recorded here; they are in the run's `state.json` in the gitignored folder.
- Sandbox attack numbers are in ATTACK-RESULTS.md. This rehearsal ran on a real chain with real block times, so it complements them; it is not a replacement.
