//! Attack 9 (ARCHITECTURE.md section 7): cross-key grief. Claim: key A uses the cap up, honest key B is not burned.
//! The cap is account-wide, so B's legitimate send is refused. In v2 that refusal counted and B burned after three tries;
//! in v3 it is uncounted. Measured: how many refusals B takes without a strike, that B is still on the account, what B
//! can still do, that removing A does not free the cap, and (control) that the counter still works on B for a refusal
//! that counts. How long B stays blocked is in `timed.rs` (it needs the chain clock moved a day).

use serde_json::json;

use crate::common::*;
use crate::support::*;

#[tokio::test]
async fn attack_9_a_key_that_uses_the_cap_up_does_not_burn_the_honest_key() {
    let rig = Rig::new(true).await; // allowlist enforced, f.payee listed: B's send is a legitimate one
    let rpc = rig.rpc();
    let vid = rig.vid.clone();
    let payee = rig.f.payee.id().clone();
    let a = rig.add_daily(None).await;
    let b = rig.add_daily(None).await;
    let mut c = Checks::new();

    // A spends the whole cap on the listed payee. In-cap, allowed.
    let spend = rig.send_small(&a, &payee, CAP).await;
    let a_spend_ts = spend.call_receipt(&vid).ts;
    c.check("A's send of the whole cap goes through", spend.out() == Out::Sent && rig.spent_24h().await == CAP);

    // B asks `check` first, then tries its legitimate send, ten times (a third is enough to burn under the v2 rule).
    let chk = rig.check(&b.pk, None, SEND, &payee).await;
    c.check("`check` for B: refuse, cap_exhausted, not counted, would not burn, headroom 0", chk["verdict"] == "refuse" && chk["reason"] == "cap_exhausted" && chk["counted"] == false && chk["would_burn"] == false && chk["headroom"] == "0");
    let tries = 10u64;
    let mut gas_each = 0;
    let mut all_uncounted = true;
    let mut last_ts = 0;
    for _ in 0..tries {
        let f = rig.send_small(&b, &payee, SEND).await;
        gas_each = f.gas_burnt;
        last_ts = f.call_receipt(&vid).ts;
        all_uncounted &= matches!(f.out(), Out::Refused { ref reason, strikes: 0, burned: false } if reason == "over the 24 h limit");
    }
    c.check("all ten refusals of B are uncounted: strikes 0, never burned", all_uncounted && rig.strikes(&b.pk).await == 0);
    c.check("B is still a recorded daily key and still on the account", rig.on_account(&b.pk).await && rig.view("daily_keys", json!({})).await.as_array().unwrap().iter().any(|k| k == &json!(b.pk)));

    // What B can do meanwhile: the delayed path is open to it.
    let alt = rig.request(&b, None, SEND, &payee).await;
    c.check("B can still use request_withdraw (the queue) while the cap is used up", !alt.failed());

    // The grief outlives A: the admin removes A, the spend stays in the window, B stays blocked.
    let removal = rig.admin_tx("remove_daily_key", json!({ "public_key": a.pk })).await;
    c.check("the admin removed A and A's key left the account", !removal.failed() && !rig.on_account(&a.pk).await);
    let after = rig.send_small(&b, &payee, SEND).await;
    c.check("with A gone B is still refused: the cap spent by A stays in the window, uncounted", matches!(after.out(), Out::Refused { ref reason, strikes: 0, burned: false } if reason == "over the 24 h limit") && rig.spent_24h().await == CAP);

    // Control, so the zero strikes above are not a counter that cannot count: a refusal that DOES count still burns B.
    let x = rig.f.attacker.id().clone();
    let mut counted = Vec::new();
    for _ in 0..3 {
        counted.push(rig.send_small(&b, &x, SEND).await.out());
    }
    c.check("control: three refusals that do count (unlisted payee) burn the same key B at strike 3", matches!(counted.last(), Some(Out::Refused { strikes: 3, burned: true, .. })));

    let measured = rig.with_bound(json!({
        "node": node_version(rpc).await,
        "cap_used_up_by_A_yocto": CAP.to_string(),
        "refusals_of_B_without_a_strike": tries + 1,
        "v2_rule_would_have_burned_B_at_refusal": 3,
        "strikes_of_B_after": 0,
        "check_for_B": chk,
        "gas_burnt_per_refused_send_of_B": gas_each,
        "B_blocked_chain_ms_from_A_spend_to_last_refusal_in_this_run": ms_between(a_spend_ts, last_ts),
        "B_request_withdraw_during_the_grief": "accepted",
        "B_refused_after_A_removed": true,
        "control_counted_refusals_to_burn": 3,
    })).await;
    c.finish("attack_9", "key A uses the cap up, honest key B is not burned", measured);
}
