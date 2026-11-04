//! Open item 1 of v3: the records of keys awaiting the account's confirmation of their deletion are bounded.
//!
//! The design (docs/v3/LOSS-BOUND.md, section 8): `add_daily_key` is the only call that makes the records grow, so it
//! is the only one that refuses when served plus awaiting-deletion keys reach `MAX_KEY_RECORDS`. Removing or burning a
//! key moves it from one set to the other and is never refused, so containment cannot be blocked by a full set.
//! `forget_revoked_key` is the admin's way out for a delete the account can never confirm. `lock_down` reads at most
//! `MAX_KEY_RECORDS` of the revoked set, whatever the set holds.

use super::*;
use near_sdk::borsh::BorshDeserialize;

/// A distinct ed25519 key for any index (`key(n)` only has 256).
fn many_key(i: u32) -> PublicKey {
    let mut bytes = vec![9u8; 32];
    bytes[..4].copy_from_slice(&i.to_le_bytes());
    PublicKey::from_parts(CurveType::ED25519, bytes).unwrap()
}

/// How many keys the vault records in all, served or awaiting deletion.
fn records(m: &Mamori) -> u32 {
    m.daily_keys().len() as u32 + m.revoked_keys().len() as u32
}

/// A vault holding exactly `MAX_KEY_RECORDS - 1` records: 8 keys removed (their deletes never confirmed) and 7 served
/// (`key(11)..=key(17)`), with the clock at 1_100 s. The next `add_daily_key` is the last one the cap lets in.
fn one_below_the_cap() -> Mamori {
    let mut m = setup(); // key 1 served
    as_admin(1_100 * SEC);
    for n in 2..=MAX_DAILY_KEYS as u8 {
        let _ = m.add_daily_key(key(n), None);
    }
    for n in 1..=MAX_DAILY_KEYS as u8 {
        let _ = m.remove_daily_key(key(n));
    }
    assert_eq!(m.revoked_keys().len(), MAX_DAILY_KEYS as usize);
    for n in 11..=17u8 {
        let _ = m.add_daily_key(key(n), None);
    }
    assert_eq!(records(&m), MAX_KEY_RECORDS - 1);
    m
}

/// `one_below_the_cap` plus one more key served: the records are full. Key 18 is the one added.
fn at_the_cap() -> Mamori {
    let mut m = one_below_the_cap();
    as_admin(1_101 * SEC);
    let _ = m.add_daily_key(key(18), None);
    assert_eq!(records(&m), MAX_KEY_RECORDS);
    m
}

#[test]
fn the_cap_is_twice_the_daily_key_limit() {
    assert_eq!(MAX_KEY_RECORDS, 2 * MAX_DAILY_KEYS);
    assert_eq!(MAX_KEY_RECORDS, 16);
}

#[test]
fn add_daily_key_takes_the_last_record_and_refuses_the_next_one() {
    let mut m = one_below_the_cap();
    as_admin(1_101 * SEC);
    let _ = m.add_daily_key(key(18), None); // 15 -> 16 records: allowed
    assert_eq!(records(&m), MAX_KEY_RECORDS);
    // Free a served slot without freeing a record: key 18 is removed, its delete is not confirmed.
    as_admin(1_102 * SEC);
    let _ = m.remove_daily_key(key(18));
    assert_eq!((m.daily_keys().len(), m.revoked_keys().len()), (7, 9));
    as_admin(1_103 * SEC);
    let reason = panics_with(|| {
        let _ = m.add_daily_key(key(19), None);
    });
    assert_eq!(reason, "too many keys awaiting deletion: confirm or forget some first");
    // The refused add recorded nothing and scheduled nothing.
    assert_eq!(records(&m), MAX_KEY_RECORDS);
    assert!(!m.daily_keys().contains(&key(19)));
    assert!(!receipts_text().contains("AddKey"), "{}", receipts_text());
    assert!(event("add_daily_key").is_none());
}

#[test]
fn the_older_refusals_keep_their_place_ahead_of_the_new_one() {
    // Eight served keys: "too many daily keys" is still what the admin hears (and a revoked key still says why).
    let mut m = at_the_cap();
    assert_eq!(m.daily_keys().len(), MAX_DAILY_KEYS as usize);
    as_admin(1_102 * SEC);
    assert!(panics_with(|| {
        let _ = m.add_daily_key(key(19), None);
    })
    .contains("too many daily keys"));
    assert!(panics_with(|| {
        let _ = m.add_daily_key(key(1), None);
    })
    .contains("revoked key: its deletion is not confirmed yet"));
}

#[test]
fn burning_and_removing_are_never_blocked_by_full_records() {
    let mut m = at_the_cap();
    let served_before = m.daily_keys().len();
    // A burn: three counted refusals from key 11. The records are full, and the burn must still complete.
    let mut last = None;
    for n in 0..3u64 {
        last = Some(attack_as(&mut m, &key(11), (2_000 + n) * SEC));
    }
    assert!(last.unwrap().burned, "the third counted refusal burns the key whatever the records hold");
    assert!(receipts_text().contains("DeleteKey"), "and its delete is scheduled: {}", receipts_text());
    assert!(!m.daily_keys().contains(&key(11)), "no longer served");
    assert!(m.revoked_keys().contains(&key(11)), "and owed its deletion, recorded");
    assert_eq!(m.daily_keys().len(), served_before - 1);
    // An admin removal likewise.
    as_admin(2_010 * SEC);
    let _ = m.remove_daily_key(key(12));
    assert!(receipts_text().contains("DeleteKey"), "{}", receipts_text());
    assert!(m.revoked_keys().contains(&key(12)));
    // The sum never moved: keys only changed sets.
    assert_eq!(records(&m), MAX_KEY_RECORDS);
    assert_books_are_consistent(&m);
}

#[test]
fn forgetting_a_revoked_key_frees_a_record_and_the_key_may_return() {
    let mut m = one_below_the_cap();
    as_admin(1_101 * SEC);
    let _ = m.add_daily_key(key(18), None);
    as_admin(1_102 * SEC);
    let _ = m.remove_daily_key(key(18)); // 16 records, 7 served: an add is refused
    as_admin(1_103 * SEC);
    assert!(panics_with(|| {
        let _ = m.add_daily_key(key(19), None);
    })
    .contains("too many keys awaiting deletion"));

    // The admin has seen on the account that key 1 is not there: forget it.
    as_admin(1_104 * SEC);
    m.forget_revoked_key(key(1));
    let r = receipts_text();
    assert!(!r.contains("DeleteKey") && !r.contains("AddKey") && !r.contains("Transfer"), "it schedules nothing: {r}");
    assert!(!m.revoked_keys().contains(&key(1)));
    assert_eq!(records(&m), MAX_KEY_RECORDS - 1);
    let e = event("remove_daily_key").expect("it is logged");
    assert_eq!(
        (e["data"]["public_key"].clone(), e["data"]["retry"].clone(), e["data"]["forgotten"].clone()),
        (serde_json::json!(key(1)), serde_json::json!(false), serde_json::json!(true)),
        "{e}"
    );

    // The freed record lets another key in, and the forgotten key itself is no longer blocked as revoked.
    as_admin(1_105 * SEC);
    let _ = m.add_daily_key(key(1), None);
    assert!(m.daily_keys().contains(&key(1)));
    assert!(receipts_text().contains("AddKey"));
    assert_eq!(records(&m), MAX_KEY_RECORDS);
    assert_books_are_consistent(&m);

    // A delete callback that arrives for a forgotten key, failed or not, leaves no phantom record behind.
    m.forget_revoked_key(key(2));
    callback_after_failure(1_106 * SEC);
    m.on_revoked_key_deleted(key(2));
    assert!(!m.revoked_keys().contains(&key(2)), "a failed callback does not bring a forgotten key back");
    callback_after_success(1_107 * SEC);
    m.on_revoked_key_deleted(key(2));
    assert!(!m.revoked_keys().contains(&key(2)));
}

#[test]
fn only_a_revoked_key_can_be_forgotten_and_a_refused_call_changes_nothing() {
    let mut m = one_below_the_cap();
    let before = (m.daily_keys(), m.revoked_keys());
    as_admin(1_200 * SEC);
    for k in [key(11), key(99)] {
        // key 11 is served, key 99 was never seen
        assert_eq!(panics_with(|| m.forget_revoked_key(k.clone())), "not a revoked key");
    }
    assert_eq!((m.daily_keys(), m.revoked_keys()), before, "a served key stays served, nothing is invented");
    // Once forgotten, a second call has nothing left to forget.
    m.forget_revoked_key(key(1));
    assert_eq!(panics_with(|| m.forget_revoked_key(key(1))), "not a revoked key");
    as_anyone(1_201 * SEC);
    assert_eq!(panics_with(|| m.forget_revoked_key(key(2))), "admin only");
    assert!(m.revoked_keys().contains(&key(2)));
}

/// What the `lock_down` pass costs in the unit VM, which charges the host's real fees, when the revoked set holds
/// `n` keys. `n` above `MAX_KEY_RECORDS` is a state `add_daily_key` cannot produce; it is written straight into the
/// set to show that the read is bounded by the guard and not only by the rule above it.
fn lock_down_with_revoked(n: u32, given: Gas) -> (u64, usize, u32) {
    // The mock chain is per thread and keeps its storage between contexts, so each run gets a thread of its own.
    std::thread::spawn(move || lock_down_with_revoked_on_this_chain(n, given))
        .join()
        .unwrap_or_else(|e| std::panic::resume_unwind(e))
}

fn lock_down_with_revoked_on_this_chain(n: u32, given: Gas) -> (u64, usize, u32) {
    // Store the vault the way a chain would, under a context with gas to spare for the writes.
    let mut m = setup();
    as_callback_with_gas(1_500 * SEC, Gas::from_tgas(1_000_000));
    m.daily_keys.remove(&key(1));
    m.era = Era::Kaigen;
    for i in 0..n {
        m.revoked_keys.insert(many_key(i));
    }
    let state = near_sdk::borsh::to_vec(&m).expect("state serialises");
    drop(m); // flushes the collections to storage
    // Then read it back under the gas a `lock_down` receipt is given, as the next receipt on the chain would.
    as_callback_with_gas(2_001 * SEC, given);
    // Never dropped: a drop would flush, and a pass that ran out of gas must fail the test, not abort the run.
    let mut m = std::mem::ManuallyDrop::new(Mamori::try_from_slice(&state).expect("the stored state reads back"));
    m.lock_down();
    let used = env::used_gas().as_gas();
    // The set's length, not the view: the view would read all of it and spend the test's own gas.
    (used, receipts_text().matches("DeleteKey").count(), m.revoked_keys.len())
}

#[test]
fn lock_down_reads_a_bounded_part_of_the_revoked_set_whatever_it_holds() {
    let given = LOCK_DOWN_GAS;
    let (at_cap_used, at_cap_deletes, _) = lock_down_with_revoked(MAX_KEY_RECORDS, given);
    println!("lock_down with {MAX_KEY_RECORDS} revoked keys: {} Ggas, {at_cap_deletes} deletes started", at_cap_used / 1_000_000_000);
    assert!(at_cap_used <= given.as_gas());
    assert!(at_cap_deletes > 0, "and it does start deletes");
    // A set far past anything the rule allows: the pass costs what it costs at the cap (plus the length read), and
    // never starts more deletes than the cap.
    let (huge_used, huge_deletes, left) = lock_down_with_revoked(2_000, given);
    println!("lock_down with 2000 revoked keys: {} Ggas, {huge_deletes} deletes started", huge_used / 1_000_000_000);
    assert!(huge_used <= given.as_gas(), "used {huge_used} of {} given", given.as_gas());
    assert!(huge_deletes <= MAX_KEY_RECORDS as usize, "{huge_deletes} deletes started");
    assert_eq!(left, 2_000, "nothing is confirmed by trying, every key stays recorded");
    assert!(huge_used < at_cap_used + 5_000_000_000, "reading 2000 keys cost {huge_used} against {at_cap_used} for {MAX_KEY_RECORDS}");
}

#[test]
fn the_records_never_exceed_the_cap_through_a_mixed_run_of_adds_removals_burns_and_forgets() {
    // A deterministic walk that tries to grow the records every way the admin and a hijacked key can.
    let mut m = setup();
    let mut next_key = 2u32;
    let mut t = 3_000u64;
    let mut refused_adds = 0u32;
    for step in 0..400u32 {
        t += 1;
        match step % 5 {
            // Add a fresh key (refused when the records are full or eight keys are served).
            0 | 1 => {
                as_admin(t * SEC);
                let k = many_key(next_key);
                next_key += 1;
                let tried = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _ = m.add_daily_key(k.clone(), None);
                }));
                if tried.is_err() {
                    refused_adds += 1; // refused before anything was recorded, as the books check below confirms
                }
            }
            // Remove the first served key; its delete never confirms.
            2 => {
                as_admin(t * SEC);
                if let Some(k) = m.daily_keys().first().cloned() {
                    let _ = m.remove_daily_key(k);
                }
            }
            // Burn the last served key by three counted refusals.
            3 => {
                if let Some(k) = m.daily_keys().last().cloned() {
                    for i in 0..3 {
                        attack_as(&mut m, &k, t * SEC + i);
                    }
                }
            }
            // Every fourth round the admin forgets one stuck record.
            _ => {
                if step % 20 == 4 {
                    as_admin(t * SEC);
                    if let Some(k) = m.revoked_keys().first().cloned() {
                        m.forget_revoked_key(k);
                    }
                }
            }
        }
        assert!(records(&m) <= MAX_KEY_RECORDS, "step {step}: {} records", records(&m));
        assert!(m.daily_keys().len() <= MAX_DAILY_KEYS as usize);
        assert_books_are_consistent(&m);
    }
    assert!(refused_adds > 0, "the walk never reached the cap, so it proved nothing");
}
