//! M5a: the `check` view and the reason codes. Advisory: the real enforcement is `send_small` and `execute`.
//! The documented ABI and the reason table are in docs/v3/ATTEST-CHECK.md, and two tests here tie the code to it.

use super::attest_check::{field_names, json, storage_untouched_by};
use super::*;

const ALL_REASONS: [Reason; 10] = [
    Reason::Ok,
    Reason::NotAllowlisted,
    Reason::OverCapTotal,
    Reason::CapExhausted,
    Reason::NoLimit,
    Reason::BelowMinSend,
    Reason::NotADailyKey,
    Reason::EraNotCalm,
    Reason::ZeroAmount,
    Reason::TransferFailed,
];

/// `check` called by a stranger in a block at `now`, as a view is.
fn check_at(m: &Mamori, now: u64, k: &PublicKey, asset: Option<AccountId>, amount: u128, to: AccountId) -> CheckView {
    as_anyone(now);
    m.check(k.clone(), asset, U128(amount), to)
}

/// The five facts of an answer, for compact assertions: verdict, reason, counted, would_burn, headroom.
fn facts(c: &CheckView) -> (Verdict, Reason, bool, bool, u128) {
    (c.verdict, c.reason, c.counted, c.would_burn, c.headroom.0)
}

#[test]
fn check_allows_what_send_small_would_send_and_reports_the_headroom() {
    let mut m = setup();
    let c = check_at(&m, 2_000 * SEC, &key(1), None, NEAR / 4, accounts(2));
    assert_eq!(facts(&c), (Verdict::Allow, Reason::Ok, false, false, NEAR));
    as_daily(&key(1), 2_000 * SEC);
    assert_sent(m.send_small(None, U128(NEAR / 4), accounts(2)));
    let c = check_at(&m, 2_001 * SEC, &key(1), None, NEAR / 4, accounts(2));
    assert_eq!(facts(&c), (Verdict::Allow, Reason::Ok, false, false, NEAR - NEAR / 4), "headroom follows the spend");
    // An amount equal to the headroom still goes through.
    let c = check_at(&m, 2_001 * SEC, &key(1), None, NEAR - NEAR / 4, accounts(2));
    assert_eq!(c.verdict, Verdict::Allow);
}

#[test]
fn check_reason_not_allowlisted_is_a_counted_refusal_and_says_when_it_is_the_last() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.enforce_allowlist(true);
    let c = check_at(&m, 2_000 * SEC, &key(1), None, 1, accounts(2));
    assert_eq!(facts(&c), (Verdict::Refuse, Reason::NotAllowlisted, true, false, NEAR));
    // Two strikes later the third is the last, and check says so before it happens.
    for at in [2_001, 2_002] {
        as_daily(&key(1), at * SEC);
        refused(m.send_small(None, U128(1), accounts(2)));
    }
    let c = check_at(&m, 2_003 * SEC, &key(1), None, 1, accounts(2));
    assert_eq!(facts(&c), (Verdict::Refuse, Reason::NotAllowlisted, true, true, NEAR));
    // An allowlisted payee is fine, struck key or not.
    as_admin(2_004 * SEC);
    m.allow_recipient(accounts(2));
    assert_eq!(check_at(&m, 2_005 * SEC, &key(1), None, 1, accounts(2)).verdict, Verdict::Allow);
}

#[test]
fn check_reason_over_cap_total_is_counted_even_when_the_window_is_empty_or_used() {
    let mut m = setup();
    let c = check_at(&m, 2_000 * SEC, &key(1), None, NEAR + 1, accounts(2));
    assert_eq!(facts(&c), (Verdict::Refuse, Reason::OverCapTotal, true, false, NEAR));
    // The window being used up does not turn "above the whole limit" into the uncounted kind.
    as_daily(&key(1), 2_001 * SEC);
    assert_sent(m.send_small(None, U128(NEAR / 2), accounts(2)));
    let c = check_at(&m, 2_002 * SEC, &key(1), None, NEAR + 1, accounts(2));
    assert_eq!((c.reason, c.counted, c.headroom.0), (Reason::OverCapTotal, true, NEAR / 2));
}

#[test]
fn check_reason_cap_exhausted_is_not_counted_and_never_burns() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    assert_sent(m.send_small(None, U128(NEAR - 10), accounts(2)));
    let c = check_at(&m, 2_001 * SEC, &key(1), None, 11, accounts(2));
    assert_eq!(facts(&c), (Verdict::Refuse, Reason::CapExhausted, false, false, 10));
    // Even for a key one strike from the burn: an uncounted refusal cannot burn.
    as_admin(2_002 * SEC);
    m.enforce_allowlist(true);
    m.allow_recipient(accounts(2));
    m.set_max_strikes(1);
    let c = check_at(&m, 2_003 * SEC, &key(1), None, 11, accounts(2));
    assert_eq!(facts(&c), (Verdict::Refuse, Reason::CapExhausted, false, false, 10));
    // A day later the window has aged out and the same call is allowed.
    let c = check_at(&m, 2_000 * SEC + DAY_NS + SEC, &key(1), None, 11, accounts(2));
    assert_eq!(facts(&c), (Verdict::Allow, Reason::Ok, false, false, NEAR));
}

#[test]
fn check_reason_no_limit_for_a_token_without_one_and_for_near_at_zero() {
    let mut m = setup();
    let c = check_at(&m, 2_000 * SEC, &key(1), Some(accounts(3)), 1, accounts(2));
    assert_eq!(facts(&c), (Verdict::Refuse, Reason::NoLimit, false, false, 0));
    m.daily_limit = 0;
    let c = check_at(&m, 2_001 * SEC, &key(1), None, 1, accounts(2));
    assert_eq!(facts(&c), (Verdict::Refuse, Reason::NoLimit, false, false, 0));
    // Listing the token turns it into an ordinary decision.
    as_admin(2_002 * SEC);
    m.set_token_limit(accounts(3), U128(100));
    let c = check_at(&m, 2_003 * SEC, &key(1), Some(accounts(3)), 100, accounts(2));
    assert_eq!(facts(&c), (Verdict::Allow, Reason::Ok, false, false, 100));
    let c = check_at(&m, 2_003 * SEC, &key(1), Some(accounts(3)), 101, accounts(2));
    assert_eq!(facts(&c), (Verdict::Refuse, Reason::OverCapTotal, true, false, 100));
}

#[test]
fn check_reason_below_min_send_applies_to_near_only() {
    let mut m = setup_production();
    let min = m.config().min_send.0;
    let c = check_at(&m, 2_000 * SEC, &key(1), None, min - 1, accounts(2));
    assert_eq!(facts(&c), (Verdict::Refuse, Reason::BelowMinSend, false, false, NEAR));
    assert_eq!(check_at(&m, 2_000 * SEC, &key(1), None, min, accounts(2)).verdict, Verdict::Allow, "the minimum itself is fine");
    as_admin(2_001 * SEC);
    m.set_token_limit(accounts(3), U128(100));
    assert_eq!(check_at(&m, 2_002 * SEC, &key(1), Some(accounts(3)), 1, accounts(2)).verdict, Verdict::Allow);
}

#[test]
fn check_reason_not_a_daily_key_for_a_stranger_a_removed_key_and_a_burned_key() {
    let mut m = setup();
    let c = check_at(&m, 2_000 * SEC, &key(9), None, 1, accounts(2));
    assert_eq!(facts(&c), (Verdict::Reject, Reason::NotADailyKey, false, false, NEAR));
    as_admin(2_001 * SEC);
    let _ = m.add_daily_key(key(2), None);
    assert_eq!(check_at(&m, 2_002 * SEC, &key(2), None, 1, accounts(2)).verdict, Verdict::Allow);
    as_admin(2_003 * SEC);
    let _ = m.remove_daily_key(key(2));
    assert_eq!(check_at(&m, 2_004 * SEC, &key(2), None, 1, accounts(2)).reason, Reason::NotADailyKey);
    for n in 0..3 {
        attack(&mut m, (2_100 + n) * SEC);
    }
    assert_eq!(check_at(&m, 2_200 * SEC, &key(1), None, 1, accounts(2)).reason, Reason::NotADailyKey);
}

#[test]
fn check_reason_era_not_calm_at_warning_and_at_kaigen() {
    let mut m = setup();
    m.era = Era::Warning;
    let c = check_at(&m, 2_000 * SEC, &key(1), None, 1, accounts(2));
    assert_eq!(facts(&c), (Verdict::Reject, Reason::EraNotCalm, false, false, NEAR));
    m.era = Era::Kaigen;
    assert_eq!(check_at(&m, 2_001 * SEC, &key(1), None, 1, accounts(2)).reason, Reason::EraNotCalm);
}

#[test]
fn check_reason_zero_amount() {
    let m = setup();
    let c = check_at(&m, 2_000 * SEC, &key(1), None, 0, accounts(2));
    assert_eq!(facts(&c), (Verdict::Reject, Reason::ZeroAmount, false, false, NEAR));
}

/// When two things are wrong at once, the first of the old checks speaks, exactly as `send_small` always did.
#[test]
fn check_reports_the_first_problem_in_the_order_send_small_has_always_checked() {
    let mut m = setup_production();
    as_admin(1_100 * SEC);
    m.enforce_allowlist(true);
    let (k, other) = (key(1), accounts(2));
    // A stranger key beats everything.
    m.era = Era::Warning;
    assert_eq!(check_at(&m, 2_000 * SEC, &key(9), None, 0, other.clone()).reason, Reason::NotADailyKey);
    // Then the era, then a zero amount.
    assert_eq!(check_at(&m, 2_000 * SEC, &k, None, 0, other.clone()).reason, Reason::EraNotCalm);
    m.era = Era::Calm;
    assert_eq!(check_at(&m, 2_000 * SEC, &k, None, 0, other.clone()).reason, Reason::ZeroAmount);
    // Then the allowlist, before the limit, the minimum and the window.
    assert_eq!(check_at(&m, 2_000 * SEC, &k, Some(accounts(3)), 1, other.clone()).reason, Reason::NotAllowlisted);
    as_admin(2_001 * SEC);
    m.allow_recipient(other.clone());
    // Then "no limit", before the minimum (a NEAR amount below the minimum is also under a zero limit).
    m.daily_limit = 0;
    assert_eq!(check_at(&m, 2_002 * SEC, &k, None, 1, other.clone()).reason, Reason::NoLimit);
    m.daily_limit = NEAR;
    // Then the minimum, before the window.
    assert_eq!(check_at(&m, 2_003 * SEC, &k, None, 1, other).reason, Reason::BelowMinSend);
}

#[test]
fn check_is_a_view_it_writes_nothing_logs_nothing_and_schedules_nothing_even_when_it_would_burn() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.enforce_allowlist(true);
    for at in [2_000, 2_001] {
        as_daily(&key(1), at * SEC);
        refused(m.send_small(None, U128(1), accounts(2)));
    }
    assert!(
        storage_untouched_by(m, 2_002 * SEC, |v| {
            let c = v.check(key(1), None, U128(1), accounts(2));
            assert!(c.would_burn && c.counted);
            assert_eq!(v.strikes_of(key(1)), 2, "the strike it warned about was not recorded");
            assert!(get_logs().is_empty(), "no events: {:?}", get_logs());
            assert!(get_created_receipts().is_empty(), "no receipts, so no DeleteKey");
        }),
        "check changed storage"
    );
}

/// The ABI cage-check and agents read.
#[test]
fn check_has_exactly_the_documented_fields_and_values() {
    let m = setup();
    let v = json(&check_at(&m, 2_000 * SEC, &key(1), None, NEAR + 1, accounts(2)));
    assert_eq!(field_names(&v), ["counted", "headroom", "reason", "verdict", "would_burn"]);
    assert_eq!(v["verdict"], "refuse");
    assert_eq!(v["reason"], "over_cap_total");
    assert_eq!(v["counted"], true);
    assert_eq!(v["would_burn"], false);
    assert!(v["headroom"].is_string(), "u128 travels as a string");
    assert_eq!(json(&Verdict::Allow), "allow");
    assert_eq!(json(&Verdict::Reject), "reject");
}

/// The code is a promise to machine readers. It is written by hand in `Reason::code`; this ties it to the JSON
/// name serde produces, and to the doc table, so none of the three can drift.
#[test]
fn every_reason_code_is_stable_distinct_and_in_the_doc_table() {
    let doc = include_str!("../../../../docs/v3/ATTEST-CHECK.md");
    let mut seen = std::collections::BTreeSet::new();
    for r in ALL_REASONS {
        assert_eq!(json(&r), r.code(), "{r:?}: serde name and code() differ");
        assert!(seen.insert(r.code()), "{} is not distinct", r.code());
        assert!(doc.contains(&format!("| `{}` |", r.code())), "docs/v3/ATTEST-CHECK.md has no table row for {}", r.code());
        assert!(!r.text().is_empty());
    }
    // The texts that existed before the codes did are unchanged: callers and tests match on them.
    assert_eq!(Reason::NotAllowlisted.text(), "recipient is not on the allowlist");
    assert_eq!(Reason::OverCapTotal.text(), "over the 24 h limit");
    assert_eq!(Reason::CapExhausted.text(), "over the 24 h limit");
    assert_eq!(Reason::NoLimit.text(), "no 24 h limit is set for this token");
    assert_eq!(Reason::BelowMinSend.text(), "below the minimum send");
    assert_eq!(Reason::NotADailyKey.text(), "not a recorded daily key");
    assert_eq!(Reason::EraNotCalm.text(), "paused: era is not calm");
    assert_eq!(Reason::ZeroAmount.text(), "amount must be > 0");
    assert_eq!(Reason::TransferFailed.text(), "the transfer failed and was refunded to the daily limit");
}

/// Every field `attest()` and `check` have is in the doc.
#[test]
fn every_attest_and_check_field_is_in_the_doc() {
    let doc = include_str!("../../../../docs/v3/ATTEST-CHECK.md");
    let m = setup();
    as_anyone(2_000 * SEC);
    let v = json(&m.attest());
    for name in field_names(&v).into_iter().chain(field_names(&v["config"])).chain(field_names(&v["daily_keys"][0])) {
        assert!(doc.contains(&format!("`{name}`")), "docs/v3/ATTEST-CHECK.md does not mention attest field {name}");
    }
    let c = json(&check_at(&m, 2_000 * SEC, &key(1), None, 1, accounts(2)));
    for name in field_names(&c) {
        assert!(doc.contains(&format!("`{name}`")), "docs/v3/ATTEST-CHECK.md does not mention check field {name}");
    }
}

/// The reason `send_small` gives when a transfer fails is the one the table names.
#[test]
fn the_failed_transfer_text_is_the_one_in_the_table() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    assert_sent(m.send_small(None, U128(5), accounts(2)));
    callback_after_failure(2_001 * SEC);
    let o = m.on_send_done(None, U128(5), U64(2_000 * SEC));
    assert_eq!(o.refused.as_deref(), Some(Reason::TransferFailed.text()));
}

/// The strongest test of "advisory": for hundreds of random calls in random states, ask `check` first and then
/// make the real call in the same block. The verdict, the reason, the strike, the burn and the headroom must all
/// match what `send_small` then does. (Between two blocks the state can change, and check says so in its docs;
/// within a block it must be exact.)
#[test]
fn check_matches_what_send_small_then_does_over_random_runs() {
    let mut rng = 0x00C0_FFEE_u64;
    let mut m = setup();
    as_admin(1_050 * SEC);
    let _ = m.add_daily_key(key(2), None);
    m.set_token_limit(accounts(3), U128(1_000));
    m.allow_recipient(accounts(2));
    let payees = [accounts(2), accounts(4)];
    let assets: [Option<AccountId>; 3] = [None, Some(accounts(3)), Some(accounts(1))];
    let mut now = 1_100 * SEC;
    let mut seen: std::collections::BTreeMap<&'static str, u32> = std::collections::BTreeMap::new();
    for step in 0..700u32 {
        now += (next(&mut rng) % 30_000) * SEC;
        if step % 41 == 0 {
            as_admin(now);
            m.enforce_allowlist(next(&mut rng) % 3 != 0);
            m.set_min_send(U128(if next(&mut rng) % 2 == 0 { 0 } else { 1_000 }));
            m.set_max_strikes(1 + (next(&mut rng) % 4) as u32);
        }
        m.daily_limit = if next(&mut rng) % 97 == 0 { 0 } else { NEAR };
        m.era = if next(&mut rng) % 20 == 0 { Era::Warning } else { Era::Calm };
        let k = [key(1), key(2), key(9)][(next(&mut rng) % 3) as usize].clone();
        let asset = assets[(next(&mut rng) % 3) as usize].clone();
        let palette: &[u128] = match &asset {
            None => &[0, 1, 500, NEAR / 1_000, NEAR / 3, NEAR / 2, NEAR, NEAR + 1, 2 * NEAR],
            Some(t) if *t == accounts(3) => &[0, 1, 300, 500, 1_000, 1_001, 2_000],
            Some(_) => &[0, 1, 10],
        };
        let amount = palette[(next(&mut rng) as usize) % palette.len()];
        let to = payees[(next(&mut rng) % 2) as usize].clone();

        // One block: the view and then the call, under the key's own context (the view reads no signer).
        as_daily(&k, now);
        let c = m.check(k.clone(), asset.clone(), U128(amount), to.clone());
        let limit = m.token_limit(asset.clone()).0;
        let spent = m.spent_24h(asset.clone()).0;
        assert_eq!(c.headroom.0, limit.saturating_sub(spent), "step {step}: headroom");
        *seen.entry(c.reason.code()).or_default() += 1;
        let strikes_before = m.strikes_of(k.clone());
        let open_before = m.open_strikes(&k, now).count;

        let real = try_call(|| m.send_small(asset.clone(), U128(amount), to.clone()));
        match real {
            Ok(PromiseOrValue::Promise(_)) => {
                assert_eq!((c.verdict, c.reason, c.counted, c.would_burn), (Verdict::Allow, Reason::Ok, false, false), "step {step}");
            }
            Ok(PromiseOrValue::Value(o)) => {
                assert!(!o.sent);
                assert_eq!(c.verdict, Verdict::Refuse, "step {step}: {c:?} vs {o:?}");
                assert_eq!(o.refused.as_deref(), Some(c.reason.text()), "step {step}");
                if c.counted {
                    assert_eq!(o.strikes, open_before + 1, "step {step}: a counted refusal adds one strike");
                } else {
                    assert_eq!((o.strikes, o.burned), (strikes_before, false), "step {step}: an uncounted refusal changes nothing");
                }
                assert_eq!(o.burned, c.would_burn, "step {step}: would_burn");
                if o.burned {
                    callback_after_success(now);
                    m.on_revoked_key_deleted(k.clone());
                    as_admin(now);
                    let _ = m.add_daily_key(k.clone(), None);
                }
            }
            Err(msg) => {
                assert_eq!(c.verdict, Verdict::Reject, "step {step}: {c:?} vs panic {msg}");
                assert!(msg.contains(c.reason.text()), "step {step}: panic {msg:?} vs reason {:?}", c.reason);
                assert!(!c.counted && !c.would_burn);
            }
        }
    }
    println!("check coverage by reason over {} calls: {seen:?}", 700);
    // The run reached every decision `check` can make; otherwise it proved less than it looks.
    for r in ALL_REASONS.iter().filter(|r| **r != Reason::TransferFailed) {
        assert!(seen.get(r.code()).copied().unwrap_or(0) >= 10, "reason {} reached only {:?} times: {seen:?}", r.code(), seen.get(r.code()));
    }
    assert!(!seen.contains_key("transfer_failed"), "check never reports a failed transfer");
}
