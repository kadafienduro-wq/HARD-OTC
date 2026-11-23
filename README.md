# HARD OTC: Stokenet (v0.1)

Escrow OTC na Radix Stokenet: smart kontrakt w Scrypto plus front w TypeScript, który działa z Radix Wallet.
Tylko aktywa testowe. Bez wartości pieniężnej.

## Co działa w v1
- **Rider Badge**: darmowe NFT, które służy za tożsamość na desku (potrzebne do handlu, rezerwacji i rabatu).
- **Oferta z escrow**: aktywo sprzedającego jest zablokowane w kontrakcie. Ważność 1, 6 lub 72 h, opcjonalnie zarezerwowany kupujący (ID jego Rider Badge).
- **Atomowe rozliczenie**: jedna transakcja. Kupujący dostaje aktywo, a zapłata od razu trafia na konto sprzedającego.
- **Opłaty**: 0,75% z każdej strony (sprzedający płaci z ceny, kupujący z aktywa).
- **Lock HARD**: ≥ 1000 HARD zablokowane = 20% zniżki na Twoją połowę opłaty. Bez zysku, wypłata w każdej chwili.
- **Anulowanie / odbiór po wygaśnięciu**: tylko sprzedający. Działa nawet przy pauzie.
- **Admin** (badge): wypłata opłat, pauza.
- Eventy on-chain: `OfferCreated`, `OfferFilled`, `OfferCancelled`, `HardLockChanged` (do zakładki „On-chain activity”).

Ograniczenie v1: obie strony muszą być fungible (tokeny, LSU, LP receipt). Pozycje NFT to następny krok.

## 1. Zbuduj kontrakt (Windows, PowerShell)
Jednorazowa instalacja:
1. Zainstaluj Rust: pobierz `rustup-init.exe` z rust-lang.org i uruchom. Jeśli zaproponuje doinstalowanie Visual Studio C++ Build Tools, zgódź się.
2. Zainstaluj LLVM: `winget install LLVM.LLVM` (albo instalator z GitHuba LLVM; zaznacz „Add LLVM to PATH”).
3. Otwórz **nowe** okno PowerShell i wpisz:
```powershell
rustup target add wasm32-unknown-unknown
cargo install --force radix-clis@1.3.0
```
4. Zainstaluj Node.js LTS: `winget install OpenJS.NodeJS.LTS`

Build:
```powershell
cd hard-otc\scrypto
scrypto build
# wynik: target\wasm32-unknown-unknown\release\hard_otc.wasm i hard_otc.rpd
```
Pełna instrukcja: https://docs.radixdlt.com/docs/getting-rust-scrypto

## 2. Wdróż na Stokenet
1. Zainstaluj Radix Wallet, przełącz go na Stokenet i weź testowe XRD z faucetu (w ustawieniach portfela, dev mode).
2. Otwórz **Stokenet Developer Console** → *Deploy Package* i wgraj `.wasm` oraz `.rpd`. Zapisz adres `package_tdx_2_…`.
3. W konsoli → *Send Raw Transaction* wklej `scrypto/manifests/instantiate.rtm` (podmień adres pakietu i konta).
4. Z receiptu zapisz: adres komponentu, zasób Rider Badge i zasób HARD (test). 1 000 000 HARD i badge admina trafią na Twoje konto.
5. W konsoli → *Configure dApp Definition*: ustaw konto jako dApp Definition i dodaj localhost / swoją domenę.

## 3. Uruchom front lokalnie
```powershell
cd hard-otc\frontend
# uzupełnij src\config.ts adresami z kroku 2
npm install
npm run dev
```
Pierwsze kroki w UI: połącz portfel → „Rider badge i HARD” → wybij badge → „+ Nowa oferta”.

## 4. Link dla drugiej strony (test na dwóch osobnych portfelach)
`npm run dev` działa tylko na Twoim komputerze. Żeby druga osoba weszła ze swoim Radix Wallet, wystaw front publicznie:
```powershell
npm run build      # tworzy folder dist
```
1. Wejdź na app.netlify.com/drop i przeciągnij folder `dist`. Dostaniesz link `https://…netlify.app`.
2. W Developer Console → *Configure dApp Definition* dodaj ten adres jako *claimed website*.
3. Wyślij link drugiej osobie. Oboje: Radix Wallet na Stokenet, testowe XRD z faucetu, każdy wybija swój Rider Badge.
4. Ty wystawiasz ofertę, ona kupuje (albo odwrotnie). Obie transakcje widać w Stokenet Dashboard po hashu.

Testowe HARD dla drugiej osoby wyślij przelewem z Radix Wallet (masz 1 000 000 z instantiate).
