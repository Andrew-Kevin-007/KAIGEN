//! The headline scene as a log anyone can run, with no keys, no chain and no network:
//!
//!   cargo test -p mamori demo_story -- --nocapture
//!
//! A prompt-injected agent holds a daily key. One honest payment goes through; then the agent is talked into three
//! attacks, the vault refuses each and counts it, and on the third it schedules the DeleteKey that removes the key
//! from the account. The key's next attempt is refused too. This runs the same contract code as the testnet demo, in
//! the unit VM (what the unit VM does not model: the chain actually executing the DeleteKey receipt; the testnet
//! rehearsal in docs/v3/TESTNET-REHEARSAL.md shows that part). Every printed line is also asserted.

use super::*;

/// Prints one line of the log. Run with `--nocapture` to see it; the assertions around it hold either way.
fn say(line: &str) {
    println!("{line}");
}

#[test]
fn demo_story() {
    let agent = key(1);
    let supplier = accounts(2);
    let attacker = accounts(3);

    // The owner sets the vault up: 1 NEAR per 24 h, the agent's daily key, and only the supplier may be paid.
    let mut m = setup();
    as_admin(1_100 * SEC);
    let _ = m.allow_recipient(supplier.clone());
    m.enforce_allowlist(true);
    say("== KAIGEN demo story (offline unit VM, no keys, no chain) ==");
    say(&format!("vault {} | cap 1 NEAR / 24 h | max strikes {} | daily keys {} | allowlist enforced", vault(), m.config().max_strikes, m.daily_keys().len()));
    assert_eq!((m.config().max_strikes, m.daily_keys(), m.allowlist().enforced), (3, vec![agent.clone()], true));

    // 1. The honest payment.
    as_daily(&agent, 2_000 * SEC);
    assert_sent(m.send_small(None, U128(NEAR / 10), supplier.clone()));
    say(&format!("[1] SENT     0.1 NEAR to {supplier} (on the allowlist, under the cap)"));
    assert_eq!((m.strikes_of(agent.clone()), m.spent_24h(None).0), (0, NEAR / 10));

    // 2. The agent reads an injected page and is told to send the funds elsewhere. Three attacks.
    say("-- the agent is prompt-injected --");
    let attacks: [(&str, u128, &AccountId); 3] = [
        ("send to an attacker, not on the allowlist", 1, &attacker),
        ("drain 5 NEAR to the supplier, far over the cap", NEAR * 5, &supplier),
        ("drain 5 NEAR to the attacker", NEAR * 5, &attacker),
    ];
    let mut last = None;
    for (n, (what, amount, to)) in attacks.into_iter().enumerate() {
        let strikes_before = m.strikes_of(agent.clone());
        as_daily(&agent, (2_001 + n as u64) * SEC);
        let o = refused(m.send_small(None, U128(amount), to.clone()));
        let reason = o.refused.clone().expect("a refusal carries its reason");
        say(&format!("[{}] REFUSED  {what}: {reason} | strike {}/{}{}", n + 2, o.strikes, m.config().max_strikes, if o.burned { " | KEY BURNED" } else { "" }));
        assert_eq!(strikes_before + 1, o.strikes, "each refusal is one strike");
        assert_eq!(o.burned, n == 2, "only the third refusal burns the key");
        if n == 0 {
            assert_eq!(reason, "recipient is not on the allowlist");
        }
        if n == 1 {
            assert_eq!(reason, "over the 24 h limit");
        }
        last = Some(o);
    }
    assert!(last.unwrap().burned);
    assert_eq!(m.spent_24h(None).0, NEAR / 10, "none of the attacks moved a yoctoNEAR");

    // 3. The vault removed the key itself.
    let receipts = receipts_text();
    assert_eq!(receipts.matches("DeleteKey").count(), 1, "{receipts}");
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"key_burned\"")));
    assert!(m.daily_keys().is_empty());
    assert_eq!(m.revoked_keys(), vec![agent.clone()], "recorded as removed until the account confirms the delete");
    say("[5] DELETEKEY scheduled by the vault itself; key_burned event logged; daily keys now []; revoked keys now [the agent's key]");

    // 4. The burned key tries again.
    as_daily(&agent, 2_010 * SEC);
    let again = panics_with(|| {
        let _ = m.send_small(None, U128(1), supplier.clone());
    });
    say(&format!("[6] REFUSED  the burned key's next attempt: {again}"));
    assert!(again.contains("not a recorded daily key"), "{again}");
    say("HELD: 0.1 NEAR moved, all 3 attacks refused, the key is gone");
}
