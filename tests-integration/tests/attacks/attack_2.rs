//! Attack 2 (ARCHITECTURE.md section 7, MANDATORY): the calibrated attacker. A hijacked daily key reads `check` for the
//! exact headroom, sends in-cap amounts to a payee of its own with the allowlist off, and never gets refused.
//! Claim: the loss equals exactly one cap and the key collects zero strikes. This is the honest picture of what the
//! refusal counter does not do, so PASS here means "the documented limitation reproduces", not "the attacker is stopped".
//! The pending part of the bound (cap + pending limit, LOSS-BOUND.md) needs the chain clock moved a day: `timed.rs`.
//!
//! 2a: drain the cap from `check`'s headroom, then probe on without a strike, then fill the queue to the pending limit.
//! 2b: how far uncounted probing goes: a key with a small allowance, cap already used up, probes until the runtime
//!     stops it; what is left of the key afterwards is observed, not assumed.

use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

use crate::common::*;
use crate::support::*;

#[tokio::test]
async fn attack_2a_calibrated_attacker_loses_exactly_one_cap_and_collects_no_strike() {
    let rig = Rig::new(false).await; // allowlist off: the default configuration of the contract
    let rpc = rig.rpc();
    let vid = rig.vid.clone();
    let key = rig.add_daily(None).await;
    let x = rig.f.attacker.id().clone();
    let (att0, vault0) = (rpc.balance(&x).await, rig.settled_balance(&vid).await);
    let mut c = Checks::new();

    // The attacker's loop: ask `check` (a free view) what is left, send exactly that much, in chunks of a quarter cap.
    let chunk = CAP / 4;
    let mut steps = Vec::new();
    let mut ledger: Vec<(u64, u128)> = Vec::new();
    let mut advice_matched = true;
    let mut every_send_sent = true;
    let (mut sends, mut gas_sends, mut first_block, mut last_block) = (0u64, 0u64, 0u64, 0u64);
    for _ in 0..16 {
        let chk = rig.check(&key.pk, None, chunk, &x).await;
        let headroom: u128 = chk["headroom"].as_str().unwrap().parse().unwrap();
        steps.push(json!({ "check_verdict": chk["verdict"], "check_reason": chk["reason"], "headroom_yocto": headroom.to_string() }));
        if chk["verdict"] != "allow" {
            break;
        }
        let amount = chunk.min(headroom);
        let f = rig.send_small(&key, &x, amount).await;
        advice_matched &= chk["reason"] == "ok";
        every_send_sent &= f.out() == Out::Sent;
        ledger.push((f.call_receipt(&vid).ts, amount));
        sends += 1;
        gas_sends += f.gas_burnt;
        if sends == 1 {
            first_block = f.tx_height;
        }
        last_block = f.tx_height;
    }
    let lost = rpc.balance(&x).await - att0;
    let final_check = rig.check(&key.pk, None, chunk, &x).await;
    c.check("every send the attacker made went through, each one allowed by `check` first", every_send_sent && advice_matched);
    c.check("loss equals exactly one cap (balance of the attacker's payee)", lost == CAP);
    c.check("the contract's own books agree: spent_24h equals the cap", rig.spent_24h().await == CAP);
    c.check("the window ledger holds exactly one cap in 24 h", max_window(&ledger) == CAP);
    c.check("`check` now says refuse / cap_exhausted, not counted, headroom 0", final_check["verdict"] == "refuse" && final_check["reason"] == "cap_exhausted" && final_check["counted"] == false && final_check["headroom"] == "0");
    c.check("zero strikes after draining the cap", rig.strikes(&key.pk).await == 0);

    // The attacker keeps going: the refusal that the cap earns is not counted, so no strike, no burn.
    let probes = 6;
    let mut probe_gas = 0;
    let mut probes_refused_uncounted = true;
    for _ in 0..probes {
        let f = rig.send_small(&key, &x, DEFAULT_MIN).await;
        probe_gas = f.gas_burnt;
        probes_refused_uncounted &= matches!(f.out(), Out::Refused { ref reason, strikes: 0, burned: false } if reason == "over the 24 h limit");
    }
    c.check("six more attempts after the cap is used up are refused, not counted: strikes stay 0, key not burned", probes_refused_uncounted && rig.strikes(&key.pk).await == 0);
    c.check("the key is still on the account and still recorded", rig.on_account(&key.pk).await && rig.view("daily_keys", json!({})).await.as_array().unwrap().iter().any(|k| k == &json!(key.pk)));
    c.check("no further money moved to the attacker", rpc.balance(&x).await - att0 == CAP);

    // The queue part, as far as it can be measured without waiting: the attacker fills the pending limit.
    let mut queued = Vec::new();
    let mut queue_gas = 0;
    for _ in 0..2 {
        let f = rig.request(&key, None, PENDING / 2, &x).await;
        queue_gas = f.gas_burnt;
        queued.push(f.value().expect("request id"));
    }
    let q = rig.queue().await;
    let pending: u128 = q.iter().map(|w| w["amount"].as_str().unwrap().parse::<u128>().unwrap()).sum();
    let over = rig.request(&key, None, 1, &x).await;
    let early = rig.anyone_tx(&rig.f.payee, "execute", json!({ "id": queued[0] }), 100).await;
    c.check("the queue holds exactly the pending limit and one yocto more is refused", pending == PENDING && over.panic_text().is_some_and(|t| t.contains("over the pending limit")));
    c.check("a queued request cannot be executed at once (still locked); nothing more reached the attacker", early.panic_text().is_some_and(|t| t.contains("still locked")) && rpc.balance(&x).await - att0 == CAP);
    c.check("still zero strikes after filling the queue", rig.strikes(&key.pk).await == 0);

    let vault1 = rig.settled_balance(&vid).await;
    let measured = rig.with_bound(json!({
        "node": node_version(rpc).await,
        "cap_yocto": CAP.to_string(),
        "pending_limit_yocto": PENDING.to_string(),
        "loss_instant_yocto": lost.to_string(),
        "loss_instant_near": near_str(lost),
        "loss_instant_in_caps": lost / CAP,
        "strikes_after_drain": 0,
        "strikes_after_probing": rig.strikes(&key.pk).await,
        "send_calls_that_moved_money": sends,
        "check_calls_used_by_the_attacker": steps.len(),
        "check_steps": steps,
        "first_send_block": first_block,
        "last_send_block": last_block,
        "blocks_first_to_last_send": last_block - first_block,
        "gas_burnt_per_send_avg": gas_sends / sends.max(1),
        "gas_burnt_per_refused_probe": probe_gas,
        "probes_after_cap_used_up": probes,
        "queued_pending_yocto": pending.to_string(),
        "queued_requests": q.len(),
        "gas_burnt_per_request_withdraw": queue_gas,
        "queued_request_executable_immediately": false,
        "vault_balance_change_yocto_incl_gas": delta(vault0, vault1),
        "key_still_on_account": rig.on_account(&key.pk).await,
    })).await;
    c.finish("attack_2a", "loss equals exactly one cap, zero strikes (the counter does not stop a calibrated attacker)", measured);
}

const DEFAULT_MIN: u128 = NEAR / 1000; // the contract's default minimum send, 0.001 NEAR

/// 2b: uncounted probing is bounded only by the key's gas allowance. A key with a small allowance probes until the
/// runtime refuses it; what the runtime then does with the key is the measurement (the v2 code comment says it deletes it).
#[tokio::test]
async fn attack_2b_uncounted_probing_stops_only_when_the_gas_allowance_is_gone() {
    let rig = Rig::new(false).await;
    let rpc = rig.rpc();
    let vid = rig.vid.clone();
    let x = rig.f.attacker.id().clone();
    let mut c = Checks::new();

    // Another key uses the cap up first, so the prober's every attempt is a cap refusal.
    let drainer = rig.add_daily(None).await;
    let drained = rig.send_small(&drainer, &x, CAP).await;
    c.check("setup: the cap is used up by another key", drained.out() == Out::Sent && rig.spent_24h().await == CAP);

    let x_before = rpc.balance(&x).await;
    let allowance = NearToken::from_millinear(20);
    let prober = rig.add_daily(Some(allowance)).await;
    let allowance0 = allowance_of(rpc, &vid, &prober.pk).await.expect("allowance");
    let mut probes = 0u64;
    let (mut gas_each, mut allowance_each) = (0u64, 0u128);
    let mut all_uncounted = true;
    let end_reason: String;
    let mut prev = allowance0;
    let ended_by_runtime = loop {
        let r = prober
            .acct
            .call(&vid, "send_small")
            .args_json(json!({ "token": null, "amount": DEFAULT_MIN.to_string(), "to": x }))
            .gas(Gas::from_tgas(10))
            .transact()
            .await;
        match r {
            Ok(res) => {
                let f = facts(rpc, &res.outcome().transaction_hash.to_string(), &vid).await;
                all_uncounted &= matches!(f.out(), Out::Refused { strikes: 0, burned: false, .. });
                probes += 1;
                gas_each = f.gas_burnt;
                match allowance_of(rpc, &vid, &prober.pk).await {
                    Some(now) => {
                        allowance_each = prev.saturating_sub(now);
                        prev = now;
                    }
                    None => {
                        end_reason = format!("the key left the account right after probe {probes}");
                        break true;
                    }
                }
            }
            Err(e) => {
                end_reason = format!("the node refused probe {}: {}", probes + 1, e.to_string().chars().take(300).collect::<String>());
                break true;
            }
        }
        assert!(probes < 400, "the prober was never stopped");
    };
    // The stop came from the node. Ask it again with a raw transaction to read its own words, then keep probing with
    // the least gas a refused send needs to see whether the key is finished or only too poor for the bigger prepay.
    let (_, bh) = rpc.head("final").await;
    let nonce = rpc.access_key(&vid, &prober.pk).await.map_or(0, |k| k["nonce"].as_u64().unwrap_or(0));
    let mut raw = KeySigner::new(&vid, &prober.sk, nonce);
    let retry = raw.call(&vid, "send_small", &json!({ "token": null, "amount": DEFAULT_MIN.to_string(), "to": x }), 10, &bh);
    let node_words = match rpc.commit(&retry).await {
        Ok(_) => "accepted".to_string(),
        Err(e) => e.to_string().chars().take(400).collect::<String>(),
    };
    let allowance_when_stopped = allowance_of(rpc, &vid, &prober.pk).await;
    let mut small_probes = 0u64;
    let mut small_error = String::from("none: stopped at the safety limit");
    for _ in 0..400 {
        let tx = raw.call(&vid, "send_small", &json!({ "token": null, "amount": DEFAULT_MIN.to_string(), "to": x }), 5, &rpc.head("final").await.1);
        match rpc.commit(&tx).await {
            Ok(r) if r["status"].get("Failure").is_some() => {
                small_error = format!("transaction failed on chain: {}", r["status"]["Failure"].to_string().chars().take(200).collect::<String>());
                break;
            }
            Ok(_) => small_probes += 1,
            Err(e) => {
                small_error = e.to_string().chars().take(300).collect();
                break;
            }
        }
    }
    let key_after = rpc.access_key(&vid, &prober.pk).await;
    let recorded_after = rig.view("daily_keys", json!({})).await.as_array().unwrap().iter().any(|k| k == &json!(prober.pk));
    let strikes_after = rig.strikes(&prober.pk).await;
    c.check("every probe was refused without a strike", all_uncounted && strikes_after == 0);
    c.check("the runtime, not the contract, ended the probing (the node refused a transaction of the key, or the key left the account)", ended_by_runtime);
    c.check("no money moved during the probing", rpc.balance(&x).await == x_before && rig.spent_24h().await == CAP);

    let measured = json!({
        "node": node_version(rpc).await,
        "allowance_start_yocto": allowance0.to_string(),
        "gas_prepaid_per_probe_tgas": 10,
        "probes_refused_at_10_tgas_prepaid_before_the_node_stopped_the_key": probes,
        "node_words_when_asked_again_at_10_tgas": node_words,
        "allowance_when_the_10_tgas_probes_stopped_yocto": allowance_when_stopped.map(|a| a.to_string()),
        "further_probes_refused_at_5_tgas_prepaid": small_probes,
        "what_stopped_the_5_tgas_probes": small_error,
        "gas_burnt_per_probe": gas_each,
        "allowance_used_per_probe_last_yocto": allowance_each.to_string(),
        "allowance_left_yocto": key_after.as_ref().and_then(|k| k["permission"]["FunctionCall"]["allowance"].as_str().map(str::to_string)),
        "strikes_at_the_end": strikes_after,
        "key_on_account_after": key_after.is_some(),
        "key_still_recorded_by_the_vault": recorded_after,
        "how_the_10_tgas_probing_ended": end_reason,
    });
    c.finish("attack_2b", "uncounted refusals cost gas from the key's allowance and nothing else; the allowance is the only brake", measured);
}
