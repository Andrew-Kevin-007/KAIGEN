//! Attack 7 (ARCHITECTURE.md section 7): a decimal-misread send. Claim: refused or bounded per token.
//! The agent means to send 5 tokens (0.5 NEAR) but scales the amount with the wrong number of decimals. Mamori's cap is in
//! token units (ARCHITECTURE.md 5), so the amount is judged against the cap of that token, with no notion of price or
//! decimals. Two assets: native NEAR (24 decimals, cap 1 NEAR) and `ft6`, a NEP-141 look-alike with 6 decimals and a
//! cap of 100 tokens (tests-integration/fixtures/ft-mock; a fixture, not a real token, see its header). A third token
//! with no limit set. Each case runs on a fresh daily key (removed afterwards), so strikes of one case do not burn the next.

use serde_json::{json, Value};

use crate::common::*;
use crate::support::*;

const FT_CAP_TOKENS: u128 = 100;
const FT_DECIMALS: u32 = 6;

fn units_str(v: u128, decimals: u32) -> String {
    let unit = 10u128.pow(decimals);
    let (whole, frac) = (v / unit, v % unit);
    if frac == 0 {
        return whole.to_string();
    }
    format!("{whole}.{}", format!("{frac:0width$}", width = decimals as usize).trim_end_matches('0'))
}

fn ft_wasm() -> Vec<u8> {
    let path = std::env::var("FT_MOCK_WASM").expect("FT_MOCK_WASM must point at ft_mock.wasm (build tests-integration/fixtures/ft-mock)");
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
}

async fn deploy_ft(rig: &Rig, decimals: u8, mint_to_vault: u128) -> near_workspaces::Contract {
    let ft = rig.f.worker.dev_deploy(&ft_wasm()).await.expect("deploy ft");
    ft.call("new").args_json(json!({ "decimals": decimals })).transact().await.expect("ft new").into_result().expect("ft new ok");
    ft.call("ft_mint")
        .args_json(json!({ "account_id": rig.vid, "amount": mint_to_vault.to_string() }))
        .transact()
        .await
        .expect("ft mint")
        .into_result()
        .expect("ft mint ok");
    ft
}

async fn ft_balance(rig: &Rig, ft: &near_workspaces::AccountId, who: &near_workspaces::AccountId) -> u128 {
    rig.rpc().view(ft, "ft_balance_of", json!({ "account_id": who })).await.as_str().expect("balance").parse().expect("number")
}

/// One misread on a fresh key: returns the send's facts.
async fn one_case(rig: &Rig, token: Option<&near_workspaces::AccountId>, raw: u128, to: &near_workspaces::AccountId) -> Facts {
    let key = rig.add_daily(None).await;
    let f = rig.call_as(&key, "send_small", json!({ "token": token, "amount": raw.to_string(), "to": to }), 100).await;
    rig.admin_tx("remove_daily_key", json!({ "public_key": key.pk })).await;
    f
}

#[tokio::test]
async fn attack_7_decimal_misreads_are_refused_or_bounded_by_the_cap_of_that_token() {
    let rig = Rig::new(false).await;
    let rpc = rig.rpc();
    let x = rig.f.attacker.id().clone();
    let one_ft = 10u128.pow(FT_DECIMALS);
    let ft6 = deploy_ft(&rig, FT_DECIMALS as u8, 1_000_000 * one_ft).await;
    let ft8 = deploy_ft(&rig, 8, 1_000_000 * 10u128.pow(8)).await;
    rig.admin_tx("set_token_limit", json!({ "token": ft6.id(), "limit": (FT_CAP_TOKENS * one_ft).to_string() })).await;
    let mut c = Checks::new();
    let mut table: Vec<Value> = Vec::new();
    let mut counted_refusals_ok = true;
    let mut uncounted_ok = true;

    // ---- ft6: the agent means 5 tokens ------------------------------------------------------------------------------
    let ft_cap_raw = FT_CAP_TOKENS * one_ft;
    let mut ft_lost_total = 0u128;
    let mut ft_max_single = 0u128;
    for believed in [6u32, 3, 7, 8, 9, 18, 24] {
        let raw = 5 * 10u128.pow(believed);
        let before = ft_balance(&rig, ft6.id(), &x).await;
        let f = one_case(&rig, Some(ft6.id()), raw, &x).await;
        let moved = ft_balance(&rig, ft6.id(), &x).await - before;
        ft_lost_total += moved;
        ft_max_single = ft_max_single.max(moved);
        let over_cap = raw > ft_cap_raw;
        let out = f.out();
        match (&out, over_cap) {
            (Out::Refused { strikes: 1, burned: false, reason }, true) if reason == "over the 24 h limit" => {}
            (Out::Sent, false) => {}
            _ => counted_refusals_ok = false,
        }
        table.push(json!({
            "asset": "ft6 (6 decimals, cap 100)", "intended_tokens": "5", "believed_decimals": believed,
            "amount_sent_raw": raw.to_string(), "amount_sent_in_tokens": units_str(raw, FT_DECIMALS),
            "outcome": format!("{out:?}"), "moved_to_attacker_tokens": units_str(moved, FT_DECIMALS),
            "gas_burnt": f.gas_burnt,
        }));
    }
    c.check("ft6: every misread over the 100-token cap was refused with a strike and moved nothing, every one under it was sent", counted_refusals_ok);
    c.check("ft6: the attacker holds only the in-cap sends (5 + 0.005 + 50 tokens), no more", ft_lost_total == 5 * one_ft + 5_000 + 50 * one_ft);

    // The x10 misread (believed 7) repeated: the second one is the one the cap stops.
    let raw = 5 * 10u128.pow(7);
    let before = ft_balance(&rig, ft6.id(), &x).await;
    let again = one_case(&rig, Some(ft6.id()), raw, &x).await;
    let moved_again = ft_balance(&rig, ft6.id(), &x).await - before;
    let again_ok = matches!(again.out(), Out::Refused { strikes: 0, burned: false, ref reason } if reason == "over the 24 h limit") && moved_again == 0;
    c.check("ft6: repeating the 10x misread after 55.005 tokens went out is stopped by the cap, uncounted", again_ok);
    table.push(json!({
        "asset": "ft6 (6 decimals, cap 100)", "intended_tokens": "5", "believed_decimals": 7, "note": "repeat, 55.005 tokens already sent in this window",
        "amount_sent_raw": raw.to_string(), "outcome": format!("{:?}", again.out()), "moved_to_attacker_tokens": units_str(moved_again, FT_DECIMALS),
    }));
    let ft_total = ft_balance(&rig, ft6.id(), &x).await;
    c.check("ft6: the attacker's total never exceeds the token's cap", ft_total <= ft_cap_raw);

    // ---- NEAR: the agent means 0.5 NEAR ----------------------------------------------------------------------------
    let intended_near = NEAR / 2;
    let mut near_lost_total = 0u128;
    let mut near_max_single = 0u128;
    let mut near_ok = true;
    for believed in [24u32, 18, 25, 27, 30] {
        let raw = 5 * 10u128.pow(believed - 1);
        let before = rpc.balance(&x).await;
        let f = one_case(&rig, None, raw, &x).await;
        let moved = rpc.balance(&x).await - before;
        near_lost_total += moved;
        near_max_single = near_max_single.max(moved);
        let out = f.out();
        let expect_ok = match believed {
            24 => matches!(out, Out::Sent),
            18 => matches!(&out, Out::Refused { strikes: 0, burned: false, reason } if reason == "below the minimum send"),
            _ => matches!(&out, Out::Refused { strikes: 1, burned: false, reason } if reason == "over the 24 h limit"),
        };
        near_ok &= expect_ok;
        table.push(json!({
            "asset": "NEAR (24 decimals, cap 1)", "intended": near_str(intended_near), "believed_decimals": believed,
            "amount_sent_yocto": raw.to_string(), "amount_sent_near": near_str(raw),
            "outcome": format!("{out:?}"), "moved_to_attacker_near": near_str(moved), "gas_burnt": f.gas_burnt,
        }));
    }
    c.check("NEAR: the under-read is refused as dust without a strike, every over-read above 1 NEAR is refused with a strike", near_ok);
    c.check("NEAR: only the correctly scaled 0.5 NEAR reached the attacker", near_lost_total == intended_near);

    // ---- a token with no limit --------------------------------------------------------------------------------------
    let ft8_raw = 5 * 10u128.pow(8);
    let f8 = one_case(&rig, Some(ft8.id()), ft8_raw, &x).await;
    uncounted_ok &= matches!(f8.out(), Out::Refused { strikes: 0, burned: false, ref reason } if reason == "no 24 h limit is set for this token");
    let ft8_moved = ft_balance(&rig, ft8.id(), &x).await;
    c.check("a token with no limit set is refused without a strike and moves nothing", uncounted_ok && ft8_moved == 0);
    table.push(json!({ "asset": "ft8 (8 decimals, no limit set)", "intended_tokens": "5", "believed_decimals": 8, "amount_sent_raw": ft8_raw.to_string(), "outcome": format!("{:?}", f8.out()), "moved_to_attacker": ft8_moved.to_string() }));

    // ---- the caps are per token --------------------------------------------------------------------------------------
    let spent_near: u128 = rig.spent_24h().await;
    let spent_ft6: u128 = rpc.view(&rig.vid, "spent_24h", json!({ "token": ft6.id() })).await.as_str().unwrap().parse().unwrap();
    c.check("each token has its own window: NEAR shows only the 0.5 NEAR, ft6 only its own sends", spent_near == intended_near && spent_ft6 == ft_total);

    let ft6_pending: u128 = rig.view("pending_limit", json!({ "token": ft6.id() })).await.as_str().unwrap().parse().unwrap();
    let measured = rig.with_bound(json!({
        "node": node_version(rpc).await,
        "ft6_pending_limit_tokens": units_str(ft6_pending, FT_DECIMALS),
        "ft6_cap_plus_pending_tokens": units_str(ft_cap_raw + ft6_pending, FT_DECIMALS),
        "ft_fixture": "ft-mock, NEP-141 look-alike (no storage registration, open mint)",
        "ft6_cap_tokens": FT_CAP_TOKENS,
        "near_cap": "1",
        "cases": table,
        "max_loss_ft6_tokens": units_str(ft_total, FT_DECIMALS),
        "max_loss_ft6_vs_cap_tokens": FT_CAP_TOKENS,
        "max_loss_near": near_str(near_lost_total),
        "largest_single_misread_that_went_through_ft6_tokens": units_str(ft_max_single, FT_DECIMALS),
        "largest_single_misread_that_went_through_near": near_str(near_max_single),
    })).await;
    c.finish("attack_7", "decimal-misread send: refused or bounded per token", measured);
}
