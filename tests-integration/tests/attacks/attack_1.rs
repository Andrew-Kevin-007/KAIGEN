//! Attack 1 (ARCHITECTURE.md section 7): an injected agent sends over the cap repeatedly, the clumsy attacker.
//! Claim: the key is burned at strike N and no funds above the cap move. Measured: attempts and strikes used, blocks and
//! chain time from the first attempt and from the burn decision to the block in which the key leaves the account, gas
//! (burnt by the attack, and the key's allowance used), funds moved, and what the burned key can still do.
//!
//! Three runs, each on a fresh vault: (a) amount over the whole cap, allowlist off, N = 3 (the default); (b) an in-cap
//! amount to a payee that is not on the enforced allowlist, N = 3; (c) as (a) with N = 10, the ceiling.

use serde_json::json;

use crate::common::*;
use crate::support::*;

struct Variant {
    id: &'static str,
    what: &'static str,
    allowlist_on: bool,
    max_strikes: u64,
    amount: u128,
}

async fn clumsy(v: Variant) {
    let rig = Rig::new(v.allowlist_on).await;
    let rpc = rig.rpc();
    let vid = rig.vid.clone();
    if v.max_strikes != 3 {
        rig.admin_tx("set_max_strikes", json!({ "max": v.max_strikes })).await;
    }
    let key = rig.add_daily(None).await;
    let attacker = rig.f.attacker.id().clone();
    let (att0, vault0) = (rpc.balance(&attacker).await, rig.settled_balance(&vid).await);
    let allowance0 = allowance_of(rpc, &vid, &key.pk).await.expect("allowance");
    let mut c = Checks::new();

    // The attack: the same refused request, again and again, until the vault stops serving the key.
    let mut attempts = Vec::new();
    let mut first_ts = 0;
    let mut last: Option<Facts> = None;
    let mut allowance_before_last = 0;
    let mut sequence_ok = true;
    for n in 1..=v.max_strikes {
        if n == v.max_strikes {
            allowance_before_last = allowance_of(rpc, &vid, &key.pk).await.expect("allowance");
        }
        let f = rig.send_small(&key, &attacker, v.amount).await;
        if n == 1 {
            first_ts = f.tx_ts;
        }
        let out = f.out();
        let expected_burn = n == v.max_strikes;
        sequence_ok &= matches!(&out, Out::Refused { strikes, burned, .. } if *strikes == n && *burned == expected_burn);
        attempts.push(json!({
            "attempt": n, "tx_block": f.tx_height, "outcome": format!("{out:?}"),
            "gas_burnt": f.gas_burnt, "tgas": tgas(f.gas_burnt), "tokens_burnt_yocto": f.tokens_burnt.to_string(),
        }));
        last = Some(f);
    }
    let burn = last.expect("an attempt");
    c.check(&format!("strikes read 1..{} and only attempt {} burned", v.max_strikes, v.max_strikes), sequence_ok);

    // Blocks, from the receipts of the burning transaction.
    let burn_receipt = burn.receipt_with_log("\"event\":\"key_burned\"").expect("key_burned event");
    let h_burn = burn_receipt.height;
    let h_delete = burn.delete_height().expect("the burn scheduled a DeleteKey receipt");
    let delete_ts = burn.receipts.iter().find(|r| r.delete_key).expect("delete receipt").ts;
    let h_confirmed = burn.last_height();
    let present_at_burn = key_present_at(rpc, &vid, &key.pk, h_burn).await;
    let present_before_delete = key_present_at(rpc, &vid, &key.pk, h_delete - 1).await;
    let present_at_delete = key_present_at(rpc, &vid, &key.pk, h_delete).await;
    c.check("the key is on the account in the burn block and in the block before the DeleteKey receipt", present_at_burn && present_before_delete);
    c.check("the key is off the account from the block of the DeleteKey receipt", !present_at_delete && h_delete > h_burn);
    c.check("the burn tx and all its receipts succeeded", !burn.failed());

    // Money and bookkeeping.
    let (att1, vault1) = (rpc.balance(&attacker).await, rig.settled_balance(&vid).await);
    c.check("no funds moved to the attacker", att1 == att0);
    let daily = rig.view("daily_keys", json!({})).await;
    c.check("the vault no longer serves the key", !daily.as_array().unwrap().iter().any(|k| k == &json!(key.pk)));
    c.check("revoked ledger empty (the account confirmed the delete)", rig.view("revoked_keys", json!({})).await == json!([]));
    c.check("strike record cleared and queue empty", rig.strikes(&key.pk).await == 0 && rig.queue().await.is_empty());

    // What the burned key can still do: nothing, the runtime refuses its transactions.
    let (_, bh) = rpc.head("final").await;
    let mut late = KeySigner::new(&vid, &key.sk, 1_000_000_000_000);
    let mut post = Vec::new();
    for (m, args) in [
        ("send_small", json!({ "token": null, "amount": v.amount.to_string(), "to": attacker })),
        ("request_withdraw", json!({ "token": null, "amount": v.amount.to_string(), "to": attacker })),
    ] {
        let tx = late.call(&vid, m, &args, 50, &bh);
        let err = rpc.commit(&tx).await.expect_err("a tx from a deleted key must be rejected");
        let rejected = err.to_string().contains("AccessKeyNotFound");
        c.check(&format!("{m} from the burned key is rejected with AccessKeyNotFound"), rejected);
        post.push(json!({ "method": m, "rejected_by_runtime": rejected }));
    }
    c.check("the attacker received nothing after the burn either", rpc.balance(&attacker).await == att0);

    let first_block = attempts[0]["tx_block"].as_u64().unwrap();
    let gas_total: u64 = attempts.iter().map(|a| a["gas_burnt"].as_u64().unwrap()).sum();
    let tokens_total: u128 = attempts.iter().map(|a| a["tokens_burnt_yocto"].as_str().unwrap().parse::<u128>().unwrap()).sum();
    let measured = rig.with_bound(json!({
        "variant": v.what,
        "node": node_version(rpc).await,
        "max_strikes_N": v.max_strikes,
        "amount_sent_per_attempt_yocto": v.amount.to_string(),
        "strikes_used": v.max_strikes,
        "attempts": attempts,
        "first_attempt_block": first_block,
        "burn_decision_block": h_burn,
        "deletekey_receipt_block": h_delete,
        "last_callback_block": h_confirmed,
        "blocks_burn_decision_to_key_off_account": h_delete - h_burn,
        "blocks_first_attempt_to_key_off_account": h_delete - first_block,
        "chain_ms_first_attempt_to_key_off_account": ms_between(first_ts, delete_ts),
        "key_on_account_at_burn_block": present_at_burn,
        "key_on_account_at_block_before_delete": present_before_delete,
        "key_on_account_at_delete_block": present_at_delete,
        "gas_burnt_by_all_attempts": gas_total,
        "tgas_burnt_by_all_attempts": tgas(gas_total),
        "tokens_burnt_yocto_all_attempts": tokens_total.to_string(),
        "gas_burnt_burning_attempt_incl_delete_and_callbacks": burn.gas_burnt,
        "allowance_start_yocto": allowance0.to_string(),
        "allowance_used_before_burning_attempt_yocto": (allowance0 - allowance_before_last).to_string(),
        "funds_moved_to_attacker_yocto": (att1 - att0).to_string(),
        "vault_balance_change_yocto": delta(vault0, vault1),
        "after_burn": post,
    })).await;
    c.finish(v.id, "key burned at strike N, no funds above the cap move", measured);
}

#[tokio::test]
async fn attack_1a_over_cap_sends_burn_the_key_at_the_third_strike() {
    clumsy(Variant { id: "attack_1a", what: "amount 2 NEAR (cap 1 NEAR), allowlist off, N=3", allowlist_on: false, max_strikes: 3, amount: 2 * NEAR }).await;
}

#[tokio::test]
async fn attack_1b_unlisted_payee_burns_the_key_at_the_third_strike() {
    clumsy(Variant { id: "attack_1b", what: "amount 0.01 NEAR to a payee off the enforced allowlist, N=3", allowlist_on: true, max_strikes: 3, amount: SEND }).await;
}

#[tokio::test]
async fn attack_1c_over_cap_sends_burn_the_key_at_the_strike_ceiling() {
    clumsy(Variant { id: "attack_1c", what: "amount 2 NEAR (cap 1 NEAR), allowlist off, N=10 (ceiling)", allowlist_on: false, max_strikes: 10, amount: 2 * NEAR }).await;
}
