//! HARD OTC Desk v8 — escrow OTC na Radix (po audycie bezpieczeństwa).
//!
//! 1. HARD OTC Badge (darmowe NFT) = tożsamość na desku.
//! 2. Sprzedający blokuje token w escrow (`create_offer`), płaci opłatę za ogłoszenie w HARD
//!    (domyślnie 100, admin 0–100). Opcjonalnie: częściowe kupno, rezerwacja dla konkretnego ridera
//!    (wymaga >= 1 000 HARD w locku).
//! 3. Kupujący płaci (`accept_offer`) całość albo część (jeśli oferta pozwala) — atomowo.
//! 4. Opłata od transakcji 0,75% z każdej strony; progi rabatowe za lock HARD (−20/−40/−60%).
//! 5. Opłaty -> skarbiec (buyback HARD / płynność). Brak spalania HARD.
//! 6a. Rezerwacja oferty dla konkretnego badge'a: 50 HARD za każde rozpoczęte 24 h ważności (ustawia admin).
//! 6. Wyróżnienie oferty (★): 50 HARD za każde 24 h, dokupowane w dowolnym momencie (ustawia admin).
//! 7. Zweryfikowane tokeny: lista prowadzona przez admina (strona oznacza je ✓).
//! 8. Reputacja: liczniki transakcji ridera (sprzedaże, zakupy).
//! 10. Skup stakowanego XRD: użytkownik składa zlecenie sprzedaży LSU (LSU czeka w escrow).
//!     Admin ręcznie akceptuje albo odrzuca (LSU wraca). Wypłata = wartość LSU w XRD × (1 − prowizja),
//!     z czego część w XRD (domyślnie 80%, z portfela XRD admina) i reszta w HARD (20%, po cenie HARD
//!     z chwili akceptacji). Użytkownik może anulować, dopóki zlecenie czeka.
//! 11. Bezpieczeństwo (v8): badge nieprzenośny (środki nie przechodzą na kogoś innego), opłata za handel
//!     zamrożona w ofercie w chwili wystawienia, kupujący podaje minimum, które musi dostać, wygasłe oferty
//!     może zwrócić KAŻDY — zawsze tylko na konto sprzedającego, admin może zwrócić ofertę (np. podejrzany
//!     token) — także tylko na konto sprzedającego, tryb "tylko zweryfikowane tokeny" (domyślnie włączony).
//!     Brak wspólnej puli: admin nie zarządza cudzymi środkami.
//! 9. Wypłata locka w dwóch krokach z okresem oczekiwania (domyślnie 7 dni).
//!
//! Obie strony oferty: zasoby fungible (tokeny, LSU, LP). NFT — w kolejnej wersji.

use scrypto::prelude::*;

pub mod test_faucet;

/// HARD OTC Badge: numerowany (#1, #2, …) badge tożsamości na desku.
#[derive(ScryptoSbor, NonFungibleData)]
pub struct RiderBadge {
    pub name: String,
    pub number: u64,
    pub created_at: Instant,
}

#[derive(ScryptoSbor, Clone, PartialEq, Eq, Debug)]
pub enum OfferStatus {
    Open,
    Filled,
    Cancelled,
}

#[derive(ScryptoSbor, Clone)]
pub struct Offer {
    pub seller: NonFungibleLocalId,
    pub seller_account: Global<Account>,
    pub sell_resource: ResourceAddress,
    pub sell_amount: Decimal,
    pub ask_resource: ResourceAddress,
    pub ask_amount: Decimal,
    /// ile jeszcze zostało do sprzedania / do zapłaty (przy częściowym kupnie maleje)
    pub sell_remaining: Decimal,
    pub ask_remaining: Decimal,
    pub allow_partial: bool,
    pub created_at: Instant,
    pub expires_at: Instant,
    pub featured_until: Instant,
    pub reserved_buyer: Option<NonFungibleLocalId>,
    pub status: OfferStatus,
    /// opłata za handel od strony obowiązująca w chwili wystawienia (admin nie podniesie jej istniejącym ofertom)
    pub fee_rate: Decimal,
}

#[derive(ScryptoSbor, Clone, Default)]
pub struct RiderStats {
    pub sells: u64,
    pub buys: u64,
    pub offers_created: u64,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OfferCreatedEvent {
    pub offer_id: u64,
    pub seller: NonFungibleLocalId,
    pub sell_resource: ResourceAddress,
    pub sell_amount: Decimal,
    pub ask_resource: ResourceAddress,
    pub ask_amount: Decimal,
    pub expires_at: Instant,
    pub reserved: bool,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OfferFilledEvent {
    pub offer_id: u64,
    pub seller: NonFungibleLocalId,
    pub buyer: NonFungibleLocalId,
    pub paid: Decimal,
    pub received: Decimal,
    pub fully_filled: bool,
    pub seller_fee: Decimal,
    pub buyer_fee: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OfferCancelledEvent {
    pub offer_id: u64,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OfferPromotedEvent {
    pub offer_id: u64,
    pub featured_until: Instant,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct FeeCollectedEvent {
    pub resource: ResourceAddress,
    pub to_treasury: Decimal,
}

#[derive(ScryptoSbor, Clone, PartialEq, Eq, Debug)]
pub enum LsuRequestStatus {
    Pending,
    Accepted,
    Rejected,
    Cancelled,
}

#[derive(ScryptoSbor, Clone)]
pub struct LsuRequest {
    pub requester: NonFungibleLocalId,
    pub account: Global<Account>,
    pub lsu: ResourceAddress,
    pub lsu_amount: Decimal,
    /// minimum XRD i HARD, jakie użytkownik akceptuje (ochrona przed zmianą ceny)
    pub min_xrd_out: Decimal,
    pub min_hard_out: Decimal,
    pub created_at: Instant,
    pub status: LsuRequestStatus,
    pub xrd_paid: Decimal,
    pub hard_paid: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct LsuSoldEvent {
    pub lsu: ResourceAddress,
    pub lsu_amount: Decimal,
    pub xrd_value: Decimal,
    pub xrd_out: Decimal,
    pub hard_out: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct HardLockChangedEvent {
    pub rider: NonFungibleLocalId,
    pub locked_total: Decimal,
}

#[blueprint]
#[events(OfferCreatedEvent, OfferFilledEvent, OfferCancelledEvent, OfferPromotedEvent, HardLockChangedEvent, FeeCollectedEvent, LsuSoldEvent)]
mod hard_otc {
    enable_method_auth! {
        methods {
            mint_rider_badge => PUBLIC;
            claim_faucet => PUBLIC;
            fund_faucet => restrict_to: [OWNER];
            set_faucet_amount => restrict_to: [OWNER];
            withdraw_faucet => restrict_to: [OWNER];
            create_offer => PUBLIC;
            accept_offer => PUBLIC;
            cancel_offer => PUBLIC;
            reclaim_expired_offer => PUBLIC;
            admin_return_offer => restrict_to: [OWNER];
            set_only_verified => restrict_to: [OWNER];
            promote_offer => PUBLIC;
            request_lsu_sale => PUBLIC;
            cancel_lsu_sale => PUBLIC;
            lock_hard => PUBLIC;
            request_unlock => PUBLIC;
            withdraw_unlocked => PUBLIC;
            get_offer => PUBLIC;
            quote_fee => PUBLIC;
            withdraw_treasury => restrict_to: [OWNER];
            set_paused => restrict_to: [OWNER];
            set_listing_fee => restrict_to: [OWNER];
            set_unlock_period => restrict_to: [OWNER];
            set_promotion_fee => restrict_to: [OWNER];
            set_reservation_fee => restrict_to: [OWNER];
            add_verified => restrict_to: [OWNER];
            set_lsu_buyback => restrict_to: [OWNER];
            accept_lsu_sale => restrict_to: [OWNER];
            reject_lsu_sale => restrict_to: [OWNER];
            set_hard_price => restrict_to: [OWNER];
            fund_lsu_buyback => restrict_to: [OWNER];
            fund_lsu_buyback_xrd => restrict_to: [OWNER];
            withdraw_buyback_xrd => restrict_to: [OWNER];
            set_lsu_split => restrict_to: [OWNER];
            set_lsu_limits => restrict_to: [OWNER];
            set_trading_fee => restrict_to: [OWNER];
            withdraw_buyback_hard => restrict_to: [OWNER];
            withdraw_lsu => restrict_to: [OWNER];
            remove_verified => restrict_to: [OWNER];
        }
    }

    struct OtcDesk {
        /// wersja kontraktu (strona dopasowuje do niej transakcje)
        version: u8,
        /// badge admina (strona pokazuje panel admina portfelom, które go mają)
        admin_badge: ResourceAddress,
        rider_badge: NonFungibleResourceManager,
        /// numer następnego HARD OTC Badge
        next_badge_number: u64,
        hard_resource: ResourceAddress,
        /// (próg zablokowanych HARD, mnożnik opłaty) rosnąco po progu
        discount_tiers: Vec<(Decimal, Decimal)>,
        fee_rate_per_side: Decimal,
        /// opłata w HARD za wystawienie oferty
        listing_fee_hard: Decimal,
        /// opłata w HARD za wyróżnienie oferty, za każde 24 h
        promotion_fee_hard: Decimal,
        /// opłata w HARD za rezerwację oferty, za każde rozpoczęte 24 h ważności
        reservation_fee_hard: Decimal,
        /// łącznie HARD z opłat za rezerwację
        reservation_fees_hard: Decimal,
        /// łącznie HARD z promowania ofert
        promotion_fees_hard: Decimal,
        /// tokeny zweryfikowane przez admina
        verified: Vec<ResourceAddress>,
        /// reputacja riderów
        rider_stats: KeyValueStore<NonFungibleLocalId, RiderStats>,
        next_offer_id: u64,
        offers: KeyValueStore<u64, Offer>,
        escrow: KeyValueStore<u64, Vault>,
        treasury: KeyValueStore<ResourceAddress, Vault>,
        /// łącznie zarobione opłaty (do przejrzystości na stronie)
        fees_collected: IndexMap<ResourceAddress, Decimal>,
        /// łącznie HARD zarobione z opłat za ogłoszenia
        listing_fees_hard: Decimal,
        /// łącznie wypłacone ze skarbca (na buyback / płynność)
        treasury_withdrawn: IndexMap<ResourceAddress, Decimal>,
        // ---- Skup LSU za HARD ----
        lsu_buyback_enabled: bool,
        /// jaka część wartości LSU jest wypłacana w HARD, np. 0.9 = −10%, 0.85 = −15%
        lsu_payout: Decimal,
        /// cena HARD w XRD (ile XRD za 1 HARD), ustawiana przez admina
        hard_price_xrd: Decimal,
        hard_price_updated_at: Instant,
        /// maks. HARD wypłacane za jedno zlecenie
        lsu_max_hard_per_tx: Decimal,
        next_lsu_request_id: u64,
        lsu_requests: KeyValueStore<u64, LsuRequest>,
        lsu_escrow: KeyValueStore<u64, Vault>,
        /// HARD przeznaczone na skup (zasila admin)
        buyback_hard: Vault,
        /// XRD przeznaczone na skup (zasila admin)
        buyback_xrd: Vault,
        /// jaka część wypłaty idzie w XRD (reszta w HARD), np. 0.8
        lsu_xrd_share: Decimal,
        /// łącznie XRD wypłacone za LSU
        lsu_xrd_paid: Decimal,
        /// Limit wartości wypłaty (w XRD) na jedno zgłoszenie.
        lsu_max_value_per_tx: Decimal,
        /// Dzienny limit wartości wypłat (w XRD) – okno 24 h.
        lsu_daily_limit: Decimal,
        lsu_day_start: i64,
        lsu_day_used: Decimal,
        /// Kranik HARD (np. dla testerów / akcji promocyjnych): raz na badge, 0 = wyłączony.
        faucet: Vault,
        faucet_amount: Decimal,
        faucet_claimed: KeyValueStore<NonFungibleLocalId, ()>,
        faucet_given: Decimal,
        /// odkupione LSU (admin wypłaca, odstakowuje, odkupuje HARD)
        lsu_vaults: KeyValueStore<ResourceAddress, Vault>,
        /// łącznie: ile LSU skupiono i ile HARD wydano
        lsu_bought: IndexMap<ResourceAddress, Decimal>,
        lsu_hard_paid: Decimal,


        hard_locks: KeyValueStore<NonFungibleLocalId, Vault>,
        /// HARD w trakcie wypłaty (nie liczą się do rabatu)
        unlocking: KeyValueStore<NonFungibleLocalId, Vault>,
        /// od kiedy można odebrać HARD z `unlocking`
        unlock_ready_at: KeyValueStore<NonFungibleLocalId, Instant>,
        /// okres oczekiwania na wypłatę locka, w sekundach
        unlock_period_seconds: i64,
        paused: bool,
        /// tylko tokeny z listy zweryfikowanych (chroni przed tokenami, które wystawca może odebrać lub zamrozić)
        only_verified: bool,
    }

    impl OtcDesk {
        /// Tworzy desk. Zwraca komponent i badge admina (do wypłaty opłat i pauzy).
        pub fn instantiate(hard_resource: ResourceAddress) -> (Global<OtcDesk>, FungibleBucket) {
            assert!(hard_resource.is_fungible(), "HARD must be fungible");

            let (address_reservation, component_address) =
                Runtime::allocate_component_address(OtcDesk::blueprint_id());

            let admin_badge = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(init {
                    "name" => "HARD OTC Admin", locked;
                    "description" => "Admin key for the HARD ADV OTC desk. Keep the second one as a backup.", locked;
                }))
                .mint_initial_supply(2);

            let rider_badge = ResourceBuilder::new_integer_non_fungible::<RiderBadge>(OwnerRole::None)
                .metadata(metadata!(init {
                    "name" => "HARD OTC Badge", locked;
                    "description" => "Identity badge for the HARD ADV OTC desk. Free, no monetary value.", locked;
                }))
                .mint_roles(mint_roles! {
                    minter => rule!(require(global_caller(component_address)));
                    minter_updater => rule!(deny_all);
                })
                // Nieprzenośny: zostaje na koncie, na które trafił. Oferty i lock nie przejdą na kogoś innego.
                .withdraw_roles(withdraw_roles! {
                    withdrawer => rule!(deny_all);
                    withdrawer_updater => rule!(deny_all);
                })
                .create_with_no_initial_supply();

            let component = Self {
                version: 8,
                admin_badge: admin_badge.resource_address(),
                rider_badge,
                next_badge_number: 1,
                hard_resource,
                discount_tiers: vec![
                    (dec!("1000"), dec!("0.8")),
                    (dec!("10000"), dec!("0.6")),
                    (dec!("50000"), dec!("0.4")),
                ],
                fee_rate_per_side: dec!("0.005"),
                listing_fee_hard: dec!("100"),
                promotion_fee_hard: dec!("50"),
                reservation_fee_hard: dec!("50"),
                reservation_fees_hard: Decimal::ZERO,
                promotion_fees_hard: Decimal::ZERO,
                verified: vec![XRD, hard_resource],
                rider_stats: KeyValueStore::new(),
                next_offer_id: 1,
                offers: KeyValueStore::new(),
                escrow: KeyValueStore::new(),
                treasury: KeyValueStore::new(),
                fees_collected: IndexMap::new(),
                listing_fees_hard: Decimal::ZERO,
                treasury_withdrawn: IndexMap::new(),
                lsu_buyback_enabled: false,
                lsu_payout: dec!("0.9"),
                hard_price_xrd: Decimal::ZERO,
                hard_price_updated_at: Instant::new(0),
                lsu_max_hard_per_tx: dec!("1000000"),
                next_lsu_request_id: 1,
                lsu_requests: KeyValueStore::new(),
                lsu_escrow: KeyValueStore::new(),
                buyback_hard: Vault::new(hard_resource),
                buyback_xrd: Vault::new(XRD),
                lsu_xrd_share: dec!("0.8"),
                lsu_xrd_paid: Decimal::ZERO,
                lsu_max_value_per_tx: dec!("5000"),
                lsu_daily_limit: dec!("20000"),
                lsu_day_start: 0,
                lsu_day_used: Decimal::ZERO,
                faucet: Vault::new(hard_resource),
                faucet_amount: Decimal::ZERO,
                faucet_claimed: KeyValueStore::new(),
                faucet_given: Decimal::ZERO,
                lsu_vaults: KeyValueStore::new(),
                lsu_bought: IndexMap::new(),
                lsu_hard_paid: Decimal::ZERO,
                hard_locks: KeyValueStore::new(),
                unlocking: KeyValueStore::new(),
                unlock_ready_at: KeyValueStore::new(),
                unlock_period_seconds: 7 * 24 * 3600,
                paused: false,
                only_verified: true,
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(rule!(require(
                admin_badge.resource_address()
            ))))
            .with_address(address_reservation)
            .metadata(metadata!(init {
                "name" => "HARD ADV OTC Desk", locked;
                "description" => "Peer-to-peer OTC escrow for the HARD ADV community.", locked;
            }))
            .globalize();

            (component, admin_badge)
        }

        // ---------- Rider badge ----------

        /// Odbiór HARD z kranika – raz na badge, tylko gdy admin go włączył i zasilił.
        pub fn claim_faucet(&mut self, rider: Proof) -> Bucket {
            let who = self.check_rider(rider);
            assert!(self.faucet_amount > Decimal::ZERO, "Faucet is off");
            assert!(self.faucet_claimed.get(&who).is_none(), "Already claimed with this badge");
            assert!(self.faucet.amount() >= self.faucet_amount, "Faucet is empty");
            self.faucet_claimed.insert(who, ());
            self.faucet_given = self.faucet_given.checked_add(self.faucet_amount).unwrap();
            self.faucet.take(self.faucet_amount)
        }

        pub fn fund_faucet(&mut self, hard: Bucket) {
            assert!(hard.resource_address() == self.hard_resource, "Faucet holds HARD only");
            self.faucet.put(hard);
        }

        /// 0 wyłącza kranik.
        pub fn set_faucet_amount(&mut self, amount: Decimal) {
            assert!(amount >= Decimal::ZERO, "Amount cannot be negative");
            self.faucet_amount = amount;
        }

        /// `amount` = 0 oznacza całość.
        pub fn withdraw_faucet(&mut self, amount: Decimal) -> Bucket {
            Self::take_part(&mut self.faucet, amount)
        }

        /// Wybija kolejny numerowany HARD OTC Badge (#1, #2, …). Badge jest nieprzenośny.
        pub fn mint_rider_badge(&mut self) -> NonFungibleBucket {
            let number = self.next_badge_number;
            self.next_badge_number += 1;
            self.rider_badge.mint_non_fungible(
                &NonFungibleLocalId::integer(number),
                RiderBadge {
                    name: format!("HARD OTC Badge #{}", number),
                    number,
                    created_at: Clock::current_time_rounded_to_seconds(),
                },
            )
        }

        // ---------- Oferty ----------

        /// Blokuje `sell` w escrow. `expiry_hours`: 1, 6 albo 72.
        /// `seller_account` — konto, na które trafi zapłata.
        pub fn create_offer(
            &mut self,
            rider: Proof,
            sell: Bucket,
            ask_resource: ResourceAddress,
            ask_amount: Decimal,
            expiry_hours: u8,
            reserved_buyer: Option<NonFungibleLocalId>,
            seller_account: Global<Account>,
            mut listing_fee: Bucket,
            allow_partial: bool,
        ) -> (u64, Bucket) {
            assert!(!self.paused, "Desk is paused");
            let seller = self.check_rider(rider);
            Self::assert_real_account(&seller_account);

            // Opłata za ogłoszenie (+ ewentualnie za rezerwację) w HARD -> skarbiec. Reszta wraca.
            assert!(listing_fee.resource_address() == self.hard_resource, "Listing fee must be paid in HARD");
            // Rezerwacja: stawka za każde rozpoczęte 24 h ważności oferty (1 h / 6 h = 1 doba, 72 h = 3 doby).
            let days = ((expiry_hours as u64) + 23) / 24;
            let reservation_fee = if reserved_buyer.is_some() {
                self.reservation_fee_hard.checked_mul(Decimal::from(days)).unwrap()
            } else {
                Decimal::ZERO
            };
            assert!(
                listing_fee.amount() >= self.listing_fee_hard.checked_add(reservation_fee).unwrap(),
                "Listing fee too small"
            );
            if reservation_fee > Decimal::ZERO {
                let fee = listing_fee.take(reservation_fee);
                self.reservation_fees_hard = self.reservation_fees_hard.checked_add(fee.amount()).unwrap();
                self.collect_fee(fee);
            }
            if self.listing_fee_hard > Decimal::ZERO {
                let fee = listing_fee.take(self.listing_fee_hard);
                self.listing_fees_hard = self.listing_fees_hard.checked_add(fee.amount()).unwrap();
                self.collect_fee(fee);
            }

            let sell_resource = sell.resource_address();
            let sell_amount = sell.amount();
            assert!(sell_resource.is_fungible(), "v1: only fungible assets can be sold");
            assert!(ask_resource.is_fungible(), "v1: only fungible payment assets");
            assert!(sell_resource != ask_resource, "Sell and ask asset must differ");
            if self.only_verified {
                assert!(
                    self.verified.contains(&sell_resource) && self.verified.contains(&ask_resource),
                    "Only verified tokens can be traded right now"
                );
            }
            assert!(sell_amount > Decimal::ZERO, "Nothing to sell");
            assert!(ask_amount > Decimal::ZERO, "Price must be positive");
            assert!(
                expiry_hours == 1 || expiry_hours == 6 || expiry_hours == 72,
                "Expiry must be 1, 6 or 72 hours"
            );
            Self::assert_fits_divisibility(ask_resource, ask_amount);
            if reserved_buyer.is_some() {
                assert!(
                    self.locked_amount(&seller) >= self.discount_tiers[0].0,
                    "Reserved offers require at least 1000 HARD locked"
                );
            }

            let now = Clock::current_time_rounded_to_seconds();
            let expires_at =
                Instant::new(now.seconds_since_unix_epoch + (expiry_hours as i64) * 3600);
            self.bump_stats(&seller, 0, 0, 1);

            let offer_id = self.next_offer_id;
            self.next_offer_id += 1;

            let reserved = reserved_buyer.is_some();
            self.offers.insert(
                offer_id,
                Offer {
                    seller: seller.clone(),
                    seller_account,
                    sell_resource,
                    sell_amount,
                    ask_resource,
                    ask_amount,
                    sell_remaining: sell_amount,
                    ask_remaining: ask_amount,
                    allow_partial,
                    created_at: now,
                    expires_at,
                    featured_until: now,
                    reserved_buyer,
                    status: OfferStatus::Open,
                    fee_rate: self.fee_rate_per_side,
                },
            );
            self.escrow.insert(offer_id, Vault::with_bucket(sell));

            Runtime::emit_event(OfferCreatedEvent {
                offer_id,
                seller,
                sell_resource,
                sell_amount,
                ask_resource,
                ask_amount,
                expires_at,
                reserved,
            });

            (offer_id, listing_fee)
        }

        /// Atomowe rozliczenie. Kupujący płaci całość (albo część, jeśli oferta na to pozwala).
        /// Zwraca (kupiony token minus opłata kupującego, reszta płatności).
        pub fn accept_offer(
            &mut self,
            offer_id: u64,
            rider: Proof,
            mut payment: Bucket,
            min_receive: Decimal,
        ) -> (Bucket, Bucket) {
            assert!(!self.paused, "Desk is paused");
            let buyer = self.check_rider(rider);

            let mut offer = self.offers.get(&offer_id).expect("Offer not found").clone();
            assert!(offer.status == OfferStatus::Open, "Offer is not open");
            assert!(
                !Clock::current_time_is_at_or_after(offer.expires_at, TimePrecision::Second),
                "Offer expired"
            );
            assert!(buyer != offer.seller, "Cannot fill your own offer");
            if let Some(reserved) = &offer.reserved_buyer {
                assert!(reserved == &buyer, "Offer is reserved for another user");
            }
            assert!(payment.resource_address() == offer.ask_resource, "Wrong payment asset");

            // Ile płaci kupujący: całość pozostałej ceny albo mniej (częściowe kupno).
            let pay = if payment.amount() >= offer.ask_remaining {
                offer.ask_remaining
            } else {
                assert!(offer.allow_partial, "This offer must be bought in full");
                payment.amount()
            };
            assert!(pay > Decimal::ZERO, "Payment is zero");
            let full = pay == offer.ask_remaining;

            // Ile tokenów dostaje (proporcjonalnie, zaokrąglone w dół na korzyść sprzedającego).
            let mut asset = if full {
                self.escrow.get_mut(&offer_id).unwrap().take_all()
            } else {
                let out = offer
                    .sell_remaining
                    .checked_mul(pay)
                    .unwrap()
                    .checked_div(offer.ask_remaining)
                    .unwrap();
                self.escrow
                    .get_mut(&offer_id)
                    .unwrap()
                    .take_advanced(out, WithdrawStrategy::Rounded(RoundingMode::ToZero))
            };
            let received_gross = asset.amount();
            assert!(received_gross > Decimal::ZERO, "Amount too small to fill");
            // Ochrona: w escrow musi być tyle, ile obiecano (np. wystawca tokena nic z niego nie odebrał).
            if full {
                assert!(received_gross >= offer.sell_remaining, "Escrow holds less than offered");
            }

            // Strona sprzedającego: zapłata minus jego opłata.
            let mut to_seller = payment.take(pay);
            let seller_fee = to_seller.take_advanced(
                self.fee_for_rate(&offer.seller, pay, offer.fee_rate),
                WithdrawStrategy::Rounded(RoundingMode::ToZero),
            );
            // Strona kupującego: token minus jego opłata.
            let buyer_fee = asset.take_advanced(
                self.fee_for_rate(&buyer, received_gross, offer.fee_rate),
                WithdrawStrategy::Rounded(RoundingMode::ToZero),
            );
            // Kupujący nie dostanie mniej, niż widział (zaokrąglenia, zmiany stanu między podglądem a podpisem).
            assert!(asset.amount() >= min_receive, "You would receive less than your minimum");
            let seller_fee_taken = seller_fee.amount();
            let buyer_fee_taken = buyer_fee.amount();
            self.collect_fee(seller_fee);
            self.collect_fee(buyer_fee);

            // Jeśli konto sprzedającego blokuje depozyty, cała transakcja się wycofa.
            let mut seller_account = offer.seller_account;
            seller_account.try_deposit_or_abort(to_seller, None);

            offer.ask_remaining = offer.ask_remaining.checked_sub(pay).unwrap();
            offer.sell_remaining = offer.sell_remaining.checked_sub(received_gross).unwrap();
            let fully_filled = offer.ask_remaining.is_zero() || offer.sell_remaining.is_zero();
            if fully_filled {
                offer.status = OfferStatus::Filled;
                // Resztki (pył po zaokrągleniach) wracają do sprzedającego.
                let dust = self.escrow.get_mut(&offer_id).unwrap().take_all();
                seller_account.try_deposit_or_abort(dust, None);
            }
            let seller = offer.seller.clone();
            self.offers.insert(offer_id, offer);

            self.bump_stats(&seller, 1, 0, 0);
            self.bump_stats(&buyer, 0, 1, 0);

            Runtime::emit_event(OfferFilledEvent {
                offer_id,
                seller,
                buyer,
                paid: pay,
                received: received_gross,
                fully_filled,
                seller_fee: seller_fee_taken,
                buyer_fee: buyer_fee_taken,
            });

            (asset, payment)
        }

        /// Wyróżnienie oferty: ★ na górze rynku przez `days` × 24 h (kolejne dokupienie przedłuża).
        /// Może tylko sprzedający. Opłata = stawka × dni, w HARD -> skarbiec. Zwraca resztę HARD.
        pub fn promote_offer(&mut self, offer_id: u64, rider: Proof, mut hard: Bucket, days: u8) -> Bucket {
            assert!(days >= 1 && days <= 30, "Days must be between 1 and 30");
            let cost = self.promotion_fee_hard.checked_mul(Decimal::from(days as u64)).unwrap();
            assert!(!self.paused, "Desk is paused");
            let who = self.check_rider(rider);
            let mut offer = self.offers.get(&offer_id).expect("Offer not found").clone();
            assert!(offer.seller == who, "Only the seller can promote");
            assert!(offer.status == OfferStatus::Open, "Offer is not open");
            assert!(
                !Clock::current_time_is_at_or_after(offer.expires_at, TimePrecision::Second),
                "Offer expired"
            );
            assert!(hard.resource_address() == self.hard_resource, "Promotion is paid in HARD");
            assert!(hard.amount() >= cost, "Promotion fee too small");

            if cost > Decimal::ZERO {
                let fee = hard.take(cost);
                self.promotion_fees_hard = self.promotion_fees_hard.checked_add(fee.amount()).unwrap();
                self.collect_fee(fee);
            }
            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;
            let base = if offer.featured_until.seconds_since_unix_epoch > now {
                offer.featured_until.seconds_since_unix_epoch
            } else {
                now
            };
            // Nie da się zapłacić za wyróżnienie dłuższe niż ważność oferty (max 1 rozpoczęta doba ponad).
            assert!(
                base + ((days as i64) - 1) * 24 * 3600 < offer.expires_at.seconds_since_unix_epoch,
                "Featuring would outlast the offer; choose fewer days"
            );
            offer.featured_until = Instant::new(base + (days as i64) * 24 * 3600);
            let featured_until = offer.featured_until;
            self.offers.insert(offer_id, offer);
            Runtime::emit_event(OfferPromotedEvent { offer_id, featured_until });
            hard
        }

        /// Sprzedający zabiera aktywo z powrotem (także po wygaśnięciu). Działa nawet przy pauzie.
        pub fn cancel_offer(&mut self, offer_id: u64, rider: Proof) -> Bucket {
            let who = self.check_rider(rider);
            let mut offer = self.offers.get(&offer_id).expect("Offer not found").clone();
            assert!(offer.seller == who, "Only the seller can cancel");
            assert!(offer.status == OfferStatus::Open, "Offer is not open");

            let asset = self.escrow.get_mut(&offer_id).unwrap().take_all();
            offer.status = OfferStatus::Cancelled;
            self.offers.insert(offer_id, offer);

            Runtime::emit_event(OfferCancelledEvent { offer_id });
            asset
        }

        /// Zwrot WYGASŁEJ oferty — może wywołać każdy, środki trafiają zawsze na konto sprzedającego.
        pub fn reclaim_expired_offer(&mut self, offer_id: u64) {
            let offer = self.offers.get(&offer_id).expect("Offer not found").clone();
            assert!(
                Clock::current_time_is_at_or_after(offer.expires_at, TimePrecision::Second),
                "Offer has not expired yet"
            );
            self.return_to_seller(offer_id, offer);
        }

        /// Admin zwraca otwartą ofertę sprzedającemu (np. podejrzany token). Środki idą tylko na konto sprzedającego.
        pub fn admin_return_offer(&mut self, offer_id: u64) {
            let offer = self.offers.get(&offer_id).expect("Offer not found").clone();
            self.return_to_seller(offer_id, offer);
        }

        fn return_to_seller(&mut self, offer_id: u64, mut offer: Offer) {
            assert!(offer.status == OfferStatus::Open, "Offer is not open");
            let asset = self.escrow.get_mut(&offer_id).unwrap().take_all();
            let mut account = offer.seller_account;
            account.try_deposit_or_abort(asset, None);
            offer.status = OfferStatus::Cancelled;
            self.offers.insert(offer_id, offer);
            Runtime::emit_event(OfferCancelledEvent { offer_id });
        }

        // ---------- Skup LSU za HARD ----------

        /// Zlecenie sprzedaży LSU za HARD. LSU czeka w escrow na decyzję admina.
        /// `account` — konto, na które trafi HARD (albo wróci LSU przy odrzuceniu).
        pub fn request_lsu_sale(
            &mut self,
            rider: Proof,
            lsu: Bucket,
            min_xrd_out: Decimal,
            min_hard_out: Decimal,
            account: Global<Account>,
        ) -> u64 {
            assert!(!self.paused, "Desk is paused");
            assert!(self.lsu_buyback_enabled, "Staked XRD buyback is not active");
            let who = self.check_rider(rider);
            Self::assert_real_account(&account);
            let lsu_resource = lsu.resource_address();
            let lsu_amount = lsu.amount();
            assert!(lsu_amount > Decimal::ZERO, "Nothing to sell");
            // Minimum chroni sprzedającego przed zmianą ceny / prowizji / podziału przez admina.
            assert!(min_xrd_out >= Decimal::ZERO && min_hard_out >= Decimal::ZERO, "Minimums cannot be negative");
            assert!(
                self.lsu_xrd_share.is_zero() || min_xrd_out > Decimal::ZERO,
                "Set a minimum XRD amount"
            );
            assert!(
                self.lsu_xrd_share == Decimal::ONE || min_hard_out > Decimal::ZERO,
                "Set a minimum HARD amount"
            );
            // sprawdza, że to prawdziwe LSU (panic, jeśli nie) i limit na zgłoszenie
            let value = Self::lsu_xrd_value(lsu_resource, lsu_amount);
            assert!(
                value.checked_mul(self.lsu_payout).unwrap() <= self.lsu_max_value_per_tx,
                "Above the per-request limit"
            );

            let id = self.next_lsu_request_id;
            self.next_lsu_request_id += 1;
            self.lsu_requests.insert(
                id,
                LsuRequest {
                    requester: who,
                    account,
                    lsu: lsu_resource,
                    lsu_amount,
                    min_xrd_out,
                    min_hard_out,
                    created_at: Clock::current_time_rounded_to_seconds(),
                    status: LsuRequestStatus::Pending,
                    xrd_paid: Decimal::ZERO,
                    hard_paid: Decimal::ZERO,
                },
            );
            self.lsu_escrow.insert(id, Vault::with_bucket(lsu));
            id
        }

        /// Użytkownik wycofuje swoje oczekujące zlecenie; LSU wraca.
        pub fn cancel_lsu_sale(&mut self, request_id: u64, rider: Proof) -> Bucket {
            let who = self.check_rider(rider);
            let mut req = self.lsu_requests.get(&request_id).expect("Request not found").clone();
            assert!(req.requester == who, "Not your request");
            assert!(req.status == LsuRequestStatus::Pending, "Request is not pending");
            req.status = LsuRequestStatus::Cancelled;
            self.lsu_requests.insert(request_id, req);
            self.lsu_escrow.get_mut(&request_id).unwrap().take_all()
        }

        /// Admin akceptuje: płaci XRD + HARD według aktualnej wartości LSU, prowizji, podziału i ceny HARD.
        pub fn accept_lsu_sale(&mut self, request_id: u64) {
            assert!(self.hard_price_xrd > Decimal::ZERO, "Set the HARD price first");
            let mut req = self.lsu_requests.get(&request_id).expect("Request not found").clone();
            assert!(req.status == LsuRequestStatus::Pending, "Request is not pending");

            let xrd_value = Self::lsu_xrd_value(req.lsu, req.lsu_amount);
            let payout_value = xrd_value.checked_mul(self.lsu_payout).unwrap();
            let xrd_out = payout_value.checked_mul(self.lsu_xrd_share).unwrap();
            let hard_out = payout_value
                .checked_sub(xrd_out)
                .unwrap()
                .checked_div(self.hard_price_xrd)
                .unwrap();
            assert!(hard_out <= self.lsu_max_hard_per_tx, "Above the per-request HARD limit");
            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;
            if now - self.lsu_day_start >= 86_400 {
                self.lsu_day_start = now;
                self.lsu_day_used = Decimal::ZERO;
            }
            let used = self.lsu_day_used.checked_add(payout_value).unwrap();
            assert!(used <= self.lsu_daily_limit, "Daily buying limit reached");
            self.lsu_day_used = used;
            assert!(xrd_out >= req.min_xrd_out, "XRD below the seller's minimum, reject instead");
            assert!(hard_out >= req.min_hard_out, "HARD below the seller's minimum, reject instead");
            assert!(self.buyback_xrd.amount() >= xrd_out, "Not enough XRD in the buyback wallet");
            assert!(self.buyback_hard.amount() >= hard_out, "Not enough HARD in the buyback wallet");

            let xrd_bucket = self
                .buyback_xrd
                .take_advanced(xrd_out, WithdrawStrategy::Rounded(RoundingMode::ToZero));
            let hard_bucket = self
                .buyback_hard
                .take_advanced(hard_out, WithdrawStrategy::Rounded(RoundingMode::ToZero));
            let xrd_paid = xrd_bucket.amount();
            let hard_paid = hard_bucket.amount();
            req.account.try_deposit_or_abort(xrd_bucket, None);
            req.account.try_deposit_or_abort(hard_bucket, None);

            let lsu = self.lsu_escrow.get_mut(&request_id).unwrap().take_all();
            let exists = self.lsu_vaults.get(&req.lsu).is_some();
            if exists {
                self.lsu_vaults.get_mut(&req.lsu).unwrap().put(lsu);
            } else {
                self.lsu_vaults.insert(req.lsu, Vault::with_bucket(lsu));
            }
            let e = self.lsu_bought.entry(req.lsu).or_insert(Decimal::ZERO);
            *e = e.checked_add(req.lsu_amount).unwrap();
            self.lsu_hard_paid = self.lsu_hard_paid.checked_add(hard_paid).unwrap();
            self.lsu_xrd_paid = self.lsu_xrd_paid.checked_add(xrd_paid).unwrap();

            Runtime::emit_event(LsuSoldEvent {
                lsu: req.lsu,
                lsu_amount: req.lsu_amount,
                xrd_value,
                xrd_out: xrd_paid,
                hard_out: hard_paid,
            });
            req.status = LsuRequestStatus::Accepted;
            req.xrd_paid = xrd_paid;
            req.hard_paid = hard_paid;
            self.lsu_requests.insert(request_id, req);
        }

        /// Admin odrzuca: LSU wraca na konto użytkownika.
        pub fn reject_lsu_sale(&mut self, request_id: u64) {
            let mut req = self.lsu_requests.get(&request_id).expect("Request not found").clone();
            assert!(req.status == LsuRequestStatus::Pending, "Request is not pending");
            let lsu = self.lsu_escrow.get_mut(&request_id).unwrap().take_all();
            req.account.try_deposit_or_abort(lsu, None);
            req.status = LsuRequestStatus::Rejected;
            self.lsu_requests.insert(request_id, req);
        }

        // ---------- Lock HARD (rabat) ----------

        pub fn lock_hard(&mut self, rider: Proof, hard: Bucket) {
            let who = self.check_rider(rider);
            assert!(hard.resource_address() == self.hard_resource, "Not HARD");

            let exists = self.hard_locks.get(&who).is_some();
            if exists {
                self.hard_locks.get_mut(&who).unwrap().put(hard);
            } else {
                self.hard_locks.insert(who.clone(), Vault::with_bucket(hard));
            }
            let locked_total = self.locked_amount(&who);
            Runtime::emit_event(HardLockChangedEvent { rider: who, locked_total });
        }

        /// Krok 1 wypłaty: przenosi `amount` HARD z locka do kolejki wypłat.
        /// Od tej chwili nie liczą się do rabatu. Zegar startuje od nowa przy każdej prośbie.
        pub fn request_unlock(&mut self, rider: Proof, amount: Decimal) {
            let who = self.check_rider(rider);
            assert!(amount > Decimal::ZERO, "Amount must be positive");
            // Nie zerujemy zegara HARD, który już czeka gotowy do odbioru — najpierw trzeba go odebrać.
            if let Some(ready) = self.unlock_ready_at.get(&who).map(|r| *r) {
                let waiting = self.unlocking.get(&who).map(|v| v.amount()).unwrap_or(Decimal::ZERO);
                assert!(
                    waiting.is_zero() || !Clock::current_time_is_at_or_after(ready, TimePrecision::Second),
                    "Withdraw your unlocked HARD first"
                );
            }
            let bucket = {
                let mut lock = self.hard_locks.get_mut(&who).expect("Nothing locked");
                assert!(lock.amount() >= amount, "Not enough HARD locked");
                lock.take(amount)
            };

            let exists = self.unlocking.get(&who).is_some();
            if exists {
                self.unlocking.get_mut(&who).unwrap().put(bucket);
            } else {
                self.unlocking.insert(who.clone(), Vault::with_bucket(bucket));
            }

            let now = Clock::current_time_rounded_to_seconds();
            let ready = Instant::new(now.seconds_since_unix_epoch + self.unlock_period_seconds);
            self.unlock_ready_at.insert(who.clone(), ready);

            let locked_total = self.locked_amount(&who);
            Runtime::emit_event(HardLockChangedEvent { rider: who, locked_total });
        }

        /// Krok 2 wypłaty: po upływie okresu oczekiwania oddaje HARD z kolejki.
        pub fn withdraw_unlocked(&mut self, rider: Proof) -> Bucket {
            let who = self.check_rider(rider);
            let ready = *self.unlock_ready_at.get(&who).expect("No unlock requested");
            assert!(
                Clock::current_time_is_at_or_after(ready, TimePrecision::Second),
                "Unlock period has not passed yet"
            );
            self.unlocking.get_mut(&who).expect("No unlock requested").take_all()
        }

        // ---------- Odczyt ----------

        pub fn get_offer(&self, offer_id: u64) -> Option<Offer> {
            self.offers.get(&offer_id).map(|o| o.clone())
        }

        pub fn quote_fee(&self, rider: NonFungibleLocalId, amount: Decimal) -> Decimal {
            self.fee_for(&rider, amount)
        }

        // ---------- Admin ----------

        /// Wypłata ze skarbca (np. na buyback HARD albo płynność na Ociswap).
        /// `amount` = 0 oznacza całość.
        pub fn withdraw_treasury(&mut self, resource: ResourceAddress, amount: Decimal) -> Bucket {
            let bucket = {
                let mut v = self
                    .treasury
                    .get_mut(&resource)
                    .expect("Nothing in treasury for this resource");
                Self::take_part(&mut *v, amount)
            };
            let entry = self.treasury_withdrawn.entry(resource).or_insert(Decimal::ZERO);
            *entry = entry.checked_add(bucket.amount()).unwrap();
            bucket
        }

        pub fn set_paused(&mut self, paused: bool) {
            self.paused = paused;
        }

        /// Okres oczekiwania na wypłatę locka w sekundach (np. 604800 = 7 dni, 300 = 5 minut).
        pub fn set_unlock_period(&mut self, seconds: i64) {
            assert!(seconds >= 0, "Period cannot be negative");
            assert!(seconds <= 30 * 24 * 3600, "Unlock period cannot exceed 30 days");
            self.unlock_period_seconds = seconds;
        }

        /// Opłata w HARD za wystawienie oferty (0 = darmowe wystawianie).
        /// Opłata za handel od każdej strony (np. 0.005 = 0,5%), maks. 1%.
        pub fn set_trading_fee(&mut self, rate: Decimal) {
            assert!(rate >= Decimal::ZERO, "Fee cannot be negative");
            assert!(rate <= dec!("0.01"), "Trading fee cannot exceed 1% per side");
            self.fee_rate_per_side = rate;
        }

        pub fn set_listing_fee(&mut self, amount: Decimal) {
            assert!(amount >= Decimal::ZERO, "Fee cannot be negative");
            assert!(amount <= dec!("100"), "Listing fee cannot exceed 100 HARD");
            self.listing_fee_hard = amount;
        }

        /// Opłata w HARD za wyróżnienie oferty, za każde 24 h.
        pub fn set_promotion_fee(&mut self, amount: Decimal) {
            assert!(amount >= Decimal::ZERO, "Fee cannot be negative");
            self.promotion_fee_hard = amount;
        }

        /// Opłata w HARD za rezerwację oferty, za każde rozpoczęte 24 h ważności (0 = bez opłaty).
        pub fn set_reservation_fee(&mut self, amount: Decimal) {
            assert!(amount >= Decimal::ZERO, "Fee cannot be negative");
            self.reservation_fee_hard = amount;
        }

        /// Ustawienia skupu: włącz/wyłącz, stawka (0.8 = wypłata 80% wartości, czyli −20%), limit HARD na zlecenie.
        pub fn set_lsu_buyback(&mut self, enabled: bool, payout: Decimal, max_hard_per_tx: Decimal) {
            assert!(payout > Decimal::ZERO && payout <= Decimal::ONE, "Payout must be between 0 and 1");
            assert!(max_hard_per_tx > Decimal::ZERO, "Limit must be positive");
            self.lsu_buyback_enabled = enabled;
            self.lsu_payout = payout;
            self.lsu_max_hard_per_tx = max_hard_per_tx;
        }

        /// Cena HARD w XRD (ile XRD za 1 HARD), używana przy akceptacji zleceń skupu.
        pub fn set_hard_price(&mut self, xrd_per_hard: Decimal) {
            assert!(xrd_per_hard > Decimal::ZERO, "Price must be positive");
            self.hard_price_xrd = xrd_per_hard;
            self.hard_price_updated_at = Clock::current_time_rounded_to_seconds();
        }

        /// Jaka część wypłaty za LSU idzie w XRD (reszta w HARD): 0.8 = 80% XRD / 20% HARD.
        pub fn set_lsu_split(&mut self, xrd_share: Decimal) {
            assert!(xrd_share >= Decimal::ZERO && xrd_share <= Decimal::ONE, "Share must be 0..1");
            self.lsu_xrd_share = xrd_share;
        }

        /// Zasilenie portfela skupu w XRD.
        /// Limity skupu: maks. wartość (XRD) na zgłoszenie i na 24 h.
        pub fn set_lsu_limits(&mut self, max_value_per_tx: Decimal, daily_limit: Decimal) {
            assert!(max_value_per_tx >= Decimal::ZERO && daily_limit >= Decimal::ZERO, "Limits must be >= 0");
            self.lsu_max_value_per_tx = max_value_per_tx;
            self.lsu_daily_limit = daily_limit;
        }

        pub fn fund_lsu_buyback_xrd(&mut self, xrd: Bucket) {
            assert!(xrd.resource_address() == XRD, "Not XRD");
            self.buyback_xrd.put(xrd);
        }

        /// `amount` = 0 oznacza całość.
        pub fn withdraw_buyback_xrd(&mut self, amount: Decimal) -> Bucket {
            Self::take_part(&mut self.buyback_xrd, amount)
        }

        /// Zasilenie puli skupu w HARD.
        pub fn fund_lsu_buyback(&mut self, hard: Bucket) {
            assert!(hard.resource_address() == self.hard_resource, "Not HARD");
            self.buyback_hard.put(hard);
        }

        /// `amount` = 0 oznacza całość.
        pub fn withdraw_buyback_hard(&mut self, amount: Decimal) -> Bucket {
            Self::take_part(&mut self.buyback_hard, amount)
        }

        fn take_part(vault: &mut Vault, amount: Decimal) -> Bucket {
            assert!(amount >= Decimal::ZERO, "Amount cannot be negative");
            if amount.is_zero() || amount >= vault.amount() {
                vault.take_all()
            } else {
                vault.take_advanced(amount, WithdrawStrategy::Rounded(RoundingMode::ToZero))
            }
        }

        /// Wypłata odkupionych LSU (do odstakowania).
        pub fn withdraw_lsu(&mut self, lsu: ResourceAddress) -> Bucket {
            self.lsu_vaults.get_mut(&lsu).expect("No such LSU in the desk").take_all()
        }

        /// Dodaje tokeny do listy zweryfikowanych.
        pub fn add_verified(&mut self, resources: Vec<ResourceAddress>) {
            for r in resources {
                if !self.verified.contains(&r) {
                    self.verified.push(r);
                }
            }
        }

        /// Tryb "tylko zweryfikowane tokeny" (domyślnie włączony).
        pub fn set_only_verified(&mut self, on: bool) {
            self.only_verified = on;
        }

        pub fn remove_verified(&mut self, resource: ResourceAddress) {
            self.verified.retain(|r| *r != resource);
        }

        // ---------- Pomocnicze ----------

        fn check_rider(&self, rider: Proof) -> NonFungibleLocalId {
            rider
                .check_with_message(self.rider_badge.address(), "Invalid HARD OTC Badge")
                .as_non_fungible()
                .non_fungible_local_id()
        }

        fn bump_stats(&mut self, rider: &NonFungibleLocalId, sells: u64, buys: u64, offers: u64) {
            let mut st = self.rider_stats.get(rider).map(|s| s.clone()).unwrap_or_default();
            st.sells += sells;
            st.buys += buys;
            st.offers_created += offers;
            self.rider_stats.insert(rider.clone(), st);
        }

        fn locked_amount(&self, rider: &NonFungibleLocalId) -> Decimal {
            self.hard_locks
                .get(rider)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO)
        }

        fn fee_for(&self, rider: &NonFungibleLocalId, amount: Decimal) -> Decimal {
            self.fee_for_rate(rider, amount, self.fee_rate_per_side)
        }

        fn fee_for_rate(&self, rider: &NonFungibleLocalId, amount: Decimal, rate: Decimal) -> Decimal {
            let locked = self.locked_amount(rider);
            let mut multiplier = Decimal::ONE;
            for (threshold, m) in self.discount_tiers.iter() {
                if locked >= *threshold {
                    multiplier = *m;
                }
            }
            amount
                .checked_mul(rate)
                .unwrap()
                .checked_mul(multiplier)
                .unwrap()
        }

        fn collect_fee(&mut self, fee: Bucket) {
            let addr = fee.resource_address();
            let total = fee.amount();
            let to_treasury = total;

            let exists = self.treasury.get(&addr).is_some();
            if exists {
                self.treasury.get_mut(&addr).unwrap().put(fee);
            } else {
                self.treasury.insert(addr, Vault::with_bucket(fee));
            }

            let entry = self.fees_collected.entry(addr).or_insert(Decimal::ZERO);
            *entry = entry.checked_add(total).unwrap();

            Runtime::emit_event(FeeCollectedEvent { resource: addr, to_treasury });
        }

        /// Sprawdza, że to prawdziwe LSU (metadane "validator" wskazują walidatora, którego
        /// "pool_unit" to ten sam zasób) i zwraca jego wartość w XRD według walidatora.
        fn lsu_xrd_value(lsu: ResourceAddress, amount: Decimal) -> Decimal {
            let validator_addr: GlobalAddress = ResourceManager::from(lsu)
                .get_metadata("validator")
                .ok()
                .flatten()
                .expect("Not a liquid stake unit (no validator)");
            // Tylko prawdziwy natywny walidator Radix (nie podrobiony komponent udający walidatora).
            assert!(
                validator_addr.as_node_id().entity_type() == Some(EntityType::GlobalValidator),
                "Not a native Radix validator"
            );
            let validator: Global<Validator> =
                Global::from(ComponentAddress::new_or_panic(validator_addr.as_node_id().0));
            let pool_unit: GlobalAddress = validator
                .get_metadata("pool_unit")
                .ok()
                .flatten()
                .expect("Validator has no pool unit");
            assert!(
                pool_unit.as_node_id() == lsu.as_node_id(),
                "Token is not this validator's stake unit"
            );
            validator.get_redemption_value(amount)
        }

        /// Wypłaty trafiają tylko na prawdziwe konta Radix (nie na dowolny komponent).
        fn assert_real_account(account: &Global<Account>) {
            let et = account.address().as_node_id().entity_type();
            assert!(
                matches!(
                    et,
                    Some(EntityType::GlobalAccount)
                        | Some(EntityType::GlobalPreallocatedSecp256k1Account)
                        | Some(EntityType::GlobalPreallocatedEd25519Account)
                ),
                "Payout address must be a Radix account"
            );
        }

        fn assert_fits_divisibility(resource: ResourceAddress, amount: Decimal) {
            let divisibility = ResourceManager::from(resource)
                .resource_type()
                .divisibility()
                .expect("Must be fungible");
            let rounded = amount
                .checked_round(divisibility, RoundingMode::ToZero)
                .unwrap();
            assert!(rounded == amount, "Amount exceeds the asset's divisibility");
        }
    }
}
