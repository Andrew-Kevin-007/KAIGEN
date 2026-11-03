//! Attack 6 (ARCHITECTURE.md section 7): a new payee reached through `request_withdraw` instead of `send_small`.
//! Claim: it is queued, then cancelled. With the allowlist enforced, `send_small` to an unlisted payee is refused with a
//! strike; `request_withdraw` to the same payee queues (ARCHITECTURE.md 2.4), waits the 24 h delay, and the admin
//! cancels it inside that delay. Measured: blocks and chain time from the request to the cancel, the lock still left,
//! that nothing reached the payee, and that an execute after the cancel finds nothing.

use serde_json::json;

use crate::common::*;
use crate::support::*;

#[tokio::test]
async fn attack_6_a_new_payee_through_the_queue_is_queued_then_cancelled() {
    let rig = Rig::new(true).await; // allowlist enforced; only f.payee is listed
    let rpc = rig.rpc();
    let vid = rig.vid.clone();
    let key = rig.add_daily(None).await;
    let x = rig.f.attacker.id().clone(); // the new payee, not on the allowlist
    let x0 = rpc.balance(&x).await;
    let mut c = Checks::new();

    // Control: the instant path refuses the new payee, and it is a strike.
    let refused = rig.send_small(&key, &x, SEND).await;
    c.check("control: send_small to the unlisted payee is refused with a strike", matches!(refused.out(), Out::Refused { ref reason, strikes: 1, burned: false } if reason == "recipient is not on the allowlist"));

    // The queue path: a request far over the cap, to the same payee.
    let amount = 5 * NEAR;
    let req = rig.request(&key, None, amount, &x).await;
    let id = req.value().expect("request id");
    let req_receipt = req.call_receipt(&vid).clone();
    c.check("request_withdraw to the unlisted payee is accepted, 5 x the cap, no refusal", !req.failed());
    c.check("it earned no strike (still the one strike from the control)", rig.strikes(&key.pk).await == 1);
    let q = rig.queue().await;
    let unlocks_at: u64 = q[0]["unlocks_at"].as_str().unwrap().parse().unwrap();
    let requested_at: u64 = q[0]["requested_at"].as_str().unwrap().parse().unwrap();
    c.check("the queue holds it for the payee, locked for exactly the delay (24 h)", q.len() == 1 && q[0]["to"] == json!(x) && unlocks_at - requested_at == DAY_NS && q[0]["amount"] == json!(amount.to_string()));

    // Anyone can try to execute it at once: still locked.
    let early = rig.anyone_tx(&rig.f.payee, "execute", json!({ "id": id }), 100).await;
    c.check("execute at once is refused: still locked", early.panic_text().is_some_and(|t| t == "still locked"));
    c.check("nothing reached the payee", rpc.balance(&x).await == x0);

    // The admin cancels inside the delay.
    let cancel = rig.admin_tx("cancel", json!({ "id": id })).await;
    let cancel_receipt = cancel.call_receipt(&vid).clone();
    c.check("cancel succeeded and logged a cancel event", !cancel.failed() && !cancel.events_named("cancel").is_empty());
    c.check("the queue is empty", rig.queue().await.is_empty());
    let after = rig.anyone_tx(&rig.f.payee, "execute", json!({ "id": id }), 100).await;
    c.check("execute after the cancel finds no such request", after.panic_text().is_some_and(|t| t == "no such request"));
    c.check("the payee received nothing, ever", rpc.balance(&x).await == x0);

    let lock_left_ns = unlocks_at.saturating_sub(cancel_receipt.ts);
    let measured = rig.with_bound(json!({
        "node": node_version(rpc).await,
        "request_amount_yocto": amount.to_string(),
        "request_amount_in_caps": amount / CAP,
        "send_small_control_strikes": 1,
        "strikes_after_request_withdraw": 1,
        "request_block": req_receipt.height,
        "cancel_block": cancel_receipt.height,
        "blocks_request_to_cancel": cancel_receipt.height - req_receipt.height,
        "chain_ms_request_to_cancel": ms_between(req_receipt.ts, cancel_receipt.ts),
        "delay_ms": (unlocks_at - requested_at) / 1_000_000,
        "lock_still_left_at_cancel_ms": lock_left_ns / 1_000_000,
        "execute_at_once": early.panic_text(),
        "execute_after_cancel": after.panic_text(),
        "funds_moved_to_new_payee_yocto": (rpc.balance(&x).await - x0).to_string(),
        "gas_burnt_request_withdraw": req.gas_burnt,
        "gas_burnt_cancel": cancel.gas_burnt,
        "gas_burnt_execute_refused": early.gas_burnt,
        "admin_actions_needed": 1,
    })).await;
    c.finish("attack_6", "new payee via request_withdraw: queued, then cancelled", measured);
}
