//! The stretch items, part 2: the policy account and its proposals (the "policy-key split").
//! Every rule and the attack it prevents: docs/v3/STRETCH-DESIGN.md. What it does to the loss bound: docs/v3/LOSS-BOUND.md
//! section 9.
//!
//! Time in these tests (the test delay is 3 600 s): the vault is set up at 1 000 s and the policy account named at 1 100 s;
//! a proposal made at 2 000 s can be applied from 5 600 s and lapses at 92 000 s (24 h after that).

use super::sweep::{armed, safe, watcher};
use super::*;

pub(super) fn policy() -> AccountId {
    accounts(3)
}

const PROPOSED: u64 = 2_000 * SEC;
const RUNS: u64 = 5_600 * SEC;
const LAPSES: u64 = 92_000 * SEC;

fn with_policy() -> Mamori {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.set_policy_account(Some(policy()));
    m
}

fn as_policy(now: u64) {
    as_account(&policy(), now);
}

fn ids(m: &Mamori) -> Vec<u64> {
    m.proposals().iter().map(|p| p.id.0).collect()
}

fn apply(m: &mut Mamori, id: u64) -> PromiseOrValue<()> {
    m.apply(U64(id))
}

/// `apply` and let its promise (if any) be built, which is when its receipts are created.
fn run(m: &mut Mamori, id: u64) {
    drop(apply(m, id));
}

fn refusal_of_apply(m: &mut Mamori, id: u64) -> String {
    panics_with(|| drop(m.apply(U64(id))))
}

/// The four ways of proposing, each as a closure, with the name it is known by.
type Propose = (&'static str, fn(&mut Mamori) -> U64);

fn proposals_of_each_kind() -> Vec<Propose> {
    vec![
        ("propose_add_daily_key", |m| m.propose_add_daily_key(key(2), None)),
        ("propose_set_token_limit", |m| m.propose_set_token_limit(accounts(4), U128(1_000))),
        ("propose_set_pending_limit", |m| m.propose_set_pending_limit(None, U128(20 * NEAR))),
        ("propose_allow_recipient", |m| m.propose_allow_recipient(accounts(2))),
    ]
}

#[test]
fn only_the_policy_account_can_propose_and_with_none_named_nobody_can() {
    for (name, propose) in proposals_of_each_kind() {
        // The unit VM keeps its storage across vaults set up in one thread: one fresh chain per kind.
        super::admin_surface::on_a_fresh_chain(move || {
            let mut m = setup();
            as_account(&policy(), PROPOSED);
            let msg = panics_with(|| {
                propose(&mut m);
            });
            assert!(msg.contains("no policy account is set"), "{name}: none named yet: {msg}");
            as_admin(1_100 * SEC);
            m.set_policy_account(Some(policy()));
            for (who, what) in [(accounts(4), "a stranger"), (vault(), "the vault itself, which is the admin"), (watcher(), "a watcher"), (safe(), "the safe account")] {
                as_account(&who, PROPOSED);
                let msg = panics_with(|| {
                    propose(&mut m);
                });
                assert!(msg.contains("policy account only"), "{name} by {what}: {msg}");
            }
            assert!(m.proposals().is_empty(), "{name}: nothing was recorded");
            as_policy(PROPOSED);
            assert_eq!(propose(&mut m), U64(0), "{name}: the policy account can");
            assert_eq!(m.proposals().len(), 1);
        });
    }
}

#[test]
fn a_proposal_changes_nothing_until_the_delay_has_passed_and_then_anyone_can_apply_it() {
    let mut m = with_policy();
    let token = accounts(4);
    as_policy(PROPOSED);
    assert_eq!(m.propose_set_pending_limit(None, U128(20 * NEAR)), U64(0));
    assert_eq!(m.propose_set_token_limit(token.clone(), U128(1_000)), U64(1));
    let waiting = m.proposals();
    assert_eq!(waiting.len(), 2);
    assert_eq!(
        (waiting[0].proposal.proposed_at, waiting[0].proposal.executable_at, waiting[0].proposal.expires_at),
        (U64(PROPOSED), U64(RUNS), U64(LAPSES)),
        "executable one withdrawal delay after it was proposed; it lapses 24 h after that"
    );
    assert_eq!(
        event("propose").unwrap()["data"],
        serde_json::json!({
            "id": "0",
            "change": { "kind": "set_pending_limit", "token": null, "limit": (20 * NEAR).to_string() },
            "executable_at": RUNS.to_string(),
            "expires_at": LAPSES.to_string(),
        })
    );
    // Nothing is in force while it waits: the old pending limit, and a token that still has no limit.
    as_daily(&key(1), 3_000 * SEC);
    assert_eq!(m.pending_limit(None), U128(10 * NEAR));
    assert_eq!(refused(m.send_small(Some(token.clone()), U128(5), accounts(2))).refused.as_deref(), Some("no 24 h limit is set for this token"));
    // The last instant before the delay: still locked, by anyone.
    as_anyone(RUNS - 1);
    assert!(refusal_of_apply(&mut m, 0).contains("still locked"));
    assert!(refusal_of_apply(&mut m, 1).contains("still locked"));
    assert_eq!(m.pending_limit(None), U128(10 * NEAR));
    // From the delay on a stranger can run both.
    as_anyone(RUNS);
    assert!(matches!(apply(&mut m, 0), PromiseOrValue::Value(())));
    assert!(matches!(apply(&mut m, 1), PromiseOrValue::Value(())));
    assert!(m.proposals().is_empty());
    assert_eq!(m.pending_limit(None), U128(20 * NEAR));
    assert_eq!(m.token_limit(Some(token.clone())), U128(1_000));
    as_daily(&key(1), RUNS + SEC);
    assert_sent(m.send_small(Some(token), U128(5), accounts(2)));
    // The same proposal cannot be run twice.
    assert!(refusal_of_apply(&mut m, 0).contains("no such proposal"));
}

#[test]
fn a_proposal_lapses_a_day_after_it_can_first_run() {
    let mut m = with_policy();
    as_policy(PROPOSED);
    m.propose_allow_recipient(accounts(2));
    m.propose_allow_recipient(accounts(5));
    as_anyone(LAPSES - 1);
    run(&mut m, 0);
    assert_eq!(m.allowlist().accounts, vec![accounts(2)]);
    as_anyone(LAPSES);
    assert!(refusal_of_apply(&mut m, 1).contains("expired"));
    assert_eq!(m.allowlist().accounts, vec![accounts(2)], "a lapsed proposal does nothing");
    assert_eq!(ids(&m), vec![1], "and is left in the table until the next proposal clears it");
}

#[test]
fn applying_a_proposal_does_what_the_admins_own_call_does() {
    // add_daily_key, with and without an allowance
    let mut m = with_policy();
    as_policy(PROPOSED);
    m.propose_add_daily_key(key(2), Some(U128(NEAR / 10)));
    m.propose_add_daily_key(key(3), None);
    as_anyone(RUNS);
    drop(apply(&mut m, 0));
    let r = receipts_text();
    assert!(r.contains("AddKeyWithFunctionCall") && r.contains(r#"method_names: ["send_small", "request_withdraw"]"#) && r.contains(&format!("allowance: Some(NearToken {{ inner: {} }})", NEAR / 10)), "{r}");
    assert_eq!(m.daily_keys(), vec![key(1), key(2)]);
    assert_eq!(names_of_events(), ["add_daily_key", "proposal_applied"]);
    drop(apply(&mut m, 1));
    assert!(receipts_text().contains(&format!("allowance: Some(NearToken {{ inner: {} }})", NEAR / 4)), "the default allowance when none is proposed: {}", receipts_text());
    assert_eq!(m.daily_keys(), vec![key(1), key(2), key(3)]);
    // set_pending_limit, with a token
    let mut m = with_policy();
    as_policy(PROPOSED);
    m.propose_set_pending_limit(Some(accounts(4)), U128(77));
    as_anyone(RUNS);
    run(&mut m, 0);
    assert_eq!(m.pending_limit(Some(accounts(4))), U128(77));
    assert_eq!(names_of_events(), ["set_pending_limit", "proposal_applied"]);
    // allow_recipient
    let mut m = with_policy();
    as_policy(PROPOSED);
    m.propose_allow_recipient(accounts(2));
    as_anyone(RUNS);
    run(&mut m, 0);
    assert_eq!(m.allowlist().accounts, vec![accounts(2)]);
    assert_eq!(names_of_events(), ["allow_recipient", "proposal_applied"]);
}

fn names_of_events() -> Vec<String> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap()["event"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn apply_refuses_what_the_admins_own_call_would_refuse_and_the_proposal_waits_for_the_next_try() {
    let mut m = with_policy();
    // A key the vault stopped serving and the account has not confirmed deleting.
    as_admin(1_200 * SEC);
    let _ = m.remove_daily_key(key(1));
    as_policy(PROPOSED);
    m.propose_add_daily_key(key(1), None);
    as_anyone(RUNS);
    assert!(refusal_of_apply(&mut m, 0).contains("revoked key: its deletion is not confirmed yet"));
    assert_eq!(ids(&m), vec![0], "the refusal rolled the whole call back, the proposal is still there");
    assert!(m.daily_keys().is_empty());
    as_admin(RUNS + SEC);
    m.forget_revoked_key(key(1));
    as_anyone(RUNS + 2 * SEC);
    drop(apply(&mut m, 0));
    assert_eq!(m.daily_keys(), vec![key(1)]);
    // At kaigen no classical key can be added, by anyone.
    let mut m = with_policy();
    as_policy(PROPOSED);
    m.propose_add_daily_key(key(2), None);
    m.era = Era::Kaigen;
    as_anyone(RUNS);
    assert!(refusal_of_apply(&mut m, 0).contains("lockdown: classical keys can no longer be added"));
    assert_eq!(m.daily_keys(), vec![key(1)]);
    assert!(refusal_of_apply(&mut m, 9).contains("no such proposal"));
}

#[test]
fn the_admin_can_cancel_a_proposal_before_or_after_its_delay_and_a_cancelled_one_never_runs() {
    let mut m = with_policy();
    as_policy(PROPOSED);
    m.propose_allow_recipient(accounts(2));
    m.propose_allow_recipient(accounts(5));
    as_admin(PROPOSED + SEC);
    m.cancel_proposal(U64(0));
    assert_eq!(event("proposal_cancelled").unwrap()["data"], serde_json::json!({ "id": "0", "change": { "kind": "allow_recipient", "account": accounts(2) } }));
    as_admin(RUNS + SEC); // past the delay, before anyone applied
    m.cancel_proposal(U64(1));
    assert!(m.proposals().is_empty());
    as_anyone(RUNS + 2 * SEC);
    assert!(refusal_of_apply(&mut m, 0).contains("no such proposal"));
    assert!(refusal_of_apply(&mut m, 1).contains("no such proposal"));
    assert!(m.allowlist().accounts.is_empty());
    as_admin(RUNS + 3 * SEC);
    assert!(panics_with(|| m.cancel_proposal(U64(1))).contains("no such proposal"));
}

#[test]
fn replacing_the_policy_account_takes_back_everything_it_asked_for_in_the_same_call() {
    let mut m = with_policy();
    as_policy(PROPOSED);
    m.propose_allow_recipient(accounts(2));
    m.propose_set_pending_limit(None, U128(1));
    m.propose_add_daily_key(key(2), None);
    as_admin(PROPOSED + SEC);
    m.set_policy_account(Some(accounts(1)));
    assert!(m.proposals().is_empty());
    assert_eq!(m.policy_account(), Some(accounts(1)));
    let data = event("set_policy_account").unwrap()["data"].clone();
    assert_eq!(data["account"], accounts(1).to_string());
    assert_eq!(data["dropped"], 3);
    assert_eq!(data["proposals"].as_array().unwrap().len(), 3);
    assert_eq!(data["proposals"][0], serde_json::json!({ "id": "0", "change": { "kind": "allow_recipient", "account": accounts(2) }, "executable_at": RUNS.to_string() }));
    as_anyone(RUNS);
    assert!(refusal_of_apply(&mut m, 0).contains("no such proposal"), "what the old account asked for cannot run");
    as_policy(RUNS);
    let msg = panics_with(|| {
        m.propose_allow_recipient(accounts(2));
    });
    assert!(msg.contains("policy account only"), "the old account is out: {msg}");
    as_account(&accounts(1), RUNS);
    assert_eq!(m.propose_allow_recipient(accounts(2)), U64(3), "ids keep counting");
    // None switches the path off, and takes back what the new one asked for.
    as_admin(RUNS + SEC);
    m.set_policy_account(None);
    assert!(m.proposals().is_empty() && m.policy_account().is_none());
    assert_eq!(event("set_policy_account").unwrap()["data"]["dropped"], 1);
    as_account(&accounts(1), RUNS + 2 * SEC);
    let msg = panics_with(|| {
        m.propose_allow_recipient(accounts(2));
    });
    assert!(msg.contains("no policy account is set"), "{msg}");
}

#[test]
fn the_policy_account_cannot_be_the_vault_itself() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    assert!(panics_with(|| m.set_policy_account(Some(vault()))).contains("the policy account cannot be the vault itself"));
    assert!(m.policy_account().is_none());
}

#[test]
fn the_proposal_table_holds_eight_and_the_next_proposal_clears_the_lapsed_ones() {
    let mut m = with_policy();
    as_policy(PROPOSED);
    for n in 0..8 {
        assert_eq!(m.propose_set_pending_limit(None, U128(n)), U64(u64::from(n as u32)));
    }
    let msg = panics_with(|| {
        m.propose_set_pending_limit(None, U128(99));
    });
    assert!(msg.contains("too many proposals waiting"), "{msg}");
    assert_eq!(m.proposals().len(), 8);
    // Once they have lapsed they are in the way of nothing: the next proposal clears them first, and says so.
    as_policy(LAPSES);
    assert_eq!(m.propose_set_pending_limit(None, U128(99)), U64(8));
    assert_eq!(ids(&m), vec![8]);
    let expired = event("proposal_expired").unwrap()["data"].clone();
    assert_eq!(expired["count"], 8);
    assert_eq!(expired["proposals"].as_array().unwrap().len(), 8);
    assert_eq!(names_of_events(), ["proposal_expired", "propose"]);
}

#[test]
fn a_zero_allowance_cannot_be_proposed_and_a_proposal_that_cannot_be_recorded_leaves_no_trace() {
    let mut m = with_policy();
    as_policy(PROPOSED);
    let msg = panics_with(|| {
        m.propose_add_daily_key(key(2), Some(U128(0)));
    });
    assert!(msg.contains("allowance must be > 0"), "{msg}");
    assert!(m.proposals().is_empty());
    m.propose_add_daily_key(key(2), Some(U128(1)));
    assert_eq!(ids(&m), vec![0], "the refused call did not use up an id");
}

#[test]
fn a_proposed_key_may_carry_at_most_the_default_gas_allowance_which_is_where_the_policy_path_is_narrower_than_the_admin() {
    let mut m = with_policy();
    let default = DEFAULT_ALLOWANCE.as_yoctonear();
    as_policy(PROPOSED);
    m.propose_add_daily_key(key(2), Some(U128(default)));
    let msg = panics_with(|| {
        m.propose_add_daily_key(key(3), Some(U128(default + 1)));
    });
    assert!(msg.contains("an allowance above the default is the admin's to give"), "{msg}");
    assert_eq!(ids(&m), vec![0], "the refused one recorded nothing");
    // The admin can give more, through the same private function.
    as_admin(PROPOSED + SEC);
    drop(m.add_daily_key(key(3), Some(U128(default + 1))));
    assert_eq!(m.daily_keys(), vec![key(1), key(3)]);
}

#[test]
fn the_delay_of_a_proposal_is_the_withdrawal_delay_of_this_vault_whatever_it_is() {
    for delay in [3_600u64, 7_200, 86_400, 90_000] {
        on_a_fresh_chain_with(delay);
    }
}

fn on_a_fresh_chain_with(delay: u64) {
    super::admin_surface::on_a_fresh_chain(move || {
        let mut m = with_policy();
        m.delay_secs = delay;
        as_policy(PROPOSED);
        m.propose_allow_recipient(accounts(2));
        let p = &m.proposals()[0].proposal;
        assert_eq!(p.executable_at, U64(PROPOSED + delay * SEC), "delay {delay}");
        assert_eq!(p.expires_at, U64(PROPOSED + delay * SEC + 86_400 * SEC), "delay {delay}");
    });
}

#[test]
fn each_change_has_a_stable_wire_shape() {
    let mut m = with_policy();
    as_policy(PROPOSED);
    for (_, propose) in proposals_of_each_kind() {
        propose(&mut m);
    }
    let shapes: Vec<serde_json::Value> = m.proposals().iter().map(|p| serde_json::to_value(&p.proposal.change).unwrap()).collect();
    assert_eq!(
        shapes,
        vec![
            serde_json::json!({ "kind": "add_daily_key", "public_key": key(2), "allowance": null }),
            serde_json::json!({ "kind": "set_token_limit", "token": accounts(4), "limit": "1000" }),
            serde_json::json!({ "kind": "set_pending_limit", "token": null, "limit": (20 * NEAR).to_string() }),
            serde_json::json!({ "kind": "allow_recipient", "account": accounts(2) }),
        ]
    );
    let one = serde_json::to_value(&m.proposals()[0]).unwrap();
    assert_eq!(
        super::attest_check::field_names(&one),
        ["change", "executable_at", "expires_at", "id", "proposed_at"],
        "a proposal as the view and attest() show it: the change is flattened next to its times"
    );
}

#[test]
fn attest_and_the_views_report_the_same_stretch_settings() {
    let mut m = armed();
    as_admin(6_000 * SEC);
    m.set_policy_account(Some(policy()));
    m.set_emergency(3_600);
    m.set_safe_account(accounts(1));
    as_policy(6_100 * SEC);
    m.propose_allow_recipient(accounts(2));
    as_anyone(6_200 * SEC);
    let a = m.attest();
    assert_eq!(a.policy_account, Some(policy()));
    assert_eq!(a.watchers, vec![watcher()]);
    assert_eq!(a.emergency_until, U64(6_000 * SEC + 3_600 * SEC));
    assert_eq!(a.safe_account, SafeAccountView { current: Some(safe()), pending: Some(PendingSafe { account: accounts(1), effective_at: U64(9_600 * SEC) }) });
    assert_eq!(ids_of(&a.proposals), vec![0]);
    let v = serde_json::to_value(&a).unwrap();
    assert_eq!(v["policy_account"], serde_json::to_value(m.policy_account()).unwrap());
    assert_eq!(v["safe_account"], serde_json::to_value(m.safe_account()).unwrap());
    assert_eq!(v["watchers"], serde_json::to_value(m.watchers()).unwrap());
    assert_eq!(v["emergency_until"], serde_json::to_value(m.emergency_until()).unwrap());
    assert_eq!(v["proposals"], serde_json::to_value(m.proposals()).unwrap());
    assert_eq!(v["safe_account"]["pending"]["account"], accounts(1).to_string());
    // Once the safe account's delay has passed the waiting one is the current one, and nothing is waiting.
    as_anyone(9_600 * SEC);
    assert_eq!(m.attest().safe_account, SafeAccountView { current: Some(accounts(1)), pending: None });
}

fn ids_of(v: &[ProposalView]) -> Vec<u64> {
    v.iter().map(|p| p.id.0).collect()
}
