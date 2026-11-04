//! Open items 2 and 4 of v3: what a callback does depends on when it arrives and on what ran before it.
//!
//! Item 2: a failure callback that arrives a day or more after its send gives nothing back (`on_send_done`).
//! Item 4: the orders in which the callbacks of the promise chains (`send_small` -> `on_send_done`, `execute` ->
//! `on_execute_done`) can arrive relative to other calls, as far as the unit VM can show them. The unit VM runs
//! each call to completion and hands a callback whatever result the test chooses, so it can show every order of
//! arrival, but not what the chain really does between receipts; what it cannot show is listed at the end of this file.

use super::*;

/// Runs one scenario on a chain of its own: the mock chain is per thread and keeps its storage between contexts, so
/// two vaults on one thread would share their collections.
fn on_a_fresh_chain<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
    std::thread::spawn(f).join().unwrap_or_else(|e| std::panic::resume_unwind(e))
}

/// `send_small` of 100 yoctoNEAR at 2_000 s, then its callback reporting a failure `late_by` ns after the send.
/// Returns what the `send_failed` event says about the refund, and the stored log afterwards.
fn failed_send_reported_late(late_by: u64) -> (bool, Vec<(u64, u128)>) {
    on_a_fresh_chain(move || {
        let mut m = setup();
        as_daily(&key(1), 2_000 * SEC);
        assert_sent(m.send_small(None, U128(100), accounts(2)));
        callback_after_failure(2_000 * SEC + late_by);
        m.on_send_done(None, U128(100), U64(2_000 * SEC));
        let refunded = event("send_failed").expect("the failure is logged")["data"]["refunded"].as_bool().expect("a flag");
        (refunded, m.window.get(&None::<AccountId>).cloned().unwrap_or_default())
    })
}

#[test]
fn a_failed_send_is_refunded_to_the_last_instant_of_its_day_and_not_from_the_first_instant_after() {
    let (refunded, log) = failed_send_reported_late(DAY_NS - 1);
    assert!(refunded, "one nanosecond inside the day the entry is still counted, so it is given back");
    assert!(log.is_empty(), "{log:?}");
    let (refunded, log) = failed_send_reported_late(DAY_NS);
    assert!(!refunded, "from the instant the send leaves the window nothing counts it, so nothing is given back");
    assert_eq!(log, vec![(2_000 * SEC, 100)], "and the stored log is not touched: {log:?}");
}

#[test]
fn a_late_failure_never_reduces_a_later_send_even_when_that_send_is_big_enough_to_stand_in() {
    // The old refund looked for the first entry at or after the send's time that was at least as large, and took the
    // amount out of it. Here the stand-in is exactly such an entry: a later, larger send that did leave.
    on_a_fresh_chain(|| {
        let mut m = setup();
        m.daily_limit = 1_000;
        as_daily(&key(1), 2_000 * SEC);
        assert_sent(m.send_small(None, U128(400), accounts(2)));
        let next_day = 2_000 * SEC + DAY_NS + 60 * SEC;
        as_daily(&key(1), next_day);
        assert_sent(m.send_small(None, U128(600), accounts(2))); // the first entry is pruned by this write
        callback_after_failure(next_day + 61 * SEC);
        m.on_send_done(None, U128(400), U64(2_000 * SEC));
        assert_eq!(m.spent_24h(None).0, 600, "the 600 that left is still counted in full");
        assert_eq!(event("send_failed").unwrap()["data"]["refunded"], serde_json::json!(false));
        // So 401 more does not fit: 600 + 401 > 1000. (The old refund left 200 in the log and let 800 through.)
        as_daily(&key(1), next_day + 62 * SEC);
        let o = refused(m.send_small(None, U128(401), accounts(2)));
        assert_eq!(o.refused.as_deref(), Some("over the 24 h limit"));
    });
}

// ---- item 4: the execute chain -----------------------------------------------------------------------------------

/// A request of 1 yoctoNEAR made by key 1 at `at` seconds, with the id it got.
fn request(m: &mut Mamori, at: u64) -> U64 {
    queue_dust(m, &key(1), at, 1)[0]
}

/// `execute` of the queued request `id` at `at` seconds. Returns the request as it was queued and the `next_id`
/// `execute` passes to the callback: how many requests had been made when it went out.
fn execute_out(m: &mut Mamori, id: U64, at: u64) -> (Withdrawal, U64) {
    let w = m.queue().iter().find(|q| q.id == id).expect("it is queued").withdrawal.clone();
    as_anyone(at * SEC);
    let _ = m.execute(id);
    assert!(m.queue().iter().all(|q| q.id != id), "in flight, it is in no collection");
    (w, requests_before_in_the_callback())
}

/// The `requests_before` that the last `execute` put in its callback's arguments, read from the receipt it created.
fn requests_before_in_the_callback() -> U64 {
    let r = receipts_text();
    let tag = "\"requests_before\":\"";
    let at = r.find(tag).unwrap_or_else(|| panic!("the callback carries no requests_before: {r}")) + tag.len();
    U64(r[at..].split('"').next().unwrap().parse().expect("a number"))
}

/// A unit-test callback after a failed transfer: the VM hands it a failed result at `at` seconds.
fn execute_failed(m: &mut Mamori, id: U64, w: Withdrawal, requests_before: U64, at: u64) {
    callback_after_failure(at * SEC);
    m.on_execute_done(id, w, requests_before);
}

#[test]
fn a_request_made_between_an_execute_and_its_failure_callback_stops_the_request_coming_back() {
    let go = TEST_DELAY + 2_000;
    let mut m = setup();
    let r = request(&mut m, 2_000);
    let (w, before) = execute_out(&mut m, r, go + 1);
    assert_eq!(before.0, m.next_id, "execute tells its callback how many requests had been made");
    let n = request_at(&mut m, go + 2); // the room r held is now asked for again
    assert_eq!(m.next_id, before.0 + 1);
    execute_failed(&mut m, r, w, before, go + 3);
    assert_eq!(queued_ids(&m), vec![n.0], "only the new request is queued");
    let dropped = event("execute_dropped").expect("and the drop is logged");
    assert_eq!(dropped["data"]["reason"], serde_json::json!("request_made"));
    assert_eq!(dropped["data"]["id"], serde_json::json!(r));
}

/// A request made by key 1 at `at` seconds, whenever the clock is.
fn request_at(m: &mut Mamori, at: u64) -> U64 {
    as_daily(&key(1), at * SEC);
    m.request_withdraw(None, U128(1), accounts(2))
}

#[test]
fn a_failed_execute_with_no_request_in_between_comes_back_whatever_else_ran() {
    // What may run in the gap without taking the request's place: views, an execute of another request, a
    // cancel of another request, a purge, a strike, a send. None of them is a request.
    let go = TEST_DELAY + 2_000;
    let mut m = setup();
    let (r, other) = (request(&mut m, 2_000), request(&mut m, 2_000));
    let (w, before) = execute_out(&mut m, r, go + 1);
    as_anyone((go + 2) * SEC);
    let _ = m.execute(other); // frees more room
    let _ = m.purge_expired();
    as_daily(&key(1), (go + 2) * SEC);
    assert_sent(m.send_small(None, U128(1), accounts(2)));
    execute_failed(&mut m, r, w, before, go + 3);
    assert_eq!(queued_ids(&m), vec![r.0], "back in the queue, and the drop is not logged");
    assert!(event("execute_dropped").is_none());
}

#[test]
fn two_failed_executes_come_back_in_either_order_and_the_second_sees_the_first() {
    for first_back in [0usize, 1] {
        on_a_fresh_chain(move || {
            let go = TEST_DELAY + 2_000;
            let mut m = setup();
            let ids = queue_dust(&mut m, &key(1), 2_000, 2);
            let out: Vec<(Withdrawal, U64)> = ids.iter().map(|id| execute_out(&mut m, *id, go + 1)).collect();
            assert!(m.queue().is_empty());
            let order = if first_back == 0 { [0, 1] } else { [1, 0] };
            for (n, i) in order.into_iter().enumerate() {
                let (w, before) = out[i].clone();
                execute_failed(&mut m, ids[i], w, before, go + 2 + n as u64);
            }
            assert_eq!(queued_ids(&m), vec![ids[0].0, ids[1].0], "both are back whichever callback came first");
        });
    }
}

#[test]
fn reasons_a_failed_execute_is_dropped_keep_their_order_and_a_new_request_comes_before_no_room() {
    let live = 2_000 * SEC + 3_600 * SEC + 86_400 * SEC;
    let w = |by: PublicKey, expires_at: u64| Withdrawal {
        token: None,
        amount: U128(1),
        to: accounts(2),
        requested_at: U64(2_000 * SEC),
        expires_at: U64(expires_at),
        requested_by: by,
    };
    let mut m = setup();
    m.next_id = 50; // a request has been made since these went out (they passed 49)
    let reason = |m: &mut Mamori, id: u64, wd: Withdrawal, at: u64| {
        callback_after_failure(at);
        m.on_execute_done(U64(id), wd, U64(49));
        event("execute_dropped").map(|e| e["data"]["reason"].as_str().unwrap().to_string())
    };
    // Every other reason that applies is named first.
    m.era = Era::Kaigen;
    assert_eq!(reason(&mut m, 90, w(key(9), 1), 2_100 * SEC).as_deref(), Some("lockdown"));
    m.era = Era::Calm;
    assert_eq!(reason(&mut m, 91, w(key(1), live), live + SEC).as_deref(), Some("expired"));
    assert_eq!(reason(&mut m, 92, w(key(9), live), 2_101 * SEC).as_deref(), Some("key_gone"));
    // With the queue full, "no room" would also apply; the request that was made is the reason given.
    as_admin(2_200 * SEC);
    m.cancel_all();
    queue_dust(&mut m, &key(1), 2_201, MAX_QUEUE);
    assert_eq!(reason(&mut m, 93, w(key(1), live), 2_202 * SEC).as_deref(), Some("request_made"));
    // And with no request in between, it is "no room" as before.
    callback_after_failure(2_203 * SEC);
    m.on_execute_done(U64(94), w(key(1), live), U64(m.next_id));
    assert_eq!(event("execute_dropped").unwrap()["data"]["reason"], serde_json::json!("no_room"));
}

#[test]
fn an_admin_cancel_during_the_gap_cannot_reach_the_request_in_flight_and_it_comes_back_after() {
    // Pinned as it is, not as one might wish: `cancel` and `cancel_all` act on the queue, and an executing request
    // is not in it. The admin's cancel window is the delay, which this request has used up (it unlocked); it is
    // back in the queue to be seen and cancelled once the callback has landed, and anyone may execute it again.
    let go = TEST_DELAY + 2_000;
    let mut m = setup();
    let r = request(&mut m, 2_000);
    let (w, before) = execute_out(&mut m, r, go + 1);
    as_admin((go + 2) * SEC);
    assert_eq!(m.cancel_all(), 0, "nothing queued to cancel");
    assert!(panics_with(|| m.cancel(r)).contains("no such request"));
    execute_failed(&mut m, r, w, before, go + 3);
    assert_eq!(queued_ids(&m), vec![r.0]);
    as_admin((go + 4) * SEC);
    m.cancel(r); // now the admin can
    assert!(m.queue().is_empty());
}

// ---- item 4: the other chains --------------------------------------------------------------------------------------

#[test]
fn failed_sends_refund_whichever_callback_comes_first() {
    for reversed in [false, true] {
        on_a_fresh_chain(move || {
            let mut m = setup();
            m.daily_limit = 1_000;
            let times = [2_000 * SEC, 2_001 * SEC];
            for t in times {
                as_daily(&key(1), t);
                assert_sent(m.send_small(None, U128(300), accounts(2)));
            }
            assert_eq!(m.spent_24h(None).0, 600);
            let order = if reversed { [1, 0] } else { [0, 1] };
            for (n, i) in order.into_iter().enumerate() {
                callback_after_failure(2_002 * SEC + n as u64);
                m.on_send_done(None, U128(300), U64(times[i]));
                assert!(event("send_failed").unwrap()["data"]["refunded"].as_bool().unwrap());
                if n == 0 {
                    // The credit came out of the failed send's own entry, not out of the other one.
                    let left = m.window.get(&None::<AccountId>).cloned().unwrap_or_default();
                    assert_eq!(left, vec![(times[1 - i], 300)], "reversed = {reversed}");
                }
            }
            assert_eq!(m.spent_24h(None).0, 0, "both given back, in either order");
        });
    }
}

#[test]
fn a_send_whose_callback_comes_after_lockdown_is_still_refunded_and_nothing_else_moves() {
    let mut m = setup();
    m.daily_limit = 1_000;
    as_daily(&key(1), 2_000 * SEC);
    assert_sent(m.send_small(None, U128(300), accounts(2)));
    as_callback(2_001 * SEC);
    m.on_era(Ok(Era::Kaigen));
    lock_down_at(&mut m, 2_002 * SEC);
    assert!(m.daily_keys().is_empty());
    callback_after_failure(2_003 * SEC);
    let o = m.on_send_done(None, U128(300), U64(2_000 * SEC));
    assert!(!o.sent);
    assert_eq!(m.spent_24h(None).0, 0, "the callback has no era check: it only corrects the books");
    assert!(event("send_failed").unwrap()["data"]["refunded"].as_bool().unwrap());
}

#[test]
fn a_key_removed_before_its_addkey_callback_fails_stays_owed_a_deletion_and_can_be_forgotten() {
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.add_daily_key(key(2), None);
    let _ = m.remove_daily_key(key(2)); // removed before the AddKey callback came back
    callback_after_failure(1_101 * SEC);
    m.on_key_added(key(2)); // the AddKey failed (the key was never on the account)
    assert_eq!(m.daily_keys(), vec![key(1)]);
    assert_eq!(m.revoked_keys(), vec![key(2)], "still owed a deletion, which can only fail");
    assert_books_are_consistent(&m);
    callback_after_failure(1_102 * SEC);
    m.on_revoked_key_deleted(key(2));
    assert_eq!(m.revoked_keys(), vec![key(2)], "and it stays, the account has nothing to delete");
    as_admin(1_103 * SEC);
    m.forget_revoked_key(key(2));
    assert!(m.revoked_keys().is_empty());
}

#[cfg(not(feature = "drill"))]
#[test]
fn two_trips_in_flight_cannot_lower_the_era_whichever_callback_comes_last() {
    let mut m = setup();
    as_callback(2_000 * SEC);
    m.on_era(Ok(Era::Kaigen));
    m.on_era(Ok(Era::Warning)); // the older answer arrives last
    assert_eq!(m.era(), Era::Kaigen);
    m.on_era(Ok(Era::Calm));
    assert_eq!(m.era(), Era::Kaigen);
}

// What the unit VM cannot show, so nothing above claims it:
//
// * How long a gap really is. Here a callback arrives when the test says; on a chain it is a few blocks, measured
//   on a sandbox only for the key-deletion chain (V3-M1-PROGRESS.md: callback three blocks after the call), not for
//   `execute` or `send_small`, and congestion could stretch it.
// * That a callback always arrives. A receipt whose callback is lost leaves a send counted (safe) and a request out
//   of the queue (safe), and the unit VM has no way to lose one.
// * The order of receipts from different transactions inside one block, and which of two transactions that reach
//   the same block lands first. Every ordering here is one a test chose.
// * A callback that fails for want of gas or of balance for storage. The unit VM runs it to completion; on a chain
//   a failed callback leaves its books as they were (a refund not made, a request not put back).
// * `#[private]` (the wasm wrapper's own check) and the access-key layer. The tests call callbacks directly.
// * Whether the runtime drops a function-call key whose allowance is used up (THREAT-MODEL.md section 7).
// * A DeleteKey that lands after a later AddKey of the same key (needs two real receipts).