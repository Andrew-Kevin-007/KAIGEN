//! M5b: the extended `kaigen` events. These tests assert the event TEXT (the logged line, or the parsed data),
//! because the log is how a keeper or cage-check reads what happened. The reference is docs/v3/ATTEST-CHECK.md,
//! section 5; a test here ties the event names in `lib.rs` to that table.
//!
//! Every new field is additive: no field of a v2 event was removed, renamed or changed in meaning, so the envelope
//! version stays "1.0.0" (a reader pinned to it keeps working; it reads the new fields by name).

use super::*;

const LIB_SOURCE: &str = include_str!("../lib.rs");

fn text<T: near_sdk::serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap()
}

/// The exact line the contract logs for an event with this data.
fn line(event: &str, data: &str) -> String {
    format!(r#"EVENT_JSON:{{"standard":"kaigen","version":"1.0.0","event":"{event}","data":{data}}}"#)
}

/// The logged lines, in order, of the events with this name.
fn lines_of(event: &str) -> Vec<String> {
    let needle = format!(r#""event":"{event}","#);
    get_logs().into_iter().filter(|l| l.starts_with("EVENT_JSON:") && l.contains(&needle)).collect()
}

/// The only line of that event; panics if there is none or more than one.
fn only_line(event: &str) -> String {
    let mut found = lines_of(event);
    assert_eq!(found.len(), 1, "expected one {event} event, logs: {:#?}", get_logs());
    found.remove(0)
}

fn data_of(event: &str) -> serde_json::Value {
    super::event(event).unwrap_or_else(|| panic!("no {event} event in {:#?}", get_logs()))["data"].clone()
}

/// Names of the events in the last call's logs, in order.
fn event_names() -> Vec<String> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap()["event"].as_str().unwrap().to_string())
        .collect()
}

// ---- refusals ---------------------------------------------------------------------------------------------------

#[test]
fn a_counted_refusal_logs_the_code_the_call_and_where_the_cap_stood_as_this_exact_line() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.enforce_allowlist(true);
    m.allow_recipient(accounts(3));
    as_daily(&key(1), 2_000 * SEC);
    assert_sent(m.send_small(None, U128(5), accounts(3)));
    as_daily(&key(1), 2_001 * SEC);
    let o = refused(m.send_small(None, U128(7), accounts(2)));
    assert_eq!((o.strikes, o.burned), (1, false));
    let data = format!(
        r#"{{"public_key":{},"reason":"recipient is not on the allowlist","reason_code":"not_allowlisted","strikes":1,"counted":true,"token":null,"amount":"7","to":{},"spent_after":"5"}}"#,
        text(&key(1)),
        text(&accounts(2)),
    );
    assert_eq!(only_line("refused"), line("refused", &data));
    assert_eq!(get_logs().len(), 1, "one refusal, one event");
}

#[test]
fn every_refusal_logs_its_own_code_and_whether_it_counted() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.set_min_send(U128(5));
    // The window used up by an allowed send first, so "cap exhausted" is reachable.
    as_daily(&key(1), 2_000 * SEC);
    assert_sent(m.send_small(None, U128(NEAR - 10), accounts(3)));
    let mut refusal = |at: u64, token: Option<AccountId>, amount: u128, to: AccountId| {
        as_daily(&key(1), at * SEC);
        refused(m.send_small(token, U128(amount), to));
        data_of("refused")
    };
    let exhausted = refusal(2_001, None, 11, accounts(2));
    assert_eq!((exhausted["reason_code"].as_str(), exhausted["counted"].as_bool()), (Some("cap_exhausted"), Some(false)));
    assert_eq!((exhausted["reason"].as_str(), exhausted["strikes"].as_u64()), (Some("over the 24 h limit"), Some(0)));
    assert_eq!((exhausted["amount"].as_str(), exhausted["spent_after"].as_str()), (Some("11"), Some((NEAR - 10).to_string().as_str())));

    let over = refusal(2_002, None, NEAR + 1, accounts(2));
    assert_eq!((over["reason_code"].as_str(), over["counted"].as_bool(), over["strikes"].as_u64()), (Some("over_cap_total"), Some(true), Some(1)));
    assert_eq!(over["reason"].as_str(), Some("over the 24 h limit"), "two codes, one text");

    let no_limit = refusal(2_003, Some(accounts(3)), 1, accounts(2));
    assert_eq!((no_limit["reason_code"].as_str(), no_limit["counted"].as_bool()), (Some("no_limit"), Some(false)));
    assert_eq!(no_limit["token"].as_str(), Some(accounts(3).as_str()));
    assert_eq!(no_limit["spent_after"].as_str(), Some("0"), "the token has no spend");
    assert_eq!(no_limit["strikes"].as_u64(), Some(1), "an uncounted refusal reports the strikes the key already has");

    let below = refusal(2_004, None, 4, accounts(2));
    assert_eq!((below["reason_code"].as_str(), below["counted"].as_bool(), below["reason"].as_str()), (Some("below_min_send"), Some(false), Some("below the minimum send")));
}

// ---- burns ------------------------------------------------------------------------------------------------------

#[test]
fn the_burning_call_logs_the_refusal_then_the_cancelled_queue_then_the_burn() {
    let mut m = setup();
    as_daily(&key(1), 1_900 * SEC);
    m.request_withdraw(None, U128(1), accounts(2));
    m.request_withdraw(None, U128(2), accounts(2));
    assert_eq!(attack(&mut m, 2_000 * SEC).strikes, 1);
    assert_eq!(attack(&mut m, 2_001 * SEC).strikes, 2);
    let last = attack(&mut m, 2_002 * SEC);
    assert!(last.burned);
    assert_eq!(event_names(), ["refused", "queue_cancelled", "key_burned"], "in the order they happen");

    let refused_data = data_of("refused");
    assert_eq!((refused_data["strikes"].as_u64(), refused_data["counted"].as_bool()), (Some(3), Some(true)));
    assert_eq!(refused_data["reason_code"].as_str(), Some("over_cap_total"));

    let cancelled = data_of("queue_cancelled");
    assert_eq!((cancelled["reason"].as_str(), cancelled["count"].as_u64()), (Some("key_burned"), Some(2)));
    assert_eq!(cancelled["public_key"].as_str(), Some(text(&key(1)).trim_matches('"')));
    assert_eq!(cancelled["withdrawals"].as_array().unwrap().len(), 2);

    let burned = format!(
        r#"{{"public_key":{},"reason":"over the 24 h limit","reason_code":"over_cap_total","strikes":3,"max_strikes":3}}"#,
        text(&key(1))
    );
    assert_eq!(only_line("key_burned"), line("key_burned", &burned));
}

#[test]
fn the_burn_logs_the_limit_the_admin_set() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    m.set_max_strikes(2);
    attack(&mut m, 2_000 * SEC);
    let last = attack(&mut m, 2_001 * SEC);
    assert!(last.burned);
    let burned = data_of("key_burned");
    assert_eq!((burned["strikes"].as_u64(), burned["max_strikes"].as_u64()), (Some(2), Some(2)));
}

// ---- sends ------------------------------------------------------------------------------------------------------

#[test]
fn a_send_logs_the_key_and_what_the_window_holds_after_it_as_this_exact_line() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    assert_sent(m.send_small(None, U128(3), accounts(2)));
    let first = format!(
        r#"{{"public_key":{},"token":null,"amount":"3","to":{},"spent_after":"3"}}"#,
        text(&key(1)),
        text(&accounts(2))
    );
    assert_eq!(only_line("send_small"), line("send_small", &first));
    as_daily(&key(1), 2_001 * SEC);
    assert_sent(m.send_small(None, U128(4), accounts(2)));
    assert_eq!(data_of("send_small")["spent_after"].as_str(), Some("7"));
}

#[test]
fn a_failed_transfer_logs_send_failed_with_the_refund_as_this_exact_line() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    assert_sent(m.send_small(None, U128(5), accounts(2)));
    callback_after_failure(2_001 * SEC);
    let o = m.on_send_done(None, U128(5), U64(2_000 * SEC));
    assert_eq!(o.refused.as_deref(), Some("the transfer failed and was refunded to the daily limit"));
    assert_eq!(
        only_line("send_failed"),
        line("send_failed", r#"{"reason_code":"transfer_failed","token":null,"amount":"5","refunded":true,"spent_after":"0"}"#)
    );
}

#[test]
fn a_failed_transfer_whose_entry_has_aged_out_says_nothing_was_refunded() {
    let mut m = setup();
    as_daily(&key(1), 2_000 * SEC);
    assert_sent(m.send_small(None, U128(100), accounts(2)));
    // A day and ten seconds later another send rewrites the log without the old entry.
    let later = 2_000 * SEC + DAY_NS + 10 * SEC;
    as_daily(&key(1), later);
    assert_sent(m.send_small(None, U128(1), accounts(2)));
    callback_after_failure(later + SEC);
    m.on_send_done(None, U128(100), U64(2_000 * SEC));
    let failed = data_of("send_failed");
    assert_eq!((failed["refunded"].as_bool(), failed["spent_after"].as_str()), (Some(false), Some("1")));
}

// ---- purges, cancels and discards -------------------------------------------------------------------------------

#[test]
fn a_purge_logs_how_many_expired_and_which_call_cleared_them() {
    let mut m = setup();
    queue_dust(&mut m, &key(1), 2_000, 2);
    as_anyone(expiry_ns(2_000));
    assert_eq!(m.purge_expired(), 2);
    let purged = data_of("queue_expired");
    assert_eq!(
        (purged["reason"].as_str(), purged["trigger"].as_str(), purged["count"].as_u64()),
        (Some("expired"), Some("purge_expired"), Some(2))
    );
    assert_eq!(purged["withdrawals"].as_array().unwrap().len(), 2);
    // An empty purge logs nothing.
    as_anyone(expiry_ns(2_000) + SEC);
    assert_eq!(m.purge_expired(), 0);
    assert!(lines_of("queue_expired").is_empty());

    // A new request clears stale ones and says it was the one that did.
    queue_dust(&mut m, &key(1), 3_000, 2);
    as_daily(&key(1), expiry_ns(3_000));
    m.request_withdraw(None, U128(1), accounts(2));
    let cleared = data_of("queue_expired");
    assert_eq!((cleared["trigger"].as_str(), cleared["count"].as_u64()), (Some("request_withdraw"), Some(2)));
    assert_eq!(event_names(), ["queue_expired", "request_withdraw"]);
}

#[test]
fn the_failed_execute_callback_names_itself_when_it_clears_stale_requests_and_says_why_it_drops_its_own() {
    let mut m = setup();
    let ids = queue_dust(&mut m, &key(1), 4_000, 2);
    let w = m.queue().into_iter().find(|q| q.id == ids[0]).expect("queued").withdrawal;
    as_anyone(4_000 * SEC + 3_601 * SEC);
    let _ = m.execute(ids[0]);
    callback_after_failure(expiry_ns(4_000));
    m.on_execute_done(ids[0], w, U64(m.next_id));
    assert_eq!(event_names(), ["queue_expired", "execute_dropped"]);
    assert_eq!(data_of("queue_expired")["trigger"].as_str(), Some("execute_failed"));
    assert_eq!(data_of("execute_dropped")["reason"].as_str(), Some("expired"));
}

#[test]
fn cancel_all_and_a_key_removal_and_lockdown_each_log_a_count() {
    let mut m = setup();
    queue_dust(&mut m, &key(1), 2_000, 3);
    as_admin(2_001 * SEC);
    assert_eq!(m.cancel_all(), 3);
    let all = data_of("queue_cancelled");
    assert_eq!((all["reason"].as_str(), all["count"].as_u64()), (Some("cancel_all"), Some(3)));

    queue_dust(&mut m, &key(1), 2_100, 2);
    as_admin(2_101 * SEC);
    let _ = m.remove_daily_key(key(1));
    let removed = data_of("queue_cancelled");
    assert_eq!((removed["reason"].as_str(), removed["count"].as_u64()), (Some("key_removed"), Some(2)));

    // Kaigen discards what is left.
    as_admin(2_200 * SEC);
    let _ = m.add_daily_key(key(2), None);
    queue_dust(&mut m, &key(2), 2_210, 2);
    m.era = Era::Kaigen;
    lock_down_at(&mut m, 2_300 * SEC);
    let discarded = data_of("queue_discarded");
    assert_eq!((discarded["reason"].as_str(), discarded["count"].as_u64()), (Some("lockdown"), Some(2)));
}

#[test]
fn a_dropped_execute_says_why_for_each_reason_and_a_request_that_can_return_logs_nothing() {
    let mut m = setup();
    let w = |requested_by: PublicKey, expires_at: u64| Withdrawal {
        token: None,
        amount: U128(1),
        to: accounts(2),
        requested_at: U64(2_000 * SEC),
        expires_at: U64(expires_at),
        requested_by,
    };
    let live = 2_000 * SEC + 3_600 * SEC + 86_400 * SEC;

    // It can return: no event, and it is back in the queue.
    callback_after_failure(2_100 * SEC);
    m.on_execute_done(U64(90), w(key(1), live), U64(m.next_id));
    assert!(lines_of("execute_dropped").is_empty());
    assert_eq!(m.queue().len(), 1);

    // Its key is gone.
    callback_after_failure(2_101 * SEC);
    m.on_execute_done(U64(91), w(key(9), live), U64(m.next_id));
    assert_eq!(data_of("execute_dropped")["reason"].as_str(), Some("key_gone"));

    // It expired.
    callback_after_failure(live + SEC);
    m.on_execute_done(U64(92), w(key(1), live), U64(m.next_id));
    assert_eq!(data_of("execute_dropped")["reason"].as_str(), Some("expired"));

    // Lockdown beats every other reason.
    m.era = Era::Kaigen;
    callback_after_failure(2_102 * SEC);
    m.on_execute_done(U64(93), w(key(9), 1), U64(m.next_id));
    assert_eq!(data_of("execute_dropped")["reason"].as_str(), Some("lockdown"));
    m.era = Era::Calm;

    // The queue is full, so there is no room.
    as_admin(2_200 * SEC);
    m.cancel_all();
    queue_dust(&mut m, &key(1), 2_201, MAX_QUEUE);
    callback_after_failure(2_202 * SEC);
    m.on_execute_done(U64(94), w(key(1), live), U64(m.next_id));
    let dropped = data_of("execute_dropped");
    assert_eq!(dropped["reason"].as_str(), Some("no_room"));
    // The line keeps its v2 fields.
    assert_eq!(
        only_line("execute_dropped"),
        line(
            "execute_dropped",
            &format!(r#"{{"id":"94","reason":"no_room","to":{},"token":null,"amount":"1"}}"#, text(&accounts(2)))
        )
    );
}

// ---- the envelope, the table, the size -------------------------------------------------------------------------

/// Every event the contract can emit is in the doc's events table, and the table names no event the contract
/// does not emit. (`emit("name"` in the source is the only way an event is logged.)
#[test]
fn every_event_the_contract_emits_is_in_the_doc_table_and_the_table_has_no_ghosts() {
    let doc = include_str!("../../../../docs/v3/ATTEST-CHECK.md");
    let mut emitted = std::collections::BTreeSet::new();
    let code = LIB_SOURCE.split("#[cfg(test)]").next().unwrap();
    for part in code.split("emit(").skip(1) {
        // `emit(` then, after any line break, the quoted event name. `fn emit(event: &str, ..)` has no quote there.
        if let Some(rest) = part.trim_start().strip_prefix('"') {
            emitted.insert(rest.split('"').next().unwrap().to_string());
        }
    }
    assert!(emitted.len() >= 20, "found only {emitted:?}");
    let section = doc.split("\n## 5. Events").nth(1).expect("section 5").split("\n## ").next().unwrap();
    let table_rows: std::collections::BTreeSet<String> = section
        .lines()
        .filter(|l| l.starts_with("| `"))
        .filter_map(|l| l.trim_start_matches("| `").split('`').next().map(str::to_string))
        .collect();
    assert_eq!(table_rows, emitted, "the events table in section 5 and the contract disagree");
}

/// A burn is the biggest thing a single call logs: the refusal, the whole queue of the key (all 32 requests, with
/// 64-character accounts, 37-digit amounts and a secp256k1 key, the longest forms) and the burn. It has to fit in
/// the one receipt the protocol allows 16 384 bytes of logs to.
#[test]
fn the_biggest_burn_still_logs_less_than_a_receipt_may() {
    let long: AccountId = "a".repeat(64).parse().unwrap();
    let token: AccountId = "b".repeat(64).parse().unwrap();
    let huge = U128(10u128.pow(36));
    let fat_key = PublicKey::from_parts(CurveType::SECP256K1, vec![7; 64]).unwrap();
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.remove_daily_key(key(1));
    callback_after_success(1_101 * SEC);
    m.on_revoked_key_deleted(key(1));
    as_admin(1_102 * SEC);
    let _ = m.add_daily_key(fat_key.clone(), None);
    m.set_token_limit(token.clone(), U128(1));
    m.set_pending_limit(Some(token.clone()), U128(10u128.pow(38)));
    as_daily(&fat_key, 2_000 * SEC);
    for _ in 0..MAX_QUEUE {
        m.request_withdraw(Some(token.clone()), huge, long.clone());
    }
    let mut last = 0;
    for n in 0..3u64 {
        as_daily(&fat_key, (2_100 + n) * SEC);
        let o = refused(m.send_small(Some(token.clone()), huge, long.clone()));
        last = logged_bytes();
        assert_eq!(o.burned, n == 2);
    }
    println!("worst-case burn: {last} B in {} logs ({:?})", get_logs().len(), event_names());
    assert_eq!(event_names(), ["refused", "queue_cancelled", "key_burned"]);
    assert!(last < 16_384, "{last} bytes of logs in the receipt of a burn");
}
