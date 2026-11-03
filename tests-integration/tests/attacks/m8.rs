//! Milestone M8 (docs/v3/ROADMAP.md): the measured table. Blocks to key deletion are in attack_1 (and attack 8 for the
//! planted keys); this file measures
//!   - gas per call type (what each call burns on the chain, callbacks and the delete included),
//!   - the false-positive cost of a strike in replay: which honest mistakes count, what a false burn takes from the honest
//!     key (queued withdrawals, request budget), how many blocks the admin must wait before the key can be re-added, and an
//!     honest-agent trace replayed against the vault until its key burns.
//! The honest trace is scripted by us (the mix of mistakes is a parameter, listed in the result); it is NOT recorded
//! agent behaviour, and no agent-benchmark data set is used. The 24 h lapse of a strike is in `timed.rs`.

use serde_json::{json, Value};

use crate::common::*;
use crate::support::*;

fn row(call: &str, f: &Facts) -> Value {
    json!({
        "call": call, "gas_burnt": f.gas_burnt, "tgas": tgas(f.gas_burnt), "tokens_burnt_yocto": f.tokens_burnt.to_string(),
        "receipts": f.receipts.len(), "blocks_tx_to_last_receipt": f.last_height() - f.tx_height,
    })
}

#[tokio::test]
async fn m8_gas_per_call_type() {
    let rig = Rig::new(true).await;
    let rpc = rig.rpc();
    let payee = rig.f.payee.id().clone();
    let x = rig.f.attacker.id().clone();
    let mut c = Checks::new();
    let mut rows: Vec<Value> = Vec::new();

    let (sk, pk) = new_key();
    let add = rig.admin_tx("add_daily_key", json!({ "public_key": pk, "allowance": null })).await;
    wait_for("daily key on the account", std::time::Duration::from_secs(10), || async { rpc.access_key(&rig.vid, &pk).await.map(|_| ()) }).await;
    rows.push(row("add_daily_key (admin: AddKey receipt + callback)", &add));
    let k = Daily { acct: rig.f.daily(&sk), sk, pk };

    for i in 0..3 {
        let f = rig.send_small(&k, &payee, SEND).await;
        c.check(&format!("send_small sample {i} sent"), f.out() == Out::Sent);
        rows.push(row(&format!("send_small, sent (NEAR transfer + callback), sample {i}"), &f));
    }
    let mut ids = Vec::new();
    for i in 0..3 {
        let f = rig.request(&k, None, SEND, &payee).await;
        ids.push(f.value().expect("id"));
        rows.push(row(&format!("request_withdraw, sample {i}"), &f));
    }
    let cancel = rig.admin_tx("cancel", json!({ "id": ids[0] })).await;
    rows.push(row("cancel (admin), 1 request", &cancel));
    let cancel_all = rig.admin_tx("cancel_all", json!({})).await;
    c.check("cancel_all removed the other two", cancel_all.value() == Some(json!(2)));
    rows.push(row("cancel_all (admin), 2 requests", &cancel_all));

    // Use the cap up (the rest of it, to the payee), then refusals that do not count.
    let used = 3 * SEND;
    let rest = rig.send_small(&k, &payee, CAP - used).await;
    c.check("the cap is used up", rest.out() == Out::Sent && rig.spent_24h().await == CAP);
    for i in 0..3 {
        let f = rig.send_small(&k, &payee, SEND).await;
        c.check(&format!("cap-exhausted refusal {i} is uncounted"), matches!(f.out(), Out::Refused { strikes: 0, .. }));
        rows.push(row(&format!("send_small, refused, uncounted (cap used up), sample {i}"), &f));
    }
    let dust = rig.send_small(&k, &payee, NEAR / 2000).await;
    rows.push(row("send_small, refused, uncounted (below minimum send)", &dust));

    // Counted refusals, the burn included.
    let s1 = rig.send_small(&k, &x, SEND).await;
    rows.push(row("send_small, refused, counted (strike 1)", &s1));
    let s2 = rig.send_small(&k, &x, SEND).await;
    rows.push(row("send_small, refused, counted (strike 2)", &s2));
    let s3 = rig.send_small(&k, &x, SEND).await;
    c.check("the third counted refusal burned the key", matches!(s3.out(), Out::Refused { strikes: 3, burned: true, .. }));
    rows.push(row("send_small, refused, counted, burns the key (strike 3: queue cancel + DeleteKey + callback)", &s3));

    // The admin removing a key by hand.
    let (_, pk2) = new_key();
    rig.f.add_daily_key(&pk2, None).await;
    let rm = rig.admin_tx("remove_daily_key", json!({ "public_key": pk2 })).await;
    rows.push(row("remove_daily_key (admin: DeleteKey + callback)", &rm));

    let price = gas_price(rpc).await;
    let measured = json!({
        "node": node_version(rpc).await,
        "gas_price_yocto_per_gas": price.to_string(),
        "note": "gas_burnt is summed over the transaction and every receipt it caused, callbacks and refunds included; views are not transactions and are not listed",
        "rows": rows,
    });
    c.finish("m8_gas", "gas per call type, measured", measured);
}

/// What a false-positive strike costs. Classes first: which honest mistakes count at all.
#[tokio::test]
async fn m8_false_positive_cost_of_a_strike() {
    let rig = Rig::new(true).await;
    let rpc = rig.rpc();
    let vid = rig.vid.clone();
    let payee = rig.f.payee.id().clone();
    let x = rig.f.attacker.id().clone();
    let mut c = Checks::new();

    // ---- 1. which honest mistakes count --------------------------------------------------------------------------
    let mut classes: Vec<Value> = Vec::new();
    let mut all_as_documented = true;
    let big = NEAR * 3 / 2;
    // (name, token, amount, to, counted?)
    let cases: Vec<(&str, Option<&str>, u128, &near_workspaces::AccountId, bool)> = vec![
        ("first payment to a new vendor that is not on the allowlist yet", None, SEND, &x, true),
        ("legitimate payment above the whole 24 h cap (1.5 NEAR)", None, big, &payee, true),
        ("dust below the minimum send", None, NEAR / 2000, &payee, false),
        ("token with no limit set", Some("unlisted-token.test"), 1_000, &payee, false),
    ];
    for (name, token, amount, to, counted) in cases {
        let k = rig.add_daily(None).await;
        let token_id: Option<near_workspaces::AccountId> = token.map(|t| t.parse().expect("account id"));
        let advice = rig.check(&k.pk, token_id.as_ref(), amount, to).await;
        let f = rig.call_as(&k, "send_small", json!({ "token": token_id, "amount": amount.to_string(), "to": to }), 50).await;
        let strikes = rig.strikes(&k.pk).await;
        let as_documented = (strikes == 1) == counted && advice["counted"] == counted && advice["verdict"] == "refuse";
        all_as_documented &= as_documented;
        classes.push(json!({
            "mistake": name, "check_says_counted": advice["counted"], "check_reason": advice["reason"],
            "strikes_after": strikes, "counted_in_fact": strikes == 1, "gas_burnt": f.gas_burnt, "outcome": format!("{:?}", f.out()),
        }));
        rig.admin_tx("remove_daily_key", json!({ "public_key": k.pk })).await;
    }
    // Cap used up by earlier honest spending: on a vault of its own, so the cap is free again for what follows.
    {
        let rig2 = Rig::new(true).await;
        let spender = rig2.add_daily(None).await;
        rig2.send_small(&spender, rig2.f.payee.id(), CAP).await;
        let k = rig2.add_daily(None).await;
        let f = rig2.send_small(&k, rig2.f.payee.id(), SEND).await;
        let s = rig2.strikes(&k.pk).await;
        all_as_documented &= s == 0 && matches!(f.out(), Out::Refused { strikes: 0, .. });
        classes.push(json!({ "mistake": "cap used up by earlier honest spending (account-wide window)", "strikes_after": s, "counted_in_fact": s > 0, "gas_burnt": f.gas_burnt, "outcome": format!("{:?}", f.out()) }));
    }
    // A refused queue request and a zero amount are panics: uncounted.
    let k = rig.add_daily(None).await;
    let over = rig.request(&k, None, 11 * NEAR, &payee).await;
    let s = rig.strikes(&k.pk).await;
    all_as_documented &= s == 0 && over.failed();
    classes.push(json!({ "mistake": "request_withdraw above the pending limit (a panic)", "strikes_after": s, "counted_in_fact": s > 0, "gas_burnt": over.gas_burnt, "outcome": over.panic_text() }));
    let zero = rig.call_as(&k, "send_small", json!({ "token": null, "amount": "0", "to": payee }), 50).await;
    let s = rig.strikes(&k.pk).await;
    all_as_documented &= s == 0 && zero.failed();
    classes.push(json!({ "mistake": "zero amount (a panic)", "strikes_after": s, "counted_in_fact": s > 0, "gas_burnt": zero.gas_burnt, "outcome": zero.panic_text() }));
    c.check("every class behaves as ARCHITECTURE.md 2.1 says, and `check` predicted the counted ones", all_as_documented);
    rig.admin_tx("remove_daily_key", json!({ "public_key": k.pk })).await;

    // ---- 2. a false burn, and what it costs ----------------------------------------------------------------------
    let h = rig.add_daily(None).await;
    let mut queued_ids = Vec::new();
    for _ in 0..2 {
        queued_ids.push(rig.request(&h, None, PENDING / 2, &payee).await.value().expect("id"));
    }
    c.check("setup: the honest key has queued its whole pending limit (2 x 5 NEAR)", rig.queue().await.len() == 2);
    let mut strikes_seen = Vec::new();
    let mut burn: Option<Facts> = None;
    for _ in 0..3 {
        let f = rig.send_small(&h, &x, SEND).await; // an honest payment to a new vendor, three times in a day
        if let Out::Refused { strikes, burned, .. } = f.out() {
            strikes_seen.push(strikes);
            if burned {
                burn = Some(f);
            }
        }
    }
    let burn = burn.expect("the third counted mistake burned the honest key");
    c.check("strikes 1, 2, 3 and the third burns the honest key", strikes_seen == vec![1, 2, 3]);
    let cancelled_by_burn: u64 = burn.events_named("queue_cancelled").iter().map(|e| e["data"]["count"].as_u64().unwrap_or(0)).sum();
    c.check("the burn cancelled the honest key's two queued withdrawals", cancelled_by_burn == 2 && rig.queue().await.is_empty());
    let h_burn = burn.receipt_with_log("\"event\":\"key_burned\"").unwrap().height;
    let h_delete = burn.delete_height().unwrap();
    let h_confirmed = burn.last_height();

    // Recovery: the admin re-adds the same key as soon as the account has confirmed the delete.
    let re_add = rig.admin_tx("add_daily_key", json!({ "public_key": h.pk, "allowance": null })).await;
    c.check("the admin can re-add the same key right after the burn transaction has finished", !re_add.failed());
    wait_for("re-added key on the account", std::time::Duration::from_secs(10), || async { rig.rpc().access_key(&vid, &h.pk).await.map(|_| ()) }).await;
    let re_add_block = re_add.call_receipt(&vid).height;
    let after = rig.send_small(&h, &payee, SEND).await;
    c.check("the re-added key sends again at once (the instant path is back)", after.out() == Out::Sent);
    let requeue = rig.request(&h, None, NEAR, &payee).await;
    c.check("but it cannot queue anything for 24 h: cancelling by burn does not give the request budget back", requeue.panic_text().is_some_and(|t| t == "over the 24 h pending limit for this token"));

    // ---- 3. the window in which the admin cannot re-add the key yet ----------------------------------------------
    let h2 = rig.add_daily(None).await;
    for _ in 0..2 {
        rig.send_small(&h2, &x, SEND).await;
    }
    let admin_sk = rig.f.vault.as_account().secret_key().clone();
    let admin_pk = admin_sk.public_key().to_string();
    let admin_nonce = rpc.access_key(&vid, &admin_pk).await.expect("admin key")["nonce"].as_u64().expect("nonce");
    let mut admin_signer = KeySigner::new(&vid, &admin_sk, admin_nonce);
    let mut h2_signer = rig.signer(&h2).await;
    let burn_tx = rig.sign_calls(&mut h2_signer, &[("send_small", json!({ "token": null, "amount": SEND.to_string(), "to": x }), 50)]).await;
    let (_, bh) = rpc.head("final").await;
    let re_adds: Vec<SignedCall> = (0..40).map(|_| admin_signer.call(&vid, "add_daily_key", &json!({ "public_key": h2.pk, "allowance": null }), 60, &bh)).collect();
    send_all(rpc, &burn_tx).await;
    for t in &re_adds {
        rpc.send(t).await.expect("node accepts the admin attempt");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let burn2 = facts(rpc, &burn_tx[0].hash, &vid).await;
    let attempts = facts_many(rpc, &vid, &re_adds.iter().map(|t| t.hash.clone()).collect::<Vec<_>>()).await;
    let h2_burn = burn2.receipt_with_log("\"event\":\"key_burned\"").expect("second burn").height;
    let h2_confirmed = burn2.last_height();
    let mut refused_heights: Vec<u64> = Vec::new();
    let mut first_ok: Option<u64> = None;
    let (mut before_burn, mut after_success) = (0, 0);
    for a in &attempts {
        let at = a.call_receipt(&vid).height;
        match a.panic_text() {
            None => {
                first_ok = Some(first_ok.map_or(at, |b: u64| b.min(at)));
            }
            Some(t) if t.contains("revoked key") => refused_heights.push(at),
            Some(t) if t.contains("already recorded") => {
                if at < h2_burn {
                    before_burn += 1;
                } else {
                    after_success += 1;
                }
            }
            Some(_) => {}
        }
    }
    refused_heights.sort();
    refused_heights.dedup();
    c.check("the burn happened, and the admin's re-add was refused as 'deletion not confirmed' in at least one block", !refused_heights.is_empty());
    c.check("a re-add did succeed once the account confirmed the delete", first_ok.is_some_and(|b| b >= h2_confirmed));
    c.check("every refused re-add ran after the burn decision and before the confirmation", refused_heights.iter().all(|h| *h >= h2_burn && *h <= h2_confirmed));

    // ---- 4. an honest-agent trace replayed until the key burns ----------------------------------------------------------
    let mut traces = Vec::new();
    for seed in [1u64, 2, 3] {
        traces.push(replay(seed).await);
    }
    let all_burned = traces.iter().all(|t| t["burn_at_op"].is_u64());
    c.check("in every replayed trace the honest key was burned by its third counted mistake, and every later op was refused by the runtime", all_burned && traces.iter().all(|t| t["counted_mistakes_before_burn"] == 3 && t["ops_denied_after_burn_by_runtime"] == t["ops_after_burn"]));

    let measured = json!({
        "node": node_version(rpc).await,
        "caveat": "scripted honest trace, mistake mix chosen by us; not recorded agent behaviour; chain-side recovery only, admin response time is not measured",
        "mistake_classes": classes,
        "false_burn": {
            "counted_mistakes_to_burn": 3,
            "strikes_seen": strikes_seen,
            "queued_requests_cancelled_by_the_burn": cancelled_by_burn,
            "queued_value_cancelled_yocto": PENDING.to_string(),
            "burn_decision_block": h_burn,
            "deletekey_block": h_delete,
            "confirmed_block": h_confirmed,
            "blocks_burn_to_confirmed": h_confirmed - h_burn,
            "gas_burnt_by_the_burning_call": burn.gas_burnt,
            "admin_actions_to_recover": 1,
            "gas_burnt_by_the_admin_re_add": re_add.gas_burnt,
            "re_add_executed_in_block": re_add_block,
            "blocks_burn_to_re_add_executed": re_add_block - h_burn,
            "first_send_after_re_add": format!("{:?}", after.out()),
            "request_withdraw_after_re_add": requeue.panic_text(),
        },
        "re_add_race": {
            "burn_decision_block": h2_burn,
            "confirmed_block": h2_confirmed,
            "blocks_with_re_add_refused_as_not_confirmed": refused_heights.len(),
            "refused_in_blocks": refused_heights,
            "first_successful_re_add_block": first_ok,
            "attempts_total": attempts.len(),
            "attempts_that_ran_before_the_burn_decision": before_burn,
            "attempts_after_the_first_success": after_success,
        },
        "traces": traces,
    });
    c.finish("m8_false_positive", "a false-positive strike: which mistakes count, what a false burn costs, how long until the key can be re-added", measured);
}

// ---------------------------------------------------------------------------------------------------------------
// The scripted honest trace
// ---------------------------------------------------------------------------------------------------------------

fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// (op, weight in percent): an honest agent's day of payments with the mistakes an honest agent makes.
const MIX: [(&str, u64); 5] = [("pay", 70), ("new_payee", 10), ("big_pay", 4), ("dust", 8), ("no_limit_token", 8)];
const TRACE_OPS: usize = 80;

async fn replay(seed: u64) -> Value {
    let rig = Rig::new(true).await;
    let rpc = rig.rpc();
    let vid = rig.vid.clone();
    let payee = rig.f.payee.id().clone();
    let x = rig.f.attacker.id().clone();
    let key = rig.add_daily(None).await;
    let mut state = seed;
    let ops: Vec<&str> = (0..TRACE_OPS)
        .map(|_| {
            let mut roll = splitmix(&mut state) % 100;
            for (op, w) in MIX {
                if roll < w {
                    return op;
                }
                roll -= w;
            }
            "pay"
        })
        .collect();

    let (mut pays_done, mut counted, mut uncounted) = (0u64, 0u64, 0u64);
    let mut burn_at: Option<usize> = None;
    let mut denied = 0u64;
    let mut late = KeySigner::new(&vid, &key.sk, 1_000_000_000_000);
    for (i, op) in ops.iter().enumerate() {
        if burn_at.is_some() {
            // The key is gone: the runtime refuses whatever the agent tries next.
            let (_, bh) = rpc.head("final").await;
            let tx = late.call(&vid, "send_small", &json!({ "token": null, "amount": SEND.to_string(), "to": payee }), 50, &bh);
            if rpc.commit(&tx).await.err().is_some_and(|e| e.to_string().contains("AccessKeyNotFound")) {
                denied += 1;
            }
            continue;
        }
        let (token, amount, to): (Option<&str>, u128, &near_workspaces::AccountId) = match *op {
            "pay" => (None, SEND, &payee),
            "new_payee" => (None, SEND, &x),
            "big_pay" => (None, NEAR * 3 / 2, &payee),
            "dust" => (None, NEAR / 2000, &payee),
            _ => (Some("unlisted-token.test"), 1_000, &payee),
        };
        let f = rig.call_as(&key, "send_small", json!({ "token": token, "amount": amount.to_string(), "to": to }), 50).await;
        match f.out() {
            Out::Sent => pays_done += 1,
            Out::Refused { burned, strikes, .. } => {
                if *op == "new_payee" || *op == "big_pay" {
                    counted += 1;
                    assert_eq!(strikes, counted, "strike count follows the counted mistakes");
                } else {
                    uncounted += 1;
                }
                if burned {
                    burn_at = Some(i);
                }
            }
            Out::Aborted(t) => panic!("unexpected abort in the trace: {t}"),
        }
    }
    let after = burn_at.map_or(0, |b| ops.len() - b - 1);
    let mix: Vec<Value> = MIX.iter().map(|(op, w)| json!({ "op": op, "percent": w, "count_in_trace": ops.iter().filter(|o| *o == op).count() })).collect();
    json!({
        "seed": seed, "trace_ops": ops.len(), "mix": mix,
        "burn_at_op": burn_at, "counted_mistakes_before_burn": counted, "uncounted_refusals_before_burn": uncounted,
        "honest_payments_completed_before_burn": pays_done,
        "ops_after_burn": after, "ops_denied_after_burn_by_runtime": denied,
        "ops_run_in_total_on_chain": ops.len() as u64 - after as u64,
    })
}
