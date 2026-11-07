# Kizashi: a NEAR refund against its callback

**Result: not fixed in the contract, on purpose.** `contracts/kizashi/src/lib.rs` is unchanged (sha256 `66a4ccff409025852b0f91c876a55a368c505ef1cbeb6286e8144dad171fcd6d`), so the Kizashi wasm is the same bytes and no testnet rehearsal has to be rerun. The gap is real only if a transaction is delivered between a failed transfer's refund and its callback; nothing read guarantees it cannot, and no rule the contract can run closes it without stranding NEAR somewhere else. Written 2026-11-07. Evidence: the unit-test model in `contracts/kizashi/src/tests.rs`, and the pages listed below.

## The gap

`claim` (and `retry_payout`) pays NEAR with `Promise::transfer(..).then(on_near_payout)`. The runtime takes the amount out of the balance when the receipt is created. If the transfer fails (the claimant account does not exist), the amount comes back to the contract as a refund, a plain transfer receipt that runs no code, and `on_near_payout` books it as owed to the claimant. If the refund reaches the contract before the callback, and a second claim is processed between the two, that claim sees the refunded NEAR as free and pays it to someone else. The callback then books a debt nothing backs: 10 NEAR owed, 0.05 NEAR on hand, and the second claimant's USDC cannot be registered for want of spare NEAR. If the callback runs first, the contract is right.

## What is known about the order

| # | Fact | Label | Source |
|---|---|---|---|
| 1 | A failed receipt's deposit goes back as a refund receipt to the refund receiver, the predecessor by default. From protocol version 82 a contract can name another one (`promise_set_refund_to`). | READ | nomicon.io/RuntimeSpec/Refunds |
| 2 | "Runtime doesn't require that Receipts come in a particular order." A postponed action receipt (a callback) runs once all its data inputs have arrived. | READ | nomicon.io/RuntimeSpec/Receipts |
| 3 | In `apply_action_receipt` the deposit refund (and gas refund) of a failed receipt are pushed to `result.new_receipts` BEFORE the data receipts that feed the callbacks (`// Calculating and generating refunds` comes before `// Generating outgoing data`). So the refund is created first and the callback's data receipt after it. Two separate reads of the source gave the same order. | READ, on nearcore `master` through the fetch tool's summary, no commit pinned, not checked against the protocol version the network runs | raw.githubusercontent.com/near/nearcore/master/runtime/runtime/src/lib.rs |
| 4 | A chunk processes local receipts, then the delayed backlog, then incoming receipts; receipts that do not fit the compute limit go to the delayed queue in their original order, and the delayed queue is served first the next time. | READ, same source and caveats | same |
| 5 | Callbacks "wait for their dependencies before executing"; receipts "can execute in later blocks"; the page says nothing about a refund against a callback. | READ | docs.near.org/protocol/transactions/transaction-execution |
| 6 | The cross-contract page says a callback runs even when the call fails and "typically 1-2 blocks apart"; nothing about refunds or ordering. | READ | docs.near.org/smart-contracts/anatomy/crosscontract |
| 7 | The data-flow page says nothing about the order of receipts, or of a refund against a callback. | READ (nothing there) | docs.near.org/protocol/data-flow/near-data-flow |
| 8 | Any statement that the refund and the callback of one failed transfer are processed one right after the other, or that a later transaction cannot be processed between them. | NOT FOUND | none of the pages above |
| 9 | How the incoming receipts of one chunk from different source shards are ordered; whether congestion control or the bandwidth scheduler can deliver two receipts created together in different chunks; the code that runs a postponed receipt when its last data input arrives. | NOT READ (the fetched text did not show them) | nearcore |
| 10 | `docs.near.org/protocol/transaction-anatomy` and `.../protocol/transaction-execution` | NOT FOUND (HTTP 404); the working paths are `.../protocol/transactions/transaction-execution` and `.../protocol/data-flow/near-data-flow` | docs.near.org |

Inference, not read: the two receipts are created together for the same destination, so in the ordinary case they sit next to each other in one list and run one after the other. Only a delivery split (row 9) or a delayed-receipt interleave unknown to me would let a claim run between them.

So the contract's own assumption ("owed NEAR has not returned yet" in `retry_payout`, the model's old default) that the callback comes first is NOT what nearcore master creates. What nearcore master creates is refund first, callback right after. The contract passes that order. It fails only when a transaction is delivered in between.

## What the contract needs from the chain

One of: the callback runs before the refund, or no claim is processed between a failed transfer's refund and its callback. The first is not what the source says. The second is what the source suggests for an ordinary chunk and what no page promises.

## The model, three orders (`RefundOrder` in `tests.rs`)

All of it runs against the unchanged `lib.rs`; every schedule of every pair is tried and the books are checked after every step.

| order | what it models | result |
|---|---|---|
| `AfterCallback` | refund after the callback (the old default) | 0 violations (`matrix_a_claimants_near_payout_fails_and_comes_back_owed`) |
| `JustBeforeCallback` | refund, then the callback in the same step: nothing runs between (nearcore master's creation order) | 0 violations over a pool of 5 transactions, 20 ordered pairs (`matrix_the_refund_of_a_failed_payout_comes_just_before_its_callback`) |
| `BeforeCallbackAnyTime` | the refund is a receipt of its own, delivered any time before the callback | 1 of the 20 pairs breaks: claim of one omen, then claim of another. `NEAR owed twice` and `USDC still owed ... after every retry` (`a_refund_that_reaches_the_contract_before_its_callback_is_swept_by_the_next_claim`, the pinned gap) |

## Why no fix inside the contract

The contract sees the NEAR balance, what it owes, its reservations and the epoch. A refund is a transfer with no call, so it shows up only as a larger balance, the same as a top-up of that size.
`a_refund_and_an_equal_top_up_look_the_same_to_the_next_claim` builds two worlds. In R the failed transfer's refund has arrived. In T the refund is still on its way and someone has sent the same amount. Balance, owed, reservations, epoch and clock are equal; the second claim schedules the same payout (the whole 10 NEAR) in both. In R that payout must not happen (the NEAR is owed to the first claimant: the books break). In T it must (nobody else will ever sweep it). Any rule that reads only what the contract can read pays the same in both, so it is wrong in one. The callback has the same blindness (argued, not a separate test): in the normal order (callback first) and after a sweep it finds the same balance, the reserve and the margin, so it cannot tell a debt whose refund is still to come from one whose refund was swept.

What can still be done is to read more state, and the one candidate that does it:

* **Hold-back** (tried for real in `lib.rs`, then removed, hash-checked): a `pending_near` counter, added when a NEAR transfer is scheduled, removed in `on_near_payout`, taken off `payable_near()`. Measured on the same model: the pinned gap closes (89 states, 0 violations) and 99 of the 100 old tests stay green (the one that fails is the pinned gap test, as it demands). But claim, a top-up of 1 NEAR, claim (the payout does not even fail) gives 4 violations, `NEAR stuck: 999999999999999999999999 sits on the contract beyond its reserve, margin and debts with every omen dead`: the top-up lands while the first payout is unreported, the hold takes it, and the last claim has nothing left to sweep it with. The original contract on that fixture: 0 violations (92 states). A hold-back also adds a state field (layout change, no in-place upgrade of an existing deploy), changes the wasm, and changes what a claim in that window pays. It trades "the books balance" for "no stuck funds", in a case that needs no failure at all. `holding_back_the_unresolved_payout_closes_the_gap_and_strands_a_top_up` keeps both halves as a model test (a simulation: it agrees on the sign, 5 violations against the real patch's 4).
* Limiting the hold to the inflow since the schedule: in R and T the inflow is the same amount, so it holds back the same NEAR and strands the same top-up. Booking the NEAR as owed at schedule time is the same hold (and `retry_payout` would pay an in-transit record a second time without one more flag). Deferring a held claim's payout to a later `retry_payout` needs a record that can never be told to expire (a ghost that later swallows a top-up meant for another claim), a second state field and a changed `owed` view. These three were argued with the two worlds above, not built.
* Redirecting the refund (`promise_set_refund_to`, protocol 82): it needs a second contract that can see the refund, which is a new component, not a fix.
* Forbidding the failing transfer: it fails only when the claimant account does not exist. The contract cannot look an account up. The claim tooling can (see below).

None of these keeps all three: no double payment, no stuck funds, books that balance. The gap keeps the first two and, in the window, breaks the third (measured: `NEAR owed twice`, and the second claimant's USDC left owed after every retry). The hold-back keeps the first and third and breaks the second.

## What stays open, and what to do about it

1. **Check the order on a chain.** The model assumes; the source suggests; nothing was run on a node (no sandbox, no testnet, by instruction). `tests-integration` is the place: send a claim whose claimant account does not exist, and read the block heights of the refund receipt and of the `on_near_payout` receipt in the transaction's outcomes. That shows the order in an ordinary chunk. It cannot force a claim between them, so it narrows the question and does not close it.
2. **Keep the failing transfer from happening.** The gap needs the transfer to fail, and it fails only for a claimant account that does not exist. `jobs/` and `app/` could check `view_account` on the claimant before submitting a claim. Not done here (outside this scope).
3. **Pinned.** The day the contract changes so that the pinned test fails, run `a_top_up_while_a_payout_is_on_its_way_is_swept_by_the_claim_that_follows` before calling the gap closed: the hold-back shape fails it.

## Reproduce

```
$env:PATH="D:\HACK-Projects\toolchain\cargo\bin;$env:PATH"; $env:AWS_LC_SYS_PREBUILT_NASM='1'
cargo test -p kizashi                    # 104 passed (was 100)
cargo test -p kizashi --features drill   # 105 passed (was 101)
cargo clippy -p kizashi --all-targets -- -D warnings   # and with --features drill: clean
```

Sources read 2026-11-07: nomicon.io/RuntimeSpec/Refunds, nomicon.io/RuntimeSpec/Receipts, docs.near.org/smart-contracts/anatomy/crosscontract, docs.near.org/protocol/transactions/transaction-execution, docs.near.org/protocol/data-flow/near-data-flow, raw.githubusercontent.com/near/nearcore/master/runtime/runtime/src/lib.rs (read twice, plus the receipt-processing part).
