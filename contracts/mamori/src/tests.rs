use super::*;
use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, CurveType};

const SEC: u64 = 1_000_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn vault() -> AccountId {
    accounts(0)
}

fn key(n: u8) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, vec![n; 32]).unwrap()
}

/// A call signed by a full-access key (the admin) on the vault itself.
fn as_admin(now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .predecessor_account_id(vault())
        .signer_account_id(vault())
        .block_timestamp(now)
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
}

/// A call signed by a classical daily key.
fn as_daily(k: &PublicKey, now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .predecessor_account_id(vault())
        .signer_account_id(vault())
        .signer_account_pk(k.clone())
        .block_timestamp(now)
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
}

/// A call from a stranger.
fn as_anyone(now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .predecessor_account_id(accounts(4))
        .signer_account_id(accounts(4))
        .block_timestamp(now)
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
}

/// A callback the contract sent to itself.
fn as_callback(now: u64) {
    as_admin(now);
}

/// The delay most tests run with. It is below the production floor (`MIN_DELAY_SECS`, 24 h), which would make
/// every test about the queue span days; the floor itself is covered by the `init_*` tests below.
const TEST_DELAY: u64 = 3600;

/// Vault with one daily key (key 1), a 1 NEAR / 24 h limit, a 1 h delay and the production default
/// minimum send. `init` is given the floor and the delay is then lowered, so this works in every build.
fn setup_production() -> Mamori {
    as_admin(1_000 * SEC);
    let mut m = Mamori::init(accounts(1), U128(NEAR), MIN_DELAY_SECS);
    m.delay_secs = TEST_DELAY;
    let _ = m.add_daily_key(key(1), None);
    m
}

/// `setup_production` with the minimum send switched off: most tests send 1 yoctoNEAR, which the
/// default minimum refuses.
fn setup() -> Mamori {
    let mut m = setup_production();
    m.set_min_send(U128(0));
    m
}

/// The `send_small` call went through: it returned the transfer promise, not a refusal.
fn assert_sent(r: PromiseOrValue<SendOutcome>) {
    match r {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(o) => panic!("expected the send to go through, got {o:?}"),
    }
}

/// A trip at kaigen runs in two receipts: `on_era` caches the era and schedules `lock_down`, which then
/// runs on its own. This runs the second one.
fn lock_down_at(m: &mut Mamori, now: u64) {
    as_callback(now);
    m.lock_down();
}

/// The refusal a `send_small` returned; panics if the send actually went through.
fn refused(r: PromiseOrValue<SendOutcome>) -> SendOutcome {
    match r {
        PromiseOrValue::Value(o) => {
            assert!(!o.sent, "expected a refusal");
            o
        }
        PromiseOrValue::Promise(_) => panic!("expected a refusal, but the send went through"),
    }
}

fn panics_with(f: impl FnOnce()) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a panic");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

/// Debug text of the created receipts, with byte-array fields (method names, args) decoded to text.
fn receipts_text() -> String {
    let raw = format!("{:?}", get_created_receipts());
    let mut out = String::new();
    let mut rest = raw.as_str();
    while let Some(start) = rest.find('[') {
        out.push_str(&rest[..start]);
        let Some(len) = rest[start..].find(']') else { break };
        let inner = &rest[start + 1..start + len];
        let bytes: Option<Vec<u8>> = inner.split(", ").map(|n| n.trim().parse::<u8>().ok()).collect();
        match bytes.filter(|b| b.len() >= 3 && b.iter().all(|c| (0x20..0x7f).contains(c))) {
            Some(b) => {
                out.push_str(&String::from_utf8_lossy(&b));
                rest = &rest[start + len + 1..];
            }
            None => {
                out.push('[');
                rest = &rest[start + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[test]
fn only_the_vault_itself_can_use_admin_methods() {
    let mut m = setup();
    as_anyone(2_000 * SEC);
    assert!(panics_with(|| {
        let _ = m.add_daily_key(key(2), None);
    })
    .contains("admin only"));
    assert!(panics_with(|| m.cancel(U64(0))).contains("admin only"));
}

#[test]
fn add_daily_key_records_key_and_creates_function_call_key() {
    let mut m = setup();
    assert_eq!(m.daily_keys(), vec![key(1)]);
    as_admin(1_001 * SEC);
    let _ = m.add_daily_key(key(2), Some(U128(NEAR / 10)));
    drop(m.daily_keys());
    let r = receipts_text();
    assert!(r.contains("AddKey"), "{r}");
    assert!(r.contains("send_small") && r.contains("request_withdraw"), "{r}");
    assert!(!r.contains("transfer_all"), "{r}");
}

#[test]
fn duplicate_and_excess_daily_keys_are_rejected() {
    let mut m = setup();
    as_admin(1_001 * SEC);
    assert!(panics_with(|| {
        let _ = m.add_daily_key(key(1), None);
    })
    .contains("already recorded"));
    for n in 2..=8 {
        let _ = m.add_daily_key(key(n), None);
    }
    assert!(panics_with(|| {
        let _ = m.add_daily_key(key(9), None);
    })
    .contains("too many daily keys"));
}

#[test]
fn send_small_enforces_a_rolling_24h_cap() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let _ = m.send_small(None, U128(NEAR * 6 / 10), accounts(2));
    // 0.6 + 0.5 > 1 NEAR in the same window.
    as_daily(&key(1), 3_000 * SEC);
    assert_eq!(refused(m.send_small(None, U128(NEAR * 5 / 10), accounts(2))).refused.as_deref(), Some("over the 24 h limit"));
    assert_eq!(m.spent_24h(None).0, NEAR * 6 / 10);
    // 24 h after the first send, the allowance returns.
    as_daily(&key(1), 2_000 * SEC + DAY_NS + SEC);
    assert_eq!(m.spent_24h(None).0, 0);
    let _ = m.send_small(None, U128(NEAR * 9 / 10), accounts(2));
}

#[test]
fn send_small_is_not_a_fixed_window_that_allows_double_spend_at_the_boundary() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let _ = m.send_small(None, U128(NEAR), accounts(2));
    // Just before the 24 h mark, a fixed window might have reset; a rolling one has not.
    as_daily(&key(1), 2_000 * SEC + DAY_NS - SEC);
    assert_eq!(refused(m.send_small(None, U128(1), accounts(2))).refused.as_deref(), Some("over the 24 h limit"));
}

#[test]
fn tokens_without_an_explicit_limit_cannot_be_sent() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    assert_eq!(refused(m.send_small(Some(accounts(3)), U128(1), accounts(2))).refused.as_deref(), Some(NO_LIMIT_REASON));
    as_admin(2_001 * SEC);
    m.set_token_limit(accounts(3), U128(1_000));
    as_daily(&key(1), 2_002 * SEC);
    let _ = m.send_small(Some(accounts(3)), U128(1_000), accounts(2));
    let r = receipts_text();
    assert!(r.contains("ft_transfer"), "{r}");
    // The NEP-141 1 yoctoNEAR deposit is attached by the guard, not the daily key.
    assert!(r.contains("inner: 1 }"), "{r}");
}

#[test]
fn only_recorded_daily_keys_can_send() {
    let mut m = setup();
    as_daily(&key(7), 2_000 * SEC);
    assert!(panics_with(|| {
        let _ = m.send_small(None, U128(1), accounts(2));
    })
    .contains("not a recorded daily key"));
    as_anyone(2_000 * SEC);
    assert!(panics_with(|| {
        let _ = m.send_small(None, U128(1), accounts(2));
    })
    .contains("daily key only"));
}

#[test]
fn failed_send_refunds_the_spend() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let _ = m.send_small(None, U128(NEAR), accounts(2));
    assert_eq!(m.spent_24h(None).0, NEAR);
    // Simulate the transfer receipt failing.
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .predecessor_account_id(vault())
        .block_timestamp(2_001 * SEC);
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![near_sdk::PromiseResult::Failed]);
    m.on_send_done(None, U128(NEAR), U64(2_000 * SEC));
    assert_eq!(m.spent_24h(None).0, 0);
}

#[test]
fn queued_withdrawal_waits_for_the_delay_and_can_be_cancelled() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(5 * NEAR), accounts(2));
    assert_eq!(m.queue().len(), 1);
    assert_eq!(m.queue()[0].unlocks_at.0, 2_000 * SEC + 3600 * SEC);

    as_anyone(2_000 * SEC + 3599 * SEC);
    assert!(panics_with(|| {
        let _ = m.execute(id);
    })
    .contains("still locked"));

    as_admin(2_100 * SEC);
    m.cancel(id);
    assert!(m.queue().is_empty());
    as_anyone(2_000 * SEC + 3601 * SEC);
    assert!(panics_with(|| {
        let _ = m.execute(id);
    })
    .contains("no such request"));
}

#[test]
fn anyone_can_execute_after_unlock_while_calm() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(5 * NEAR), accounts(2));
    as_anyone(2_000 * SEC + 3601 * SEC);
    let _ = m.execute(id);
    assert!(m.queue().is_empty());
    assert!(receipts_text().contains("Transfer"));
}

#[test]
fn failed_execute_requeues_the_request() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(5 * NEAR), accounts(2));
    let w = m.queue()[0].withdrawal.clone();
    as_anyone(2_000 * SEC + 3601 * SEC);
    let _ = m.execute(id);
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault()).predecessor_account_id(vault());
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![near_sdk::PromiseResult::Failed]);
    m.on_execute_done(id, w);
    assert_eq!(m.queue().len(), 1);
}

#[test]
fn queue_is_bounded() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    for _ in 0..MAX_QUEUE {
        m.request_withdraw(None, U128(1), accounts(2));
    }
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("queue full"));
}

#[test]
fn warning_pauses_send_small_and_execute_and_the_delay_does_not_change() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(NEAR), accounts(2));

    as_callback(2_100 * SEC);
    assert_eq!(m.on_era(Ok(Era::Warning)), Era::Warning);
    // The delay used to double here, but `execute` is calm-only, so no request could ever have used the
    // doubled delay. It is one delay in every era now.
    let c = m.config();
    assert_eq!((c.delay_secs, c.effective_delay_secs), (TEST_DELAY, TEST_DELAY));
    // Keys survive a warning.
    assert_eq!(m.daily_keys(), vec![key(1)]);

    as_daily(&key(1), 2_200 * SEC);
    assert!(panics_with(|| {
        let _ = m.send_small(None, U128(1), accounts(2));
    })
    .contains("paused"));
    assert_eq!(m.queue()[0].unlocks_at.0, 2_000 * SEC + TEST_DELAY * SEC);
    // Long past the unlock, `execute` is still blocked outside calm.
    as_anyone(2_000 * SEC + 8000 * SEC);
    assert!(panics_with(|| {
        let _ = m.execute(id);
    })
    .contains("paused"));
}

#[test]
fn a_request_queued_before_a_warning_is_frozen_but_the_admin_can_still_cancel_it() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(NEAR), accounts(2));
    as_callback(2_100 * SEC);
    m.on_era(Ok(Era::Warning));
    // Past its unlock and still frozen: nothing leaves through a classical key while the era is not calm.
    as_anyone(2_000 * SEC + 2 * DAY_NS);
    assert!(panics_with(|| {
        let _ = m.execute(id);
    })
    .contains("paused"));
    assert_eq!(m.queue().len(), 1, "it waits, it is not discarded");
    // The admin is not paused: a frozen request can be cleared out.
    as_admin(2_000 * SEC + 2 * DAY_NS);
    m.cancel(id);
    assert!(m.queue().is_empty());
}

#[test]
fn request_withdraw_is_paused_at_warning_so_nothing_queues_that_cannot_run() {
    let mut m = setup();
    as_callback(2_100 * SEC);
    m.on_era(Ok(Era::Warning));
    as_daily(&key(1), 2_200 * SEC);
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("paused: era is not calm"));
    assert!(m.queue().is_empty());
    assert!(m.requested.get(&None::<AccountId>).is_none(), "and the refusal used none of the request budget");
}

#[test]
fn request_withdraw_at_kaigen_still_says_lockdown() {
    let mut m = setup();
    as_callback(2_100 * SEC);
    m.on_era(Ok(Era::Kaigen)); // the fan-out has not run, so the key is still recorded
    as_daily(&key(1), 2_200 * SEC);
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("lockdown"));
}

#[test]
fn kaigen_deletes_every_recorded_key_clears_the_queue_and_removes_intents_keys() {
    let mut m = setup();
    as_admin(1_001 * SEC);
    let _ = m.add_daily_key(key(2), None);
    let _ = m.register_intents_key(key(3));
    as_daily(&key(1), 2_000 * SEC);
    m.request_withdraw(None, U128(NEAR), accounts(2));

    as_callback(2_100 * SEC);
    assert_eq!(m.on_era(Ok(Era::Kaigen)), Era::Kaigen);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"trip\"")));
    lock_down_at(&mut m, 2_101 * SEC);
    assert!(m.daily_keys().is_empty());
    assert!(m.intents_keys().is_empty());
    assert!(m.queue().is_empty());
    let r = receipts_text();
    assert_eq!(r.matches("DeleteKey").count(), 2, "{r}");
    assert!(r.contains("remove_public_key"), "{r}");

    // No new classical keys after lockdown.
    as_admin(2_200 * SEC);
    assert!(panics_with(|| {
        let _ = m.add_daily_key(key(4), None);
    })
    .contains("lockdown"));
    assert!(panics_with(|| {
        let _ = m.register_intents_key(key(5));
    })
    .contains("lockdown"));
}

#[cfg(not(feature = "drill"))]
#[test]
fn era_in_a_vault_never_goes_back_down() {
    let mut m = setup();
    as_callback(2_100 * SEC);
    m.on_era(Ok(Era::Kaigen));
    as_callback(2_200 * SEC);
    assert_eq!(m.on_era(Ok(Era::Calm)), Era::Kaigen);
}

#[test]
fn trip_with_unreachable_kizashi_changes_nothing() {
    let mut m = setup();
    as_callback(2_100 * SEC);
    assert!(panics_with(|| {
        m.on_era(Err(PromiseError::Failed));
    })
    .contains("kizashi unreachable"));
    assert_eq!(m.era(), Era::Calm);
}

#[test]
fn trip_is_callable_by_anyone_and_asks_kizashi() {
    let m = setup();
    as_anyone(2_100 * SEC);
    let _ = m.trip();
    let r = receipts_text();
    assert!(r.contains("era") && r.contains("on_era"), "{r}");
}

#[test]
fn removing_a_daily_key_deletes_it() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.remove_daily_key(key(1));
    assert!(m.daily_keys().is_empty());
    assert!(receipts_text().contains("DeleteKey"));
    // The account confirms the delete; only then is the key unknown to the vault altogether.
    callback_after_success(1_101 * SEC);
    m.on_revoked_key_deleted(key(1));
    as_admin(1_102 * SEC);
    assert!(panics_with(|| {
        let _ = m.remove_daily_key(key(1));
    })
    .contains("unknown daily key"));
}

/// The next callback sees a failed promise result, as if its receipt had failed.
fn callback_after_failure(now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault()).predecessor_account_id(vault()).block_timestamp(now);
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![near_sdk::PromiseResult::Failed]);
}

/// The next callback sees a successful promise result.
fn callback_after_success(now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault()).predecessor_account_id(vault()).block_timestamp(now);
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![near_sdk::PromiseResult::Successful(vec![])]);
}

// ---- K3: a key the vault stops serving stays on record until the account confirms it is deleted ----------

#[test]
fn a_removed_key_stays_recorded_for_deletion_until_the_account_confirms_it() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.remove_daily_key(key(1));
    let r = receipts_text();
    assert!(r.contains("DeleteKey") && r.contains("on_revoked_key_deleted"), "{r}");
    assert!(m.daily_keys().is_empty(), "no longer served, at once");
    assert_eq!(m.revoked_keys(), vec![key(1)], "but owed a deletion");
    callback_after_success(1_101 * SEC);
    m.on_revoked_key_deleted(key(1));
    assert!(m.revoked_keys().is_empty());
    assert!(event("delete_key_failed").is_none());
}

#[test]
fn a_deletion_that_failed_is_logged_stays_recorded_and_the_key_is_still_not_served() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.remove_daily_key(key(1));
    callback_after_failure(1_101 * SEC);
    m.on_revoked_key_deleted(key(1));
    assert_eq!(m.revoked_keys(), vec![key(1)]);
    assert_eq!(event("delete_key_failed").unwrap()["data"]["public_key"], serde_json::json!(key(1)));
    // If the delete never lands the key is still on the account, but the contract refuses everything it signs.
    as_daily(&key(1), 1_102 * SEC);
    assert!(panics_with(|| {
        let _ = m.send_small(None, U128(1), accounts(2));
    })
    .contains("not a recorded daily key"));
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("not a recorded daily key"));
}

#[test]
fn the_admin_can_retry_a_deletion_that_did_not_land() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.remove_daily_key(key(1));
    callback_after_failure(1_101 * SEC);
    m.on_revoked_key_deleted(key(1));
    as_admin(1_102 * SEC);
    let _ = m.remove_daily_key(key(1)); // same call: the key is not served, but it is still owed a deletion
    assert!(receipts_text().contains("DeleteKey"));
    callback_after_success(1_103 * SEC);
    m.on_revoked_key_deleted(key(1));
    assert!(m.revoked_keys().is_empty());
    as_admin(1_104 * SEC);
    assert!(panics_with(|| {
        let _ = m.remove_daily_key(key(1));
    })
    .contains("unknown daily key"));
}

#[test]
fn a_burned_key_is_recorded_for_deletion_until_the_account_confirms_it() {
    let mut m = setup();
    attack(&mut m, 2_000 * SEC);
    attack(&mut m, 2_001 * SEC);
    assert!(attack(&mut m, 2_002 * SEC).burned);
    let r = receipts_text();
    assert!(r.contains("DeleteKey") && r.contains("on_revoked_key_deleted"), "{r}");
    assert_eq!(m.revoked_keys(), vec![key(1)]);
    callback_after_failure(2_003 * SEC);
    m.on_revoked_key_deleted(key(1));
    assert_eq!(m.revoked_keys(), vec![key(1)], "a failed delete is not forgotten");
    // And the burned key is not served meanwhile, deleted or not.
    as_daily(&key(1), 2_004 * SEC);
    assert!(panics_with(|| {
        let _ = m.send_small(None, U128(1), accounts(2));
    })
    .contains("not a recorded daily key"));
    callback_after_success(2_005 * SEC);
    m.on_revoked_key_deleted(key(1));
    assert!(m.revoked_keys().is_empty());
}

#[test]
fn lock_down_gives_a_key_whose_deletion_was_never_confirmed_one_more_try() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.remove_daily_key(key(1)); // its callback never came back
    as_callback(2_000 * SEC);
    m.on_era(Ok(Era::Kaigen));
    lock_down_at(&mut m, 2_001 * SEC);
    let r = receipts_text();
    assert_eq!(r.matches("DeleteKey").count(), 1, "{r}");
    assert!(m.revoked_keys().is_empty(), "one try at kaigen: it is not recorded again, or lockdown could never finish");
    callback_after_failure(2_002 * SEC);
    m.on_revoked_key_deleted(key(1));
    assert!(event("delete_key_failed").is_some(), "the failure is still reported");
    assert!(m.revoked_keys().is_empty());
}

#[test]
fn a_partial_lock_down_says_how_many_unconfirmed_deletions_are_left() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    for n in 2..=MAX_DAILY_KEYS as u8 {
        let _ = m.add_daily_key(key(n), None);
    }
    for n in 2..=MAX_DAILY_KEYS as u8 {
        let _ = m.remove_daily_key(key(n)); // seven keys owed a deletion
    }
    for n in 11..11 + MAX_INTENTS_KEYS as u8 {
        let _ = m.register_intents_key(key(n));
    }
    as_callback(2_000 * SEC);
    m.on_era(Ok(Era::Kaigen));
    as_callback_with_gas(2_001 * SEC, LOCK_DOWN_GAS);
    m.lock_down();
    let e = event("lockdown_partial").expect("a pass that cannot finish says so");
    assert!(e["data"]["revoked_keys_left"].as_u64().unwrap() > 0, "{e}");
    assert_eq!(e["data"]["revoked_keys_left"].as_u64().unwrap() as usize, m.revoked_keys().len());
}

// ---- the production delay floor ---------------------------------------------------------------

#[test]
fn the_production_delay_floor_is_a_day() {
    // A withdrawal queued by a hijacked key must outlast a day, so an owner who checks once a day can cancel it.
    // Lowering this is a decision about every production vault, not a tidy-up: change it on purpose.
    assert!(MIN_DELAY_SECS >= 86_400);
    assert_eq!(MIN_DELAY_SECS % 3600, 0, "the refusal message counts hours");
}

#[cfg(not(feature = "drill"))]
#[test]
fn init_refuses_a_withdrawal_delay_that_defeats_the_cap() {
    as_admin(1_000 * SEC);
    assert!(panics_with(|| {
        Mamori::init(accounts(1), U128(NEAR), 0);
    })
    .contains("at least 24 hours"));
    assert!(panics_with(|| {
        Mamori::init(accounts(1), U128(NEAR), 300);
    })
    .contains("at least 24 hours"));
    assert!(panics_with(|| {
        Mamori::init(accounts(1), U128(NEAR), 86_399);
    })
    .contains("at least 24 hours"));
    let _ = Mamori::init(accounts(1), U128(NEAR), 86_400);
}

#[test]
fn a_daily_key_whose_addkey_failed_is_forgotten() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    assert!(m.daily_keys().contains(&key(2)));
    assert!(receipts_text().contains("on_key_added"));
    callback_after_failure(1_101 * SEC);
    m.on_key_added(key(2));
    assert!(!m.daily_keys().contains(&key(2)), "never delete a real key because of a stale record");
    assert!(m.daily_keys().contains(&key(1)), "other keys are untouched");
}

#[test]
fn lockdown_deletes_each_key_in_its_own_receipt_with_a_retry_callback() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    as_callback(2_000 * SEC);
    m.on_era(Ok(Era::Kaigen));
    lock_down_at(&mut m, 2_001 * SEC);
    let r = receipts_text();
    assert_eq!(r.matches("DeleteKey").count(), 2, "{r}");
    assert_eq!(r.matches("on_key_removed").count(), 2, "{r}");
    // Two separate receipts to the vault, not one batch that fails together.
    assert!(get_created_receipts().iter().filter(|x| x.actions.len() == 1 && format!("{:?}", x.actions).contains("DeleteKey")).count() == 2, "{r}");
}

#[test]
fn a_key_that_failed_to_delete_is_recorded_again_so_the_next_trip_retries_it() {
    let mut m = setup();
    as_callback(2_000 * SEC);
    m.on_era(Ok(Era::Kaigen));
    lock_down_at(&mut m, 2_000 * SEC);
    assert!(m.daily_keys().is_empty());
    callback_after_failure(2_001 * SEC);
    m.on_key_removed(key(1));
    assert_eq!(m.daily_keys(), vec![key(1)]);
    as_callback(2_100 * SEC);
    m.on_era(Ok(Era::Kaigen)); // a later trip tries again
    lock_down_at(&mut m, 2_100 * SEC);
    assert!(get_created_receipts().iter().any(|x| format!("{:?}", x.actions).contains("DeleteKey")));
}

#[test]
fn an_intents_key_that_failed_to_come_off_is_recorded_again() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.register_intents_key(key(3));
    as_callback(2_000 * SEC);
    m.on_era(Ok(Era::Kaigen));
    lock_down_at(&mut m, 2_000 * SEC);
    assert!(m.intents_keys().is_empty());
    assert!(receipts_text().contains("on_intents_removed"));
    callback_after_failure(2_001 * SEC);
    m.on_intents_removed(key(3));
    assert_eq!(m.intents_keys(), vec![key(3)]);
}

#[test]
fn a_failed_execute_does_not_resurrect_a_request_after_lockdown() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(NEAR), accounts(2));
    let w = m.queue()[0].withdrawal.clone();
    as_anyone(2_000 * SEC + 3601 * SEC);
    let _ = m.execute(id);
    as_callback(2_000 * SEC + 3700 * SEC);
    m.on_era(Ok(Era::Kaigen)); // lockdown while the transfer is in flight
    lock_down_at(&mut m, 2_000 * SEC + 3700 * SEC);
    callback_after_failure(2_000 * SEC + 3702 * SEC);
    m.on_execute_done(id, w);
    assert!(m.queue().is_empty(), "the queue was cleared on purpose and stays cleared");
}

#[test]
fn a_failed_execute_cannot_push_the_queue_past_its_cap() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(1), accounts(2));
    let w = m.queue()[0].withdrawal.clone();
    as_anyone(2_000 * SEC + 3601 * SEC);
    let _ = m.execute(id);
    as_daily(&key(1), 2_000 * SEC + 3602 * SEC);
    for _ in 0..MAX_QUEUE {
        m.request_withdraw(None, U128(1), accounts(2)); // refills every slot, including the freed one
    }
    callback_after_failure(2_000 * SEC + 3603 * SEC);
    m.on_execute_done(id, w);
    assert_eq!(m.queue().len() as u32, MAX_QUEUE);
}

// ---- recipient allowlist (policy) -------------------------------------------------------

#[test]
fn the_allowlist_is_off_by_default_so_an_empty_list_never_locks_anyone_out() {
    let mut m = setup();
    assert_eq!(m.allowlist().enforced, false);
    as_daily(&key(1), 2_000 * SEC);
    let _ = m.send_small(None, U128(1), accounts(2));
}

#[test]
fn when_enforced_send_small_pays_only_allowed_recipients() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.allow_recipient(accounts(2));
    m.enforce_allowlist(true);
    assert_eq!(m.allowlist().accounts, vec![accounts(2)]);

    as_daily(&key(1), 2_000 * SEC);
    let _ = m.send_small(None, U128(1), accounts(2));
    assert_eq!(refused(m.send_small(None, U128(1), accounts(3))).refused.as_deref(), Some("recipient is not on the allowlist"));
    // A refused send spends nothing from the daily cap.
    assert_eq!(m.spent_24h(None).0, 1);
}

#[test]
fn the_allowlist_gates_instant_sends_only_and_larger_sends_still_wait_in_the_queue() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.enforce_allowlist(true);
    as_daily(&key(1), 2_000 * SEC);
    // Not allowed for an instant send, but it can still be requested: delayed, and the admin can cancel it.
    let id = m.request_withdraw(None, U128(NEAR), accounts(3));
    as_admin(2_100 * SEC);
    m.cancel(id);
    assert!(m.queue().is_empty());
}

#[test]
fn allowlist_changes_are_admin_only_bounded_and_reversible() {
    let mut m = setup();
    as_anyone(2_000 * SEC);
    assert!(panics_with(|| m.allow_recipient(accounts(2))).contains("admin only"));
    assert!(panics_with(|| m.enforce_allowlist(true)).contains("admin only"));
    // A daily key cannot widen its own policy either, but that is enforced by the runtime (its access
    // key only permits send_small and request_withdraw), which a unit test cannot model.

    as_admin(2_100 * SEC);
    m.allow_recipient(accounts(2));
    assert!(panics_with(|| m.allow_recipient(accounts(2))).contains("already allowed"));
    m.disallow_recipient(accounts(2));
    assert!(panics_with(|| m.disallow_recipient(accounts(2))).contains("not on the allowlist"));
    for i in 0..MAX_ALLOWED {
        m.allow_recipient(format!("r{i}.near").parse().unwrap());
    }
    assert!(panics_with(|| m.allow_recipient("one-too-many.near".parse().unwrap())).contains("allowlist is full"));
}

// ---- strikes: the vault burns a key that keeps attacking ----------------------------------

fn attack(m: &mut Mamori, at: u64) -> SendOutcome {
    as_daily(&key(1), at);
    refused(m.send_small(None, U128(NEAR * 5), accounts(2)))
}

#[test]
fn a_refusal_is_recorded_not_reverted_and_counts_against_the_key() {
    let mut m = setup();
    let o = attack(&mut m, 2_000 * SEC);
    assert_eq!((o.sent, o.strikes, o.burned), (false, 1, false));
    assert_eq!(o.refused.as_deref(), Some("over the 24 h limit"));
    // The state survived the call: a panic would have rolled the strike back.
    assert_eq!(m.strikes_of(key(1)), 1);
    assert_eq!(m.config().max_strikes, 3);
}

#[test]
fn the_third_refusal_burns_the_key_and_it_can_do_nothing_after() {
    let mut m = setup();
    assert_eq!(attack(&mut m, 2_000 * SEC).strikes, 1);
    assert_eq!(attack(&mut m, 2_001 * SEC).strikes, 2);
    let last = attack(&mut m, 2_002 * SEC);
    assert_eq!((last.strikes, last.burned), (3, true));
    assert!(m.daily_keys().is_empty(), "the vault stopped recording the key");
    assert!(receipts_text().contains("DeleteKey"), "and deleted it from the account");
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"key_burned\"")));

    // Even if the delete never lands, the contract no longer serves the key.
    as_daily(&key(1), 2_003 * SEC);
    assert!(panics_with(|| {
        let _ = m.send_small(None, U128(1), accounts(2));
    })
    .contains("not a recorded daily key"));
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("not a recorded daily key"));
}

#[test]
fn strikes_decay_after_24_hours_so_an_honest_slip_is_forgiven() {
    let mut m = setup();
    attack(&mut m, 2_000 * SEC);
    attack(&mut m, 2_001 * SEC);
    // A day later the old strikes have expired: this is strike one again, not strike three.
    let later = attack(&mut m, 2_001 * SEC + DAY_NS + SEC);
    assert_eq!((later.strikes, later.burned), (1, false));
    assert_eq!(m.strikes_of(key(1)), 1);
}

#[test]
fn successful_sends_never_count_as_strikes() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    for i in 0..5u64 {
        as_daily(&key(1), (2_000 + i) * SEC);
        let _ = m.send_small(None, U128(1), accounts(2));
    }
    assert_eq!(m.strikes_of(key(1)), 0);
}

#[test]
fn strikes_belong_to_the_key_so_one_hijacked_key_does_not_cost_the_others() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    attack(&mut m, 2_000 * SEC);
    attack(&mut m, 2_001 * SEC);
    attack(&mut m, 2_002 * SEC);
    assert_eq!(m.daily_keys(), vec![key(2)], "only the attacking key was burned");
    as_daily(&key(2), 2_003 * SEC);
    let _ = m.send_small(None, U128(1), accounts(2));
}

#[test]
fn the_admin_sets_how_many_strikes_a_key_gets_within_bounds() {
    let mut m = setup();
    as_anyone(2_000 * SEC);
    assert!(panics_with(|| m.set_max_strikes(5)).contains("admin only"));
    as_admin(2_001 * SEC);
    assert!(panics_with(|| m.set_max_strikes(0)).contains("between 1 and 10"));
    assert!(panics_with(|| m.set_max_strikes(11)).contains("between 1 and 10"));
    m.set_max_strikes(1);
    assert!(attack(&mut m, 2_002 * SEC).burned, "with one strike allowed the first refusal burns the key");
}

#[test]
fn an_allowlist_violation_is_a_strike_too_and_moves_nothing() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.enforce_allowlist(true);
    as_daily(&key(1), 2_000 * SEC);
    let o = refused(m.send_small(None, U128(1), accounts(3)));
    assert_eq!(o.refused.as_deref(), Some("recipient is not on the allowlist"));
    assert_eq!((o.strikes, m.spent_24h(None).0), (1, 0));
}

// ---- helpers for the findings below ---------------------------------------------------------

/// The first logged event with this name, parsed.
fn event(name: &str) -> Option<serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .find(|v| v["event"] == name)
}

fn window_len(m: &Mamori) -> usize {
    m.window.get(&None::<AccountId>).map_or(0, Vec::len)
}

/// The most the queue may hold for NEAR under the default pending limit.
const PENDING_CAP: u128 = PENDING_LIMIT_MULTIPLE * NEAR;

// ---- S1: the value waiting in the queue is bounded ----------------------------------------

#[test]
fn pending_limit_defaults_to_a_multiple_of_the_daily_limit_and_zero_for_unlisted_tokens() {
    let m = setup();
    assert_eq!(m.config().pending_limit.0, PENDING_CAP);
    assert_eq!(m.pending_limit(None).0, PENDING_CAP);
    assert_eq!(m.pending_limit(Some(accounts(3))).0, 0);
}

#[test]
fn a_hijacked_key_cannot_queue_more_than_the_pending_limit() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(PENDING_CAP + 1), accounts(2));
    })
    .contains("pending limit"));
    m.request_withdraw(None, U128(PENDING_CAP - 1), accounts(2));
    m.request_withdraw(None, U128(1), accounts(2)); // exactly at the limit is allowed
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("pending limit"));
    assert_eq!(m.queue().len(), 2);
}

// ---- R2: the pending limit is also a rolling 24 h cap, so executing does not refill it ------------

#[test]
fn cancel_frees_queue_room_but_not_the_request_budget() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let a = m.request_withdraw(None, U128(PENDING_CAP / 2), accounts(2));
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(PENDING_CAP / 2 + 1), accounts(2));
    })
    .contains("pending limit"));
    as_admin(2_001 * SEC);
    m.cancel(a);
    as_daily(&key(1), 2_002 * SEC);
    m.request_withdraw(None, U128(PENDING_CAP / 2), accounts(2)); // the queue has room again; the budget has exactly this left
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("24 h pending limit"));
}

#[test]
fn executing_does_not_refill_the_request_budget_so_the_drain_rate_does_not_depend_on_the_delay() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(PENDING_CAP), accounts(2));
    as_anyone(2_000 * SEC + 3601 * SEC);
    let _ = m.execute(id); // all of it leaves, and the queue is empty
    as_daily(&key(1), 2_000 * SEC + 3602 * SEC);
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("24 h pending limit"));
    // A rolling window: the budget is back once the request is a day old.
    as_daily(&key(1), 2_000 * SEC + 86_400 * SEC + SEC);
    m.request_withdraw(None, U128(PENDING_CAP), accounts(2));
}

#[test]
fn the_request_budget_is_per_token_and_follows_the_pending_limit_the_admin_sets() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.set_token_limit(accounts(3), U128(100));
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(PENDING_CAP), accounts(2));
    as_admin(2_001 * SEC);
    m.cancel(id);
    as_daily(&key(1), 2_002 * SEC);
    m.request_withdraw(Some(accounts(3)), U128(100 * PENDING_LIMIT_MULTIPLE), accounts(2)); // its own budget
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("24 h pending limit"));
    as_admin(2_003 * SEC);
    m.set_pending_limit(None, U128(PENDING_CAP + 5));
    as_daily(&key(1), 2_004 * SEC);
    m.request_withdraw(None, U128(5), accounts(2));
}

#[test]
fn the_request_log_stays_bounded_and_never_forgets_a_request_early() {
    let mut m = setup();
    let (mut t, mut requested) = (2_000u64, 0u128);
    for _ in 0..3 {
        as_daily(&key(1), t * SEC);
        let ids: Vec<U64> = (0..MAX_QUEUE).map(|_| m.request_withdraw(None, U128(1), accounts(2))).collect();
        requested += MAX_QUEUE as u128;
        as_anyone((t + 3601) * SEC);
        for id in ids {
            let _ = m.execute(id);
        }
        t += 3602;
    }
    assert!(m.requested.get(&None::<AccountId>).unwrap().len() <= MAX_WINDOW_ENTRIES);
    as_daily(&key(1), t * SEC);
    m.request_withdraw(None, U128(PENDING_CAP - requested), accounts(2)); // 96 are still counted, none lost to folding
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("24 h pending limit"));
}

#[test]
fn the_pending_limit_is_kept_per_token() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.set_token_limit(accounts(3), U128(100));
    as_daily(&key(1), 2_000 * SEC);
    m.request_withdraw(None, U128(PENDING_CAP), accounts(2)); // NEAR is full
    m.request_withdraw(Some(accounts(3)), U128(100 * PENDING_LIMIT_MULTIPLE), accounts(2)); // the token has its own room
    assert!(panics_with(|| {
        m.request_withdraw(Some(accounts(3)), U128(1), accounts(2));
    })
    .contains("pending limit"));
}

#[test]
fn a_token_without_a_limit_cannot_be_queued() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    assert!(panics_with(|| {
        m.request_withdraw(Some(accounts(3)), U128(1), accounts(2));
    })
    .contains("pending limit"));
}

#[test]
fn the_admin_sets_the_pending_limit_and_nobody_else_can() {
    let mut m = setup();
    as_anyone(2_000 * SEC);
    assert!(panics_with(|| m.set_pending_limit(None, U128(1))).contains("admin only"));
    as_admin(2_001 * SEC);
    m.set_pending_limit(None, U128(5 * NEAR));
    assert_eq!((m.config().pending_limit.0, m.pending_limit(None).0), (5 * NEAR, 5 * NEAR));
    m.set_pending_limit(Some(accounts(3)), U128(7)); // listing a token for the queue needs no daily limit
    as_daily(&key(1), 2_002 * SEC);
    m.request_withdraw(None, U128(5 * NEAR), accounts(2));
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(2));
    })
    .contains("pending limit"));
    m.request_withdraw(Some(accounts(3)), U128(7), accounts(2));
}

#[test]
fn a_failed_execute_cannot_push_the_queue_past_the_pending_limit() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(PENDING_CAP), accounts(2));
    let w = m.queue()[0].withdrawal.clone();
    as_anyone(2_000 * SEC + 3601 * SEC);
    let _ = m.execute(id);
    as_daily(&key(1), 2_000 * SEC + 86_402 * SEC); // a day on, the request budget is back too
    m.request_withdraw(None, U128(PENDING_CAP), accounts(2)); // takes the room the in-flight request left
    callback_after_failure(2_000 * SEC + 86_403 * SEC);
    m.on_execute_done(id, w);
    assert_eq!(m.queue().len(), 1);
    assert!(event("execute_dropped").is_some());
}

// ---- S-queue: a removed or burned key takes its queued withdrawals with it -----------------

#[test]
fn a_queued_withdrawal_records_the_key_that_requested_it_and_the_view_stays_flat() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    as_daily(&key(1), 2_000 * SEC);
    let a = m.request_withdraw(None, U128(1), accounts(2));
    as_daily(&key(2), 2_001 * SEC);
    let b = m.request_withdraw(None, U128(2), accounts(2));
    let q = m.queue();
    let by = |id: U64| q.iter().find(|x| x.id == id).unwrap().withdrawal.requested_by.clone();
    assert_eq!((by(a), by(b)), (key(1), key(2)));
    let v = serde_json::to_value(&q[0]).unwrap();
    for field in ["id", "token", "amount", "to", "requested_at", "unlocks_at", "requested_by"] {
        assert!(v.get(field).is_some(), "queue view lost `{field}`: {v}");
    }
}

#[test]
fn removing_a_daily_key_cancels_its_queued_withdrawals_and_only_its_own() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    as_daily(&key(1), 2_000 * SEC);
    m.request_withdraw(None, U128(1), accounts(2));
    m.request_withdraw(None, U128(2), accounts(2));
    as_daily(&key(2), 2_001 * SEC);
    let keep = m.request_withdraw(None, U128(3), accounts(2));
    as_admin(2_002 * SEC);
    let _ = m.remove_daily_key(key(1));
    let q = m.queue();
    assert_eq!(q.len(), 1);
    assert_eq!((q[0].id, q[0].withdrawal.requested_by.clone()), (keep, key(2)));
    let cancelled = event("queue_cancelled").expect("a cancelled request must be logged");
    assert_eq!(cancelled["data"]["withdrawals"].as_array().unwrap().len(), 2);
    assert_eq!(cancelled["data"]["reason"], "key_removed");
    // The surviving key's request still executes.
    as_anyone(2_001 * SEC + 3601 * SEC);
    let _ = m.execute(keep);
}

#[test]
fn burning_a_key_by_strikes_cancels_its_queued_withdrawals_and_only_its_own() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    as_daily(&key(1), 2_000 * SEC);
    m.request_withdraw(None, U128(1), accounts(2));
    m.request_withdraw(None, U128(2), accounts(2));
    as_daily(&key(2), 2_001 * SEC);
    let keep = m.request_withdraw(None, U128(3), accounts(2));
    attack(&mut m, 2_010 * SEC);
    attack(&mut m, 2_011 * SEC);
    assert_eq!(m.queue().len(), 3, "not burned yet, nothing cancelled");
    assert!(attack(&mut m, 2_012 * SEC).burned);
    let q = m.queue();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].id, keep);
    let cancelled = event("queue_cancelled").expect("a cancelled request must be logged");
    assert_eq!(cancelled["data"]["reason"], "key_burned");
}

#[test]
fn a_failed_execute_does_not_resurrect_a_request_of_a_removed_key() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let id = m.request_withdraw(None, U128(NEAR), accounts(2));
    let w = m.queue()[0].withdrawal.clone();
    as_anyone(2_000 * SEC + 3601 * SEC);
    let _ = m.execute(id); // in flight: no longer in the queue, so removing the key cannot cancel it
    as_admin(2_000 * SEC + 3602 * SEC);
    let _ = m.remove_daily_key(key(1));
    callback_after_failure(2_000 * SEC + 3603 * SEC);
    m.on_execute_done(id, w);
    assert!(m.queue().is_empty());
}

// ---- S3: dust cannot fill the send window or burn an honest key ----------------------------

#[test]
fn a_send_below_the_minimum_is_refused_without_a_strike() {
    let mut m = setup_production();
    assert_eq!(m.config().min_send.0, DEFAULT_MIN_SEND.as_yoctonear());
    for i in 0..5u64 {
        // five dust sends: more than the strikes that would burn a key
        as_daily(&key(1), (2_000 + i) * SEC);
        let o = refused(m.send_small(None, U128(1), accounts(2)));
        assert_eq!((o.refused.as_deref(), o.strikes, o.burned), (Some(BELOW_MIN_REASON), 0, false));
    }
    assert_eq!((m.strikes_of(key(1)), m.spent_24h(None).0), (0, 0));
    assert_eq!(m.daily_keys(), vec![key(1)]);
    as_daily(&key(1), 2_010 * SEC);
    assert_sent(m.send_small(None, U128(DEFAULT_MIN_SEND.as_yoctonear()), accounts(2)));
}

#[test]
fn the_minimum_send_is_for_near_only_and_set_by_the_admin() {
    let mut m = setup_production();
    as_anyone(2_000 * SEC);
    assert!(panics_with(|| m.set_min_send(U128(5))).contains("admin only"));
    as_admin(2_001 * SEC);
    m.set_min_send(U128(5));
    m.set_token_limit(accounts(3), U128(1_000));
    as_daily(&key(1), 2_002 * SEC);
    assert_eq!(refused(m.send_small(None, U128(4), accounts(2))).refused.as_deref(), Some(BELOW_MIN_REASON));
    assert_sent(m.send_small(None, U128(5), accounts(2)));
    assert_sent(m.send_small(Some(accounts(3)), U128(1), accounts(2)));
}

#[test]
fn dust_cannot_fill_the_send_window_or_burn_an_honest_key() {
    let mut m = setup();
    let dust = MAX_WINDOW_ENTRIES as u64 + 6;
    for i in 0..dust {
        as_daily(&key(1), (2_000 + i) * SEC);
        assert_sent(m.send_small(None, U128(1), accounts(2)));
    }
    assert_eq!(m.strikes_of(key(1)), 0);
    assert_eq!(m.daily_keys(), vec![key(1)]);
    assert_eq!(window_len(&m), MAX_WINDOW_ENTRIES, "the log stays bounded");
    assert_eq!(m.spent_24h(None).0, dust as u128, "folded sends still count against the cap");
    as_daily(&key(1), 3_000 * SEC);
    assert_sent(m.send_small(None, U128(NEAR / 2), accounts(2))); // an honest send still goes through
}

#[test]
fn folding_into_a_full_window_never_expires_a_send_early() {
    let mut m = setup();
    let n = MAX_WINDOW_ENTRIES as u64;
    for i in 0..=n {
        as_daily(&key(1), (2_000 + i) * SEC);
        assert_sent(m.send_small(None, U128(1), accounts(2))); // the last one is folded into the newest entry
    }
    // The folded entry now expires 24 h after the later send, never before the earlier one's 24 h.
    as_daily(&key(1), (2_000 + n) * SEC + DAY_NS - SEC);
    assert_eq!(m.spent_24h(None).0, 2);
    as_daily(&key(1), (2_000 + n) * SEC + DAY_NS + SEC);
    assert_eq!(m.spent_24h(None).0, 0);
}

#[test]
fn a_failed_send_that_was_folded_into_a_full_window_is_refunded() {
    let mut m = setup();
    let n = MAX_WINDOW_ENTRIES as u64;
    for i in 0..=n {
        as_daily(&key(1), (2_000 + i) * SEC);
        assert_sent(m.send_small(None, U128(1), accounts(2)));
    }
    assert_eq!(m.spent_24h(None).0, n as u128 + 1);
    callback_after_failure(2_100 * SEC);
    m.on_send_done(None, U128(1), U64((2_000 + n) * SEC));
    assert_eq!(m.spent_24h(None).0, n as u128);
}

// ---- S4: an unlisted token is refused with its own reason and no strike --------------------

#[test]
fn an_unlisted_token_is_refused_with_a_clear_reason_and_no_strike() {
    let mut m = setup();
    for i in 0..5u64 {
        as_daily(&key(1), (2_000 + i) * SEC);
        let o = refused(m.send_small(Some(accounts(3)), U128(1), accounts(2)));
        assert_eq!((o.refused.as_deref(), o.strikes, o.burned), (Some(NO_LIMIT_REASON), 0, false));
    }
    assert_eq!(m.daily_keys(), vec![key(1)], "an honest first send of a new token does not burn the key");
    as_admin(2_100 * SEC);
    m.set_token_limit(accounts(3), U128(10));
    as_daily(&key(1), 2_101 * SEC);
    assert_sent(m.send_small(Some(accounts(3)), U128(1), accounts(2)));
}

#[test]
fn near_with_a_zero_limit_is_refused_the_same_way() {
    as_admin(1_000 * SEC);
    let mut m = Mamori::init(accounts(1), U128(0), MIN_DELAY_SECS);
    let _ = m.add_daily_key(key(1), None);
    as_daily(&key(1), 2_000 * SEC);
    let o = refused(m.send_small(None, U128(NEAR), accounts(2)));
    assert_eq!((o.refused.as_deref(), o.strikes), (Some(NO_LIMIT_REASON), 0));
}

#[test]
fn an_overspend_of_a_listed_limit_is_a_strike_with_its_own_reason() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.set_token_limit(accounts(3), U128(10));
    as_daily(&key(1), 2_000 * SEC);
    let o = refused(m.send_small(Some(accounts(3)), U128(11), accounts(2)));
    assert_eq!((o.refused.as_deref(), o.strikes), (Some("over the 24 h limit"), 1));
}

// ---- F1: the era is cached before the lockdown fan-out, which runs in its own receipt -------

#[test]
fn trip_caches_the_era_first_and_schedules_lock_down_in_a_separate_receipt() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.register_intents_key(key(3));
    as_callback(2_000 * SEC);
    assert_eq!(m.on_era(Ok(Era::Kaigen)), Era::Kaigen);
    assert_eq!(m.era(), Era::Kaigen);
    let r = receipts_text();
    assert_eq!(r.matches("lock_down").count(), 1, "{r}");
    assert!(!r.contains("DeleteKey") && !r.contains("remove_public_key"), "the fan-out must not share on_era's receipt: {r}");
    assert_eq!(m.daily_keys(), vec![key(1)], "the keys go in the lock_down receipt");
}

#[test]
fn a_lock_down_that_never_ran_leaves_the_cached_era_and_the_next_trip_runs_it_again() {
    let mut m = setup();
    as_callback(2_000 * SEC);
    m.on_era(Ok(Era::Kaigen));
    // Suppose the lock_down receipt ran out of gas: none of its effects are kept, the era is.
    assert_eq!((m.era(), m.daily_keys()), (Era::Kaigen, vec![key(1)]));
    as_callback(2_100 * SEC);
    assert_eq!(m.on_era(Ok(Era::Kaigen)), Era::Kaigen);
    assert_eq!(event("trip").unwrap()["data"]["changed"], false);
    assert_eq!(receipts_text().matches("lock_down").count(), 1);
    lock_down_at(&mut m, 2_101 * SEC);
    assert!(m.daily_keys().is_empty());
    // Once it is done, tripping again is harmless.
    as_callback(2_200 * SEC);
    m.on_era(Ok(Era::Kaigen));
    lock_down_at(&mut m, 2_201 * SEC);
    assert!(!receipts_text().contains("DeleteKey"));
}

#[test]
fn a_calm_or_warning_trip_schedules_no_lock_down() {
    let mut m = setup();
    as_callback(2_000 * SEC);
    m.on_era(Ok(Era::Calm));
    assert!(!receipts_text().contains("lock_down"));
    m.on_era(Ok(Era::Warning));
    assert!(!receipts_text().contains("lock_down"));
}

#[test]
fn lock_down_runs_only_at_kaigen() {
    let mut m = setup();
    as_callback(2_001 * SEC);
    assert!(panics_with(|| m.lock_down()).contains("kaigen"));
    assert_eq!(m.daily_keys(), vec![key(1)]);
}

/// A callback that was given exactly this much gas, as `lock_down` is when `trip` carries the minimum.
fn as_callback_with_gas(now: u64, gas: Gas) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .predecessor_account_id(vault())
        .signer_account_id(vault())
        .block_timestamp(now)
        .prepaid_gas(gas);
    testing_env!(b.build());
}

/// Worst case: 8 daily keys, 8 intents keys and a full queue, locked down by repeated `lock_down` receipts
/// that are each given `given` gas. Returns the (daily, intents) keys still recorded after each pass.
/// Measured, the whole job costs over 400 Tgas, more than a transaction can carry, so a pass must never
/// start what it cannot afford.
fn lockdown_at_maximum_load(given: Gas) -> Vec<(u32, u32)> {
    let mut m = setup();
    as_admin(1_100 * SEC);
    for n in 2..=MAX_DAILY_KEYS as u8 {
        let _ = m.add_daily_key(key(n), None);
    }
    for n in 11..11 + MAX_INTENTS_KEYS as u8 {
        let _ = m.register_intents_key(key(n));
    }
    as_daily(&key(1), 2_000 * SEC);
    for _ in 0..MAX_QUEUE {
        m.request_withdraw(None, U128(1), accounts(2));
    }
    as_callback(2_100 * SEC);
    m.on_era(Ok(Era::Kaigen));

    let (mut deletes, mut intents_calls, mut passes, mut left) = (0, 0, 0u64, Vec::new());
    while !(m.daily_keys().is_empty() && m.intents_keys().is_empty() && m.queue().is_empty()) {
        passes += 1;
        assert!(passes <= 5, "lockdown must finish in a few trips");
        as_callback_with_gas(2_101 * SEC + passes * SEC, given);
        m.lock_down();
        let used = env::used_gas().as_gas();
        println!("given {} Tgas, pass {passes}: used {} Tgas; left {} daily, {} intents", given.as_gas() / 10u64.pow(12), used / 10u64.pow(12), m.daily_keys().len(), m.intents_keys().len());
        assert!(used <= given.as_gas(), "pass {passes} used {used} gas, it was given {}", given.as_gas());
        let r = receipts_text();
        deletes += r.matches("DeleteKey").count();
        intents_calls += r.matches("remove_public_key").count();
        left.push((m.daily_keys().len() as u32, m.intents_keys().len() as u32));
        if passes == 1 {
            assert!(event("lockdown_partial").is_some(), "a pass that stops early says so");
        }
    }
    assert_eq!((deletes, intents_calls), (MAX_DAILY_KEYS as usize, MAX_INTENTS_KEYS as usize));
    assert!(event("lockdown_partial").is_none(), "the last pass leaves nothing behind");
    left
}

// ---- R1: the keys that can still act come off first, and the order is the keeper's completion signal --

#[test]
fn lock_down_removes_intents_keys_before_daily_keys() {
    // 150 is the least `lock_down` is given; 190 is about what `on_era` has left for it out of the
    // 200 Tgas `trip` gives it.
    for given in [LOCK_DOWN_GAS, Gas::from_tgas(190)] {
        let passes = lockdown_at_maximum_load(given);
        let given = given.as_gas() / 10u64.pow(12);
        // An intents key can sign on `intents.near` without going through Mamori. A daily key cannot do
        // anything once the era is cached: `send_small` and `request_withdraw` refuse at kaigen.
        let (daily, intents) = passes[0];
        assert!(intents < MAX_INTENTS_KEYS as u32, "{given} Tgas: the first pass must start on the intents keys");
        assert_eq!(daily, MAX_DAILY_KEYS as u32, "{given} Tgas: no daily key may go while an intents key is left");
        for (n, &(daily, intents)) in passes.iter().enumerate() {
            // So no daily key is started while an intents removal is left to start.
            assert!(daily == MAX_DAILY_KEYS as u32 || intents == 0, "{given} Tgas, pass {}: {daily} daily and {intents} intents left", n + 1);
        }
    }
}

#[test]
fn lock_down_never_overspends_even_the_least_gas_it_is_ever_given() {
    lockdown_at_maximum_load(LOCK_DOWN_GAS);
}

// ---- F8: lockdown says what it threw away ---------------------------------------------------

#[test]
fn lock_down_logs_every_withdrawal_it_discards() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    let a = m.request_withdraw(None, U128(NEAR), accounts(2));
    let b = m.request_withdraw(None, U128(2), accounts(3));
    as_callback(2_100 * SEC);
    m.on_era(Ok(Era::Kaigen));
    lock_down_at(&mut m, 2_101 * SEC);
    assert!(m.queue().is_empty());
    let e = event("queue_discarded").expect("lockdown must log what it discarded");
    assert_eq!(e["data"]["reason"], "lockdown");
    let list = e["data"]["withdrawals"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    let find = |id: U64| list.iter().find(|w| w["id"] == serde_json::json!(id)).expect("listed");
    assert_eq!((find(a)["amount"].as_str(), find(a)["to"].as_str()), (Some(NEAR.to_string().as_str()), Some(accounts(2).as_str())));
    assert_eq!((find(b)["amount"].as_str(), find(b)["to"].as_str()), (Some("2"), Some(accounts(3).as_str())));
    assert!(find(a)["requested_by"].is_string());
}

#[test]
fn lock_down_with_an_empty_queue_logs_no_discard_event() {
    let mut m = setup();
    as_callback(2_100 * SEC);
    m.on_era(Ok(Era::Kaigen));
    lock_down_at(&mut m, 2_101 * SEC);
    assert!(event("queue_discarded").is_none());
}

// ---- the production delay floor -------------------------------------------------------------

#[cfg(not(feature = "drill"))]
#[test]
fn init_enforces_the_named_delay_floor_and_its_message_follows_it() {
    as_admin(1_000 * SEC);
    let msg = panics_with(|| {
        Mamori::init(accounts(1), U128(NEAR), MIN_DELAY_SECS - 1);
    });
    assert!(msg.contains(&format!("at least {} hours", MIN_DELAY_SECS / 3600)), "{msg}");
    let _ = Mamori::init(accounts(1), U128(NEAR), MIN_DELAY_SECS);
}

// ---- R4: the state layout is frozen until a migration exists --------------------------------------

/// Borsh bytes of a fresh vault, as hex. Nothing runs on mainnet yet and the testnet drill vaults are
/// throwaway, so the layout may still change: when it does, rebuild this string from the failure message.
/// From the first mainnet deploy on, a change here means every deployed vault fails to read its state (and
/// `trip` with it): write a `migrate` that reads the old layout first, and only then update this string.
const FRESH_STATE_HEX: &str = "03000000626f62000000a1edccce1bc2d30000000000008051010000000000000000000002000000647602000000646d0000000002000000697602000000696d010000006c010000007001000000720000a0dec5adc935360000000000000001000000770000000002000000717602000000716d00000000000000000000000002000000617602000000616d000300000001000000730000000002000000787602000000786d";

#[test]
fn the_state_layout_is_pinned_so_a_change_cannot_brick_a_deployed_vault_unnoticed() {
    as_admin(1_000 * SEC);
    let m = Mamori::init(accounts(1), U128(NEAR), 86_400);
    let hex: String = near_sdk::borsh::to_vec(&m).unwrap().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, FRESH_STATE_HEX, "the state layout changed: see the note above FRESH_STATE_HEX");
}
