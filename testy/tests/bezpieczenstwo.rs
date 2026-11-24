//! Testy bezpieczeństwa kontraktu HARD OTC Desk (uruchamiane automatycznie na GitHubie).
//! Każdy test buduje świeży, lokalny "blockchain" (symulator Radix) i sprawdza jedną zasadę.

use scrypto_test::prelude::*;

struct User {
    pk: Secp256k1PublicKey,
    account: ComponentAddress,
    badge: u64,
}

struct Env {
    ledger: DefaultLedgerSimulator,
    desk: ComponentAddress,
    hard: ResourceAddress,
    admin_badge: ResourceAddress,
    rider_badge: ResourceAddress,
    admin: User,
    alice: User,
    bob: User,
}

fn signer(u: &User) -> Vec<NonFungibleGlobalId> {
    vec![NonFungibleGlobalId::from_public_key(&u.pk)]
}

fn failed_with(receipt: &TransactionReceipt, text: &str) {
    let msg = format!("{:?}", receipt);
    assert!(!receipt.is_commit_success(), "Transaction should fail ({text})");
    assert!(msg.contains(text), "Expected error containing '{text}'");
}

impl Env {
    fn new() -> Self {
        let mut ledger = LedgerSimulatorBuilder::new().without_kernel_trace().build();
        // Kontrakt zbudowany wcześniej (`scrypto build`, Rust 1.81) – testujemy dokładnie ten plik, który się wgrywa.
        let dir = "../scrypto/target/wasm32-unknown-unknown/release";
        let code = std::fs::read(format!("{dir}/hard_otc.wasm")).expect("build the contract first");
        let definition: PackageDefinition =
            manifest_decode(&std::fs::read(format!("{dir}/hard_otc.rpd")).unwrap()).unwrap();
        let package = ledger.publish_package_simple((code, definition));

        let (pk, _, acc) = ledger.new_allocated_account();
        let admin = User { pk, account: acc, badge: 1 };
        let (pk, _, acc) = ledger.new_allocated_account();
        let alice = User { pk, account: acc, badge: 2 };
        let (pk, _, acc) = ledger.new_allocated_account();
        let bob = User { pk, account: acc, badge: 3 };

        // Test HARD: 1 000 000 na koncie admina
        let r = ledger.execute_manifest(
            ManifestBuilder::new()
                .lock_fee_from_faucet()
                .create_fungible_resource(
                    OwnerRole::None,
                    true,
                    18,
                    FungibleResourceRoles::default(),
                    metadata!(init { "symbol" => "HARD", locked; }),
                    Some(dec!("1000000")),
                )
                .deposit_batch(admin.account, ManifestExpression::EntireWorktop)
                .build(),
            vec![NonFungibleGlobalId::from_public_key(&admin.pk)],
        );
        let hard = r.expect_commit_success().new_resource_addresses()[0];

        let r = ledger.execute_manifest(
            ManifestBuilder::new()
                .lock_fee_from_faucet()
                .call_function(package, "OtcDesk", "instantiate", manifest_args!(hard))
                .deposit_batch(admin.account, ManifestExpression::EntireWorktop)
                .build(),
            vec![NonFungibleGlobalId::from_public_key(&admin.pk)],
        );
        let commit = r.expect_commit_success();
        let desk = commit.new_component_addresses()[0];
        let new_res = commit.new_resource_addresses().clone();
        let rider_badge = *new_res.iter().find(|r| !r.is_fungible()).expect("rider badge");
        let admin_badge = *new_res
            .iter()
            .find(|r| r.is_fungible() && ledger.get_component_balance(admin.account, **r) == dec!("2"))
            .expect("admin badge (2 pieces)");

        // HARD dla Alice i Boba, badge'e dla wszystkich (#1 admin, #2 alice, #3 bob)
        let r = ledger.execute_manifest(
            ManifestBuilder::new()
                .lock_fee_from_faucet()
                .withdraw_from_account(admin.account, hard, dec!("200000"))
                .take_from_worktop(hard, dec!("100000"), "a")
                .try_deposit_or_abort(alice.account, None, "a")
                .deposit_batch(bob.account, ManifestExpression::EntireWorktop)
                .build(),
            vec![
                NonFungibleGlobalId::from_public_key(&admin.pk),
                NonFungibleGlobalId::from_public_key(&bob.pk),
            ],
        );
        r.expect_commit_success();
        for u in [&admin, &alice, &bob] {
            let r = ledger.execute_manifest(
                ManifestBuilder::new()
                    .lock_fee_from_faucet()
                    .call_method(desk, "mint_rider_badge", manifest_args!())
                    .deposit_batch(u.account, ManifestExpression::EntireWorktop)
                    .build(),
                vec![NonFungibleGlobalId::from_public_key(&u.pk)],
            );
            r.expect_commit_success();
        }
        Env { ledger, desk, hard, admin_badge, rider_badge, admin, alice, bob }
    }

    fn bal(&mut self, account: ComponentAddress, res: ResourceAddress) -> Decimal {
        self.ledger.get_component_balance(account, res)
    }

    /// Wystawia ofertę: sprzedaje `sell` XRD za `ask` HARD.
    fn create_offer(&mut self, who: &User, sell: Decimal, ask: Decimal, hours: u8, reserved: Option<u64>, partial: bool, payout: ComponentAddress) -> TransactionReceipt {
        let hard = self.hard;
        let reserved = reserved.map(NonFungibleLocalId::integer);
        let fee = if reserved.is_some() { dec!("250") } else { dec!("100") };
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_non_fungibles(who.account, self.rider_badge, [NonFungibleLocalId::integer(who.badge)])
            .pop_from_auth_zone("rider")
            .withdraw_from_account(who.account, XRD, sell)
            .take_all_from_worktop(XRD, "sell")
            .withdraw_from_account(who.account, hard, fee)
            .take_all_from_worktop(hard, "fee")
            .call_method_with_name_lookup(self.desk, "create_offer", |l| {
                (l.proof("rider"), l.bucket("sell"), hard, ask, hours, reserved.clone(), payout, l.bucket("fee"), partial)
            })
            .deposit_batch(who.account, ManifestExpression::EntireWorktop)
            .build();
        self.ledger.execute_manifest(m, signer(who))
    }

    fn accept(&mut self, who: &User, offer: u64, pay: Decimal) -> TransactionReceipt {
        self.accept_min(who, offer, pay, Decimal::ZERO)
    }

    fn accept_min(&mut self, who: &User, offer: u64, pay: Decimal, min_receive: Decimal) -> TransactionReceipt {
        let hard = self.hard;
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_non_fungibles(who.account, self.rider_badge, [NonFungibleLocalId::integer(who.badge)])
            .pop_from_auth_zone("rider")
            .withdraw_from_account(who.account, hard, pay)
            .take_all_from_worktop(hard, "pay")
            .call_method_with_name_lookup(self.desk, "accept_offer", |l| (offer, l.proof("rider"), l.bucket("pay"), min_receive))
            .deposit_batch(who.account, ManifestExpression::EntireWorktop)
            .build();
        self.ledger.execute_manifest(m, signer(who))
    }

    fn rider_call(&mut self, who: &User, method: &str, offer: u64) -> TransactionReceipt {
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_non_fungibles(who.account, self.rider_badge, [NonFungibleLocalId::integer(who.badge)])
            .pop_from_auth_zone("rider")
            .call_method_with_name_lookup(self.desk, method, |l| (offer, l.proof("rider")))
            .deposit_batch(who.account, ManifestExpression::EntireWorktop)
            .build();
        self.ledger.execute_manifest(m, signer(who))
    }

    fn rider_call_noarg(&mut self, who: &User, method: &str) -> TransactionReceipt {
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_non_fungibles(who.account, self.rider_badge, [NonFungibleLocalId::integer(who.badge)])
            .pop_from_auth_zone("rider")
            .call_method_with_name_lookup(self.desk, method, |l| (l.proof("rider"),))
            .deposit_batch(who.account, ManifestExpression::EntireWorktop)
            .build();
        self.ledger.execute_manifest(m, signer(who))
    }

    /// Wywołanie metody admina; `with_badge` = czy dołączyć dowód badge'a admina.
    fn admin_call(&mut self, who_is_admin: bool, method: &str, args: ManifestArgs) -> TransactionReceipt {
        let (account, pk) = if who_is_admin { (self.admin.account, self.admin.pk) } else { (self.alice.account, self.alice.pk) };
        let mut b = ManifestBuilder::new().lock_fee_from_faucet();
        if who_is_admin {
            b = b.create_proof_from_account_of_amount(account, self.admin_badge, dec!("1"));
        }
        let m = b.call_method(self.desk, method, args).deposit_batch(account, ManifestExpression::EntireWorktop).build();
        self.ledger.execute_manifest(m, vec![NonFungibleGlobalId::from_public_key(&pk)])
    }

    fn lock_hard(&mut self, who: &User, amount: Decimal) {
        let hard = self.hard;
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_non_fungibles(who.account, self.rider_badge, [NonFungibleLocalId::integer(who.badge)])
            .pop_from_auth_zone("rider")
            .withdraw_from_account(who.account, hard, amount)
            .take_all_from_worktop(hard, "h")
            .call_method_with_name_lookup(self.desk, "lock_hard", |l| (l.proof("rider"), l.bucket("h")))
            .build();
        self.ledger.execute_manifest(m, signer(who)).expect_commit_success();
    }
}

fn admin_of(e: &Env) -> User { User { pk: e.admin.pk, account: e.admin.account, badge: 1 } }
fn alice_of(e: &Env) -> User { User { pk: e.alice.pk, account: e.alice.account, badge: 2 } }
fn bob_of(e: &Env) -> User { User { pk: e.bob.pk, account: e.bob.account, badge: 3 } }

// ---------------------------------------------------------------- Handel

#[test]
fn pelna_transakcja_i_oplaty_sa_poprawne() {
    let mut e = Env::new();
    let (alice, bob) = (alice_of(&e), bob_of(&e));
    let a_hard0 = e.bal(alice.account, e.hard);
    let b_xrd0 = e.bal(bob.account, XRD);
    e.create_offer(&alice, dec!("100"), dec!("1000"), 72, None, false, alice.account).expect_commit_success();
    // Alice zapłaciła 100 HARD za ogłoszenie
    assert_eq!(e.bal(alice.account, e.hard), a_hard0 - dec!("100"));
    e.accept(&bob, 1, dec!("1000")).expect_commit_success();
    // Alice: +1000 HARD − 0,5% opłaty; Bob: +100 XRD − 0,5%
    assert_eq!(e.bal(alice.account, e.hard), a_hard0 - dec!("100") + dec!("995"));
    assert_eq!(e.bal(bob.account, XRD), b_xrd0 + dec!("99.5"));
}

#[test]
fn nie_mozna_kupic_wlasnej_oferty() {
    let mut e = Env::new();
    let alice = alice_of(&e);
    e.create_offer(&alice, dec!("100"), dec!("1000"), 72, None, false, alice.account).expect_commit_success();
    let r = e.accept(&alice, 1, dec!("1000"));
    failed_with(&r, "Cannot fill your own offer");
}

#[test]
fn czesciowe_kupno_tylko_gdy_dozwolone() {
    let mut e = Env::new();
    let (alice, bob) = (alice_of(&e), bob_of(&e));
    e.create_offer(&alice, dec!("100"), dec!("1000"), 72, None, false, alice.account).expect_commit_success();
    failed_with(&e.accept(&bob, 1, dec!("500")), "must be bought in full");

    e.create_offer(&alice, dec!("100"), dec!("1000"), 72, None, true, alice.account).expect_commit_success();
    let x0 = e.bal(bob.account, XRD);
    e.accept(&bob, 2, dec!("500")).expect_commit_success();
    assert_eq!(e.bal(bob.account, XRD), x0 + dec!("49.75"));
    // reszta oferty dalej do kupienia
    e.accept(&bob, 2, dec!("500")).expect_commit_success();
    failed_with(&e.accept(&bob, 2, dec!("1")), "Offer is not open");
}

#[test]
fn tylko_sprzedajacy_moze_anulowac_takze_przy_pauzie() {
    let mut e = Env::new();
    let (alice, bob) = (alice_of(&e), bob_of(&e));
    e.create_offer(&alice, dec!("100"), dec!("1000"), 72, None, false, alice.account).expect_commit_success();
    failed_with(&e.rider_call(&bob, "cancel_offer", 1), "Only the seller can cancel");
    e.admin_call(true, "set_paused", manifest_args!(true)).expect_commit_success();
    failed_with(&e.accept(&bob, 1, dec!("1000")), "Desk is paused");
    let x0 = e.bal(alice.account, XRD);
    e.rider_call(&alice, "cancel_offer", 1).expect_commit_success();
    assert_eq!(e.bal(alice.account, XRD), x0 + dec!("100"));
}

#[test]
fn oferta_zarezerwowana_tylko_dla_wybranego() {
    let mut e = Env::new();
    let (admin, alice, bob) = (admin_of(&e), alice_of(&e), bob_of(&e));
    // bez locka 1000 HARD nie da się rezerwować
    failed_with(&e.create_offer(&alice, dec!("100"), dec!("1000"), 72, Some(3), false, alice.account), "require at least 1000 HARD locked");
    e.lock_hard(&alice, dec!("1000"));
    e.create_offer(&alice, dec!("100"), dec!("1000"), 72, Some(3), false, alice.account).expect_commit_success();
    let r = {
        let hard = e.hard;
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .withdraw_from_account(admin.account, hard, dec!("1000"))
            .create_proof_from_account_of_non_fungibles(admin.account, e.rider_badge, [NonFungibleLocalId::integer(1)])
            .pop_from_auth_zone("rider")
            .take_all_from_worktop(hard, "pay")
            .call_method_with_name_lookup(e.desk, "accept_offer", |l| (1u64, l.proof("rider"), l.bucket("pay"), Decimal::ZERO))
            .deposit_batch(admin.account, ManifestExpression::EntireWorktop)
            .build();
        e.ledger.execute_manifest(m, signer(&admin))
    };
    failed_with(&r, "reserved for another user");
    e.accept(&bob, 1, dec!("1000")).expect_commit_success();
}

#[test]
fn wyplata_tylko_na_prawdziwe_konto() {
    let mut e = Env::new();
    let alice = alice_of(&e);
    let desk = e.desk;
    // Radix sam odrzuca nie-konto przy dekodowaniu, a kontrakt ma dodatkowy bezpiecznik.
    let r = e.create_offer(&alice, dec!("100"), dec!("1000"), 72, None, false, desk);
    assert!(!r.is_commit_success(), "payout to a non-account must fail");
}

#[test]
fn wyroznienie_nie_dluzsze_niz_oferta() {
    let mut e = Env::new();
    let alice = alice_of(&e);
    e.create_offer(&alice, dec!("100"), dec!("1000"), 72, None, false, alice.account).expect_commit_success();
    let promote = |e: &mut Env, days: u8| {
        let hard = e.hard;
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_non_fungibles(alice.account, e.rider_badge, [NonFungibleLocalId::integer(2)])
            .pop_from_auth_zone("rider")
            .withdraw_from_account(alice.account, hard, dec!("1000"))
            .take_all_from_worktop(hard, "h")
            .call_method_with_name_lookup(e.desk, "promote_offer", |l| (1u64, l.proof("rider"), l.bucket("h"), days))
            .deposit_batch(alice.account, ManifestExpression::EntireWorktop)
            .build();
        e.ledger.execute_manifest(m, signer(&alice))
    };
    failed_with(&promote(&mut e, 4), "outlast the offer");
    promote(&mut e, 3).expect_commit_success();
}

// ---------------------------------------------------------------- Admin

#[test]
fn metody_admina_wymagaja_badgea() {
    let mut e = Env::new();
    let calls: Vec<(&str, ManifestArgs)> = vec![
        ("set_listing_fee", manifest_args!(dec!("1"))),
        ("set_paused", manifest_args!(true)),
        ("withdraw_buyback_xrd", manifest_args!(dec!("0"))),
        ("withdraw_buyback_hard", manifest_args!(dec!("0"))),
        ("set_lsu_buyback", manifest_args!(true, dec!("0.5"), dec!("1000"))),
        ("set_hard_price", manifest_args!(dec!("1"))),
        ("withdraw_treasury", manifest_args!(XRD, dec!("0"))),
    ];
    for (m, a) in calls {
        let r = e.admin_call(false, m, a);
        assert!(!r.is_commit_success(), "{m} should require the admin badge");
    }
    e.admin_call(true, "set_listing_fee", manifest_args!(dec!("50"))).expect_commit_success();
    failed_with(&e.admin_call(true, "set_listing_fee", manifest_args!(dec!("101"))), "cannot exceed 100");
    failed_with(&e.admin_call(true, "set_unlock_period", manifest_args!(31i64 * 24 * 3600)), "cannot exceed 30 days");
    failed_with(&e.admin_call(true, "set_trading_fee", manifest_args!(dec!("0.011"))), "cannot exceed 1% per side");
    assert!(!e.admin_call(false, "set_trading_fee", manifest_args!(dec!("0"))).is_commit_success());
    e.admin_call(true, "set_trading_fee", manifest_args!(dec!("0.0075"))).expect_commit_success();
}

#[test]
fn czesciowa_wyplata_z_portfela_skupu() {
    let mut e = Env::new();
    let admin = admin_of(&e);
    let m = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_amount(admin.account, e.admin_badge, dec!("1"))
        .withdraw_from_account(admin.account, XRD, dec!("1000"))
        .take_all_from_worktop(XRD, "x")
        .call_method_with_name_lookup(e.desk, "fund_lsu_buyback_xrd", |l| (l.bucket("x"),))
        .build();
    e.ledger.execute_manifest(m, signer(&admin)).expect_commit_success();
    let x0 = e.bal(admin.account, XRD);
    e.admin_call(true, "withdraw_buyback_xrd", manifest_args!(dec!("300"))).expect_commit_success();
    assert_eq!(e.bal(admin.account, XRD), x0 + dec!("300"));
    e.admin_call(true, "withdraw_buyback_xrd", manifest_args!(dec!("0"))).expect_commit_success();
    assert_eq!(e.bal(admin.account, XRD), x0 + dec!("1000"));
}

// ---------------------------------------------------------------- Skup stakowanego XRD

#[test]
fn falszywe_lsu_odrzucone() {
    let mut e = Env::new();
    let alice = alice_of(&e);
    e.admin_call(true, "set_lsu_buyback", manifest_args!(true, dec!("0.9"), dec!("1000000"))).expect_commit_success();
    // Token udający LSU: metadane "validator" wskazują zwykłe konto
    let r = e.ledger.execute_manifest(
        ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_fungible_resource(
                OwnerRole::None,
                true,
                18,
                FungibleResourceRoles::default(),
                metadata!(init { "validator" => GlobalAddress::from(alice.account), locked; }),
                Some(dec!("1000")),
            )
            .deposit_batch(alice.account, ManifestExpression::EntireWorktop)
            .build(),
        signer(&alice),
    );
    let fake = r.expect_commit_success().new_resource_addresses()[0];
    let m = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(alice.account, e.rider_badge, [NonFungibleLocalId::integer(2)])
        .pop_from_auth_zone("rider")
        .withdraw_from_account(alice.account, fake, dec!("1000"))
        .take_all_from_worktop(fake, "lsu")
        .call_method_with_name_lookup(e.desk, "request_lsu_sale", |l| (l.proof("rider"), l.bucket("lsu"), dec!("1"), dec!("1"), alice.account))
        .deposit_batch(alice.account, ManifestExpression::EntireWorktop)
        .build();
    failed_with(&e.ledger.execute_manifest(m, signer(&alice)), "Not a native Radix validator");
}

#[test]
fn prawdziwe_lsu_wycena_podzial_i_limity() {
    let mut e = Env::new();
    let (admin, bob) = (admin_of(&e), bob_of(&e));

    // Bob ma walidatora i stakuje 1000 XRD -> dostaje LSU
    let validator = e.ledger.new_validator_with_pub_key(bob.pk, bob.account);
    let lsu = e.ledger.get_validator_info(validator).stake_unit_resource;
    let owner_id = NonFungibleLocalId::bytes(validator.as_node_id().0).unwrap();
    let m = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(bob.account, VALIDATOR_OWNER_BADGE, [owner_id])
        .withdraw_from_account(bob.account, XRD, dec!("1000"))
        .take_all_from_worktop(XRD, "x")
        .call_method_with_name_lookup(validator, "stake_as_owner", |l| (l.bucket("x"),))
        .deposit_batch(bob.account, ManifestExpression::EntireWorktop)
        .build();
    e.ledger.execute_manifest(m, signer(&bob)).expect_commit_success();
    let lsu_amount = e.bal(bob.account, lsu);
    assert!(lsu_amount > Decimal::ZERO);

    // Admin: włącza skup (−10%), 80% XRD / 20% HARD, zasila portfele
    e.admin_call(true, "set_lsu_buyback", manifest_args!(true, dec!("0.9"), dec!("1000000"))).expect_commit_success();
    let hard = e.hard;
    let m = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_amount(admin.account, e.admin_badge, dec!("1"))
        .withdraw_from_account(admin.account, XRD, dec!("2000"))
        .take_all_from_worktop(XRD, "x")
        .call_method_with_name_lookup(e.desk, "fund_lsu_buyback_xrd", |l| (l.bucket("x"),))
        .withdraw_from_account(admin.account, hard, dec!("5000"))
        .take_all_from_worktop(hard, "h")
        .call_method_with_name_lookup(e.desk, "fund_lsu_buyback", |l| (l.bucket("h"),))
        .build();
    e.ledger.execute_manifest(m, signer(&admin)).expect_commit_success();

    // Bob składa zlecenie: minimum 700 XRD + 350 HARD
    let sell = |e: &mut Env, amount: Decimal, min_x: Decimal, min_h: Decimal| {
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_non_fungibles(bob.account, e.rider_badge, [NonFungibleLocalId::integer(3)])
            .pop_from_auth_zone("rider")
            .withdraw_from_account(bob.account, lsu, amount)
            .take_all_from_worktop(lsu, "lsu")
            .call_method_with_name_lookup(e.desk, "request_lsu_sale", |l| (l.proof("rider"), l.bucket("lsu"), min_x, min_h, bob.account))
            .deposit_batch(bob.account, ManifestExpression::EntireWorktop)
            .build();
        e.ledger.execute_manifest(m, signer(&bob))
    };
    failed_with(&sell(&mut e, lsu_amount, dec!("0"), dec!("350")), "Set a minimum XRD amount");
    sell(&mut e, lsu_amount, dec!("700"), dec!("350")).expect_commit_success();

    // Cena HARD zbyt wysoka -> HARD poniżej minimum Boba -> nie da się zaakceptować
    e.admin_call(true, "set_hard_price", manifest_args!(dec!("1"))).expect_commit_success();
    failed_with(&e.admin_call(true, "accept_lsu_sale", manifest_args!(1u64)), "below the seller's minimum");

    // Dzienny limit 100 XRD -> blokuje
    e.admin_call(true, "set_hard_price", manifest_args!(dec!("0.5"))).expect_commit_success();
    e.admin_call(true, "set_lsu_limits", manifest_args!(dec!("5000"), dec!("100"))).expect_commit_success();
    failed_with(&e.admin_call(true, "accept_lsu_sale", manifest_args!(1u64)), "Daily buying limit reached");

    // Normalnie: 1000 XRD wartości × 0,9 = 900 -> 720 XRD + 180 XRD w HARD po 0,5 = 360 HARD
    e.admin_call(true, "set_lsu_limits", manifest_args!(dec!("5000"), dec!("20000"))).expect_commit_success();
    let x0 = e.bal(bob.account, XRD);
    let h0 = e.bal(bob.account, hard);
    e.admin_call(true, "accept_lsu_sale", manifest_args!(1u64)).expect_commit_success();
    assert_eq!(e.bal(bob.account, XRD), x0 + dec!("720"));
    assert_eq!(e.bal(bob.account, hard), h0 + dec!("360"));
    // drugi raz tego samego zlecenia nie da się zaakceptować
    failed_with(&e.admin_call(true, "accept_lsu_sale", manifest_args!(1u64)), "not pending");
    // admin odbiera kupione LSU
    e.admin_call(true, "withdraw_lsu", manifest_args!(lsu)).expect_commit_success();
    assert_eq!(e.bal(admin.account, lsu), lsu_amount);
}


#[test]
fn kranik_raz_na_badge_i_tylko_gdy_wlaczony() {
    let mut e = Env::new();
    let (admin, alice) = (admin_of(&e), alice_of(&e));
    let claim = |e: &mut Env| {
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_non_fungibles(alice.account, e.rider_badge, [NonFungibleLocalId::integer(2)])
            .pop_from_auth_zone("rider")
            .call_method_with_name_lookup(e.desk, "claim_faucet", |l| (l.proof("rider"),))
            .deposit_batch(alice.account, ManifestExpression::EntireWorktop)
            .build();
        e.ledger.execute_manifest(m, signer(&alice))
    };
    failed_with(&claim(&mut e), "Faucet is off");
    // tylko admin może włączyć i zasilić
    assert!(!e.admin_call(false, "set_faucet_amount", manifest_args!(dec!("100"))).is_commit_success());
    e.admin_call(true, "set_faucet_amount", manifest_args!(dec!("100"))).expect_commit_success();
    failed_with(&claim(&mut e), "Faucet is empty");
    let hard = e.hard;
    let m = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_amount(admin.account, e.admin_badge, dec!("1"))
        .withdraw_from_account(admin.account, hard, dec!("1000"))
        .take_all_from_worktop(hard, "h")
        .call_method_with_name_lookup(e.desk, "fund_faucet", |l| (l.bucket("h"),))
        .build();
    e.ledger.execute_manifest(m, signer(&admin)).expect_commit_success();
    let h0 = e.bal(alice.account, hard);
    claim(&mut e).expect_commit_success();
    assert_eq!(e.bal(alice.account, hard), h0 + dec!("100"));
    failed_with(&claim(&mut e), "Already claimed");
    let a0 = e.bal(admin.account, hard);
    e.admin_call(true, "withdraw_faucet", manifest_args!(dec!("0"))).expect_commit_success();
    assert_eq!(e.bal(admin.account, hard), a0 + dec!("900"));
}


// ---------------------------------------------------------------- v8: poprawki po audycie

#[test]
fn badge_jest_nieprzenosny() {
    let mut e = Env::new();
    let (alice, bob) = (alice_of(&e), bob_of(&e));
    let m = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(alice.account, e.rider_badge, [NonFungibleLocalId::integer(2)])
        .deposit_batch(bob.account, ManifestExpression::EntireWorktop)
        .build();
    let r = e.ledger.execute_manifest(m, vec![
        NonFungibleGlobalId::from_public_key(&alice.pk),
        NonFungibleGlobalId::from_public_key(&bob.pk),
    ]);
    assert!(!r.is_commit_success(), "the badge must not leave Alice's account");
}

#[test]
fn oplata_zamrozona_w_ofercie() {
    let mut e = Env::new();
    let (alice, bob) = (alice_of(&e), bob_of(&e));
    e.create_offer(&alice, dec!("100"), dec!("1000"), 72, None, false, alice.account).expect_commit_success();
    // admin podnosi opłatę do 1% już po wystawieniu
    e.admin_call(true, "set_trading_fee", manifest_args!(dec!("0.01"))).expect_commit_success();
    let x0 = e.bal(bob.account, XRD);
    e.accept(&bob, 1, dec!("1000")).expect_commit_success();
    // dalej 0,5% (stawka z chwili wystawienia)
    assert_eq!(e.bal(bob.account, XRD), x0 + dec!("99.5"));
}

#[test]
fn kupujacy_dostaje_co_najmniej_minimum() {
    let mut e = Env::new();
    let (alice, bob) = (alice_of(&e), bob_of(&e));
    e.create_offer(&alice, dec!("100"), dec!("1000"), 72, None, false, alice.account).expect_commit_success();
    failed_with(&e.accept_min(&bob, 1, dec!("1000"), dec!("99.6")), "less than your minimum");
    e.accept_min(&bob, 1, dec!("1000"), dec!("99.5")).expect_commit_success();
}

#[test]
fn wygasla_oferte_moze_zwrocic_kazdy_tylko_sprzedajacemu() {
    let mut e = Env::new();
    let (alice, bob) = (alice_of(&e), bob_of(&e));
    e.create_offer(&alice, dec!("100"), dec!("1000"), 1, None, false, alice.account).expect_commit_success();
    // przed wygaśnięciem — nie
    failed_with(&e.admin_call(false, "reclaim_expired_offer", manifest_args!(1u64)), "not expired yet");
    // +2 h
    let now_ms = e.ledger.get_current_proposer_timestamp_ms();
    e.ledger.advance_to_round_at_timestamp(Round::of(100), now_ms + 2 * 3600 * 1000);
    let a0 = e.bal(alice.account, XRD);
    let b0 = e.bal(bob.account, XRD);
    // Bob (obcy) wywołuje zwrot — XRD trafia do Alice, nie do Boba
    let m = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(e.desk, "reclaim_expired_offer", manifest_args!(1u64))
        .deposit_batch(bob.account, ManifestExpression::EntireWorktop)
        .build();
    e.ledger.execute_manifest(m, signer(&bob)).expect_commit_success();
    assert_eq!(e.bal(alice.account, XRD), a0 + dec!("100"));
    assert_eq!(e.bal(bob.account, XRD), b0);
    failed_with(&e.admin_call(false, "reclaim_expired_offer", manifest_args!(1u64)), "Offer is not open");
}

#[test]
fn admin_zwraca_oferte_tylko_sprzedajacemu() {
    let mut e = Env::new();
    let (admin, alice) = (admin_of(&e), alice_of(&e));
    e.create_offer(&alice, dec!("100"), dec!("1000"), 72, None, false, alice.account).expect_commit_success();
    assert!(!e.admin_call(false, "admin_return_offer", manifest_args!(1u64)).is_commit_success());
    let a0 = e.bal(alice.account, XRD);
    let ad0 = e.bal(admin.account, XRD);
    e.admin_call(true, "admin_return_offer", manifest_args!(1u64)).expect_commit_success();
    assert_eq!(e.bal(alice.account, XRD), a0 + dec!("100"));
    assert_eq!(e.bal(admin.account, XRD), ad0);
}

#[test]
fn tylko_zweryfikowane_tokeny_domyslnie() {
    let mut e = Env::new();
    let alice = alice_of(&e);
    // nieznany token Alice
    let r = e.ledger.execute_manifest(
        ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_fungible_resource(OwnerRole::None, true, 18, FungibleResourceRoles::default(), metadata!(), Some(dec!("1000")))
            .deposit_batch(alice.account, ManifestExpression::EntireWorktop)
            .build(),
        signer(&alice),
    );
    let junk = r.expect_commit_success().new_resource_addresses()[0];
    let offer = |e: &mut Env| {
        let hard = e.hard;
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_non_fungibles(alice.account, e.rider_badge, [NonFungibleLocalId::integer(2)])
            .pop_from_auth_zone("rider")
            .withdraw_from_account(alice.account, junk, dec!("10"))
            .take_all_from_worktop(junk, "sell")
            .withdraw_from_account(alice.account, hard, dec!("100"))
            .take_all_from_worktop(hard, "fee")
            .call_method_with_name_lookup(e.desk, "create_offer", |l| {
                (l.proof("rider"), l.bucket("sell"), XRD, dec!("1"), 72u8, None::<NonFungibleLocalId>, alice.account, l.bucket("fee"), false)
            })
            .deposit_batch(alice.account, ManifestExpression::EntireWorktop)
            .build();
        e.ledger.execute_manifest(m, signer(&alice))
    };
    failed_with(&offer(&mut e), "Only verified tokens");
    e.admin_call(true, "set_only_verified", manifest_args!(false)).expect_commit_success();
    offer(&mut e).expect_commit_success();
}

#[test]
fn ponowne_odblokowanie_nie_zeruje_gotowego_hard() {
    let mut e = Env::new();
    let alice = alice_of(&e);
    e.lock_hard(&alice, dec!("2000"));
    let unlock = |e: &mut Env, amt: Decimal| {
        let m = ManifestBuilder::new()
            .lock_fee_from_faucet()
            .create_proof_from_account_of_non_fungibles(alice.account, e.rider_badge, [NonFungibleLocalId::integer(2)])
            .pop_from_auth_zone("rider")
            .call_method_with_name_lookup(e.desk, "request_unlock", |l| (l.proof("rider"), amt))
            .build();
        e.ledger.execute_manifest(m, signer(&alice))
    };
    unlock(&mut e, dec!("500")).expect_commit_success();
    let now_ms = e.ledger.get_current_proposer_timestamp_ms();
    e.ledger.advance_to_round_at_timestamp(Round::of(100), now_ms + 8 * 24 * 3600 * 1000);
    failed_with(&unlock(&mut e, dec!("500")), "Withdraw your unlocked HARD first");
    let h0 = e.bal(alice.account, e.hard);
    e.rider_call_noarg(&alice, "withdraw_unlocked").expect_commit_success();
    assert_eq!(e.bal(alice.account, e.hard), h0 + dec!("500"));
    unlock(&mut e, dec!("500")).expect_commit_success();
}
