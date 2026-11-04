//! The stretch items, part 1: `sweep_to_safe`, the safe account, the watchers and the emergency window.
//! Every rule and the attack it prevents: docs/v3/STRETCH-DESIGN.md. What it does to the loss bound: docs/v3/LOSS-BOUND.md
//! section 9 (the property test is in loss_bound.rs).
//!
//! Time in these tests (the test delay is 3 600 s): the vault is set up at 1 000 s, the safe account is named at 1 100 s and
//! takes effect at 4 700 s, request 0 is made at 5 000 s, unlocks at 8 600 s and expires at 95 000 s (24 h after it unlocks).

use super::admin_surface::{as_ml_dsa_admin, on_a_fresh_chain};
use super::*;

pub(super) fn safe() -> AccountId {
    accounts(5)
}

pub(super) fn watcher() -> AccountId {
    "watcher.near".parse().unwrap()
}

pub(super) fn payee() -> AccountId {
    accounts(2)
}

const ASKED: u64 = 5_000 * SEC;
const UNLOCKS: u64 = 8_600 * SEC;
const EXPIRES: u64 = 95_000 * SEC;

/// A vault with one request waiting (id 0: 5 NEAR to `payee()` from key 1), the safe account in force and one watcher.
/// No emergency window is open.
pub(super) fn armed() -> Mamori {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.set_safe_account(safe());
    m.add_watcher(watcher());
    as_daily(&key(1), ASKED);
    m.request_withdraw(None, U128(5 * NEAR), payee());
    m
}

/// The receipts of the last call as (receiver, actions as text).
fn sent() -> Vec<(AccountId, String)> {
    get_created_receipts().into_iter().map(|r| (r.receiver_id.clone(), readable(&format!("{:?}", r.actions)))).collect()
}

/// Who the value of the last call went to: the receivers of its transfers and `ft_transfer` calls, callbacks left out.
fn paid() -> Vec<AccountId> {
    sent().into_iter().filter(|(_, a)| a.contains("Transfer") || a.contains("ft_transfer")).map(|(to, _)| to).collect()
}

fn sweep(m: &mut Mamori, id: u64) {
    drop(m.sweep_to_safe(U64(id)));
}

fn refusal_of_sweep(m: &mut Mamori, id: u64) -> String {
    panics_with(|| drop(m.sweep_to_safe(U64(id))))
}

#[test]
fn a_sweep_sends_the_request_to_the_safe_account_and_to_no_one_else() {
    let mut m = armed();
    as_admin(6_000 * SEC); // long before it unlocks: a sweep does not wait for the delay
    sweep(&mut m, 0);
    assert!(m.queue().is_empty(), "the request left the queue");
    let r = sent();
    assert_eq!(paid(), vec![safe()], "{r:?}");
    assert!(r.iter().any(|(to, a)| to == &safe() && a.contains(&(5 * NEAR).to_string())), "the whole amount, once: {r:?}");
    assert!(r.iter().all(|(to, _)| to != &payee()), "the payee the request named gets nothing: {r:?}");
    assert_eq!(
        event("sweep_to_safe").unwrap()["data"],
        serde_json::json!({ "id": "0", "by": vault(), "safe": safe(), "token": null, "amount": (5 * NEAR).to_string(), "was_to": payee() })
    );
}

#[test]
fn a_sweep_of_a_token_request_is_an_ft_transfer_to_the_safe_account_for_that_token_and_amount() {
    let mut m = setup();
    let token = accounts(4);
    as_admin(1_100 * SEC);
    m.set_safe_account(safe());
    m.set_token_limit(token.clone(), U128(1_000));
    as_daily(&key(1), ASKED);
    m.request_withdraw(Some(token.clone()), U128(500), payee());
    as_admin(6_000 * SEC);
    sweep(&mut m, 0);
    let r = sent();
    assert_eq!(paid(), vec![token.clone()], "one call, to the token contract: {r:?}");
    let (_, call) = r.iter().find(|(to, _)| to == &token).unwrap();
    assert!(call.contains("ft_transfer") && call.contains(r#""receiver_id":"fargo","amount":"500""#), "{call}");
    assert!(!call.contains("charlie"), "the payee of the request is not in the call: {call}");
    assert_eq!(event("sweep_to_safe").unwrap()["data"]["token"], token.to_string());
}

#[test]
fn only_the_admin_and_a_watcher_inside_a_window_can_sweep() {
    let mut m = armed();
    as_admin(5_100 * SEC);
    m.set_policy_account(Some(accounts(3)));
    for (who, name) in [(accounts(4), "a stranger"), (accounts(3), "the policy account"), (safe(), "the safe account"), (payee(), "the payee")] {
        as_account(&who, 6_000 * SEC);
        let msg = refusal_of_sweep(&mut m, 0);
        assert!(msg.contains("admin or watcher only"), "{name}: {msg}");
    }
    // A watcher with no window open.
    as_account(&watcher(), 6_000 * SEC);
    assert!(refusal_of_sweep(&mut m, 0).contains("no emergency: watchers can sweep only in a declared window"));
    assert_eq!(m.queue().len(), 1, "nothing moved");
    // The same watcher inside one.
    as_admin(6_100 * SEC);
    m.set_emergency(3_600);
    as_account(&watcher(), 6_200 * SEC);
    sweep(&mut m, 0);
    assert!(m.queue().is_empty());
    assert_eq!(event("sweep_to_safe").unwrap()["data"]["by"], watcher().to_string());
    assert_eq!(paid(), vec![safe()]);
}

#[test]
fn the_admin_needs_neither_a_window_nor_to_be_a_watcher() {
    let mut m = armed();
    assert!(m.watchers() == vec![watcher()] && m.emergency_until() == U64(0));
    as_admin(6_000 * SEC);
    sweep(&mut m, 0);
    assert!(m.queue().is_empty());
}

#[test]
fn the_ml_dsa_admin_can_sweep_because_no_key_is_read() {
    let mut m = armed();
    as_ml_dsa_admin(6_000 * SEC);
    assert_eq!(env::signer_account_pk().curve_type(), CurveType::MLDSA65, "the context really is signed by an ML-DSA key");
    sweep(&mut m, 0);
    assert!(m.queue().is_empty());
    assert_eq!(paid(), vec![safe()]);
}

#[test]
fn the_window_is_open_strictly_before_its_end_and_a_new_call_replaces_it() {
    let mut m = armed();
    as_daily(&key(1), ASKED + SEC);
    m.request_withdraw(None, U128(NEAR), payee());
    as_admin(6_000 * SEC);
    m.set_emergency(3_600); // open until 9 600 s
    assert_eq!(m.emergency_until(), U64(9_600 * SEC));
    as_account(&watcher(), 9_600 * SEC - 1);
    sweep(&mut m, 0);
    as_account(&watcher(), 9_600 * SEC);
    assert!(refusal_of_sweep(&mut m, 1).contains("no emergency"), "at the end instant the window is closed");
    // A shorter window replaces the longer one, and zero closes it.
    as_admin(9_000 * SEC);
    m.set_emergency(60);
    assert_eq!(m.emergency_until(), U64(9_060 * SEC));
    as_account(&watcher(), 9_100 * SEC);
    assert!(refusal_of_sweep(&mut m, 1).contains("no emergency"));
    as_admin(9_200 * SEC);
    m.set_emergency(3_600);
    as_admin(9_201 * SEC);
    m.set_emergency(0);
    assert_eq!(m.emergency_until(), U64(0));
    as_account(&watcher(), 9_202 * SEC);
    assert!(refusal_of_sweep(&mut m, 1).contains("no emergency"));
    assert_eq!(m.queue().len(), 1, "the second request is still there");
}

#[test]
fn an_emergency_window_lasts_at_most_seven_days() {
    let mut m = setup();
    as_admin(6_000 * SEC);
    m.set_emergency(7 * 86_400);
    assert_eq!(m.emergency_until(), U64(6_000 * SEC + 7 * 86_400 * SEC));
    assert_eq!(event("set_emergency").unwrap()["data"], serde_json::json!({ "secs": 7 * 86_400, "until": (6_000 * SEC + 7 * 86_400 * SEC).to_string() }));
    let msg = panics_with(|| m.set_emergency(7 * 86_400 + 1));
    assert!(msg.contains("an emergency window lasts at most 7 days"), "{msg}");
    assert_eq!(m.emergency_until(), U64(6_000 * SEC + 7 * 86_400 * SEC), "a refused call changed nothing");
}

#[test]
fn nothing_is_swept_while_no_safe_account_is_in_force() {
    let mut m = setup();
    as_daily(&key(1), ASKED);
    m.request_withdraw(None, U128(5 * NEAR), payee());
    as_admin(6_000 * SEC);
    assert!(refusal_of_sweep(&mut m, 0).contains("no safe account is in force"), "none was ever named");
    // Named but not yet in force: the first one waits the delay too.
    m.set_safe_account(safe());
    assert!(refusal_of_sweep(&mut m, 0).contains("no safe account is in force"));
    as_admin(6_000 * SEC + 3_600 * SEC - 1);
    assert!(refusal_of_sweep(&mut m, 0).contains("no safe account is in force"), "one nanosecond early");
    assert_eq!(m.queue().len(), 1);
    as_admin(6_000 * SEC + 3_600 * SEC);
    sweep(&mut m, 0);
    assert_eq!(paid(), vec![safe()]);
}

#[test]
fn a_safe_account_change_takes_over_exactly_when_the_withdrawal_delay_has_passed() {
    let mut m = armed();
    as_daily(&key(1), ASKED + SEC);
    m.request_withdraw(None, U128(NEAR), payee());
    let new: AccountId = accounts(1);
    as_admin(10_000 * SEC);
    m.set_safe_account(new.clone());
    let waiting = PendingSafe { account: new.clone(), effective_at: U64(13_600 * SEC) };
    assert_eq!(m.safe_account(), SafeAccountView { current: Some(safe()), pending: Some(waiting.clone()) });
    assert_eq!(event("set_safe_account").unwrap()["data"], serde_json::json!({ "account": new, "effective_at": (13_600 * SEC).to_string() }));
    as_admin(13_600 * SEC - 1);
    assert_eq!(m.safe_account().current, Some(safe()), "the old one serves until the last instant of the delay");
    sweep(&mut m, 0);
    assert_eq!(paid(), vec![safe()]);
    as_admin(13_600 * SEC);
    assert_eq!(m.safe_account(), SafeAccountView { current: Some(new.clone()), pending: None });
    sweep(&mut m, 1);
    assert_eq!(paid(), vec![new]);
}

#[test]
fn the_safe_account_delay_is_the_withdrawal_delay_whatever_it_is() {
    let mut m = setup();
    m.delay_secs = 7_200;
    as_admin(1_100 * SEC);
    m.set_safe_account(safe());
    assert_eq!(m.safe_account().pending.unwrap().effective_at, U64(1_100 * SEC + 7_200 * SEC));
}

#[test]
fn a_waiting_safe_account_can_be_cancelled_until_it_takes_effect_and_not_after() {
    let mut m = armed();
    as_admin(10_000 * SEC);
    assert!(panics_with(|| m.cancel_safe_account_change()).contains("no safe account change is waiting"));
    m.set_safe_account(accounts(1));
    as_admin(13_600 * SEC - 1);
    m.cancel_safe_account_change();
    assert_eq!(m.safe_account(), SafeAccountView { current: Some(safe()), pending: None });
    assert_eq!(event("safe_account_change_cancelled").unwrap()["data"], serde_json::json!({ "account": accounts(1) }));
    // One that has taken effect is in force: it cannot be cancelled, only replaced (with another delay).
    as_admin(20_000 * SEC);
    m.set_safe_account(accounts(1));
    as_admin(23_600 * SEC);
    assert!(panics_with(|| m.cancel_safe_account_change()).contains("no safe account change is waiting"));
    assert_eq!(m.safe_account().current, Some(accounts(1)));
}

#[test]
fn naming_a_second_safe_account_replaces_the_waiting_one_and_restarts_the_delay() {
    let mut m = armed();
    as_admin(10_000 * SEC);
    m.set_safe_account(accounts(1));
    as_admin(11_000 * SEC);
    m.set_safe_account(accounts(3));
    assert_eq!(m.safe_account().pending, Some(PendingSafe { account: accounts(3), effective_at: U64(14_600 * SEC) }));
    as_admin(13_700 * SEC); // the first one's end: it was thrown away
    assert_eq!(m.safe_account().current, Some(safe()));
    as_admin(14_600 * SEC);
    assert_eq!(m.safe_account().current, Some(accounts(3)));
}

#[test]
fn a_change_that_has_taken_effect_is_kept_when_the_next_one_is_named() {
    let mut m = armed();
    as_admin(10_000 * SEC);
    m.set_safe_account(accounts(1)); // in force from 13 600 s
    as_admin(20_000 * SEC);
    m.set_safe_account(accounts(3)); // waiting until 23 600 s
    assert_eq!(m.safe_account(), SafeAccountView { current: Some(accounts(1)), pending: Some(PendingSafe { account: accounts(3), effective_at: U64(23_600 * SEC) }) });
    sweep(&mut m, 0);
    assert_eq!(paid(), vec![accounts(1)], "the one that took effect serves, not the first one and not the one still waiting");
}

#[test]
fn neither_the_safe_account_nor_a_watcher_can_be_the_vault_itself() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    assert!(panics_with(|| m.set_safe_account(vault())).contains("the safe account cannot be the vault itself"));
    assert!(panics_with(|| m.add_watcher(vault())).contains("a watcher cannot be the vault itself"));
    assert_eq!(m.safe_account(), SafeAccountView { current: None, pending: None });
    assert!(m.watchers().is_empty());
}

#[test]
fn watchers_are_a_short_list_with_no_duplicates_and_a_removed_one_loses_the_power() {
    let mut m = armed(); // watcher() is the first
    as_admin(5_100 * SEC);
    m.set_emergency(3_600);
    assert!(panics_with(|| m.add_watcher(watcher())).contains("already a watcher"));
    for n in 1..=3 {
        m.add_watcher(accounts(n));
    }
    assert_eq!(m.watchers().len(), 4);
    assert!(panics_with(|| m.add_watcher(accounts(4))).contains("too many watchers"));
    assert!(panics_with(|| m.remove_watcher(accounts(4))).contains("not a watcher"));
    m.remove_watcher(watcher());
    assert_eq!(event("remove_watcher").unwrap()["data"], serde_json::json!({ "account": watcher() }));
    as_account(&watcher(), 5_200 * SEC);
    assert!(refusal_of_sweep(&mut m, 0).contains("admin or watcher only"));
    as_account(&accounts(2), 5_200 * SEC);
    sweep(&mut m, 0);
    assert_eq!(event("sweep_to_safe").unwrap()["data"]["by"], accounts(2).to_string());
}

#[test]
fn a_sweep_needs_a_request_that_is_there_and_has_not_expired() {
    on_a_fresh_chain(|| {
        let mut m = armed();
        as_admin(EXPIRES - 1);
        sweep(&mut m, 0);
        assert!(m.queue().is_empty(), "the last instant before it expires");
    });
    on_a_fresh_chain(|| {
        let mut m = armed();
        as_admin(EXPIRES);
        assert!(refusal_of_sweep(&mut m, 0).contains("expired"), "an expired request can never run: nothing is at risk");
        assert_eq!(m.queue().len(), 1, "and it is left for purge_expired");
    });
    let mut m = armed();
    as_admin(6_000 * SEC);
    assert!(refusal_of_sweep(&mut m, 7).contains("no such request"));
}

#[test]
fn a_swept_request_can_be_neither_executed_nor_swept_again() {
    let mut m = armed();
    as_admin(6_000 * SEC);
    sweep(&mut m, 0);
    assert!(refusal_of_sweep(&mut m, 0).contains("no such request"));
    as_anyone(UNLOCKS + SEC);
    assert!(panics_with(|| drop(m.execute(U64(0)))).contains("no such request"));
}

#[test]
fn a_sweep_works_while_the_era_is_not_calm_because_that_is_when_a_queue_is_frozen_and_at_risk() {
    let mut m = armed();
    m.era = Era::Warning;
    as_admin(UNLOCKS + SEC);
    assert!(panics_with(|| drop(m.execute(U64(0)))).contains("paused"), "the queue is frozen");
    sweep(&mut m, 0);
    assert!(m.queue().is_empty());
}

/// Everything the contract keeps that is not the queue, as the views and the raw logs show it.
fn books_but_the_queue(m: &Mamori) -> String {
    let mut a = serde_json::to_value(m.attest()).unwrap();
    a["queue_len"] = serde_json::Value::Null;
    a["block_height"] = serde_json::Value::Null;
    a["block_timestamp"] = serde_json::Value::Null;
    format!(
        "{a} spent {:?} strikes {} window {:?} requested {:?} by_key {:?} next_id {}",
        m.spent_24h(None),
        m.strikes_of(key(1)),
        m.window.get(&None::<AccountId>),
        m.requested.get(&None::<AccountId>),
        m.requested_by_key.get(&(key(1), None::<AccountId>)),
        m.next_id
    )
}

#[test]
fn a_sweep_touches_no_cap_budget_strike_key_or_setting_and_refunds_no_request_budget() {
    let mut m = armed(); // 5 of the 10 NEAR pending limit asked for and queued
    as_admin(5_100 * SEC);
    m.enforce_allowlist(true);
    as_daily(&key(1), 5_200 * SEC);
    assert_eq!(refused(m.send_small(None, U128(1), payee())).strikes, 1, "a strike to keep"); // payee is not on the allowlist
    m.request_withdraw(None, U128(5 * NEAR), payee());
    let before = books_but_the_queue(&m);
    as_admin(6_000 * SEC);
    sweep(&mut m, 0);
    sweep(&mut m, 1);
    assert!(m.queue().is_empty());
    assert_eq!(books_but_the_queue(&m), before, "only the queue changed");
    // The 24 h request budget (10 NEAR) is spent although the queue is empty again: a sweep gives none of it back.
    as_daily(&key(1), 6_100 * SEC);
    let msg = panics_with(|| {
        m.request_withdraw(None, U128(NEAR), payee());
    });
    assert!(msg.contains("over the 24 h pending limit"), "{msg}");
}

#[test]
fn a_failed_sweep_transfer_is_logged_and_nothing_is_put_back() {
    let mut m = armed();
    as_admin(6_000 * SEC);
    sweep(&mut m, 0);
    callback_after_success(6_001 * SEC);
    m.on_sweep_done(U64(0), None, U128(5 * NEAR), safe());
    assert!(get_logs().is_empty(), "a transfer that landed says nothing more");
    callback_after_failure(6_001 * SEC);
    m.on_sweep_done(U64(0), None, U128(5 * NEAR), safe());
    assert_eq!(
        event("sweep_failed").unwrap()["data"],
        serde_json::json!({ "id": "0", "token": null, "amount": (5 * NEAR).to_string(), "safe": safe() })
    );
    assert!(m.queue().is_empty(), "the value stayed in the vault, the request is gone, like a cancel");
}

#[test]
fn the_sweep_callback_carries_the_destination_it_was_sent_to() {
    let mut m = armed();
    as_admin(6_000 * SEC);
    sweep(&mut m, 0);
    let r = sent();
    let (_, cb) = r.iter().find(|(to, a)| to == &vault() && a.contains("on_sweep_done")).expect("the callback receipt");
    assert!(cb.contains(r#""safe":"fargo""#) && cb.contains(r#""id":"0""#) && cb.contains(&(5 * NEAR).to_string()), "{cb}");
}
