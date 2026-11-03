# Mamori v3: `attest`, `check`, reason codes and events (ABI)

Status: implemented in `contracts/mamori` (v3 week 2) and unit-tested. Testnet only. Not deployed, no audit, no mainnet run. Everything below describes the code in this repository; nothing here was run on a node. Design source: ARCHITECTURE.md 2.7 (`check`, events) and 2.8 (`attest`, cage-check); milestones M4c, M5a, M5b in ROADMAP.md.

## 1. What these are, and what they are not

| Item | Kind | Is | Is not |
|---|---|---|---|
| `attest()` | view | The state the contract records about itself, in one call, for cage-check to compare with the chain. | Proof about the account. A full-access key can deploy code whose `attest()` says anything. It carries no code hash and no key list (see 2.2). |
| `check(key, asset, amount, to)` | view | Advice: what `send_small` would do with this call in the block the view runs in. | A control. The enforcement is `send_small` (and `execute`), which decide again when they run. State can change between the view and the call. |
| Reason codes | strings | Stable machine-readable names for each decision of `send_small`. | A change of any existing text. `SendOutcome.refused` and panic messages are byte-identical to v2. |
| Events | logs | The existing `kaigen` NEP-297 events, extended (section 5). | Receipts storage. No `receipts()` view exists. |

## 2. `attest()`

`attest() -> Attestation`. View, no arguments (call with empty args or `{}`), no state change, no log, no receipt. A test pins that storage is byte-identical after the call.

### 2.1 Fields (`Attestation`)

All 128-bit and 64-bit chain numbers travel as decimal strings (NEAR JSON convention). `delay_secs`, `min_delay_secs` and the small counters are plain numbers.

| Field | Type | Meaning |
|---|---|---|
| `attest_version` | number | Shape version of this object. Now 1. Raised when a field is removed or changes meaning; adding a field does not raise it. |
| `contract` | string | Always `"mamori"`. |
| `drill_build` | bool | True in a `--features drill` build. A drill build allows delays under the production floor and lets the cached era fall again, so the loss bound's delay condition does not hold. cage-check should treat `true` on anything but a drill vault as red. |
| `account_id` | string | The account the contract answered as. Compare with the account you asked. |
| `block_height`, `block_timestamp` | string | Block the answer is as of (`block_timestamp` in ns). |
| `config` | object | `ConfigView`, the same object the `config()` view returns: `kizashi`, `era`, `daily_limit` (NEAR cap, yocto), `delay_secs`, `effective_delay_secs` (always equal to `delay_secs`), `max_strikes`, `pending_limit` (NEAR, yocto), `min_send` (yocto). |
| `min_delay_secs` | number | The least `delay_secs` a production `init` accepts (86 400). Reported so a reader does not hard-code it. |
| `allowlist_enforced` | bool | Whether `send_small` is limited to the allowlist. Off by default. |
| `allowlist_len` | number | How many accounts are on the allowlist (read the list with `allowlist()`). |
| `daily_keys` | array | The daily keys the vault serves, each an object with `public_key` and `strikes`. `strikes` is the count in the current 24 h window (what `strikes_of` returns). |
| `intents_keys` | array of keys | Keys recorded on `intents.near`. Each signs there with no cap from this contract. |
| `revoked_keys` | array of keys | Daily keys the vault stopped serving (removed or burned) whose deletion from the account is not confirmed yet. |
| `queue_len` | number | Requests in the withdrawal queue, expired ones included until purged. |
| `note` | string | Fixed text saying what this answer is and is not. |

Per-token caps are not in `attest()`: token limits live in a map that cannot be listed. Read them with `token_limit(token)` and `pending_limit(token)` for the tokens the policy names.

### 2.2 What `attest()` deliberately does not return

* No code hash. The contract has no host function to read its own code hash (checked in `near-sys` 0.4.0, the locked version). cage-check reads it from RPC `view_account`.
* No key list and no admin key hash. The contract never reads its admin key and has no host function for the account's keys. cage-check reads them from RPC `view_access_key_list`.
* No contract version string. The crate version is not bumped per build, so it would be a claim nobody maintains. `attest_version` versions the answer's shape only.

### 2.3 How cage-check uses it (ARCHITECTURE.md 2.8, red conditions)

| Red condition | Data source | What `attest()` adds |
|---|---|---|
| Classical full-access key; not exactly one ML-DSA full-access key | RPC key list | Nothing. |
| Function-call key with null allowance, or above the configured maximum | RPC key list | Nothing. |
| Function-call key with empty `method_names` or wrong receiver or extra methods | RPC key list | Nothing. |
| Function-call key not recorded in Mamori | RPC key list against `attest().daily_keys` | The recorded set. A key in `revoked_keys` is on the list and not served: report it as pending deletion, not as unrecorded. |
| A recorded intents key | `attest().intents_keys` | The list. Not visible in RPC. |
| Code hash differs from the pinned hash | RPC `view_account` | Nothing. |
| Loss-bound conditions that live in the contract's own config | `attest()` | `drill_build`, `config.delay_secs` against `min_delay_secs`, `allowlist_enforced`, `config.era`, `config.max_strikes`. |

## 3. `check`

`check(key, asset, amount, to) -> CheckView`. View, no state change, no log, no receipt. Arguments: `key` (a public key such as `ed25519:...`, because a view has no signer), `asset` (`null` for NEAR, else the NEP-141 contract; this is `send_small`'s `token`), `amount` (decimal string in the asset's smallest unit), `to` (recipient account).

### 3.1 Answer (`CheckView`)

| Field | Type | Meaning |
|---|---|---|
| `verdict` | `"allow"` / `"refuse"` / `"reject"` | `allow`: `send_small` would send. `refuse`: it would return a refusal (the call succeeds, nothing moves). `reject`: it would abort (nothing recorded, no strike). |
| `reason` | string | One of the codes in section 4. `ok` when the verdict is `allow`. |
| `counted` | bool | True when the refusal would be a strike against `key`. Only `not_allowlisted` and `over_cap_total`. |
| `would_burn` | bool | True when that strike would be the key's last in the window: the vault would delete the key. |
| `headroom` | string | What is left of the asset's 24 h limit now: limit minus what `spent_24h` shows, never below zero. Zero for an asset without a limit. |

### 3.2 Semantics

* One decision function. `send_small` and `check` call the same private function, in the same order of checks; `send_small` then acts on the result. A randomized test (700 calls over random states) asks `check` and then calls `send_small` in the same block and requires verdict, reason, strike, burn and headroom to match.
* It models the instant path `send_small` only. `request_withdraw` is not modelled (its refusals are panics and uncounted). `execute` is not modelled.
* Same block means exact. A later block can differ: another key can use the cap up, the window can age, the admin can change a setting, the era can rise. Treat the answer as advice.

### 3.3 Known weakness (ARCHITECTURE.md 2.7, kept)

Anyone, a hijacked key included, can call `check` for free and read the exact headroom. A caller that sends exactly the headroom to an attacker payee is never refused and never struck, so the refusal ladder catches only a clumsy attacker. Views cannot be rate limited. `check` makes the calibrated attacker's work easy and does not change the loss bound: the bound is the cap plus the pending limit (LOSS-BOUND.md), not the strike counter.

## 4. Reason codes

The code is the stable name (JSON, `check.reason`, event `reason_code`). The text is what `SendOutcome.refused` and panic messages say, unchanged from v2. `counted` is whether the refusal is a strike.

| Code | Verdict | Counted | Text (unchanged) | When |
|---|---|---|---|---|
| `ok` | allow | no | `ok` (only in `check`) | The call would go through. |
| `not_allowlisted` | refuse | yes | `recipient is not on the allowlist` | Allowlist enforced and `to` not on it. |
| `over_cap_total` | refuse | yes | `over the 24 h limit` | `amount` is above the WHOLE 24 h limit of the asset, which no window can hold. |
| `cap_exhausted` | refuse | no | `over the 24 h limit` | `amount` fits the limit but not what is left of it. The window is account-wide, so another key can cause this for an honest key: never counted. |
| `no_limit` | refuse | no | `no 24 h limit is set for this token` | The asset has no limit (a token never listed, or NEAR with limit zero). |
| `below_min_send` | refuse | no | `below the minimum send` | NEAR only: `amount` below `min_send`. |
| `not_a_daily_key` | reject | no | `not a recorded daily key` | `key` is not served: never added, removed, or burned. |
| `era_not_calm` | reject | no | `paused: era is not calm` | Era is warning or kaigen. |
| `zero_amount` | reject | no | `amount must be > 0` | `amount` is 0. |
| `transfer_failed` | (none) | no | `the transfer failed and was refunded to the daily limit` | Never returned by `check`. It is the outcome `send_small` reports from its callback when the transfer failed and the spend was given back (event `send_failed`). |

Order of checks (the first that applies wins, as in v2): key, era, amount, allowlist, limit, minimum, window. Two codes share one text (`over_cap_total`, `cap_exhausted`), so a reader that must tell them apart uses the code, not the text.

## 5. Events

Envelope, unchanged: `EVENT_JSON:{"standard":"kaigen","version":"1.0.0","event":<name>,"data":{...}}`. The version stays `1.0.0` on purpose: every change below adds a field, and none removes, renames or re-means one, so a reader pinned to the v2 shape still parses. Whether to move to `1.1.0` is open (section 6). Amounts are decimal strings; `token` is `null` for NEAR. Where `reason` and `reason_code` sit together, `reason` is the text callers have always seen and `reason_code` is the code from section 4. Queue events keep their existing `reason` word as the code (`cancel_all`, `key_removed`, `key_burned`, `lockdown`, `expired`). A star marks a field or an event added in M5b. `spent_after` is what `send_small` has sent of that token in the 24 h before the block, after the call (for a refusal, nothing moved, so it is what was already spent). Items in `withdrawals` are `id`, `token`, `amount`, `to`, `requested_by`.

| Event | Logged by | Data |
|---|---|---|
| `refused` | `send_small`, a refusal | `public_key`, `reason`, `reason_code`★, `strikes`, `counted`, `token`★, `amount`★, `to`★, `spent_after`★ |
| `key_burned` | `send_small`, the last allowed refusal | `public_key`, `reason`, `reason_code`★, `strikes`★ (the count that burned it), `max_strikes`★ |
| `send_small` | `send_small`, a send that went through | `public_key`★, `token`, `amount`, `to`, `spent_after`★ |
| `send_failed` ★ | `on_send_done`, the transfer failed | `reason_code` (`transfer_failed`), `token`, `amount`, `refunded` (false when no log entry held the send any more), `spent_after` |
| `queue_expired` | `purge_expired`, `request_withdraw`, `on_execute_done` | `reason` (`expired`)★, `trigger`★ (`purge_expired`, `request_withdraw` or `execute_failed`), `count`★, `withdrawals`. Not logged when nothing expired. |
| `queue_cancelled` | `cancel_all`, `remove_daily_key`, a burn | `reason`, `public_key` (not for `cancel_all`), `count`★, `withdrawals` |
| `queue_discarded` | `lock_down` | `reason` (`lockdown`), `count`★, `withdrawals` |
| `execute_dropped` | `on_execute_done`, a failed execute that does not come back | `id`, `reason`★ (`lockdown`, `expired`, `key_gone` or `no_room`, the first that applies in that order), `to`, `token`, `amount` |
| `request_withdraw` | `request_withdraw` | `id`, `token`, `amount`, `to`, `expires_at` |
| `execute` | `execute` | `id`, `to`, `token`, `amount` |
| `cancel` | `cancel` | `id`, `to`, `token`, `amount` |
| `add_daily_key` | `add_daily_key` | `public_key` |
| `add_daily_key_failed` | `on_key_added`, the AddKey failed | `public_key` |
| `remove_daily_key` | `remove_daily_key` | `public_key`, `retry` |
| `delete_key_failed` | `on_key_removed`, `on_revoked_key_deleted` | `public_key`, `revoked` (only for a revoked key) |
| `register_intents_key` | `register_intents_key` | `public_key` |
| `intents_remove_failed` | `on_intents_removed` | `public_key` |
| `set_pending_limit` | `set_pending_limit` | `token`, `limit` |
| `set_min_send` | `set_min_send` | `min` |
| `allow_recipient` | `allow_recipient` | `account` |
| `disallow_recipient` | `disallow_recipient` | `account` |
| `set_max_strikes` | `set_max_strikes` | `max` |
| `enforce_allowlist` | `enforce_allowlist` | `on` |
| `trip` | `on_era` | `era`, `changed` |
| `lockdown_partial` | `lock_down`, keys are left | `daily_keys_left`, `intents_keys_left`, `revoked_keys_left` |

Order within one call that burns a key: `refused`, then `queue_cancelled` (if the key had requests), then `key_burned`. A burn is the largest log a single call writes: with a full queue of the burning key (32 requests, 64-character accounts, 37-digit amounts, a secp256k1 key) it logs 11 349 bytes in three events, against the 16 384 bytes a receipt may log (measured in the unit-test VM, which enforces that limit).

Not added, on purpose: no `receipts()` view (unbounded per-call storage would be a storage-staking grief, ARCHITECTURE.md 2.7), and no event for a refused `request_withdraw`, because that is a panic and a panic rolls its logs back.

## 6. Choices made where the design was open

| Question | Choice | Why |
|---|---|---|
| Should `attest()` return the code hash or admin key hash? | No. | ARCHITECTURE.md 2.8 says it does not and cannot; confirmed for the locked `near-sys` 0.4.0. |
| A version field? | `attest_version` for the shape only. No contract version. | A crate version nobody bumps is a false signal. |
| Per-token caps in `attest()`? | No. | The token map cannot be listed. An optional argument would break callers that send empty args. |
| One `check` for both paths? | `check` models `send_small` only. | The doc has one set of arguments and one verdict. `request_withdraw` refusals are panics and uncounted (Q-ABI kept), so there is no strike or burn to predict for it. |
| Fields of `check` beyond `{verdict, reason, headroom}`? | Added `counted` and `would_burn`. | An agent told "refuse" needs to know whether calling it anyway costs a strike and whether it is the last one. Both are derived from state `strikes_of` and `config` already expose, so they leak nothing new. |
| Reason as an enum or a free string? | Enum with fixed snake_case codes, text unchanged. | A code that cannot drift (tests tie `code()`, the serde name and this table together) and no change to any existing string. |
| Argument name `asset` or `token`? | `asset`, as written in ARCHITECTURE.md 2.7. | `send_small` keeps `token`; both mean the same. |
| Event envelope version | Stays `1.0.0`. | Only fields were added. A reader that matches the version exactly keeps working; one that wants the new fields reads them by name. Moving to `1.1.0` is Kevin's call (no consumer in this repository reads the version). |
| Events beyond "refusals, burns, purges" | Added `send_failed`, `execute_dropped.reason` and a `count` on the three queue-removal events. | A failed transfer was returned to the caller as a refusal-shaped outcome and logged nothing, and a dropped execute did not say why. Both are cheap and sit in the same audit trail. |
| `spent_after` on a refusal | The window total, unchanged by the call. | The log alone then shows where the cap stood when the key was refused. |

## 7. Where it is tested

`contracts/mamori/src/tests/attest_check.rs` (attest), `check_view.rs` (check, reason codes, the doc ties), `events.rs` (events), `admin_surface.rs` (every new export is classified; no new path reads the signer key). `cargo test -p mamori` and `cargo test -p mamori --features drill`.
