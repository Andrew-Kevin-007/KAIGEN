use super::*;
use ed25519_dalek::{Signer, SigningKey as EdKey};
use k256::ecdsa::SigningKey as SecpKey;
use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};
use sha2::{Digest, Sha256};

fn ctx() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(1)).block_height(100);
    testing_env!(b.build());
}

fn ed_key() -> EdKey {
    EdKey::from_bytes(&[7u8; 32])
}

fn secp_key() -> SecpKey {
    SecpKey::from_bytes((&[9u8; 32]).into()).unwrap()
}

fn secp_pub(k: &SecpKey) -> String {
    let point = k.verifying_key().to_encoded_point(false);
    hex::encode(&point.as_bytes()[1..])
}

/// Deploy-and-init is signed by the contract account itself.
fn ctx_init() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(0)).block_height(100);
    testing_env!(b.build());
}

fn init(omens: Vec<(&str, Curve, Era, String)>) -> Kizashi {
    init_with(omens, None)
}

fn init_with(omens: Vec<(&str, Curve, Era, String)>, usdc: Option<AccountId>) -> Kizashi {
    ctx_init();
    let k = Kizashi::new(
        omens
            .into_iter()
            .map(|(id, curve, level, public_key)| OmenInit { id: id.into(), curve, level, public_key })
            .collect(),
        usdc,
    );
    ctx();
    k
}

fn standard() -> Kizashi {
    init(vec![
        ("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes())),
        ("secp256k1-omen", Curve::Secp256k1, Era::Kaigen, secp_pub(&secp_key())),
        ("small-curve-omen", Curve::Ed25519, Era::Warning, hex::encode(EdKey::from_bytes(&[3u8; 32]).verifying_key().to_bytes())),
    ])
}

fn msg(k: &Kizashi, omen: &str, claimant: &AccountId) -> String {
    k.claim_message(omen.into(), claimant.clone())
}

fn ed_sig(k: &Kizashi, omen: &str, claimant: &AccountId, key: &EdKey) -> Base64VecU8 {
    key.sign(msg(k, omen, claimant).as_bytes()).to_bytes().to_vec().into()
}

fn secp_sig(k: &Kizashi, omen: &str, claimant: &AccountId) -> Vec<u8> {
    let hash = Sha256::digest(msg(k, omen, claimant).as_bytes());
    let (sig, rid) = secp_key().sign_prehash_recoverable(&hash).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(rid.to_byte());
    out
}

#[test]
fn claim_message_is_domain_separated() {
    let k = standard();
    assert_eq!(
        k.claim_message("ed25519-omen".into(), accounts(2)),
        format!("KAIGEN/v1/claim\n{}\ned25519-omen\n{}", accounts(0), accounts(2))
    );
}

#[test]
fn ed25519_claim_raises_era_and_kills_omen_forever() {
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig.clone());
    assert_eq!(k.era(), Era::Kaigen);
    let omen = k.omens().into_iter().find(|o| o.id == "ed25519-omen").unwrap();
    let death = omen.death.unwrap();
    assert_eq!(death.claimant, accounts(2));
    assert_eq!(death.block.0, 100);
    // A second claim, even with the same valid signature, must fail.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    }));
    assert!(r.is_err());
}

#[test]
#[should_panic(expected = "bad signature")]
fn copied_signature_cannot_redirect_the_bounty() {
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    // Attacker replays the signature naming themselves as claimant.
    let _ = k.claim("ed25519-omen".into(), accounts(3), sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn wrong_key_is_rejected() {
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &EdKey::from_bytes(&[1u8; 32]));
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn signature_for_another_omen_is_rejected() {
    let mut k = standard();
    // Valid ed25519 signature over the small-curve omen's message, submitted for ed25519-omen.
    let sig = ed_sig(&k, "small-curve-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
}

#[test]
#[should_panic(expected = "unknown omen")]
fn unknown_omen_is_rejected() {
    let mut k = standard();
    let _ = k.claim("nope".into(), accounts(2), vec![0u8; 64].into());
}

#[test]
fn secp256k1_claim_works() {
    let mut k = standard();
    let sig = secp_sig(&k, "secp256k1-omen", &accounts(2));
    let _ = k.claim("secp256k1-omen".into(), accounts(2), sig.into());
    assert_eq!(k.era(), Era::Kaigen);
}

#[test]
#[should_panic(expected = "bad signature")]
fn secp256k1_high_s_is_rejected() {
    let mut k = standard();
    let hash = Sha256::digest(msg(&k, "secp256k1-omen", &accounts(2)).as_bytes());
    let (sig, rid) = secp_key().sign_prehash_recoverable(&hash).unwrap();
    // Flip to the malleable twin: s' = n - s, recovery parity flipped.
    let s_neg = -*sig.s().as_ref();
    let twin = k256::ecdsa::Signature::from_scalars(
        *sig.r().as_ref(),
        k256::NonZeroScalar::new(s_neg).unwrap().as_ref().to_owned(),
    )
    .unwrap();
    let mut bytes = twin.to_bytes().to_vec();
    bytes.push(rid.to_byte() ^ 1);
    let _ = k.claim("secp256k1-omen".into(), accounts(2), bytes.into());
}

#[test]
#[should_panic(expected = "bad signature")]
fn secp256k1_bad_recovery_byte_is_rejected() {
    let mut k = standard();
    let mut sig = secp_sig(&k, "secp256k1-omen", &accounts(2));
    *sig.last_mut().unwrap() = 27;
    let _ = k.claim("secp256k1-omen".into(), accounts(2), sig.into());
}

#[test]
fn warning_omen_raises_to_warning_and_era_never_goes_back() {
    let mut k = standard();
    let sig = ed_sig(&k, "small-curve-omen", &accounts(2), &EdKey::from_bytes(&[3u8; 32]));
    let _ = k.claim("small-curve-omen".into(), accounts(2), sig);
    assert_eq!(k.era(), Era::Warning);

    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    assert_eq!(k.era(), Era::Kaigen);

    // A lower-level omen dying later cannot lower the era (fresh registry, kaigen first).
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let sig = ed_sig(&k, "small-curve-omen", &accounts(2), &EdKey::from_bytes(&[3u8; 32]));
    let _ = k.claim("small-curve-omen".into(), accounts(2), sig);
    assert_eq!(k.era(), Era::Kaigen);
}

#[test]
fn init_validates_input() {
    let good = hex::encode(ed_key().verifying_key().to_bytes());
    for (omens, why) in [
        (vec![("a", Curve::Ed25519, Era::Kaigen, "zz".to_string())], "bad hex key"),
        (vec![("a", Curve::Ed25519, Era::Kaigen, "00".to_string())], "bad key length"),
        (vec![("a", Curve::Secp256k1, Era::Kaigen, good.clone())], "bad key length"),
        (vec![("a", Curve::Ed25519, Era::Calm, good.clone())], "omen level"),
        (
            vec![("a", Curve::Ed25519, Era::Kaigen, good.clone()), ("a", Curve::Ed25519, Era::Kaigen, good.clone())],
            "duplicate omen id",
        ),
        (vec![], "1..=8 omens"),
        (vec![("a", Curve::Ed25519, Era::Kaigen, "00".repeat(32))], "all-zero key"),
        (vec![("a", Curve::Secp256k1, Era::Kaigen, "00".repeat(64))], "all-zero key"),
        (
            vec![
                ("dup-a", Curve::Ed25519, Era::Kaigen, good.clone()),
                ("dup-b", Curve::Ed25519, Era::Warning, good.clone()),
            ],
            "duplicate omen key",
        ),
        (
            vec![
                ("dup-c", Curve::Secp256k1, Era::Kaigen, secp_pub(&secp_key())),
                ("dup-d", Curve::Secp256k1, Era::Warning, secp_pub(&secp_key())),
            ],
            "duplicate omen key",
        ),
        (vec![("a", Curve::Ed25519, Era::Kaigen, format!("{}7f", "ff".repeat(31)))], "non-canonical ed25519 key"),
        (vec![("a", Curve::Ed25519, Era::Kaigen, format!("ed{}7f", "ff".repeat(30)))], "non-canonical ed25519 key"),
    ] {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            init(omens);
        }));
        let err = r.expect_err(why);
        let text = err
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(text.contains(why), "expected {why:?}, got {text:?}");
    }
}

#[test]
fn bounty_view_reports_spendable_balance() {
    let k = standard();
    let b = k.bounty();
    assert!(b.near.0 <= env::account_balance().as_yoctonear());
    assert!(b.usdc_token.is_none());
}

fn receipts_text() -> String {
    let raw = format!("{:?}", near_sdk::test_utils::get_created_receipts());
    let mut out = String::new();
    let mut rest = raw.as_str();
    while let Some(start) = rest.find('[') {
        out.push_str(&rest[..start]);
        let Some(len) = rest[start..].find(']') else { break };
        let bytes: Option<Vec<u8>> =
            rest[start + 1..start + len].split(", ").map(|n| n.trim().parse::<u8>().ok()).collect();
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
fn claim_with_usdc_configured_chains_payout_balance_read_and_callback() {
    // Regression: chaining the callback onto an already-chained promise made every claim panic.
    let mut k = init_with(
        vec![("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes()))],
        Some("usdc.token".parse().unwrap()),
    );
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    assert_eq!(k.era(), Era::Kaigen);
    let r = receipts_text();
    assert!(r.contains("ft_balance_of"), "{r}");
    assert!(r.contains("on_usdc_balance"), "{r}");
}

#[test]
fn on_usdc_balance_pays_the_balance_with_one_yocto_and_ignores_zero_or_errors() {
    let mut k = init_with(
        vec![("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes()))],
        Some("usdc.token".parse().unwrap()),
    );
    ctx_init();
    k.on_usdc_balance(accounts(2), Ok(U128(0)));
    assert!(near_sdk::test_utils::get_created_receipts().is_empty(), "nothing to send");
    k.on_usdc_balance(accounts(2), Err(PromiseError::Failed));
    assert!(near_sdk::test_utils::get_created_receipts().is_empty(), "a failed balance read sends nothing");
    k.on_usdc_balance(accounts(2), Ok(U128(5_000_000)));
    let r = receipts_text();
    assert!(r.contains("ft_transfer") && r.contains("5000000") && r.contains("inner: 1 }"), "{r}");
}

#[test]
fn payout_always_leaves_the_storage_margin() {
    let k = standard();
    let reserve = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
    let balance = env::account_balance().as_yoctonear();
    assert!(k.bounty().near.0 + reserve + STORAGE_MARGIN.as_yoctonear() <= balance);
}

fn ctx_paying(deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(1)).attached_deposit(deposit);
    testing_env!(b.build());
}

#[test]
fn register_usdc_pays_the_tokens_storage_deposit_for_this_contract() {
    let mut k = init_with(
        vec![("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes()))],
        Some("usdc.token".parse().unwrap()),
    );
    ctx_paying(NearToken::from_millinear(20));
    let _ = k.register_usdc();
    let r = receipts_text();
    assert!(r.contains("storage_deposit") && r.contains("usdc.token"), "{r}");
    assert!(r.contains(&accounts(0).to_string()) && r.contains("registration_only"), "registers this contract, nobody else: {r}");
}

#[test]
#[should_panic(expected = "attach at least 0.01 NEAR")]
fn register_usdc_needs_a_real_deposit() {
    let mut k = init_with(
        vec![("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes()))],
        Some("usdc.token".parse().unwrap()),
    );
    ctx_paying(NearToken::from_yoctonear(1));
    let _ = k.register_usdc();
}

#[test]
#[should_panic(expected = "no USDC token configured")]
fn register_usdc_without_a_token_is_refused() {
    let mut k = standard();
    ctx_paying(NearToken::from_millinear(20));
    let _ = k.register_usdc();
}

// --- K1: the USDC payout registers the claimant, transfers, and reports ---

const PAID: u128 = 5_000_000;

fn usdc_registry() -> Kizashi {
    init_with(
        vec![("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes()))],
        Some("usdc.token".parse().unwrap()),
    )
}

/// The contract calling itself back, with `result` as what the promise it waited on returned.
fn ctx_callback(result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(0));
    testing_env!(b.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

/// Anyone calling, with the contract holding `balance`.
fn ctx_with_balance(balance: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(1)).account_balance(balance);
    testing_env!(b.build());
}

fn logged(event: &str) -> bool {
    get_logs().iter().any(|l| l.contains(&format!("\"event\":\"{event}\"")))
}

fn pos(text: &str, needle: &str) -> usize {
    text.find(needle).unwrap_or_else(|| panic!("{needle:?} missing in {text}"))
}

fn panic_text(f: impl FnOnce()) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a panic");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

#[test]
fn claim_chains_the_near_resolve_before_the_balance_read_and_the_usdc_callback() {
    let mut k = usdc_registry();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let r = receipts_text();
    assert!(pos(&r, "on_near_payout") < pos(&r, "ft_balance_of"), "{r}");
    assert!(pos(&r, "ft_balance_of") < pos(&r, "on_usdc_balance"), "{r}");
}

#[test]
fn claim_without_usdc_still_resolves_the_near_payout() {
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let r = receipts_text();
    assert!(r.contains("on_near_payout") && !r.contains("ft_balance_of"), "{r}");
}

#[test]
fn gas_constants_fit_the_chain_they_pay_for() {
    assert!(FT_BALANCE_GAS >= Gas::from_tgas(10), "ft_balance_of was starved at 5 Tgas");
    let children = FT_STORAGE_DEPOSIT_GAS.as_gas() + FT_TRANSFER_GAS.as_gas() + RESOLVE_GAS.as_gas();
    assert!(ON_USDC_BALANCE_GAS.as_gas() >= children + Gas::from_tgas(5).as_gas(), "callback cannot afford its own chain");
    // jobs/src/chain.mjs submits claim with 100 Tgas; claim's own work needs the rest.
    let claim_static = RESOLVE_GAS.as_gas() + FT_BALANCE_GAS.as_gas() + ON_USDC_BALANCE_GAS.as_gas();
    assert!(claim_static <= Gas::from_tgas(80).as_gas(), "claim would not fit 100 Tgas");
    // retry_payout with every leg owed schedules the NEAR resolve, the three USDC calls, the balance
    // read and its callback; whoever calls it must be able to attach that on top of its own work.
    let retry_static = RESOLVE_GAS.as_gas() + children + FT_BALANCE_GAS.as_gas() + ON_USDC_BALANCE_GAS.as_gas();
    assert!(retry_static <= Gas::from_tgas(200).as_gas(), "a full retry would not fit the 300 Tgas cap");
}

#[test]
fn usdc_payout_registers_the_claimant_then_transfers_then_resolves() {
    let mut k = usdc_registry();
    ctx_init();
    k.on_usdc_balance(accounts(2), Ok(U128(PAID)));
    let r = receipts_text();
    let (register, transfer, resolve) = (pos(&r, "storage_deposit"), pos(&r, "ft_transfer"), pos(&r, "on_usdc_paid"));
    assert!(register < transfer && transfer < resolve, "{r}");
    assert!(r.contains("registration_only") && r.contains(&accounts(2).to_string()), "registers the claimant: {r}");
    assert!(r.contains(&format!("inner: {} }}", MIN_REGISTRATION_DEPOSIT.as_yoctonear())), "{r}");
    assert!(r.contains("\"amount\":\"5000000\"") && r.contains("inner: 1 }"), "{r}");
}

#[test]
fn failed_usdc_balance_read_is_reported_not_swallowed() {
    let mut k = usdc_registry();
    ctx_init();
    k.on_usdc_balance(accounts(2), Err(PromiseError::Failed));
    assert!(logged("payout_failed"), "{:?}", get_logs());
    assert!(get_created_receipts().is_empty());
}

#[test]
fn usdc_payout_the_contract_cannot_fund_is_recorded_not_lost() {
    let mut k = usdc_registry();
    // 0.001 NEAR above the reserve: not enough for the 0.01 NEAR registration deposit.
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve() + 1_000_000_000_000_000_000_000));
    k.on_usdc_balance(accounts(2), Ok(U128(PAID)));
    assert!(get_created_receipts().is_empty(), "no registration deposit to attach");
    assert!(logged("payout_failed"));
    assert_eq!(k.owed(accounts(2)).usdc.0, PAID);
}

#[test]
fn usdc_owed_to_an_earlier_claimant_is_not_swept_by_a_later_one() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), 0, 3_000_000);
    ctx_init();
    k.on_usdc_balance(accounts(3), Ok(U128(PAID)));
    let r = receipts_text();
    assert!(r.contains("\"amount\":\"2000000\"") && !r.contains("\"amount\":\"5000000\""), "only the unowed part moves: {r}");
}

#[test]
fn usdc_resolve_reports_success_and_records_nothing() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(2), U128(PAID));
    assert!(logged("payout_ok"), "{:?}", get_logs());
    assert_eq!(k.owed(accounts(2)).usdc.0, 0);
}

#[test]
fn usdc_resolve_reports_failure_and_records_the_amount_as_owed() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID));
    assert!(logged("payout_failed"), "{:?}", get_logs());
    assert_eq!(k.owed(accounts(2)).usdc.0, PAID);
}

// --- K3: a failed payout is owed, and anyone can retry it, to the recorded claimant only ---

#[test]
fn near_resolve_reports_success_and_records_nothing() {
    let mut k = standard();
    ctx_callback(PromiseResult::Successful(vec![]));
    k.on_near_payout(accounts(2), U128(1_000));
    assert!(logged("payout_ok"));
    assert_eq!(k.owed(accounts(2)).near.0, 0);
}

#[test]
fn near_resolve_failure_is_recorded_and_amounts_add_up() {
    let mut k = standard();
    ctx_callback(PromiseResult::Failed);
    k.on_near_payout(accounts(2), U128(1_000));
    k.on_near_payout(accounts(2), U128(500));
    assert!(logged("payout_failed"));
    assert_eq!(k.owed(accounts(2)).near.0, 1_500);
    assert_eq!(k.owed(accounts(3)).near.0, 0, "only the recorded claimant is owed");
}

#[test]
fn bounty_view_leaves_out_near_that_is_owed() {
    let mut k = standard();
    let before = k.bounty().near.0;
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, 0);
    assert_eq!(k.bounty().near.0, before - one_near);
}

#[test]
fn retry_pays_the_recorded_claimant_the_recorded_amount_and_clears_the_record() {
    let mut k = standard();
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, 0);
    ctx(); // accounts(1) calls: anyone may
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    assert!(r.contains(&accounts(2).to_string()) && !r.contains(&accounts(3).to_string()), "{r}");
    assert!(r.contains(&format!("inner: {one_near} }}")) && r.contains("on_near_payout"), "{r}");
    assert_eq!(k.owed(accounts(2)).near.0, 0, "cleared before sending, so a second retry cannot double pay");
    let again = panic_text(|| {
        let _ = k.retry_payout(accounts(2));
    });
    assert!(again.contains("nothing owed"), "{again}");
}

#[test]
fn retry_for_an_account_that_is_owed_nothing_is_refused() {
    let mut k = standard();
    k.record_owed(&accounts(2), 1_000, 0);
    ctx();
    let text = panic_text(|| {
        let _ = k.retry_payout(accounts(3));
    });
    assert!(text.contains("nothing owed"), "{text}");
}

#[test]
fn retry_pays_only_what_the_contract_can_spare_and_keeps_the_rest_owed() {
    let mut k = standard();
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, 0);
    let spare = 400_000_000_000_000_000_000_000; // 0.4 NEAR above the reserve and the margin
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve() + STORAGE_MARGIN.as_yoctonear() + spare));
    let _ = k.retry_payout(accounts(2));
    assert!(receipts_text().contains(&format!("inner: {spare} }}")));
    assert_eq!(k.owed(accounts(2)).near.0, one_near - spare);
}

#[test]
fn retry_with_nothing_payable_yet_is_refused() {
    let mut k = standard();
    k.record_owed(&accounts(2), NearToken::from_near(1).as_yoctonear(), 0);
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve()));
    let text = panic_text(|| {
        let _ = k.retry_payout(accounts(2));
    });
    assert!(text.contains("has not returned"), "{text}");
}

#[test]
fn retry_of_the_usdc_leg_registers_transfers_and_resolves() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), 0, PAID);
    ctx();
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    let (register, transfer, resolve) = (pos(&r, "storage_deposit"), pos(&r, "ft_transfer"), pos(&r, "on_usdc_paid"));
    assert!(register < transfer && transfer < resolve && r.contains("\"amount\":\"5000000\""), "{r}");
    assert_eq!(k.owed(accounts(2)).usdc.0, 0);
}

#[test]
fn retry_of_both_legs_is_one_ordered_chain() {
    let mut k = usdc_registry();
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, PAID);
    ctx();
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    let order = ["Transfer", "on_near_payout", "storage_deposit", "ft_transfer", "on_usdc_paid"].map(|n| pos(&r, n));
    assert!(order.windows(2).all(|w| w[0] < w[1]), "{r}");
    let owed = k.owed(accounts(2));
    assert_eq!((owed.near.0, owed.usdc.0), (0, 0));
}

#[test]
fn retry_of_usdc_without_spare_near_for_the_registration_is_refused() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), 0, PAID);
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve()));
    let text = panic_text(|| {
        let _ = k.retry_payout(accounts(2));
    });
    assert!(text.contains("spare NEAR"), "{text}");
}

// --- K3: a failed ft_balance_of read is owed too, as a read to repeat, because no amount is known ---

#[test]
fn failed_usdc_balance_read_is_held_so_the_claimant_can_retry_it() {
    // Regression: the failure was only logged. If that claim killed the last omen, no later claim
    // could ever sweep the USDC, and with no keys on the account it was stranded for good.
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_balance(accounts(2), Err(PromiseError::Failed));
    let owed = k.owed(accounts(2));
    assert!(owed.usdc_unread, "the read is what is owed");
    assert_eq!((owed.near.0, owed.usdc.0), (0, 0), "no amount is known, so none is recorded");
    assert!(!k.owed(accounts(3)).usdc_unread, "only the claimant whose read failed");
}

#[test]
fn retry_of_a_failed_usdc_balance_read_reads_again_and_pays_in_the_callback() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_balance(accounts(2), Err(PromiseError::Failed));
    ctx(); // accounts(1) calls: anyone may
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    let (read, callback) = (pos(&r, "ft_balance_of"), pos(&r, "on_usdc_balance"));
    assert!(read < callback && r.contains("usdc.token") && r.contains(&accounts(2).to_string()), "{r}");
    assert!(!r.contains(&accounts(3).to_string()), "{r}");
    assert!(!k.owed(accounts(2)).usdc_unread, "cleared before sending, so a second retry cannot double pay");
    let again = panic_text(|| {
        let _ = k.retry_payout(accounts(2));
    });
    assert!(again.contains("nothing owed"), "{again}");
}

#[test]
fn retry_of_a_failed_usdc_balance_read_needs_no_payable_near() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_balance(accounts(2), Err(PromiseError::Failed));
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve()));
    let _ = k.retry_payout(accounts(2));
    assert!(receipts_text().contains("ft_balance_of"));
}

#[test]
fn retry_of_all_three_legs_is_one_ordered_chain() {
    let mut k = usdc_registry();
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, PAID);
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_balance(accounts(2), Err(PromiseError::Failed));
    ctx();
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    // With a balance read pending nothing recorded in USDC is paid blind: the read settles all of it, so the
    // chain is the NEAR transfer and its resolve, then the read and its callback.
    let order = ["Transfer", "on_near_payout", "ft_balance_of", "on_usdc_balance"].map(|n| pos(&r, n));
    assert!(order.windows(2).all(|w| w[0] < w[1]), "{r}");
    assert!(!r.contains("ft_transfer") && !r.contains("storage_deposit"), "{r}");
    let owed = k.owed(accounts(2));
    // The NEAR is on its way; the unverified USDC stays held until the read settles it.
    assert_eq!((owed.near.0, owed.usdc.0, owed.usdc_unread), (0, PAID, true));
}

#[test]
fn retry_with_part_of_the_near_still_owed_keeps_that_part_and_hands_the_read_on() {
    let mut k = usdc_registry();
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, 0);
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_balance(accounts(2), Err(PromiseError::Failed));
    let spare = 400_000_000_000_000_000_000_000; // 0.4 NEAR above the reserve and the margin
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve() + STORAGE_MARGIN.as_yoctonear() + spare));
    let _ = k.retry_payout(accounts(2));
    assert!(receipts_text().contains("ft_balance_of"));
    let owed = k.owed(accounts(2));
    assert_eq!((owed.near.0, owed.usdc.0, owed.usdc_unread), (one_near - spare, 0, false));
}

// --- K2: reset exists only in the drill build, and only on a .testnet account ---

#[test]
fn reset_is_gated_by_the_drill_feature() {
    let lines: Vec<&str> = include_str!("lib.rs").lines().collect();
    let at: Vec<usize> =
        lines.iter().enumerate().filter(|(_, l)| l.trim_start().starts_with("pub fn reset")).map(|(i, _)| i).collect();
    assert_eq!(at.len(), 1, "exactly one reset");
    let gate = lines[..at[0]].iter().rev().find(|l| !l.trim_start().starts_with("///")).unwrap().trim();
    assert_eq!(gate, "#[cfg(feature = \"drill\")]");
}

#[test]
fn drill_is_not_a_default_feature() {
    let features: Vec<&str> = include_str!("../Cargo.toml")
        .lines()
        .skip_while(|l| l.trim() != "[features]")
        .skip(1)
        .take_while(|l| !l.trim_start().starts_with('['))
        .collect();
    assert!(features.iter().any(|l| l.trim() == "drill = []"));
    assert!(!features.iter().any(|l| l.trim_start().starts_with("default")), "a default feature set could pull drill in");
}

#[cfg(not(feature = "drill"))]
#[test]
fn production_feature_set_has_no_reset() {
    // `reset` is behind `#[cfg(feature = "drill")]` (see reset_is_gated_by_the_drill_feature), and a
    // production build does not enable it. The wasm export list is checked at deploy time as well.
    assert!(!cfg!(feature = "drill"));
}

#[cfg(feature = "drill")]
#[test]
#[should_panic(expected = ".testnet")]
fn reset_refuses_an_account_that_is_not_a_testnet_twin() {
    let mut k = standard();
    k.reset();
}

#[cfg(feature = "drill")]
#[test]
fn reset_revives_the_omens_on_a_testnet_twin() {
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    assert_eq!(k.era(), Era::Kaigen);
    let mut b = VMContextBuilder::new();
    b.current_account_id("kizashi.testnet".parse().unwrap()).predecessor_account_id(accounts(1));
    testing_env!(b.build());
    k.reset();
    assert_eq!(k.era(), Era::Calm);
    assert!(k.omens().iter().all(|o| o.death.is_none()));
}

// --- K4: bounty() says whether a claim can still pay out ---

#[test]
fn bounty_view_reports_whether_any_omen_is_still_claimable() {
    let mut k = standard();
    assert!(k.bounty().claimable);
    let json = near_sdk::serde_json::to_string(&k.bounty()).unwrap();
    assert!(json.contains("\"claimable\":true"), "{json}");
    for (id, key) in [("ed25519-omen", ed_key()), ("small-curve-omen", EdKey::from_bytes(&[3u8; 32]))] {
        let sig = ed_sig(&k, id, &accounts(2), &key);
        let _ = k.claim(id.into(), accounts(2), sig);
    }
    assert!(k.bounty().claimable, "one omen is still alive");
    let sig = secp_sig(&k, "secp256k1-omen", &accounts(2));
    let _ = k.claim("secp256k1-omen".into(), accounts(2), sig.into());
    assert!(!k.bounty().claimable);
}

// --- K5: init refuses keys that can never be a real omen ---

#[test]
fn init_refuses_every_small_order_ed25519_key() {
    for key in SMALL_ORDER_ED25519.iter().filter(|k| k.bytes().any(|b| b != b'0')) {
        let text = panic_text(|| {
            init(vec![("a", Curve::Ed25519, Era::Kaigen, key.to_string())]);
        });
        assert!(text.contains("small-order ed25519 key"), "{key}: {text}");
    }
}

#[test]
fn small_order_list_is_exactly_the_encodings_dalek_calls_weak() {
    // The curve has 8 points of small order. Each of the six with x != 0 has one encoding with y < p;
    // identity and (0, -1) have x = 0 and so two (sign bit clear or set). Non-canonical aliases (y >= p)
    // are refused separately. That is 6 + 2 * 2 = 10 encodings, and the list must be those.
    let mut seen = std::collections::BTreeSet::new();
    for h in SMALL_ORDER_ED25519 {
        let bytes: [u8; 32] = hex::decode(h).unwrap().try_into().unwrap();
        let key = ed25519_dalek::VerifyingKey::from_bytes(&bytes).unwrap_or_else(|e| panic!("{h} does not decode: {e}"));
        assert!(key.is_weak(), "{h} is not a small-order point");
        assert!(seen.insert(h), "{h} listed twice");
    }
    assert_eq!(seen.len(), 10);
}

// --- K7: secp256k1 signs sha256(message), not keccak ---

#[test]
#[should_panic(expected = "bad signature")]
fn secp256k1_signature_over_keccak_is_rejected() {
    let mut k = standard();
    let digest = env::keccak256_array(msg(&k, "secp256k1-omen", &accounts(2)).as_bytes());
    let (sig, rid) = secp_key().sign_prehash_recoverable(&digest).unwrap();
    let mut bytes = sig.to_bytes().to_vec();
    bytes.push(rid.to_byte());
    let _ = k.claim("secp256k1-omen".into(), accounts(2), bytes.into());
}

// --- K8: two claims close together cannot be paid the same balance, and a failed transfer is no debt until verified ---
//
// `claim` reads the token balance and a LATER callback pays it, so two claims whose reads land before the first
// transfer does both see the full balance. The contract reserves what it has scheduled (`usdc_in_flight`), and a
// transfer that fails is held as an UNVERIFIED amount: the retry reads the balance again and pays what the token
// really holds, so a phantom debt (tokens already paid to someone else) clears instead of hiding later top-ups.

const TOP_UP: u128 = 750_000;

fn receiver_is(text: &str, who: &AccountId) -> bool {
    text.contains(&format!("\"receiver_id\":\"{who}\""))
}

#[test]
fn two_payouts_close_together_cannot_both_be_paid_the_same_balance() {
    let mut k = usdc_registry();
    ctx_init();
    k.on_usdc_balance(accounts(2), Ok(U128(PAID)));
    k.on_usdc_balance(accounts(3), Ok(U128(PAID))); // read before the first transfer landed: the same balance
    let r = receipts_text();
    assert_eq!(r.matches("ft_transfer").count(), 1, "only one transfer may be scheduled: {r}");
    assert!(receiver_is(&r, &accounts(2)) && !r.contains(&accounts(3).to_string()), "{r}");
    assert_eq!(k.usdc_in_flight, PAID);
}

#[test]
fn owed_and_in_flight_usdc_both_stay_out_of_reach_of_a_later_claim() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), 0, 3_000_000);
    ctx_init();
    k.on_usdc_balance(accounts(3), Ok(U128(PAID))); // 2 000 000 is free, and goes in flight
    k.on_usdc_balance(accounts(4), Ok(U128(PAID))); // nothing is free any more
    let r = receipts_text();
    assert_eq!(r.matches("ft_transfer").count(), 1, "{r}");
    assert!(r.contains("\"amount\":\"2000000\"") && !r.contains(&accounts(4).to_string()), "{r}");
    assert_eq!(k.usdc_in_flight, 2_000_000);
}

#[test]
fn a_settled_payout_releases_its_reservation_whether_it_succeeded_or_not() {
    let mut k = usdc_registry();
    ctx_init();
    k.on_usdc_balance(accounts(2), Ok(U128(PAID)));
    assert_eq!(k.usdc_in_flight, PAID);
    ctx_callback(PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(2), U128(PAID));
    assert_eq!(k.usdc_in_flight, 0, "paid");
    ctx_init();
    k.on_usdc_balance(accounts(3), Ok(U128(PAID)));
    assert_eq!(k.usdc_in_flight, PAID);
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(3), U128(PAID));
    assert_eq!(k.usdc_in_flight, 0, "failed: it is owed now, not in flight");
}

#[test]
fn a_transfer_that_fails_is_held_as_unverified_debt() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID));
    let owed = k.owed(accounts(2));
    assert_eq!(owed.usdc.0, PAID, "still protected from a later claimant's sweep");
    assert!(owed.usdc_unread, "but not trusted: the retry must look at the token balance first");
}

#[test]
fn retrying_an_unverified_amount_reads_the_balance_and_does_not_pay_it_blind() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID));
    ctx();
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    assert!(r.contains("ft_balance_of") && r.contains("on_usdc_balance"), "{r}");
    assert!(!r.contains("ft_transfer") && !r.contains("storage_deposit"), "nothing is sent before the read: {r}");
    let owed = k.owed(accounts(2));
    assert_eq!((owed.usdc.0, owed.usdc_unread), (PAID, true), "still held against sweeps until the read settles it");
    // A second call before the read lands only repeats the read: it has no way to pay.
    ctx();
    let _ = k.retry_payout(accounts(2));
    let again = receipts_text();
    assert!(!again.contains("ft_transfer") && !again.contains("storage_deposit"), "{again}");
}

#[test]
fn a_transfer_that_failed_for_a_real_reason_is_paid_after_the_re_read() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID)); // say the token refused for a while: the USDC is still here
    ctx();
    let _ = k.retry_payout(accounts(2));
    ctx_init();
    k.on_usdc_balance(accounts(2), Ok(U128(PAID))); // the read confirms it
    let r = receipts_text();
    assert!(r.contains("\"amount\":\"5000000\"") && receiver_is(&r, &accounts(2)), "{r}");
    let owed = k.owed(accounts(2));
    assert_eq!((owed.usdc.0, owed.usdc_unread), (0, false), "the record is spent by the payout it triggered");
    assert_eq!(k.usdc_in_flight, PAID);
}

#[test]
fn a_phantom_debt_clears_at_the_re_read_and_hides_no_later_top_up() {
    let mut k = usdc_registry();
    ctx_init();
    k.on_usdc_balance(accounts(2), Ok(U128(PAID)));
    ctx_callback(PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(2), U128(PAID)); // the first payout landed: the token holds nothing now
    ctx_init();
    k.on_usdc_balance(accounts(3), Ok(U128(PAID))); // a read taken before that transfer landed
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(3), U128(PAID)); // the token had nothing to send
    assert_eq!(k.owed(accounts(3)).usdc.0, PAID, "recorded, as unverified");

    ctx();
    let _ = k.retry_payout(accounts(3));
    ctx_init();
    k.on_usdc_balance(accounts(3), Ok(U128(0))); // the token holds nothing
    let o = k.owed(accounts(3));
    assert_eq!((o.near.0, o.usdc.0, o.usdc_unread), (0, 0, false), "the phantom is gone");
    assert!(logged("owed_reconciled"), "{:?}", get_logs());
    assert!(get_created_receipts().is_empty());

    ctx_init();
    k.on_usdc_balance(accounts(4), Ok(U128(TOP_UP))); // a top-up arrives and the next claim takes all of it
    let r = receipts_text();
    assert!(r.contains(&format!("\"amount\":\"{TOP_UP}\"")) && receiver_is(&r, &accounts(4)), "{r}");
}

#[test]
fn a_re_read_never_pays_more_than_the_token_holds_beyond_what_others_are_owed() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(3), 0, 1_000_000); // a real, verified debt to someone else
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID)); // unverified: the token now holds 4 000 000 in total
    ctx();
    let _ = k.retry_payout(accounts(2));
    ctx_init();
    k.on_usdc_balance(accounts(2), Ok(U128(4_000_000)));
    let r = receipts_text();
    assert!(r.contains("\"amount\":\"3000000\""), "4 000 000 held minus 1 000 000 owed to the other claimant: {r}");
    assert!(logged("owed_reconciled"), "the recorded 5 000 000 was more than there was: {:?}", get_logs());
    assert_eq!(k.owed(accounts(3)).usdc.0, 1_000_000, "the other claimant's debt is untouched");
}

#[test]
fn a_verified_retry_reserves_its_amount_while_it_is_in_flight() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), 0, PAID); // recorded from a balance read, not from a failed transfer
    ctx();
    let _ = k.retry_payout(accounts(2));
    assert_eq!(k.usdc_in_flight, PAID);
    ctx_init();
    k.on_usdc_balance(accounts(3), Ok(U128(PAID)));
    assert!(get_created_receipts().is_empty(), "the amount being retried is not free for another claim");
}

#[test]
fn the_balance_callback_still_fits_the_gas_it_is_given_with_every_record_in_play() {
    // The callback now also takes the claimant's USDC record and sums the others', so it reads more state
    // than it used to. Measured in the unit-test VM, which charges the real fees. `used_gas` counts the gas
    // attached to the calls it schedules, so it is what `ON_USDC_BALANCE_GAS` has to cover.
    let mut k = usdc_registry();
    for n in 3..=5 {
        k.record_owed(&accounts(n), 1, 1_000_000);
    }
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID)); // an unverified record for the claimant, who is paid below
    ctx_init();
    k.on_usdc_balance(accounts(2), Ok(U128(PAID * 2)));
    let used = env::used_gas();
    assert!(get_created_receipts().iter().any(|r| format!("{:?}", r.actions).contains("FunctionCall")), "a transfer was scheduled");
    println!("on_usdc_balance used {} Tgas of {}", used.as_gas() / 10u64.pow(12), ON_USDC_BALANCE_GAS.as_gas() / 10u64.pow(12));
    assert!(used <= ON_USDC_BALANCE_GAS, "used {} gas, given {}", used.as_gas(), ON_USDC_BALANCE_GAS.as_gas());
}

#[test]
fn a_second_claim_right_after_the_first_cannot_pay_out_the_same_near() {
    // The runtime takes a transfer out of the contract's balance when it creates the receipt, so a second
    // claim in the same or the next block sees only what is left. This pins that the NEAR leg relies on it.
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let pays = |who: AccountId| {
        get_created_receipts().iter().filter(|x| x.receiver_id == who && format!("{:?}", x.actions).contains("Transfer")).count()
    };
    assert_eq!(pays(accounts(2)), 1, "the first claim pays");
    assert_eq!(k.spendable_near(), 0, "and takes everything that could be spent");
    let sig = ed_sig(&k, "small-curve-omen", &accounts(3), &EdKey::from_bytes(&[3u8; 32]));
    let _ = k.claim("small-curve-omen".into(), accounts(3), sig);
    assert_eq!(pays(accounts(3)), 0, "the second claim has nothing left to pay out");
}

#[test]
fn zz_scratch_gas_probe() {
    for (label, n_owed) in [("no records", 0usize), ("3 owed records", 3)] {
        let mut k = usdc_registry();
        for n in 3..3 + n_owed {
            k.record_owed(&accounts(n), 1, 1_000_000);
        }
        ctx_init();
        let before = env::used_gas().as_gas();
        k.on_usdc_balance(accounts(2), Ok(U128(PAID * 2)));
        println!("PROBE {label}: used {} Tgas (delta {:.2})", env::used_gas().as_gas() / 10u64.pow(12), (env::used_gas().as_gas() - before) as f64 / 1e12);
    }
}
