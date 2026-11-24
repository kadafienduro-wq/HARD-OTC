//! HARD OTC Desk v3 — escrow OTC na Radix.
//!
//! 1. HARD OTC Badge (darmowe NFT) = tożsamość na desku.
//! 2. Sprzedający blokuje token w escrow (`create_offer`), płaci opłatę za ogłoszenie w HARD
//!    (domyślnie 100, admin 0–100). Opcjonalnie: częściowe kupno, rezerwacja dla konkretnego ridera
//!    (wymaga >= 1 000 HARD w locku).
//! 3. Kupujący płaci (`accept_offer`) całość albo część (jeśli oferta pozwala) — atomowo.
//! 4. Opłata od transakcji 0,75% z każdej strony; progi rabatowe za lock HARD (−20/−40/−60%).
//! 5. Opłaty -> skarbiec (buyback HARD / płynność). Spalanie opcjonalne (admin, domyślnie 0%).
//! 6. Promowanie oferty za HARD (★ na 24 h, opłata ustawiana przez admina).
//! 7. Zweryfikowane tokeny: lista prowadzona przez admina (strona oznacza je ✓).
//! 8. Reputacja: liczniki transakcji ridera (sprzedaże, zakupy).
//! 9. Wypłata locka w dwóch krokach z okresem oczekiwania (domyślnie 7 dni).
//!
//! Obie strony oferty: zasoby fungible (tokeny, LSU, LP). NFT — w kolejnej wersji.

use scrypto::prelude::*;

#[derive(ScryptoSbor, NonFungibleData)]
pub struct RiderBadge {
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
    pub burned: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct HardLockChangedEvent {
    pub rider: NonFungibleLocalId,
    pub locked_total: Decimal,
}

#[blueprint]
#[events(OfferCreatedEvent, OfferFilledEvent, OfferCancelledEvent, OfferPromotedEvent, HardLockChangedEvent, FeeCollectedEvent)]
mod hard_otc {
    enable_method_auth! {
        methods {
            mint_rider_badge => PUBLIC;
            create_offer => PUBLIC;
            accept_offer => PUBLIC;
            cancel_offer => PUBLIC;
            promote_offer => PUBLIC;
            lock_hard => PUBLIC;
            request_unlock => PUBLIC;
            withdraw_unlocked => PUBLIC;
            get_offer => PUBLIC;
            quote_fee => PUBLIC;
            withdraw_treasury => restrict_to: [OWNER];
            set_paused => restrict_to: [OWNER];
            set_burn_share => restrict_to: [OWNER];
            set_listing_fee => restrict_to: [OWNER];
            set_unlock_period => restrict_to: [OWNER];
            set_promotion_fee => restrict_to: [OWNER];
            add_verified => restrict_to: [OWNER];
            remove_verified => restrict_to: [OWNER];
        }
    }

    struct OtcDesk {
        /// badge admina (strona pokazuje panel admina portfelom, które go mają)
        admin_badge: ResourceAddress,
        rider_badge: NonFungibleResourceManager,
        hard_resource: ResourceAddress,
        /// (próg zablokowanych HARD, mnożnik opłaty) rosnąco po progu
        discount_tiers: Vec<(Decimal, Decimal)>,
        fee_rate_per_side: Decimal,
        /// jaka część opłat w HARD jest spalana (zamykana na zawsze)
        hard_burn_share: Decimal,
        /// opłata w HARD za wystawienie oferty
        listing_fee_hard: Decimal,
        /// opłata w HARD za promowanie oferty na 24 h
        promotion_fee_hard: Decimal,
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
        /// HARD zamknięte na zawsze. Nie ma metody, która je wypłaca.
        burned_hard: Vault,
        hard_locks: KeyValueStore<NonFungibleLocalId, Vault>,
        /// HARD w trakcie wypłaty (nie liczą się do rabatu)
        unlocking: KeyValueStore<NonFungibleLocalId, Vault>,
        /// od kiedy można odebrać HARD z `unlocking`
        unlock_ready_at: KeyValueStore<NonFungibleLocalId, Instant>,
        /// okres oczekiwania na wypłatę locka, w sekundach
        unlock_period_seconds: i64,
        paused: bool,
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
                }))
                .mint_initial_supply(1);

            let rider_badge = ResourceBuilder::new_ruid_non_fungible::<RiderBadge>(OwnerRole::None)
                .metadata(metadata!(init {
                    "name" => "HARD OTC Badge", locked;
                    "description" => "Testnet identity badge for the HARD OTC desk. No monetary value.", locked;
                }))
                .mint_roles(mint_roles! {
                    minter => rule!(require(global_caller(component_address)));
                    minter_updater => rule!(deny_all);
                })
                .create_with_no_initial_supply();

            let component = Self {
                admin_badge: admin_badge.resource_address(),
                rider_badge,
                hard_resource,
                discount_tiers: vec![
                    (dec!("1000"), dec!("0.8")),
                    (dec!("10000"), dec!("0.6")),
                    (dec!("50000"), dec!("0.4")),
                ],
                fee_rate_per_side: dec!("0.0075"),
                hard_burn_share: Decimal::ZERO,
                listing_fee_hard: dec!("100"),
                promotion_fee_hard: dec!("200"),
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
                burned_hard: Vault::new(hard_resource),
                hard_locks: KeyValueStore::new(),
                unlocking: KeyValueStore::new(),
                unlock_ready_at: KeyValueStore::new(),
                unlock_period_seconds: 7 * 24 * 3600,
                paused: false,
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(rule!(require(
                admin_badge.resource_address()
            ))))
            .with_address(address_reservation)
            .metadata(metadata!(init {
                "name" => "HARD OTC Desk v3 (Stokenet)", locked;
                "description" => "Experimental escrow. Test assets only.", locked;
            }))
            .globalize();

            (component, admin_badge)
        }

        /// Wygodny start na Stokenet: tworzy testowy token HARD (1 000 000 szt.)
        /// i od razu desk, który go używa. Zwraca (desk, badge admina, HARD).
        pub fn instantiate_with_test_hard() -> (Global<OtcDesk>, FungibleBucket, FungibleBucket) {
            let hard = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_MAXIMUM)
                .metadata(metadata!(init {
                    "name" => "HARD (test)", locked;
                    "symbol" => "HARD", locked;
                    "description" => "Stokenet test token. No monetary value.", locked;
                }))
                .mint_initial_supply(1_000_000);
            let (desk, admin) = Self::instantiate(hard.resource_address());
            (desk, admin, hard)
        }

        // ---------- Rider badge ----------

        pub fn mint_rider_badge(&mut self) -> NonFungibleBucket {
            self.rider_badge.mint_ruid_non_fungible(RiderBadge {
                created_at: Clock::current_time_rounded_to_seconds(),
            })
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

            // Opłata za ogłoszenie w HARD -> skarbiec. Reszta wraca do sprzedającego.
            assert!(listing_fee.resource_address() == self.hard_resource, "Listing fee must be paid in HARD");
            assert!(listing_fee.amount() >= self.listing_fee_hard, "Listing fee too small");
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
        pub fn accept_offer(&mut self, offer_id: u64, rider: Proof, mut payment: Bucket) -> (Bucket, Bucket) {
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

            // Strona sprzedającego: zapłata minus jego opłata.
            let mut to_seller = payment.take(pay);
            let seller_fee = to_seller.take_advanced(
                self.fee_for(&offer.seller, pay),
                WithdrawStrategy::Rounded(RoundingMode::ToZero),
            );
            // Strona kupującego: token minus jego opłata.
            let buyer_fee = asset.take_advanced(
                self.fee_for(&buyer, received_gross),
                WithdrawStrategy::Rounded(RoundingMode::ToZero),
            );
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

        /// Promowanie oferty: ★ na górze rynku przez 24 h (kolejne opłacenie przedłuża).
        /// Może tylko sprzedający. Opłata w HARD -> skarbiec. Zwraca resztę HARD.
        pub fn promote_offer(&mut self, offer_id: u64, rider: Proof, mut hard: Bucket) -> Bucket {
            assert!(!self.paused, "Desk is paused");
            let who = self.check_rider(rider);
            let mut offer = self.offers.get(&offer_id).expect("Offer not found").clone();
            assert!(offer.seller == who, "Only the seller can promote");
            assert!(offer.status == OfferStatus::Open, "Offer is not open");
            assert!(hard.resource_address() == self.hard_resource, "Promotion is paid in HARD");
            assert!(hard.amount() >= self.promotion_fee_hard, "Promotion fee too small");

            if self.promotion_fee_hard > Decimal::ZERO {
                let fee = hard.take(self.promotion_fee_hard);
                self.promotion_fees_hard = self.promotion_fees_hard.checked_add(fee.amount()).unwrap();
                self.collect_fee(fee);
            }
            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;
            let base = if offer.featured_until.seconds_since_unix_epoch > now {
                offer.featured_until.seconds_since_unix_epoch
            } else {
                now
            };
            offer.featured_until = Instant::new(base + 24 * 3600);
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
        pub fn withdraw_treasury(&mut self, resource: ResourceAddress) -> Bucket {
            let bucket = self
                .treasury
                .get_mut(&resource)
                .expect("Nothing in treasury for this resource")
                .take_all();
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
            self.unlock_period_seconds = seconds;
        }

        /// Opłata w HARD za wystawienie oferty (0 = darmowe wystawianie).
        pub fn set_listing_fee(&mut self, amount: Decimal) {
            assert!(amount >= Decimal::ZERO, "Fee cannot be negative");
            assert!(amount <= dec!("100"), "Listing fee cannot exceed 100 HARD");
            self.listing_fee_hard = amount;
        }

        /// Opłata w HARD za promowanie oferty na 24 h.
        pub fn set_promotion_fee(&mut self, amount: Decimal) {
            assert!(amount >= Decimal::ZERO, "Fee cannot be negative");
            self.promotion_fee_hard = amount;
        }

        /// Dodaje tokeny do listy zweryfikowanych.
        pub fn add_verified(&mut self, resources: Vec<ResourceAddress>) {
            for r in resources {
                if !self.verified.contains(&r) {
                    self.verified.push(r);
                }
            }
        }

        pub fn remove_verified(&mut self, resource: ResourceAddress) {
            self.verified.retain(|r| *r != resource);
        }

        /// Ile z opłat pobranych w HARD zamykać na zawsze: 0 = wyłączone, 0.5 = połowa, 1 = całość.
        pub fn set_burn_share(&mut self, share: Decimal) {
            assert!(share >= Decimal::ZERO && share <= Decimal::ONE, "Share must be between 0 and 1");
            self.hard_burn_share = share;
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
            let locked = self.locked_amount(rider);
            let mut multiplier = Decimal::ONE;
            for (threshold, m) in self.discount_tiers.iter() {
                if locked >= *threshold {
                    multiplier = *m;
                }
            }
            amount
                .checked_mul(self.fee_rate_per_side)
                .unwrap()
                .checked_mul(multiplier)
                .unwrap()
        }

        fn collect_fee(&mut self, mut fee: Bucket) {
            let addr = fee.resource_address();
            let total = fee.amount();

            let mut burned = Decimal::ZERO;
            if addr == self.hard_resource && self.hard_burn_share > Decimal::ZERO {
                let burn_amount = total.checked_mul(self.hard_burn_share).unwrap();
                let burn = fee.take_advanced(
                    burn_amount,
                    WithdrawStrategy::Rounded(RoundingMode::ToZero),
                );
                burned = burn.amount();
                self.burned_hard.put(burn);
            }
            let to_treasury = fee.amount();

            let exists = self.treasury.get(&addr).is_some();
            if exists {
                self.treasury.get_mut(&addr).unwrap().put(fee);
            } else {
                self.treasury.insert(addr, Vault::with_bucket(fee));
            }

            let entry = self.fees_collected.entry(addr).or_insert(Decimal::ZERO);
            *entry = entry.checked_add(total).unwrap();

            Runtime::emit_event(FeeCollectedEvent {
                resource: addr,
                to_treasury,
                burned,
            });
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
