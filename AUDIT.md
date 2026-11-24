# HARD ADV OTC Desk: notes for the auditor

This document gives you the context to review the project without reading the whole design chat.
Questions can go to the owner (HARD ADV). The code comments are partly in Polish, but identifiers and error messages are in English.

## 1. What it is

A peer-to-peer OTC escrow for fungible Radix tokens, with extras around the HARD ADV community token (HARD):

* **Offers.** A seller locks tokens in escrow and asks for a fixed amount of another token. A buyer pays and receives the tokens in one atomic transaction. Offers can allow partial fills, be reserved for one badge holder, expire (1 h / 6 h / 72 h), and be "featured" (paid in HARD).
* **Fees.** There is a listing fee (HARD), a reservation fee (HARD per started 24 h) and a featuring fee (HARD per 24 h). A trading fee is charged per side, in the token each side receives, and goes to the treasury.
* **HARD lock.** Users lock HARD to get fee discounts (−20 / −40 / −60 % at 1k / 10k / 50k HARD). Unlocking is two-step, with a waiting period (default 7 days, max 30).
* **Staked XRD buyback.** Users sell LSUs (validator liquid stake units) to the desk. Every request is held in escrow and **accepted or rejected manually by the admin**. The payout is the LSU redemption value × (1 − fee), paid partly in XRD and partly in HARD (default 80/20). The HARD part is priced at an admin-supplied XRD/HARD price; the front-end reads it from Ociswap and sets it in the same transaction as the accept.
* **Faucet.** A HARD faucet for testers or promotions: one claim per badge, admin-funded, off by default.

Identity is a free, numbered, **non-transferable** (soulbound since v8) non-fungible **HARD OTC Badge** (integer IDs #1, #2, …). Badges are not Sybil-resistant: anyone can mint more.

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

## 5. Internal audit (v8): findings and fixes

| # | Severity | Finding | Who loses | Fix in v8 | Test |
|---|---|---|---|---|---|
| 1 | Critical | Offers, locked HARD, unlocking HARD and LSU requests belong to the **badge ID**, and the badge was **transferable**. Sending, selling or phishing the badge moved control of the funds to the new holder. | User | Badge is soulbound (`withdrawer => deny_all`). | `badge_jest_nieprzenosny` |
| 2 | High | Funds of expired offers stayed in escrow until the seller acted. There was no recovery path, and the admin could not help. | User | `reclaim_expired_offer`: **anyone** can call it after expiry; tokens go **only** to the seller's account. | `wygasla_oferte_moze_zwrocic_kazdy_tylko_sprzedajacemu` |
| 3 | High | There was no way to unwind an offer with a malicious token. | Buyers | `admin_return_offer`: the admin can return an open offer, but **only** to the seller's account; the admin receives nothing. | `admin_zwraca_oferte_tylko_sprzedajacemu` |
| 4 | High | Any token could be listed, including ones whose issuer can **recall or freeze** them, from the escrow or from the buyer after the purchase. | Buyer or seller | Verified-only mode, ON by default. Full fills also assert that the escrow still holds the promised amount. | `tylko_zweryfikowane_tokeny_domyslnie` |
| 5 | High | The admin could raise the trading fee (up to 1 %) right before someone's fill, on existing offers. | Both sides | The fee rate is frozen in each offer at creation. | `oplata_zamrozona_w_ofercie` |
| 6 | Medium | The buyer had no on-chain minimum: rounding or state changes between preview and signing reduced what they got. | Buyer | `accept_offer(…, min_receive)`. | `kupujacy_dostaje_co_najmniej_minimum` |
| 7 | High | The community pool let the admin spend depositors' HARD on LSUs and withdraw those LSUs, so the admin **could take depositors' funds**. | Depositors | The pool was removed entirely. The admin only manages the admin's own capital. | n/a |
| 8 | Medium | An LSU request with 0 minimums let the admin pay almost nothing by setting an absurd HARD price, payout or split. | Seller | Non-zero `min_xrd_out` / `min_hard_out` are required (for each part that is paid). | `prawdziwe_lsu_wycena_podzial_i_limity` |
| 9 | Medium | A second `request_unlock` restarted the timer for HARD that was already ready, re-locking it. | User | The contract refuses a new unlock until the ready HARD is withdrawn. | `ponowne_odblokowanie_nie_zeruje_gotowego_hard` |
| 10 | Medium | `instantiate_with_test_hard` let anyone create a look-alike desk with a fake "HARD" on mainnet. | Users (impersonation) | Removed. | n/a |

Also hardened earlier (v5–v7): only native validators are accepted for LSU valuation (`falszywe_lsu_odrzucone`); payouts go only to real accounts; featuring is capped to the offer's life; there are two admin badges; fees and the unlock period are capped; partial withdrawals are supported.

### What the admin can and cannot do (v8)

* **Can:** set fees within caps (affecting new offers only), pause new trading, curate verified tokens, accept or reject LSU requests (never below the seller's minimums), return offers to their sellers, and manage the admin's own vaults (treasury fees, buyback XRD and HARD, bought LSUs, faucet).
* **Cannot:** take escrowed offer tokens, locked or unlocking HARD, or pending LSUs; change the fee of an existing offer; pay an LSU seller less than their minimums. Pausing never blocks exits: cancel, reclaim, unlock, withdraw and LSU cancel all keep working.

## 6. Remaining limitations

1. **Price oracle.** The XRD/HARD price for LSU payouts is admin-supplied. The seller is protected by their own minimums (the UI sets −1 %). The admin is protected by a warning on sudden price moves. There is no on-chain TWAP.
2. **Sybil.** Badges are free, so reputation and faucet claims are per badge, not per person. Keep the faucet off on mainnet.
3. **Verified list.** Verified-only mode moves the trust to the admin's list. The admin must check a token's recall and freeze roles before verifying it.
4. **Recovery.** If a user loses access to their account, the soulbound badge cannot be moved. Expired offers can still be returned to the seller's payout account.
5. **Rounding.** Partial-fill rounding favours the seller; the amounts are negligible.
6. **Upgradeability.** None. A new version means a new component.

## 7. Tests

`testy/tests/bezpieczenstwo.rs`, 19 tests, all passing in CI. Besides the v8 tests listed in section 5:

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
* plus the 7 v8 tests from section 5

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
* Anything we missed in section 5.
