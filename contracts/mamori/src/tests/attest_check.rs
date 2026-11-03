//! M4c: `attest()`. The documented ABI is in docs/v3/ATTEST-CHECK.md; `check_view.rs` ties the fields to it.

use super::*;
use near_sdk::borsh::BorshDeserialize;
use near_sdk::env::set_blockchain_interface;
use near_sdk::mock::with_mocked_blockchain;
use near_sdk::{test_vm_config, MockedBlockchain, RuntimeFeesConfig};

/// A call from a stranger, as a view would see the chain, and the storage the vault had before it.
pub(super) fn storage_untouched_by(m: Mamori, now: u64, f: impl FnOnce(&Mamori)) -> bool {
    let state = near_sdk::borsh::to_vec(&m).expect("state serialises");
    // Dropping the vault flushes its collections, so the storage taken next is what a chain would hold.
    drop(m);
    let before = with_mocked_blockchain(|b| b.take_storage());
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .predecessor_account_id(accounts(4))
        .signer_account_id(accounts(4))
        .block_timestamp(now)
        .account_balance(NearToken::from_near(100));
    set_blockchain_interface(MockedBlockchain::new(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        vec![],
        before.clone(),
        Default::default(),
        None,
    ));
    let read_back = Mamori::try_from_slice(&state).expect("the stored state reads back");
    f(&read_back);
    drop(read_back);
    let after = with_mocked_blockchain(|b| b.take_storage());
    before == after
}

pub(super) fn json<T: near_sdk::serde::Serialize>(v: &T) -> serde_json::Value {
    serde_json::to_value(v).unwrap()
}

pub(super) fn field_names(v: &serde_json::Value) -> Vec<String> {
    let mut names: Vec<String> = v.as_object().expect("a JSON object").keys().cloned().collect();
    names.sort();
    names
}

// ---- M4c: attest() --------------------------------------------------------------------------------------------

#[test]
fn attest_describes_a_fresh_vault_as_configured() {
    let m = setup_production();
    as_anyone(1_300 * SEC);
    let a = m.attest();
    assert_eq!(a.attest_version, 1);
    assert_eq!(a.contract, "mamori");
    assert_eq!(a.drill_build, cfg!(feature = "drill"));
    assert_eq!(a.account_id, vault());
    assert_eq!(a.block_timestamp, U64(1_300 * SEC));
    assert_eq!(json(&a.config), json(&m.config()), "the config is the config view");
    assert_eq!(a.config.delay_secs, TEST_DELAY);
    assert_eq!(a.config.era, Era::Calm);
    assert_eq!(a.config.daily_limit, U128(NEAR));
    assert_eq!(a.config.max_strikes, DEFAULT_MAX_STRIKES);
    assert_eq!(a.min_delay_secs, 86_400, "the production floor, so a reader does not hard-code it");
    assert!(!a.allowlist_enforced);
    assert_eq!(a.allowlist_len, 0);
    assert_eq!(a.daily_keys.len(), 1);
    assert_eq!((a.daily_keys[0].public_key.clone(), a.daily_keys[0].strikes), (key(1), 0));
    assert!(a.intents_keys.is_empty() && a.revoked_keys.is_empty());
    assert_eq!(a.queue_len, 0);
    assert!(a.note.contains("informational") && a.note.contains("view_access_key_list"), "{}", a.note);
}

#[test]
fn attest_reports_the_block_it_is_as_of() {
    let m = setup();
    as_anyone(7_777 * SEC);
    let a = m.attest();
    assert_eq!(a.block_timestamp, U64(7_777 * SEC));
    assert_eq!(a.block_height, U64(env::block_height()));
}

#[test]
fn attest_reports_every_recorded_key_and_each_setting_as_the_admin_set_it() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    let _ = m.register_intents_key(key(3));
    let _ = m.register_intents_key(key(4));
    m.set_max_strikes(4);
    m.set_min_send(U128(5));
    m.set_pending_limit(None, U128(2 * NEAR));
    m.allow_recipient(accounts(2));
    m.allow_recipient(accounts(3));
    m.enforce_allowlist(true);
    as_daily(&key(2), 1_200 * SEC);
    m.request_withdraw(None, U128(1), accounts(2));
    as_anyone(1_300 * SEC);
    let a = m.attest();
    assert_eq!(a.config.max_strikes, 4);
    assert_eq!(a.config.min_send, U128(5));
    assert_eq!(a.config.pending_limit, U128(2 * NEAR));
    assert!(a.allowlist_enforced);
    assert_eq!(a.allowlist_len, 2);
    let served: Vec<(PublicKey, u32)> = a.daily_keys.iter().map(|k| (k.public_key.clone(), k.strikes)).collect();
    assert_eq!(served, vec![(key(1), 0), (key(2), 0)]);
    assert_eq!(a.intents_keys, vec![key(3), key(4)], "a key on intents.near is reported, whether or not it is also a daily key");
    assert!(a.revoked_keys.is_empty());
    assert_eq!(a.queue_len, 1);
}

#[test]
fn attest_gives_each_daily_key_its_own_strikes() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    m.enforce_allowlist(true);
    // Key 1 is refused twice (a payee off the allowlist counts), key 2 once.
    for (k, at) in [(1u8, 2_000u64), (1, 2_001), (2, 2_002)] {
        as_daily(&key(k), at * SEC);
        assert!(refused(m.send_small(None, U128(1), accounts(2))).strikes >= 1);
    }
    as_anyone(2_010 * SEC);
    let served: Vec<(PublicKey, u32)> = m.attest().daily_keys.iter().map(|k| (k.public_key.clone(), k.strikes)).collect();
    assert_eq!(served, vec![(key(1), 2), (key(2), 1)]);
    // And the strikes are those of the window: a day on, they have lapsed.
    as_anyone(2_002 * SEC + DAY_NS + SEC);
    let later: Vec<u32> = m.attest().daily_keys.iter().map(|k| k.strikes).collect();
    assert_eq!(later, vec![0, 0]);
}

#[test]
fn attest_moves_a_burned_key_from_served_to_revoked_and_clears_it_when_the_delete_is_confirmed() {
    let mut m = setup();
    for n in 0..3 {
        attack(&mut m, (2_000 + n) * SEC);
    }
    as_anyone(2_010 * SEC);
    let a = m.attest();
    assert!(a.daily_keys.is_empty(), "the vault no longer serves the burned key");
    assert_eq!(a.revoked_keys, vec![key(1)], "but its deletion is not confirmed, and cage-check can see that");
    callback_after_success(2_011 * SEC);
    m.on_revoked_key_deleted(key(1));
    as_anyone(2_012 * SEC);
    assert!(m.attest().revoked_keys.is_empty());
    // A removed key takes the same road.
    as_admin(2_020 * SEC);
    let _ = m.add_daily_key(key(2), None);
    let _ = m.remove_daily_key(key(2));
    as_anyone(2_021 * SEC);
    let a = m.attest();
    assert!(a.daily_keys.is_empty());
    assert_eq!(a.revoked_keys, vec![key(2)]);
}

#[test]
fn attest_reports_the_cached_era() {
    let mut m = setup();
    m.era = Era::Warning;
    as_anyone(2_000 * SEC);
    assert_eq!(m.attest().config.era, Era::Warning);
    m.era = Era::Kaigen;
    assert_eq!(m.attest().config.era, Era::Kaigen);
}

/// The ABI cage-check reads. A rename or a dropped field fails here, on purpose.
#[test]
fn attest_has_exactly_the_documented_fields() {
    let m = setup();
    as_anyone(2_000 * SEC);
    let v = json(&m.attest());
    assert_eq!(
        field_names(&v),
        [
            "account_id",
            "allowlist_enforced",
            "allowlist_len",
            "attest_version",
            "block_height",
            "block_timestamp",
            "config",
            "contract",
            "daily_keys",
            "drill_build",
            "intents_keys",
            "min_delay_secs",
            "note",
            "queue_len",
            "revoked_keys",
        ]
    );
    assert_eq!(
        field_names(&v["config"]),
        ["daily_limit", "delay_secs", "effective_delay_secs", "era", "kizashi", "max_strikes", "min_send", "pending_limit"]
    );
    assert_eq!(field_names(&v["daily_keys"][0]), ["public_key", "strikes"]);
    // Numbers that exceed 2^53 travel as strings, so a JavaScript reader keeps them exact.
    assert!(v["block_timestamp"].is_string() && v["block_height"].is_string());
    assert!(v["config"]["daily_limit"].is_string());
    // What it must not claim to know: no code hash and no admin key.
    for absent in ["code_hash", "admin_key", "admin_key_hash", "access_keys", "full_access_keys"] {
        assert!(v.get(absent).is_none(), "attest must not carry {absent}");
    }
}

#[test]
fn attest_is_a_view_it_writes_nothing_logs_nothing_and_schedules_nothing() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    let _ = m.register_intents_key(key(3));
    as_daily(&key(1), 1_200 * SEC);
    m.request_withdraw(None, U128(1), accounts(2));
    assert!(
        storage_untouched_by(m, 1_300 * SEC, |v| {
            let first = json(&v.attest());
            assert_eq!(first, json(&v.attest()), "same answer twice");
            assert!(get_logs().is_empty(), "no events: {:?}", get_logs());
            assert!(get_created_receipts().is_empty(), "no receipts");
        }),
        "attest changed storage"
    );
}

/// `attest()` and the single views are two ways to read the same books. If they ever disagree, one is wrong.
#[test]
fn attest_agrees_with_the_single_views_through_a_mixed_run() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    let _ = m.add_daily_key(key(3), None);
    let _ = m.register_intents_key(key(4));
    for n in 0..3 {
        attack(&mut m, (2_000 + n) * SEC);
    }
    as_admin(2_100 * SEC);
    let _ = m.remove_daily_key(key(3));
    as_anyone(2_200 * SEC);
    let a = m.attest();
    assert_eq!(a.daily_keys.iter().map(|k| k.public_key.clone()).collect::<Vec<_>>(), m.daily_keys());
    for k in &a.daily_keys {
        assert_eq!(k.strikes, m.strikes_of(k.public_key.clone()));
    }
    assert_eq!(a.intents_keys, m.intents_keys());
    assert_eq!(a.revoked_keys, m.revoked_keys());
    assert_eq!(json(&a.config), json(&m.config()));
    assert_eq!(a.allowlist_len as usize, m.allowlist().accounts.len());
    assert_eq!(a.allowlist_enforced, m.allowlist().enforced);
    assert_eq!(a.queue_len as usize, m.queue().len());
    assert_eq!(a.revoked_keys.len(), 2, "the burned key and the removed one");
}

/// A drill vault says so, and reports a delay under the production floor: that is what makes the loss bound's
/// delay condition visible to a reader that only has this answer.
#[cfg(feature = "drill")]
#[test]
fn a_drill_vault_says_it_is_a_drill_build_and_shows_a_delay_under_the_floor() {
    as_admin(1_000 * SEC);
    let m = Mamori::init(accounts(1), U128(NEAR), 60);
    as_anyone(1_001 * SEC);
    let a = m.attest();
    assert!(a.drill_build);
    assert_eq!(a.config.delay_secs, 60);
    assert!(a.config.delay_secs < a.min_delay_secs);
}

#[cfg(not(feature = "drill"))]
#[test]
fn a_production_vault_says_it_is_not_a_drill_build_and_cannot_start_under_the_floor() {
    let m = setup_production();
    as_anyone(1_001 * SEC);
    assert!(!m.attest().drill_build);
    as_admin(1_000 * SEC);
    assert!(panics_with(|| {
        let _ = Mamori::init(accounts(1), U128(NEAR), 60);
    })
    .contains("at least 24 hours"));
}
