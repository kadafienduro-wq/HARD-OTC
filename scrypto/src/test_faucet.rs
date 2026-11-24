//! Kranik testowy (tylko Stokenet): kilka testowych walut do wypróbowania giełdy
//! + testowy HARD z puli zasilonej przez admina. Odbiór co `cooldown` sekund na konto.
//! Testowe waluty są bez wartości, z nazwą "(test)", żeby nikt ich nie pomylił z prawdziwymi.

use scrypto::prelude::*;

#[blueprint]
mod test_faucet {
    enable_method_auth! {
        methods {
            claim => PUBLIC;
            tokens => PUBLIC;
            fund_hard => restrict_to: [OWNER];
            withdraw_hard => restrict_to: [OWNER];
            set_hard_amount => restrict_to: [OWNER];
            set_cooldown => restrict_to: [OWNER];
        }
    }

    struct TestFaucet {
        /// (zasób, ile na jeden odbiór)
        tokens: Vec<(ResourceAddress, Decimal)>,
        hard: Vault,
        hard_amount: Decimal,
        cooldown_seconds: i64,
        last_claim: KeyValueStore<ComponentAddress, i64>,
    }

    impl TestFaucet {
        /// `hard` – adres testowego HARD; `owner_badge` – badge admina desku (ten sam klucz).
        pub fn instantiate(hard: ResourceAddress, owner_badge: ResourceAddress) -> Global<TestFaucet> {
            let (reservation, me) = Runtime::allocate_component_address(TestFaucet::blueprint_id());
            let make = |name: &str, symbol: &str, divisibility: u8| -> ResourceAddress {
                ResourceBuilder::new_fungible(OwnerRole::None)
                    .divisibility(divisibility)
                    .metadata(metadata!(init {
                        "name" => format!("{} (test)", name), locked;
                        "symbol" => symbol.to_string(), locked;
                        "description" => "Stokenet test token from the HARD ADV OTC test faucet. No value.", locked;
                    }))
                    .mint_roles(mint_roles! {
                        minter => rule!(require(global_caller(me)));
                        minter_updater => rule!(deny_all);
                    })
                    .create_with_no_initial_supply()
                    .address()
            };
            let tokens = vec![
                (make("Tether USD", "tUSDT", 6), dec!("1000")),
                (make("USD Coin", "tUSDC", 6), dec!("1000")),
                (make("Ether", "tETH", 18), dec!("0.5")),
                (make("Bitcoin", "tBTC", 8), dec!("0.02")),
            ];
            Self {
                tokens,
                hard: Vault::new(hard),
                hard_amount: dec!("2000"),
                cooldown_seconds: 3600,
                last_claim: KeyValueStore::new(),
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(rule!(require(owner_badge))))
            .with_address(reservation)
            .metadata(metadata!(init {
                "name" => "HARD ADV test faucet", locked;
                "description" => "Free test tokens for the HARD ADV OTC desk on Stokenet.", locked;
            }))
            .globalize()
        }

        /// Wszystkie testowe waluty + testowy HARD (jeśli jest w puli). Raz na `cooldown` na konto.
        pub fn claim(&mut self, account: Global<Account>) -> Vec<Bucket> {
            let key = account.address();
            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;
            if let Some(last) = self.last_claim.get(&key).map(|v| *v) {
                assert!(now - last >= self.cooldown_seconds, "Come back later: one claim per hour");
            }
            self.last_claim.insert(key, now);
            let mut out: Vec<Bucket> = self
                .tokens
                .iter()
                .map(|(r, amount)| ResourceManager::from(*r).mint(*amount))
                .collect();
            if self.hard_amount > Decimal::ZERO && self.hard.amount() >= self.hard_amount {
                out.push(self.hard.take(self.hard_amount));
            }
            out
        }

        pub fn tokens(&self) -> Vec<(ResourceAddress, Decimal)> {
            self.tokens.clone()
        }

        pub fn fund_hard(&mut self, hard: Bucket) {
            self.hard.put(hard);
        }

        pub fn withdraw_hard(&mut self) -> Bucket {
            self.hard.take_all()
        }

        pub fn set_hard_amount(&mut self, amount: Decimal) {
            assert!(amount >= Decimal::ZERO, "Amount cannot be negative");
            self.hard_amount = amount;
        }

        pub fn set_cooldown(&mut self, seconds: i64) {
            assert!(seconds >= 0, "Cooldown cannot be negative");
            self.cooldown_seconds = seconds;
        }
    }
}
