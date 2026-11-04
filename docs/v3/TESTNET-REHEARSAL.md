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

## Not covered

- The production builds were not deployed. The drill builds differ from production by the `drill` feature (a Kizashi `reset`, and a Mamori era that follows Kizashi down).
- Mamori's v3 stretch items (policy-key split, `sweep_to_safe`) were not in this build.
- The `testnet` output was captured with its first lines cut off, so the account-creation and deploy transaction hashes are not recorded here; they are in the run's `state.json` in the gitignored folder.
- Sandbox attack numbers are in ATTACK-RESULTS.md. This rehearsal ran on a real chain with real block times, so it complements them; it is not a replacement.
