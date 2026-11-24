# HARD ADV OTC Desk: notes for the auditor

This document gives you the context to review the project without reading the whole design chat.
Questions can go to the owner (HARD ADV). The code comments are partly in Polish, but identifiers and error messages are in English.

## 1. What it is

A peer-to-peer OTC escrow for fungible Radix tokens, with extras around the HARD ADV community token (HARD):

* **Offers.** A seller locks tokens in escrow and asks for a fixed amount of another token. A buyer pays and receives the tokens in one atomic transaction. Offers can allow partial fills, be reserved for one badge holder, expire (1 h / 6 h / 72 h), and be "featured" (paid in HARD).
* **Fees.** There is a listing fee (HARD), a reservation fee (HARD per started 24 h) and a featuring fee (HARD per 24 h). A trading fee is charged per side, in the token each side receives, and goes to the treasury.
* **HARD lock.** Users lock HARD to get fee discounts (−20 / −40 / −60 % at 1k / 10k / 50k HARD). Unlocking is two-step, with a waiting period (default 7 days, max 30).
* **Staked XRD buyback.** Users sell LSUs (validator liquid stake units) to the desk. Every request is held in escrow and **accepted or rejected manually by the admin**. The payout is the LSU redemption value × (1 − fee), paid partly in XRD and partly in HARD (default 80/20). The HARD part is priced at an admin-supplied XRD/HARD price; the front-end reads it from Ociswap and sets it in the same transaction as the accept.
* **Community pool.** Users deposit HARD for pool shares (HBPS) to fund the buyback. It is **off by default** and not intended to be enabled for now.
* **Faucet.** A HARD faucet for testers or promotions: one claim per badge, admin-funded, off by default.

Identity is a free, numbered, transferable non-fungible **HARD OTC Badge** (integer IDs #1, #2, …). Badges are not Sybil-resistant by design.

## 2. Repository layout

| Path | What |
|---|---|
| `scrypto/src/lib.rs` | The whole blueprint `OtcDesk` (Scrypto 1.3.0, Rust 1.81.0). **Main audit target.** |
| `testy/tests/bezpieczenstwo.rs` | Integration tests (`scrypto-test` 1.3.0, LedgerSimulator) run against the exact built `.wasm` + `.rpd`. |
| `frontend/src/` | Static TypeScript front-end (Vite + Radix dApp Toolkit). `manifests.ts` builds every transaction manifest; `gateway.ts` reads state from the Gateway API; `main.ts` holds the UI and a client-side manifest sanity check (`manifestProblem`). |
| `scrypto/manifests/` | Mainnet deployment manifests (instantiate, dApp definition). |
| `.github/workflows/build.yml` | CI: builds the package (`scrypto build`), runs the tests, builds and publishes the site. The package artifact (`kontrakt-do-wgrania`) is what gets deployed. |

## 3. Roles and trust model

* **Owner / admin**: holds 2 fungible admin badges (one meant as a cold backup). `OwnerRole::Fixed(require(admin_badge))`. Admin-only methods are listed in `enable_method_auth!` (`restrict_to: [OWNER]`).
* **Users** prove a HARD OTC Badge (`check_with_message` on the badge resource) for every user action.

What users must trust the admin with:

1. **Fees.** The admin sets them within caps: trading fee ≤ 1 % per side, listing fee ≤ 100 HARD; promotion and reservation fees are uncapped but only affect new actions.
2. **Pause.** The admin can pause the desk. Pausing blocks new offers and purchases; cancelling and reclaiming always works.
3. **LSU buyback price.** The admin supplies the HARD price at accept time. The seller is protected by their own `min_xrd_out` / `min_hard_out` (the UI sets them at −1 % of the quote).
4. **Unlock period.** The admin can change it, max 30 days. Note: a change also affects HARD already waiting to unlock.
5. **Treasury, buyback vaults, faucet.** These contain admin funds or fees, and only the admin can withdraw them.

What the admin **cannot** do (please verify): take escrowed offer tokens, take locked HARD, take LSUs of pending requests, or pay a seller less than their minimums.

## 4. Assets held by the component

* `escrow` (per offer): the seller's tokens, until filled or cancelled.
* `hard_locks`, `unlocking`: users' locked and unlocking HARD.
* `treasury` (per resource): collected fees.
* `lsu_escrow` (per request): pending LSUs. `lsu_vaults` (per LSU resource): bought LSUs.
* `buyback_xrd`, `buyback_hard`: admin capital for LSU payouts.
* `faucet`: HARD for the faucet.
* Pool share resource (HBPS) and related accounting (`pool_outstanding_cost`, …).

## 5. Things we already hardened (please re-check)

* **Fake LSU / fake validator.** The LSU resource's `validator` metadata must point to an entity of type `GlobalValidator`; the validator's `pool_unit` metadata must equal the LSU; value comes from `get_redemption_value`. Without the entity-type check, a user-deployed component pretending to be a validator could report an arbitrary redemption value. Covered by test `falszywe_lsu_odrzucone`. A fake-validator *component* test is not written yet.
* **Payout targets.** Payouts go only to real accounts (`assert_real_account`: `GlobalAccount` / preallocated account entity types).
* **Featuring.** Featuring cannot be bought on an expired offer or beyond the offer's lifetime.
* **Accept rules.** Users cannot fill their own offer. Reserved offers only accept the reserved badge.
* **LSU limits.** Per-request value limit (checked at request), daily payout limit (rolling 24 h window, checked at accept), max HARD per request.
* **Admin badges.** Two admin badges, so losing one does not lock funds forever.
* **Rounding.** Partial withdrawals and partial fills use `WithdrawStrategy::Rounded(ToZero)` and divisibility checks.

## 6. Known limitations and open questions

1. **Price oracle.** The XRD/HARD price is admin-supplied (front-end reads Ociswap). HARD liquidity is thin, so the spot price is manipulable. The UI warns the admin on > 15 %/1 h or > 30 %/24 h moves, but there is no on-chain TWAP.
2. **Badges are free and transferable.** Reputation and faucet claims are per badge, not per person.
3. **Arbitrary tokens.** Any fungible token can be listed, including recallable, freezable or deposit-restricted ones. The UI shows a "verified" list curated by the admin, but the contract does not restrict tokens. Please assess the impact of recallable/freezable tokens on escrow and fills.
4. **Partial fills.** Integer rounding of `out = sell_remaining × pay / ask_remaining` favours the seller. Is dust griefing possible?
5. **`instantiate_with_test_hard`.** This function exists for testnet convenience. On mainnet anyone could call it to create a separate desk with a fake "HARD" token. It does not affect the official desk, but it enables impersonation. Should it be removed for mainnet?
6. **Community pool.** The pool logic (`deposit_pool`, `withdraw_pool`, `settle_pool`, `mint_initial_pool_shares`) has received the least testing. It is disabled by default and we may remove it before mainnet.
7. **Unlock period.** Changing it also affects requests already in progress.
8. **Upgradeability.** None. A new version means a new package and component, and users migrate by cancelling and re-creating offers.

## 7. Tests

`testy/tests/bezpieczenstwo.rs`, 12 tests, all passing in CI:

* `pelna_transakcja_i_oplaty_sa_poprawne`: full fill and exact fee amounts
* `nie_mozna_kupic_wlasnej_oferty`: self-fill is rejected
* `czesciowe_kupno_tylko_gdy_dozwolone`: partial fill only when allowed; amounts are exact
* `tylko_sprzedajacy_moze_anulowac_takze_przy_pauzie`: only the seller can cancel; cancel works while paused
* `oferta_zarezerwowana_tylko_dla_wybranego`: reserved offers, including the lock requirement
* `wyplata_tylko_na_prawdziwe_konto`: a non-account payout address is rejected
* `wyroznienie_nie_dluzsze_niz_oferta`: featuring is capped to the offer's life
* `metody_admina_wymagaja_badgea`: admin methods without the badge fail; fee caps hold
* `czesciowa_wyplata_z_portfela_skupu`: partial and full withdrawals
* `falszywe_lsu_odrzucone`: fake LSU rejected
* `prawdziwe_lsu_wycena_podzial_i_limity`: real validator flow: valuation, 80/20 split, seller minimums, daily limit, double accept
* `kranik_raz_na_badge_i_tylko_gdy_wlaczony`: faucet rules

To run them locally:

1. Build the contract: in `scrypto/`, run `scrypto build` with Rust 1.81.0.
2. Run the tests: in `testy/`, run `cargo test --release`. See `build.yml` for the lockfile pinning to 1.3.0.

## 8. Deployments (Stokenet, testnet)

| | Address |
|---|---|
| Current desk (v7) | `component_tdx_2_1cr8uef5n7vmar78mumlxhrv5luj6kyjt9e4lm7ym2et7aenn5deq87` |
| Package (v7) | `package_tdx_2_1p56r5nuh75qjq0qwfh76se4auphlppm8t2me3kzdhkn3865utew0x4` |
| Test HARD | `resource_tdx_2_1t4x3apc4tre2ynjjl2qg5ctzvfaft48xlcxp52a36qy7s9d6yxhgtn` |
| Front-end | https://kadafienduro-wq.github.io/HARD-OTC/ |

The mainnet HARD token is `resource_rdx1thh4yr9k393uc4x45n4u9l7h57804qdhxxzdw2dpmu8cjpm6ueujpn`. Mainnet is not deployed yet.

## 9. What we would most like from the audit

* Any way to extract funds from escrow, locks, pending LSU requests or the admin vaults without authorization.
* Any way to make a buyer or seller receive less than the agreed amount, or the admin pay more than intended.
* The LSU valuation path (`lsu_xrd_value`) and the trust it places in validator components.
* Behaviour with non-standard tokens: recallable, freezable, restricted deposit or withdraw, tokens with 0 divisibility.
* Whether to remove `instantiate_with_test_hard` and the community pool before mainnet.
