//! Attack 4 (ARCHITECTURE.md section 7): queue flood by one key. Claim: the caps hold, per-key slots hold, `cancel_all`
//! works. Two daily keys, A (hijacked) and B (honest), so each has MAX_QUEUE / 2 = 16 slots and half of the pending limit.
//!
//! 4a, slots: A fires 40 dust requests back to back. Expected: 16 queue, the other 24 are refused, B is not locked out,
//!     the queue stays under its count cap, `cancel_all` empties it.
//! 4b, value: A and B each queue their half of the pending limit; one yocto more is refused for both; the queued sum is
//!     exactly the pending limit; `cancel_all` empties the queue but gives no request budget back.

use near_workspaces::types::NearToken;
use serde_json::json;

use crate::common::*;
use crate::support::*;

const DUST: u128 = NEAR / 1000;
const SLOTS_EACH: usize = 16; // MAX_QUEUE (32) / 2 keys

#[tokio::test]
async fn attack_4a_a_dust_flood_stops_at_the_keys_slots_and_cancel_all_clears_it() {
    let rig = Rig::new(false).await;
    let rpc = rig.rpc();
    let x = rig.f.attacker.id().clone();
    let a = rig.add_daily(Some(NearToken::from_near(10))).await;
    let b = rig.add_daily(None).await;
    let x0 = rpc.balance(&x).await;
    let mut c = Checks::new();

    let mut sa = rig.signer(&a).await;
    let calls: Vec<(&str, serde_json::Value, u64)> =
        (0..40).map(|_| ("request_withdraw", json!({ "token": null, "amount": DUST.to_string(), "to": x }), 15)).collect();
    let txs = rig.sign_calls(&mut sa, &calls).await;
    send_all(rpc, &txs).await;
    let hashes: Vec<String> = txs.iter().map(|t| t.hash.clone()).collect();
    let all = facts_many_within(rpc, &rig.vid, &hashes, std::time::Duration::from_secs(20)).await;
    let dropped = all.iter().filter(|f| f.is_none()).count();
    c.check("every one of the 40 calls was taken in by the chain", dropped == 0);
    let results: Vec<Facts> = all.into_iter().flatten().collect();
    let accepted = results.iter().filter(|f| !f.failed()).count();
    let slot_refusals = results.iter().filter(|f| f.panic_text().is_some_and(|t| t == "this key's queue slots are used up")).count();
    let other_failures = results.len() - accepted - slot_refusals;
    let refused_count = results.len() - accepted;
    c.check("A got exactly its 16 slots", accepted == SLOTS_EACH);
    c.check("the other 24 requests were refused with the slots message, nothing else failed", slot_refusals == 40 - SLOTS_EACH && other_failures == 0);
    let q_after_flood = rig.queue().await;
    c.check("the queue holds 16 entries, all A's, far under the count cap of 32", q_after_flood.len() == SLOTS_EACH && q_after_flood.iter().all(|w| w["requested_by"] == json!(a.pk)));

    // The honest key is not locked out by the flood.
    let honest = rig.request(&b, None, NEAR / 2, &rig.f.payee.id().clone()).await;
    c.check("honest key B can still queue a request while A's flood sits in the queue", !honest.failed());
    let q_with_b = rig.queue().await;
    c.check("the queue now holds 17 entries", q_with_b.len() == SLOTS_EACH + 1);
    let pending: u128 = q_with_b.iter().map(|w| w["amount"].as_str().unwrap().parse::<u128>().unwrap()).sum();
    c.check("queued value is far under the pending limit", pending < PENDING);

    // The admin clears it with one call.
    let cancel = rig.admin_tx("cancel_all", json!({})).await;
    let cancelled = cancel.value().expect("cancel_all count");
    c.check("cancel_all returns the number it removed and the queue is empty", cancelled == json!(17) && rig.queue().await.is_empty());
    c.check("cancel_all logs what it removed (one queue_cancelled event with count 17)", cancel.events_named("queue_cancelled").iter().any(|e| e["data"]["count"] == 17));
    let again = rig.request(&a, None, DUST, &x).await;
    c.check("after cancel_all A can queue again (slots are free; this is not a ban)", !again.failed());
    c.check("no value reached the attacker's payee: a queue only holds requests", rpc.balance(&x).await == x0);

    let gas_flood: u64 = results.iter().map(|f| f.gas_burnt).sum();
    let measured = rig.with_bound(json!({
        "node": node_version(rpc).await,
        "daily_keys": 2,
        "flood_requests_sent_by_A": 40,
        "flood_requests_accepted": accepted,
        "flood_requests_refused_slots": slot_refusals,
        "queue_len_after_flood": q_after_flood.len(),
        "queue_count_cap": 32,
        "honest_request_B_accepted": !honest.failed(),
        "queue_len_with_B": q_with_b.len(),
        "queued_value_yocto": pending.to_string(),
        "cancel_all_removed": cancelled,
        "cancel_all_gas_burnt": cancel.gas_burnt,
        "cancel_all_tgas": tgas(cancel.gas_burnt),
        "gas_burnt_by_the_40_flood_calls": gas_flood,
        "gas_burnt_per_accepted_request_avg": results.iter().filter(|f| !f.failed()).map(|f| f.gas_burnt).sum::<u64>() / accepted.max(1) as u64,
        "gas_burnt_per_refused_request_avg": results.iter().filter(|f| f.failed()).map(|f| f.gas_burnt).sum::<u64>() / refused_count.max(1) as u64,
        "flood_calls_never_taken_in": dropped,
        "prepaid_tgas_per_flood_call": 15,
        "allowance_of_A_near": "10",
        "blocks_spanned_by_the_flood": results.iter().map(|f| f.call_receipt(&rig.vid).height).max().unwrap() - results.iter().map(|f| f.call_receipt(&rig.vid).height).min().unwrap() + 1,
        "strikes_A_after": rig.strikes(&a.pk).await,
        "funds_moved_to_attacker_yocto": (rpc.balance(&x).await - x0).to_string(),
    })).await;
    c.finish("attack_4a", "queue flood by one key: per-key slots hold, queue count cap holds, cancel_all works", measured);
}

#[tokio::test]
async fn attack_4b_the_pending_limit_holds_and_cancelling_gives_no_request_budget_back() {
    let rig = Rig::new(false).await;
    let rpc = rig.rpc();
    let x = rig.f.attacker.id().clone();
    let a = rig.add_daily(None).await;
    let b = rig.add_daily(None).await;
    let half = PENDING / 2;
    let x0 = rpc.balance(&x).await;
    let mut c = Checks::new();

    let a1 = rig.request(&a, None, half, &x).await;
    let a_more = rig.request(&a, None, 1, &x).await;
    c.check("A queues its half of the pending limit", !a1.failed());
    c.check("one yocto more from A is refused against A's share", a_more.panic_text().is_some_and(|t| t == "over this key's share of the pending limit for this token"));
    let b1 = rig.request(&b, None, half, &x).await;
    let b_more = rig.request(&b, None, 1, &x).await;
    c.check("B queues the other half", !b1.failed());
    c.check("one yocto more from B is refused against the account-wide pending limit", b_more.panic_text().is_some_and(|t| t == "over the pending limit for this token"));
    let q = rig.queue().await;
    let pending: u128 = q.iter().map(|w| w["amount"].as_str().unwrap().parse::<u128>().unwrap()).sum();
    c.check("the queued sum is exactly the pending limit, never above it", pending == PENDING);

    let cancel = rig.admin_tx("cancel_all", json!({})).await;
    c.check("cancel_all removed both requests", cancel.value() == Some(json!(2)) && rig.queue().await.is_empty());
    let retry = rig.request(&a, None, half, &x).await;
    let retry_text = retry.panic_text();
    c.check("cancelling did not give the 24 h request budget back: the same request is refused again", retry_text.as_deref() == Some("over the 24 h pending limit for this token"));
    c.check("no value reached the attacker's payee: a queue only holds requests", rpc.balance(&x).await == x0);

    let measured = rig.with_bound(json!({
        "node": node_version(rpc).await,
        "pending_limit_yocto": PENDING.to_string(),
        "each_key_share_yocto": half.to_string(),
        "A_first_request": "accepted",
        "A_one_yocto_more": a_more.panic_text(),
        "B_first_request": "accepted",
        "B_one_yocto_more": b_more.panic_text(),
        "queued_sum_yocto": pending.to_string(),
        "queued_sum_equals_pending_limit": pending == PENDING,
        "cancel_all_removed": cancel.value(),
        "cancel_all_gas_burnt": cancel.gas_burnt,
        "retry_after_cancel_all": retry_text,
        "gas_burnt_per_request_withdraw": a1.gas_burnt,
        "funds_moved_to_attacker_yocto": (rpc.balance(&x).await - x0).to_string(),
    })).await;
    c.finish("attack_4b", "pending sum never above the pending limit; budget not refunded by cancel_all", measured);
}
