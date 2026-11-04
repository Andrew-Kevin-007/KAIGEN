# KAIGEN v3 loss bound (re-derived against the code)

Status: 2026-11-03. Derived from `contracts/mamori/src/lib.rs` at HEAD 65fde6a (lib.rs sha256 276A870A...), not from the design docs. Testnet only. No audit, no mainnet run. The derivation is an argument plus property tests, not a machine-checked proof; sections 4 and 5 say what each piece of evidence does and does not show. Line numbers are lib.rs as of that hash.

## 1. The bound

For every token T and every half-open interval W = (a, a + 24 h] of block time:

    loss_T(W)  <=  C_T + P_T        when the withdrawal delay D is at least 24 h
    loss_T(W)  <=  C_T + 2 P_T      when D is under 24 h (drill builds only)

| Symbol | Meaning | In the code |
|---|---|---|
| C_T | 24 h cap of token T. NEAR: `daily_limit`. A NEP-141: `token_limits[T]`, and 0 if the admin never listed it (nothing can then be sent). | `limit_for`, L767 |
| P_T | Pending limit of T: `pending_limits[T]` if the admin set it, else `PENDING_LIMIT_MULTIPLE` (10) x C_T. | `pending_limit_for`, L887 |
| D | `delay_secs`, set once in `init`, never assigned again (the only assignment is L233). A production build refuses D under 86,400 s (L225 to L229). A `drill` build accepts any D. | `init`, `MIN_DELAY_SECS` L64 |
| loss_T(W) | Sum of the amounts of every transfer of T that `send_small` or `execute` started in a block inside W and that has not been reported failed. A transfer whose callback has not arrived counts. | see 2.4 |

It is a vector over tokens, in token units, with no price. Each token has its own bound. Over a span of length L the loss is at most ceil(L / 24 h) x (C_T + P_T): nothing here limits a slow drain repeated every day.

Three things to read off it.

1. The default is generous. With the default multiple of 10, C + P is 11 x C. An owner who wants a day's loss to be one cap sets the pending limit to 0 (the queue is shut for that token) or to a small value.
2. The bound is tight. A calibrated attacker reaches exactly C + P in one window and no more (test `a_calibrated_attacker_loses_exactly_cap_plus_pending_in_one_window_and_not_one_more`). The queue part is P only if the admin does not cancel inside the delay (A4); the cap part has no cancel window.
3. Delay under 24 h reaches C + 2P (test `a_delay_under_a_day_lets_two_pending_limits_through_one_window_which_is_what_the_floor_is_for`: 6,000 executed in one window with P = 3,000 and D = 1 h). That is why the floor exists and why drill builds are outside the production claim.

Per key (an attribution bound, not part of the sum): with n recorded daily keys, key k asks the queue for at most P_T / n in any 24 h and holds at most MAX_QUEUE / n requests and P_T / n of queued value at once, at the moment it asks. The account-wide limits stay on top. The shares are recomputed from the keys recorded at that moment, so adding a key shrinks everyone's share from then on, and what a key already holds stays.

## 2. Derivation

### 2.1 Instant path: send_small <= C_T per window

`send_small` records (time, amount) in `window[T]` and refuses unless the entries newer than `now - 24 h` plus the amount stay within C_T (`add_to_window` L786, `fits_in` L809, `live_log` L803). Take the last send in W, at time t. Its check counted every earlier send in (t - 24 h, t], and that range contains the rest of W. Entries only change in three ways, none of which can lose a send that left:

* a pruned entry is older than 24 h, so it is outside every later check;
* a send that finds the log full (64 entries) is folded into the newest entry and that entry's time moves up to now (`push_amount` L816): the folded amounts expire later, never earlier, so the log can only over-count;
* a refund removes an amount after a failed transfer (2.4).

So the sends in W add up to at most C_T. `limit_for` is 0 for an unlisted token, and then every send is refused without a strike.

### 2.2 Queue path: execute <= P_T per window (D >= 24 h)

Invariant Q. At every instant the entries of `queue` with token T add up to at most P_T, and there are at most MAX_QUEUE = 32 entries. An entry enters in two places. `request_withdraw` (L445) removes the expired entries, then `queue_room` (L845) refuses unless `fits_pending` (L895) holds. `on_execute_done` (L623) puts a failed execute back only after the same `queue_room` test. Entries leave by `execute`, `cancel`, `cancel_all`, expiry, or the removal of their key. Expired entries stay until something purges them, but the sum over all entries, expired included, is what the property tests assert, and it holds, because every insert is checked after the expired ones are gone and expiry changes no amount.

Claim. If D >= 24 h, the requests executed in W add up to at most P_T.

Sketch. Let a be the start of W and take an executed request i with its `execute` call at x_i in (a, a + 24 h]. It unlocked at r_i + D, so r_i <= x_i - D <= a + 24 h - 24 h = a. So every request executed in W was requested at or before a and is still in the queue at a, because it leaves only at x_i > a. By Q they add up to at most P_T. Expiry (`EXECUTE_WINDOW_SECS`, 24 h after unlock) is not used. The 24 h request budget is not used either.

The case the sketch skips: a request whose earlier `execute` failed is out of the queue between that call and its callback, which is seconds (A5), and may be executed again inside W. It returns only through `queue_room`, which counts what is queued at that moment. A request made after its first attempt cannot be executed for D >= 24 h, so it is still queued when the earlier one returns and the room test counts it; if the two do not fit together the earlier one is dropped. This is argued, not proved; the property tests cover it with transfer failures at 15 and 50 percent and callbacks delivered between other calls, and mutation M10 (section 5) shows they notice the requeue check going missing.

### 2.3 Delay under 24 h: C_T + 2 P_T

Requests executed in W split into those requested at or before a (all queued at a, at most P_T by Q) and those requested inside W. The second set is covered by the 24 h request budget (`take_request_budget` L866: requests in any half-open 24 h interval add up to at most P_T), so at most P_T more. Reached by the short-delay test. The budget therefore matters only below the floor; with the floor in place it is defence in depth (section 5).

### 2.4 Callbacks

`send_small` and `execute` start a transfer and register a callback. The bound counts a transfer from the block of its call.

* Send landed: nothing to do. Send failed: `on_send_done` (L601) gives the amount back by finding the entry with the same time and amount, else the first entry at or after that time that is at least as large. Inside 24 h that can only move the credit to a later slot (over-count). Verified by the property tests: the log never says less than the ledger, and says exactly the ledger when no fold happened.
* A failed `execute` is put back if the request is not expired, its key is still recorded, the era is not kaigen and `queue_room` passes; otherwise `execute_dropped` is logged. It never moves value.
* A callback that never arrives is the safe direction for sends (the cap stays used) and for executes (the request is not put back).
* A failure callback that arrives more than 24 h after the call is the unsafe direction (A5): the entry may have been pruned and the refund then reduces another send's entry. Test `assumption_a5_a_failure_callback_more_than_a_day_late_makes_the_window_under_count` makes it executable (400 failed, 600 in flight, the window says 200, and the next 800 is accepted). A receipt takes seconds, not a day.

### 2.5 What does not move the bound

Strikes and burns (a burned key's queued requests are cancelled and nothing is given back); the allowlist (it chooses who is paid, not how much); the minimum send; the era (it only stops value).

## 3. Conditions

ARCHITECTURE.md section 5 lists six. The derivation adds the rest. "Enforced" means the Mamori code itself refuses the violation; "assumed" means nothing in the contract can check it.

| # | Condition | From | Enforced or assumed | Where, and how it is checked |
|---|---|---|---|---|
| E1 | The cap is account-wide per token, not per key | derivation | Enforced | `window[T]` is keyed by token only (L199). Eight keys share one C_T. Property test: several keys, loss swept over every window. |
| E2 | A token with no admin-set limit can never be sent | derivation | Enforced | `limit_for` = 0 refuses in `send_small` (L403). Third token in the property test. It can be queued only if the admin sets a pending limit for it. |
| E3 | Queue value <= P_T, at request and at requeue | ARCH 5 "pending limit" | Enforced | `fits_pending` through `queue_room`. Mutation M03, M10. |
| E4 | Delay >= 24 h | ARCH 5, THREAT-MODEL 1 | Enforced in a production build, at `init`; no setter exists. Not enforced in a `drill` build. | L225 to L229. Mutation M01. Tests `init_refuses_a_withdrawal_delay_that_defeats_the_cap`, `the_production_delay_floor_is_a_day`. |
| E5 | `execute` needs the unlock time and a calm era | derivation | Enforced | L482 to L485. Mutation M09. |
| E6 | Only a recorded daily key moves value, and only through two methods | ARCH 2.2 | Contract part enforced: `assert_daily_key` (L758) needs predecessor = signer = the account and a recorded key. The runtime part (a function-call key may call only `send_small` and `request_withdraw`) is the NEAR access-key layer. | Property test: a call by a key the vault does not serve always panics. |
| E7 | Per-key slots and shares | M2 | Enforced; not part of the sum | Attribution and availability only. Mutations M02a to M02c. |
| E8 | 24 h request budget, account and per key | ARCH 2.4 | Enforced; needed only when D < 24 h | Mutation M06a, M06b. |
| E9 | Strike cap, burn | ARCH 2.1 | Enforced; adds nothing to the bound | Counting rule checked on every refusal. Mutation M08. |
| A1 | No classical full-access key and no function-call key that the vault does not record | ARCH 5 | Assumed | The contract cannot read the key list. cage-check, at a point in time (M4). |
| A2 | No key registered on `intents.near`; balances held there are outside the bound | ARCH 5 | Assumed | `register_intents_key` records it, but a key on `intents.near` signs there without Mamori. |
| A3 | Gas allowances are outside the cap | ARCH 5 | Partly enforced | At most 8 keys (`MAX_DAILY_KEYS`), allowance never 0 (`Allowance::limited`, L271), default 0.25 NEAR. The admin may pass any allowance; there is no maximum in the contract (cage-check maximum). |
| A4 | The admin looks at least once per delay period | ARCH 5 | Assumed | Without it the whole queue part (P_T) executes. Cancelling gives no request budget back. |
| A5 | A transfer's callback arrives within 24 h of the call | derivation | Assumed | 2.4. Pinned by an executable test. |
| A6 | Block timestamps do not go backwards; loss is attributed to the block of the call, the value moves one to three blocks later | derivation | Assumed (protocol) | In landing time a window of 24 h can hold two caps if two sends are 24 h apart and land a block apart. |
| A7 | The configuration (C_T, P_T, allowlist, strike cap) is the one in force for the whole window | derivation | Assumed | Only the admin changes them, with no delay (policy-key split is a stretch item). |
| A8 | A listed NEP-141 moves exactly the amount it is told to | derivation | Assumed | The guard counts the instructed amount, not the balance change. |
| A9 | The 1 yoctoNEAR attached to each NEP-141 transfer comes from the NEAR balance and is outside the NEAR cap | derivation | Not enforced | Dust, bounded by the gas allowances. |
| A10 | Allowlist enforced for payee control | ARCH 5 | Off by default | It is not a condition of the amount bound. With it on, `send_small` never pays an unlisted payee (checked in the property test); `request_withdraw` and `execute` may pay anyone, which is the point of the admin's cancel window. |

Not bounded, as ARCHITECTURE.md says: repeated in-cap drain across many windows; a calibrated attacker who reads `check` headroom (here: sends exactly C_T, zero strikes); admin or cold-key compromise; intents balances.

## 4. Evidence

Everything is in `contracts/mamori/src/tests/loss_bound.rs` (registered at the end of `tests.rs`). `lib.rs` and `Cargo.toml` are untouched. proptest is not in Cargo.lock or in the offline cargo cache, so the generator is a seeded splitmix64 (the one already in `tests.rs`) with a hand-written shrinker.

How the property test works. A ledger of every transfer the contract started is kept apart from the contract. A seeded generator drives a vault with up to nine daily keys through `send_small`, `request_withdraw`, `execute`, `cancel`, `cancel_all`, `purge_expired`, key add and remove, time jumps and callbacks that succeed or fail, over three tokens (NEAR, one listed NEP-141, one unlisted). The generator is aimed: amounts sit at the headroom and one past it, time jumps land on the exact nanosecond a window, unlock, expiry or strike ages out, one key plays the attacker. Every call is run as a chain transaction (state read from storage, written back only if the call returned). After every step the ledger is swept over every 24 h window and the contract's books are compared with the model. A failing sequence is replayed and shrunk before it is reported.

Results, at lib.rs sha256 276A870A... (unchanged by this milestone):

| Run | Result |
|---|---|
| `cargo test -p mamori` | 124 passed (120 before; the 4 new tests are in `loss_bound.rs`) |
| `cargo test -p mamori --features drill` | 121 passed (117 before) |
| Property test, default: 300 seeds x 110 steps (the dust and drainer runs are three times as long) | Passes in about 15 s with the rest of the suite. The bound held after every step. Peaks: sends 100% of C, queue executions 100% of P, both together exactly 100% of C + P, never above. |
| Soak, default build: 4,000 seeds | 0 violations, 196 s. 127,309 sends, 109,605 requests, 61,753 executions, 2,565 key burns, 5,385 failed executes put back, 8,327 dropped, 42,320 steps with the send log at 64 entries, 1,004 runs where `init` refused a delay under a day. Peaks as above. |
| Soak, drill build: 3,000 seeds | 0 violations of the drill claim (C + 2P), 147 s. Queue executions peak at exactly 200% of P in one window and the total at 190% of C + P: the delay-under-a-day case the floor exists to prevent is reached, so the generator is strong enough to find a broken floor. |
| `a_calibrated_attacker_loses_exactly_cap_plus_pending_in_one_window_and_not_one_more` | Tightness: 1,000 + 3,000 in one window, one more unit of either refused, zero strikes. |
| `a_delay_under_a_day_lets_two_pending_limits_through_one_window_which_is_what_the_floor_is_for` | 6,000 executed with P = 3,000 and D = 1 h. A production build's claim breaks at the third execution; a drill build's claim (2P) holds. |
| `assumption_a5_a_failure_callback_more_than_a_day_late_makes_the_window_under_count` | A5 made executable (2.4). |

What the property test checks after every step, besides the sweep: the queue is at most 32 entries and at most P_T in value, expired entries included; both request logs are within P_T; the send log never says less than the ledger and says exactly the ledger when no fold happened; every queued request is one the vault issued, unchanged, from a key it still serves, and nothing enters or leaves the queue except by the call that did it; the served and revoked key sets equal the model's; strikes equal the model's under the counting rule of ARCHITECTURE.md 2.1 (only never-succeed refusals count, so key A using up the cap cannot burn key B); a call by a key the vault does not serve always panics; `execute` refuses exactly while locked, expired or paused and otherwise never refuses a due request; with the allowlist on, `send_small` never pays an unlisted payee; right after each request, the asking key is within MAX_QUEUE / n slots and P_T / n of queued value and of 24 h budget; and after the era rises (the last step of some runs) `send_small`, `request_withdraw` and `execute` all refuse and no value moves.

Rerun (PowerShell, repo root; first `$env:PATH="D:\HACK-Projects\toolchain\cargo\bin;$env:PATH"; $env:AWS_LC_SYS_PREBUILT_NASM='1'`):

    cargo test -p mamori                               # 124 tests
    cargo test -p mamori --features drill              # 121 tests
    $env:KAIGEN_PROP_SEEDS='4000'; cargo test -p mamori loss_bound::the_loss_bound -- --nocapture    # soak, about 3 minutes
    $env:KAIGEN_PROP_BOUND_ONLY='1'; cargo test -p mamori loss_bound::the_loss_bound -- --nocapture  # only the loss-bound sweep is fatal

## 5. What each condition is worth (from the mutation checks)

Each row removes or weakens one line of `lib.rs` (the file was restored from a backup and compared by hash after every run; it is identical to HEAD). All 20 runs (16 mutations, 4 of them also on a drill build) made the suite fail. That alone says little, because most failures come from a bookkeeping check that stops the run first. So each mutation was run a second time in bound-only mode (`KAIGEN_PROP_BOUND_ONLY=1`: every check but the loss-bound sweep is counted, not fatal). The column "Loss bound breaks" is that second answer: does the claim of section 1 itself fail?

| Mutation | Loss bound breaks? | What it shows |
|---|---|---|
| M05 send window cap off | Yes: 65 sent, cap 64 | E1 is load-bearing. |
| M13 send window 1 ns short (`t > cutoff + 1`) | Yes: 65 sent, cap 64 | The window edge is exact to the nanosecond, and the generator lands on it. |
| M04 refund also on success | Yes: 34 sent, cap 33 | The refund path must fire only on failure (2.4). |
| M01 delay floor 24 h -> 60 s | Yes: 297 executed, claim 199 (delay 600 s); shrunk to a handful of steps | E4 is load-bearing: this is why `init` refuses a short delay. |
| M09 unlock check off | Yes: 20,000 executed, claim 10,000 | E5. |
| M03 account-wide queue sum (`fits_pending`) off | Yes: 501 executed, claim 500 (delay 90,000 s), default and drill | Per-key shares alone are not enough. Shares are recomputed from the keys recorded now, so a key added after a queue filled gets a fresh share on top of room the others already hold. The account-wide cap is what keeps the sum at P. |
| M10 failed execute put back without the room check | Yes: 6,250 executed, claim 5,000, default and drill | The requeue is part of the bound (2.2), and the property test reaches it. |
| M06b both request budgets off | Production: no. Drill: yes, 37 executed, claim 34 (delay 1 s) | With the 24 h floor the budgets are not needed for the bound. Without it they are all that holds 2P. |
| M06a account request budget off alone | No, production or drill | The per-key budget shares add up to the same P while the key count is constant; with M02c below, the two layers back each other up. |
| M07 expiry check off | No | Expiry keeps stale requests from running; it does not enter the bound for D >= 24 h. Caught by the spec check `execute` refuses an expired request. |
| M02a per-key slots = global cap; M02b per-key queue share off; M02c per-key budget share off | No | The per-key limits are an attribution and availability property, not part of the sum. Each is caught by the per-key checks right after a request. |
| M08 v2 counting rule (every cap refusal counts) | Not asked (the model diverges once keys burn differently) | Caught by the strike model: a refusal that could succeed burned a key. |
| M15 burn leaves the key's requests queued; M16 burn leaves the key served | No | Caught by the books checks (queue and key sets). |

Two weaknesses of my own test turned up on the way and were fixed before this table: a first generator did not catch M01 and did not catch M06b on a drill build, because its attacker trusted its own model of the budget and never tried what the model said was forbidden. The drainer (`attack_op`) now asks where the model says the contract must refuse, executes as late as the budget allows, and sometimes uses nanosecond-fine turn-over points.

## 6. Observations that do not change the bound

* `strikes_of` (view) and `refuse` disagree by one nanosecond: at exactly 24 h after the first strike the view says 0 strikes, while a refusal at that instant still counts as the next strike (`refuse` uses `<=`, the view uses `>`). Existing test `the_strike_window_stays_24_hours` pins the refusal side. No value moves differently.
* A removed key (not burned) keeps its strike record; adding it back within 24 h continues the count.
* The 16,384 B log limit behind the M2 log-size tests is a protocol figure that was not re-read from nearcore for this milestone.

## 7. Not done

* Nothing ran on a chain for this milestone; the property tests use the unit-test VM, which cannot show cross-receipt behaviour. M1 covers key deletion on a sandbox.
* The requeue-after-failed-execute argument in 2.2 is a sketch.
* A5 is an assumption. The cheap hardening, if wanted later, is to give each send an id and keep an in-flight map, so that a refund removes exactly its own amount whatever its age. That changes state layout, so it was not done here.

## 8. Revoked keys (deletions the account has not confirmed)

Added 2026-11-04 (open item 1 of the v3 list). Code: `contracts/mamori/src/lib.rs`. Tests: `contracts/mamori/src/tests/revoked_cap.rs`. Unit VM only: nothing of this ran on a chain.

What the set is. `revoked_keys` holds a daily key from the moment the vault stops serving it (admin removal or a burn) until the account confirms the DeleteKey. It stops `add_daily_key` from re-adding the key while its delete may still be in flight, it lets `lock_down` try the delete again at kaigen, and it lets cage-check tell a key pending deletion from an unrecorded one. It is not part of the loss bound: a key in it is not in `daily_keys`, `assert_daily_key` panics for it, and the only methods a function-call key can reach are the two daily ones (E6). A revoked key still on the account can burn its own gas allowance and nothing else.

What was wrong. (1) The set had no cap. A delete the account answers with a failure leaves its entry for good, and `on_revoked_key_deleted` cannot tell "the account does not hold that key" from any other failure. (Whether the runtime drops a function-call key whose allowance is used up is unverified in nearcore; if it does, such a key is exactly this case, and `remove_daily_key` retries a delete that fails again.) (2) Nothing could clear such an entry, and while it stood that key could not be added again. (3) `lock_down` collected the whole set before any gas check, in the same receipt that had already scheduled the intents and daily deletes. Measured in the unit VM, which charges the host's real storage fees: 69 Ggas per key read, so 2,000 keys cost 137 of the 150 Tgas a minimal `lock_down` is given and start no delete. About 2,200 keys would use all 150 Tgas (extrapolated, not run), and a receipt that runs out of gas drops every delete it scheduled. Each entry takes one admin add and one removal or burn of a key the admin added, so this is drift in a long-lived vault, not something a daily key can do on its own.

Decision.

1. `add_daily_key` refuses when served keys plus awaiting-deletion keys already number `MAX_KEY_RECORDS` (16, twice `MAX_DAILY_KEYS`): `too many keys awaiting deletion: confirm or forget some first`. The older refusals keep their place ahead of it.
2. Nothing else is refused. A removal or a burn only moves a key from `daily_keys` to `revoked_keys`, so the sum cannot rise. The cap sits on the one call that grows the sum, not on the set, so a full set never stops a containment.
3. `forget_revoked_key(public_key)` (admin) drops one entry, schedules nothing and logs `remove_daily_key` with `retry: false, forgotten: true`.
4. `lock_down` reads at most `MAX_KEY_RECORDS` of the set. The rule above already bounds it; the read runs before any gas check, so it carries its own guard.

No state field changed (`FRESH_STATE_HEX` is the same). One new admin export; no signature, outcome or refusal text of an existing method changed.

Alternatives eliminated.

* Refuse to record a key when the set is full. The key would then have no retry and no re-add protection exactly when the most entries are stuck, and containment would depend on bookkeeping room. A test fails if a full set stops recording.
* Evict an entry when full. Silent, and `IterableSet` order is not insertion order (a remove moves the last entry into the hole), so it could drop the protection of a delete still in flight.
* A permissionless retry. The entries that stick are deletes the account will never confirm, which a retry cannot clear, and it is one more method anyone can call. The admin already retries with `remove_daily_key` on a revoked key, and `lock_down` retries at kaigen.
* Forget after N failures. It needs a counter per key (a state change) and turns the unverified guess "failure means absent" into a rule.
* A cursor so `lock_down` can walk a long set across passes. A new state field, for entries that cannot act.

When the records are full. Adding a key is refused. Removing, burning, retrying, confirming and forgetting are not. The way out is a delete that lands, or `forget_revoked_key` after the admin has seen on RPC (`view_access_key_list`) that the key is off the account.

Residual.

* `lock_down` visits the revoked set last and in set order. Entries that always fail and sit first can use the gas left over in every pass and keep later entries from being retried at kaigen. No value moves differently (a revoked key cannot spend), and it shows as `revoked_keys_left`; the admin retries by hand or forgets the stuck ones.
* Forgetting a key the account still holds only drops the retry; cage-check then reports it as a function-call key that is not recorded, which is correct. Forgetting one whose delete is still in flight reopens the re-add race the set exists to prevent.
* With 16 records a vault cannot add a key even if fewer than 8 are served. That is the intended cost.
* `docs/v3/ATTEST-CHECK.md` section 5 still lists `remove_daily_key` with `public_key` and `retry`; the new `forgotten` field is not in its table.

Evidence (`revoked_cap.rs`, 8 tests). The 16th record is accepted and the 17th refused with the exact text. The older refusals keep their precedence. A burn and an admin removal complete with 16 records. `forget_revoked_key` frees a record, schedules nothing, logs, lets the key return, and a late delete callback leaves no phantom; it refuses a served key, an unknown key and a stranger. `lock_down` uses the same gas with 16 and with 2,000 revoked keys (119.27 Tgas, 6 deletes started, in both). A 400-step run of adds, removals, burns and forgets never holds more than 16 records. Mutations, with `lib.rs` hash-identical afterwards: cap removed fails 3 tests, `<=` for `<` 3, forget that does not remove 2, forget that does not log 1, no read guard 1 (137.3 Tgas for 2,000 keys against 119.3 for 16), a full set that stops recording 4.
