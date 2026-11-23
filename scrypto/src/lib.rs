//! HARD OTC Desk — escrow OTC na Radix (Stokenet).
//!
//! Przepływ:
//! 1. Użytkownik mintuje darmowy Rider Badge (tożsamość na desku).
//! 2. Sprzedający blokuje aktywo w escrow (`create_offer`) i podaje cenę.
//! 3. Kupujący płaci (`accept_offer`) — w jednej, atomowej transakcji
//!    kupujący dostaje aktywo, a sprzedający zapłatę na swoje konto.
//! 4. Opłata: 0,75% z każdej strony (1,5% łącznie). Kto ma zablokowane
//!    >= 1000 HARD, ma 20% zniżki na swoją połowę opłaty.
//!
//! v1 obsługuje zasoby fungible po obu stronach (tokeny, LSU, LP).
//! NFT (pozycje) — w kolejnej wersji.

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
    pub created_at: Instant,
    pub expires_at: Instant,
    pub reserved_buyer: Option<NonFungibleLocalId>,
    pub status: OfferStatus,
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
    pub seller_fee: Decimal,
    pub buyer_fee: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct OfferCancelledEvent {
    pub offer_id: u64,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct HardLockChangedEvent {
    pub rider: NonFungibleLocalId,
    pub locked_total: Decimal,
}

#[blueprint]
#[events(OfferCreatedEvent, OfferFilledEvent, OfferCancelledEvent, HardLockChangedEvent)]
mod hard_otc {
    enable_method_auth! {
        methods {
            mint_rider_badge => PUBLIC;
            create_offer => PUBLIC;
            accept_offer => PUBLIC;
            cancel_offer => PUBLIC;
            lock_hard => PUBLIC;
            unlock_hard => PUBLIC;
            get_offer => PUBLIC;
            quote_fee => PUBLIC;
            withdraw_fees => restrict_to: [OWNER];
            set_paused => restrict_to: [OWNER];
        }
    }

    struct OtcDesk {
        rider_badge: NonFungibleResourceManager,
        hard_resource: ResourceAddress,
        hard_discount_threshold: Decimal,
        fee_rate_per_side: Decimal,
        discount_multiplier: Decimal,
        next_offer_id: u64,
        offers: KeyValueStore<u64, Offer>,
        escrow: KeyValueStore<u64, Vault>,
        fees: KeyValueStore<ResourceAddress, Vault>,
        hard_locks: KeyValueStore<NonFungibleLocalId, Vault>,
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
                    "name" => "HARD OTC Rider Badge", locked;
                    "description" => "Testnet identity badge for the HARD OTC desk. No monetary value.", locked;
                }))
                .mint_roles(mint_roles! {
                    minter => rule!(require(global_caller(component_address)));
                    minter_updater => rule!(deny_all);
                })
                .create_with_no_initial_supply();

            let component = Self {
                rider_badge,
                hard_resource,
                hard_discount_threshold: dec!("1000"),
                fee_rate_per_side: dec!("0.0075"),
                discount_multiplier: dec!("0.8"),
                next_offer_id: 1,
                offers: KeyValueStore::new(),
                escrow: KeyValueStore::new(),
                fees: KeyValueStore::new(),
                hard_locks: KeyValueStore::new(),
                paused: false,
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(rule!(require(
                admin_badge.resource_address()
            ))))
            .with_address(address_reservation)
            .metadata(metadata!(init {
                "name" => "HARD OTC Desk (Stokenet)", locked;
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
        ) -> u64 {
            assert!(!self.paused, "Desk is paused");
            let seller = self.check_rider(rider);

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

            let now = Clock::current_time_rounded_to_seconds();
            let expires_at =
                Instant::new(now.seconds_since_unix_epoch + (expiry_hours as i64) * 3600);

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
                    created_at: now,
                    expires_at,
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

            offer_id
        }

        /// Atomowe rozliczenie. Zwraca (kupione aktywo minus opłata kupującego, reszta z płatności).
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
                assert!(reserved == &buyer, "Offer is reserved for another rider");
            }
            assert!(payment.resource_address() == offer.ask_resource, "Wrong payment asset");
            assert!(payment.amount() >= offer.ask_amount, "Payment too small");

            // Strona sprzedającego: zapłata minus jego opłata.
            let mut to_seller = payment.take(offer.ask_amount);
            let seller_fee_amt = self.fee_for(&offer.seller, offer.ask_amount);
            let seller_fee = to_seller.take_advanced(
                seller_fee_amt,
                WithdrawStrategy::Rounded(RoundingMode::ToZero),
            );

            // Strona kupującego: aktywo z escrow minus jego opłata.
            let mut asset = self.escrow.get_mut(&offer_id).unwrap().take_all();
            let buyer_fee_amt = self.fee_for(&buyer, offer.sell_amount);
            let buyer_fee = asset.take_advanced(
                buyer_fee_amt,
                WithdrawStrategy::Rounded(RoundingMode::ToZero),
            );

            let seller_fee_taken = seller_fee.amount();
            let buyer_fee_taken = buyer_fee.amount();
            self.collect_fee(seller_fee);
            self.collect_fee(buyer_fee);

            // Jeśli konto sprzedającego blokuje depozyty, cała transakcja się wycofa.
            let mut seller_account = offer.seller_account;
            seller_account.try_deposit_or_abort(to_seller, None);

            offer.status = OfferStatus::Filled;
            let seller = offer.seller.clone();
            self.offers.insert(offer_id, offer);

            Runtime::emit_event(OfferFilledEvent {
                offer_id,
                seller,
                buyer,
                seller_fee: seller_fee_taken,
                buyer_fee: buyer_fee_taken,
            });

            (asset, payment)
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

        /// Wypłaca cały lock. Bez okresu blokady, bez zysku.
        pub fn unlock_hard(&mut self, rider: Proof) -> Bucket {
            let who = self.check_rider(rider);
            let bucket = self
                .hard_locks
                .get_mut(&who)
                .expect("Nothing locked")
                .take_all();
            Runtime::emit_event(HardLockChangedEvent {
                rider: who,
                locked_total: Decimal::ZERO,
            });
            bucket
        }

        // ---------- Odczyt ----------

        pub fn get_offer(&self, offer_id: u64) -> Option<Offer> {
            self.offers.get(&offer_id).map(|o| o.clone())
        }

        pub fn quote_fee(&self, rider: NonFungibleLocalId, amount: Decimal) -> Decimal {
            self.fee_for(&rider, amount)
        }

        // ---------- Admin ----------

        pub fn withdraw_fees(&mut self, resource: ResourceAddress) -> Bucket {
            self.fees
                .get_mut(&resource)
                .expect("No fees in this resource")
                .take_all()
        }

        pub fn set_paused(&mut self, paused: bool) {
            self.paused = paused;
        }

        // ---------- Pomocnicze ----------

        fn check_rider(&self, rider: Proof) -> NonFungibleLocalId {
            rider
                .check_with_message(self.rider_badge.address(), "Invalid rider badge")
                .as_non_fungible()
                .non_fungible_local_id()
        }

        fn locked_amount(&self, rider: &NonFungibleLocalId) -> Decimal {
            self.hard_locks
                .get(rider)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO)
        }

        fn fee_for(&self, rider: &NonFungibleLocalId, amount: Decimal) -> Decimal {
            let mut rate = self.fee_rate_per_side;
            if self.locked_amount(rider) >= self.hard_discount_threshold {
                rate = rate.checked_mul(self.discount_multiplier).unwrap();
            }
            amount.checked_mul(rate).unwrap()
        }

        fn collect_fee(&mut self, fee: Bucket) {
            let addr = fee.resource_address();
            let exists = self.fees.get(&addr).is_some();
            if exists {
                self.fees.get_mut(&addr).unwrap().put(fee);
            } else {
                self.fees.insert(addr, Vault::with_bucket(fee));
            }
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
