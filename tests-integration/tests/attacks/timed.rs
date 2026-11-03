//! The parts of the attacks that need the chain clock moved by days, run against the real contract on the sandbox:
//!
//!   attack_2c  the pending part of the bound: queue the pending limit, wait out the 24 h delay without cancelling, send a
//!              full cap and execute everything inside a few blocks. Expected: cap + pending limit in one 24 h window.
//!   attack_5   a stale queue item: one request is executed inside its window (control), two are left until they have expired;
//!              `execute` must refuse them and `purge_expired` must remove them.
//!   attack_9b  the grief of attack 9 ends when the spend ages out of the 24 h window: honest key B sends again, still 0 strikes.
//!   m8_lapse   a strike lapses after 24 h: a key with two strikes has none a day later, and a third mistake is strike 1, not a burn.
//!
//! How the clock is moved: `sandbox_fast_forward` (nearcore 2.14.0). Measured in the week-3 run: the node advances the block
//! timestamp by about 0.3 s per skipped block, skips 100 to 120 blocks per second, and one chain day took 288,472 blocks
//! and 3,065 s of wall time (the second day 288,420 blocks, 2,949 s). This test moves the clock two days, so it takes about
//! 100 minutes, holds the sandbox for all of it, and is `#[ignore]`d: run it on purpose with
//!   cargo test --test attacks timed_chain_clock_phase -- --ignored --test-threads=1 --nocapture
//!
//! Everything is set up at time T0 on four vaults; then the clock moves to the latest unlock of T0 plus two minutes
//! (checks), then to the expiry of the stale requests plus two minutes (checks). A result is recorded after each phase, so a
//! node that dies late loses only the rest.

use near_workspaces::types::NearToken;
use serde_json::{json, Value};

use crate::common::*;
use crate::support::*;

const MARGIN_NS: u64 = 120 * 1_000_000_000; // two minutes past the instant a request unlocks, or a strike lapses

fn field_u64(v: &Value, k: &str) -> u64 {
    v[k].as_str().expect("string number").parse().expect("number")
}

/// After a jump the final block lags the head; wait until a transaction signed on the final block is valid again.
async fn settle_final(rpc: &Rpc) {
    wait_for("the final head to catch up after the jump", std::time::Duration::from_secs(60), || async {
        let (o, _) = rpc.head("optimistic").await;
        let (f, _) = rpc.head("final").await;
        (o.saturating_sub(f) <= 3).then_some(())
    })
    .await;
}

#[tokio::test]
#[ignore = "moves the chain clock two days: about 100 minutes of wall time, holds the sandbox; run with --ignored"]
async fn timed_chain_clock_phase() {
    let big = NearToken::from_near(1);
    let mut failures: Vec<String> = Vec::new();
    let mut jumps: Vec<Value> = Vec::new();

    // ======================================== T0: set everything up =========================================================
    // --- strike lapse first, so its first strike is the earliest event ---
    let vs = Rig::new(true).await;
    let xs = vs.f.attacker.id().clone();
    let hs = vs.add_daily(None).await;
    let strike1 = vs.send_small(&hs, &xs, SEND).await;
    let strike1_ts = strike1.call_receipt(&vs.vid).ts;
    let strike2 = vs.send_small(&hs, &xs, SEND).await;
    assert!(matches!(strike1.out(), Out::Refused { strikes: 1, burned: false, .. }) && matches!(strike2.out(), Out::Refused { strikes: 2, burned: false, .. }), "setup: two strikes");

    // --- attack 2c: a calibrated attacker with a full cap used and the whole pending limit queued ---
    let v2 = Rig::new(false).await;
    let k2 = v2.add_daily(Some(big)).await;
    let x2 = v2.f.attacker.id().clone();
    let mut ledger2: Vec<(u64, u128)> = Vec::new();
    let mut ids2 = Vec::new();
    for _ in 0..2 {
        ids2.push(v2.request(&k2, None, PENDING / 2, &x2).await.value().expect("id"));
    }
    let unlock2 = v2.queue().await.iter().map(|w| field_u64(w, "unlocks_at")).max().unwrap();
    let x2_start = v2.rpc().balance(&x2).await;
    let drain0 = v2.send_small(&k2, &x2, CAP).await;
    assert_eq!(drain0.out(), Out::Sent, "setup: the first cap goes through");
    ledger2.push((drain0.call_receipt(&v2.vid).ts, CAP));

    // --- attack 5: one request that will run inside its window, two that will go stale ---
    let v5 = Rig::new(false).await;
    let k5 = v5.add_daily(Some(big)).await;
    let x5 = v5.f.attacker.id().clone();
    let x5_start = v5.rpc().balance(&x5).await;
    let mut ids5 = Vec::new();
    for _ in 0..3 {
        ids5.push(v5.request(&k5, None, NEAR, &x5).await.value().expect("id"));
    }
    let q5 = v5.queue().await;
    let unlock5 = q5.iter().map(|w| field_u64(w, "unlocks_at")).max().unwrap();
    let expire5 = q5.iter().map(|w| field_u64(w, "expires_at")).max().unwrap();

    // --- attack 9b: A uses the cap up, B is refused ---
    let v9 = Rig::new(true).await;
    let payee9 = v9.f.payee.id().clone();
    let a9 = v9.add_daily(None).await;
    let b9 = v9.add_daily(None).await;
    let spend9 = v9.send_small(&a9, &payee9, CAP).await;
    let spend9_ts = spend9.call_receipt(&v9.vid).ts;
    let refused9 = v9.send_small(&b9, &payee9, SEND).await;
    let refused9_ts = refused9.call_receipt(&v9.vid).ts;
    assert!(matches!(refused9.out(), Out::Refused { strikes: 0, burned: false, .. }), "setup: B is refused without a strike");

    let rpc = v2.rpc();
    let node = node_version(rpc).await;
    let (h_setup, t_setup) = head_info(rpc).await;
    println!("T0 set up at block {h_setup}, chain time {t_setup}");

    // ======================================== phase 1: T0 + 24 h + 2 min ====================================================
    let target1 = [unlock2, unlock5, spend9_ts + DAY_NS, strike1_ts + DAY_NS].into_iter().max().unwrap() + MARGIN_NS;
    let j1 = jump_clock_to(rpc, target1).await;
    settle_final(rpc).await;
    let (_, t1) = head_info(rpc).await;
    jumps.push(json!({ "to": "latest unlock / window end of T0 plus 2 min", "blocks_skipped": j1.blocks, "chain_seconds": j1.chain_seconds, "wall_seconds": j1.wall_seconds }));

    // ---- attack 2c: the tightest window ----
    {
        let mut c = Checks::new();
        let again = v2.send_small(&k2, &x2, CAP).await;
        c.check("the cap window has released: a second full cap goes through a day later", again.out() == Out::Sent);
        ledger2.push((again.call_receipt(&v2.vid).ts, CAP));
        let mut tight_heights = vec![again.call_receipt(&v2.vid).height];
        let mut exec_gas = 0;
        let mut exec_ok = true;
        for id in &ids2 {
            let e = v2.anyone_tx(&v2.f.payee, "execute", json!({ "id": id }), 100).await;
            exec_ok &= !e.failed();
            exec_gas = e.gas_burnt;
            ledger2.push((e.call_receipt(&v2.vid).ts, PENDING / 2));
            tight_heights.push(e.call_receipt(&v2.vid).height);
        }
        c.check("nobody cancelled: both queued requests executed (permissionless) once the 24 h delay was over", exec_ok);
        let total_lost = v2.rpc().balance(&x2).await - x2_start;
        let window = max_window(&ledger2);
        c.check("the most any 24 h window lost is exactly cap + pending limit (11 NEAR)", window == CAP + PENDING);
        c.check("over the two windows the attacker holds 2 caps + the pending limit (12 NEAR)", total_lost == 2 * CAP + PENDING);
        let more = v2.send_small(&k2, &x2, SEND).await;
        let again_exec = v2.anyone_tx(&v2.f.payee, "execute", json!({ "id": ids2[0] }), 100).await;
        c.check("and then it is over: a further send is refused, a second execute finds no such request", matches!(more.out(), Out::Refused { strikes: 0, .. }) && again_exec.panic_text().is_some_and(|t| t == "no such request"));
        c.check("zero strikes the whole time, key still on the account", v2.strikes(&k2.pk).await == 0 && v2.on_account(&k2.pk).await);
        let measured = json!({
            "node": node,
            "cap_yocto": CAP.to_string(), "pending_limit_yocto": PENDING.to_string(), "delay_hours": 24,
            "calls_in_the_tight_window": tight_heights.len(),
            "max_loss_in_any_24h_window_yocto": window.to_string(),
            "max_loss_in_any_24h_window_near": near_str(window),
            "bound_cap_plus_pending_near": near_str(CAP + PENDING),
            "total_held_by_attacker_near": near_str(total_lost),
            "windows_used": 2,
            "chain_seconds_between_first_cap_and_the_tight_window": ledger2[1].0.saturating_sub(ledger2[0].0) / 1_000_000_000,
            "first_block_of_the_tight_window": tight_heights.iter().min(),
            "last_block_of_the_tight_window": tight_heights.iter().max(),
            "blocks_spanned_by_the_tight_window": tight_heights.iter().max().unwrap() - tight_heights.iter().min().unwrap() + 1,
            "gas_burnt_per_execute": exec_gas,
            "admin_actions_taken": 0,
        });
        if let Some(f) = c.record_only("attack_2c", "worst case within one window equals cap + pending limit when the admin does not cancel", measured) {
            failures.push(f);
        }
    }

    // ---- attack 9b: the grief ends when A's spend ages out ----
    {
        let mut c = Checks::new();
        let ok = v9.send_small(&b9, &payee9, SEND).await;
        let ok_ts = ok.call_receipt(&v9.vid).ts;
        c.check("a day after A's spend, honest key B's legitimate send goes through", ok.out() == Out::Sent);
        c.check("B never got a strike and is still on the account", v9.strikes(&b9.pk).await == 0 && v9.on_account(&b9.pk).await);
        let measured = json!({
            "node": node,
            "last_refusal_of_B_chain_seconds_after_A_spend": refused9_ts.saturating_sub(spend9_ts) / 1_000_000_000,
            "first_success_of_B_chain_seconds_after_A_spend": ok_ts.saturating_sub(spend9_ts) / 1_000_000_000,
            "window_seconds": 86_400,
            "B_blocked_for": "from A's spend until it ages out of the 24 h window (between the two numbers above)",
            "strikes_of_B": 0,
            "gas_burnt_B_send": ok.gas_burnt,
        });
        if let Some(f) = c.record_only("attack_9b", "honest key B is blocked only until A's spend leaves the 24 h window, never burned", measured) {
            failures.push(f);
        }
    }

    // ---- strike lapse ----
    {
        let mut c = Checks::new();
        let view = vs.strikes(&hs.pk).await;
        c.check("a day after the first of two strikes, strikes_of reads 0", view == 0);
        let third = vs.send_small(&hs, &xs, SEND).await;
        let third_ok = matches!(third.out(), Out::Refused { strikes: 1, burned: false, .. });
        c.check("a third counted mistake a day later is strike 1, not a burn", third_ok);
        c.check("the key is still on the account", vs.on_account(&hs.pk).await);
        let measured = json!({
            "node": node,
            "strikes_before_the_jump": 2,
            "chain_seconds_since_first_strike": (t1.saturating_sub(strike1_ts)) / 1_000_000_000,
            "strikes_of_after": view,
            "third_mistake_outcome": format!("{:?}", third.out()),
            "mistakes_that_would_have_burned_a_cumulative_count": 3,
            "cumulative_count_measured": false,
        });
        if let Some(f) = c.record_only("m8_strike_lapse", "a strike lapses after 24 h; mistakes spaced more than a day apart never burn a key", measured) {
            failures.push(f);
        }
    }

    // ======================================== phase 2: the stale requests expire ===========================================
    // First the control: a request inside its window runs.
    let mut c5 = Checks::new();
    let ctrl = v5.anyone_tx(&v5.f.payee, "execute", json!({ "id": ids5[0] }), 100).await;
    c5.check("control: a request executed inside its 24 h window goes through", !ctrl.failed() && v5.rpc().balance(&x5).await - x5_start == NEAR);
    let q_mid = v5.queue().await.len();
    c5.check("two requests are left, unlocked and not yet expired", q_mid == 2);
    let balance_mid = v5.rpc().balance(&x5).await;

    let target2 = expire5 + MARGIN_NS;
    let j2 = jump_clock_to(rpc, target2).await;
    settle_final(rpc).await;
    let (_, t2) = head_info(rpc).await;
    jumps.push(json!({ "to": "expiry of the stale requests plus 2 min", "blocks_skipped": j2.blocks, "chain_seconds": j2.chain_seconds, "wall_seconds": j2.wall_seconds }));

    let stale_a = v5.anyone_tx(&v5.f.payee, "execute", json!({ "id": ids5[1] }), 100).await;
    let stale_b = v5.anyone_tx(&v5.f.payee, "execute", json!({ "id": ids5[2] }), 100).await;
    c5.check("a stale request cannot be executed: expired", stale_a.panic_text().is_some_and(|t| t == "expired") && stale_b.panic_text().is_some_and(|t| t == "expired"));
    c5.check("nothing reached the payee", v5.rpc().balance(&x5).await == balance_mid);
    let q_stale = v5.queue().await;
    c5.check("the stale requests are still listed until someone purges them", q_stale.len() == 2 && q_stale.iter().all(|w| field_u64(w, "expires_at") <= t2));
    let purge = v5.anyone_tx(&v5.f.payee, "purge_expired", json!({}), 50).await;
    let purged = purge.value();
    c5.check("purge_expired removes both and logs queue_expired with count 2", purged == Some(json!(2)) && purge.events_named("queue_expired").iter().any(|e| e["data"]["count"] == 2 && e["data"]["trigger"] == "purge_expired"));
    let after_purge = v5.anyone_tx(&v5.f.payee, "execute", json!({ "id": ids5[1] }), 100).await;
    c5.check("after the purge the queue is empty and execute finds no such request", v5.queue().await.is_empty() && after_purge.panic_text().is_some_and(|t| t == "no such request"));
    c5.check("the payee got exactly the one control request (1 NEAR) in all", v5.rpc().balance(&x5).await - x5_start == NEAR);
    let measured5 = json!({
        "node": node,
        "delay_hours": 24, "execute_window_hours": 24,
        "requests": 3, "executed_inside_window": 1, "left_to_go_stale": 2,
        "chain_seconds_past_expiry_when_tried": t2.saturating_sub(expire5) / 1_000_000_000,
        "execute_of_stale_request": stale_a.panic_text(),
        "queue_len_after_expiry_before_purge": q_stale.len(),
        "purge_expired_removed": purged,
        "execute_after_purge": after_purge.panic_text(),
        "funds_reaching_payee_from_stale_requests_yocto": "0",
        "gas_burnt_execute_inside_window": ctrl.gas_burnt,
        "gas_burnt_execute_refused_expired": stale_a.gas_burnt,
        "gas_burnt_purge_expired_2_requests": purge.gas_burnt,
        "unlock_to_expiry_hours": 24,
        "total_unlock_wait_hours_before_item_went_stale": 48,
    });
    if let Some(f) = c5.record_only("attack_5", "a stale queue item expires and cannot execute", measured5) {
        failures.push(f);
    }

    record("timed_clock_jumps", &json!({ "node": node, "jumps": jumps, "note": "sandbox_fast_forward; the chain clock, not wall time, is what the contract reads" }));
    assert!(failures.is_empty(), "{failures:?}");
}

/// Pilot, a few seconds: after a small clock jump the chain still takes calls from daily keys and admin, and the contract
/// sees the later time. Kept because a day-long jump that fails afterwards is expensive to find out.
#[tokio::test]
async fn timed_pilot_a_small_jump_leaves_the_chain_usable() {
    let rig = Rig::new(false).await;
    let rpc = rig.rpc();
    let k = rig.add_daily(None).await;
    let x = rig.f.attacker.id().clone();
    let before = rig.send_small(&k, &x, SEND).await;
    let t0 = before.call_receipt(&rig.vid).ts;
    let target = head_info(rpc).await.1 + 600 * 1_000_000_000; // ten minutes of chain time
    let j = jump_clock_to(rpc, target).await;
    settle_final(rpc).await;
    let after = rig.send_small(&k, &x, SEND).await;
    let admin = rig.admin_tx("set_min_send", json!({ "min": (NEAR / 1000).to_string() })).await;
    let t1 = after.call_receipt(&rig.vid).ts;
    println!("PILOT jumped {} blocks, {} chain s, {} wall s; contract time moved {} s", j.blocks, j.chain_seconds, j.wall_seconds, (t1 - t0) / 1_000_000_000);
    assert!(before.out() == Out::Sent && after.out() == Out::Sent && !admin.failed());
    assert!(t1 - t0 >= 600 * 1_000_000_000);
}
