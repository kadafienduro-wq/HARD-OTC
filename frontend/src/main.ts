import { RadixDappToolkit, RadixNetwork, DataRequestBuilder } from '@radixdlt/radix-dapp-toolkit'
import { CONFIG } from './config'
import * as M from './manifests'
import { getOffers, getRiderBadges, getSymbols, loadDeskInfo, short, type OfferView } from './gateway'

// ---------- Stan ----------
let account: string | null = null
let riderIds: string[] = []
let offers: OfferView[] = []

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

// ---------- Radix dApp Toolkit ----------
const rdt = RadixDappToolkit({
  dAppDefinitionAddress: CONFIG.dAppDefinitionAddress,
  networkId: RadixNetwork.Stokenet,
  applicationName: 'HARD OTC (Stokenet)',
  applicationVersion: '0.1.0',
})
rdt.walletApi.setRequestData(DataRequestBuilder.accounts().exactly(1))

rdt.walletApi.walletData$.subscribe(async (data) => {
  account = data.accounts[0]?.address ?? null
  await refreshRider()
  render()
})

async function send(manifest: string, okMsg: string) {
  if (!account) return toast('Najpierw połącz Radix Wallet.')
  toast('Podpisz transakcję w Radix Wallet…')
  const result = await rdt.walletApi.sendTransaction({ transactionManifest: manifest, version: 1 })
  if (result.isErr()) {
    console.error(result.error)
    return toast(`Transakcja nie przeszła: ${result.error.error ?? 'odrzucona'}`)
  }
  toast(`${okMsg} (tx: ${short(result.value.transactionIntentHash)})`)
  await refreshAll()
}

// ---------- Dane ----------
async function refreshRider() {
  riderIds = account ? await getRiderBadges(account).catch(() => []) : []
}

async function refreshAll() {
  try {
    offers = await getOffers()
    await getSymbols(offers.flatMap((o) => [o.sellResource, o.askResource]))
  } catch (e) {
    console.error(e)
    toast('Nie udało się pobrać ofert. Sprawdź adresy w config.ts.')
  }
  await refreshRider()
  render()
}

// ---------- Widok ----------
const sym = (addr: string) => {
  const known = CONFIG.knownResources.find((r) => r.address === addr)
  return known?.symbol ?? short(addr)
}
let symbols = new Map<string, string>()
const label = (addr: string) => symbols.get(addr) ?? sym(addr)

function timeLeft(ms: number) {
  const diff = ms - Date.now()
  if (diff <= 0) return 'wygasła'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

async function render() {
  symbols = await getSymbols([])
  const myRider = riderIds[0]

  // Rynek
  const open = offers.filter((o) => o.status === 'Open' && o.expiresAt > Date.now())
  const visible = open.filter((o) => !o.reservedBuyer || riderIds.includes(o.reservedBuyer) || riderIds.includes(o.seller))
  $('#market-body').innerHTML = visible.length
    ? visible
        .map((o) => {
          const mine = riderIds.includes(o.seller)
          return `<tr>
            <td>${o.id}${o.reservedBuyer ? ' 🔒' : ''}</td>
            <td>${o.sellAmount} ${label(o.sellResource)}</td>
            <td>${o.askAmount} ${label(o.askResource)}</td>
            <td>${timeLeft(o.expiresAt)}</td>
            <td>${mine ? '<span class="muted">Twoja</span>' : `<button data-accept="${o.id}" ${myRider ? '' : 'disabled title="Potrzebujesz Rider Badge"'}>Kup</button>`}</td>
          </tr>`
        })
        .join('')
    : '<tr><td colspan="5" class="muted">Brak otwartych ofert.</td></tr>'

  // Moje oferty
  const mine = offers.filter((o) => riderIds.includes(o.seller))
  $('#mine-body').innerHTML = mine.length
    ? mine
        .map((o) => {
          const expired = o.expiresAt <= Date.now()
          const status = o.status === 'Open' ? (expired ? 'Wygasła' : 'Otwarta') : o.status === 'Filled' ? 'Zrealizowana' : 'Anulowana'
          return `<tr>
            <td>${o.id}</td>
            <td>${o.sellAmount} ${label(o.sellResource)}</td>
            <td>${o.askAmount} ${label(o.askResource)}</td>
            <td>${status}</td>
            <td>${o.status === 'Open' ? `<button data-cancel="${o.id}" data-seller="${o.seller}">${expired ? 'Odbierz aktywo' : 'Anuluj'}</button>` : ''}</td>
          </tr>`
        })
        .join('')
    : '<tr><td colspan="5" class="muted">Nie masz jeszcze ofert.</td></tr>'

  // Rider
  $('#rider-info').textContent = !account
    ? 'Połącz portfel.'
    : myRider
      ? `Twój Rider Badge: ${myRider}`
      : 'Nie masz jeszcze Rider Badge. Wybij go, żeby handlować.'
  $<HTMLButtonElement>('#mint-badge').hidden = !!myRider
  $<HTMLButtonElement>('#open-create').disabled = !myRider
}

// ---------- Zdarzenia ----------
document.querySelectorAll<HTMLButtonElement>('nav button').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    for (const t of ['market', 'mine', 'rider']) $(`#tab-${t}`).hidden = t !== btn.dataset.tab
  }),
)

$('#refresh').addEventListener('click', refreshAll)

document.addEventListener('click', (e) => {
  const el = e.target as HTMLElement
  const acceptId = el.dataset.accept
  const cancelId = el.dataset.cancel
  if (acceptId && account && riderIds[0]) {
    const o = offers.find((x) => x.id === acceptId)!
    send(M.acceptOffer(account, riderIds[0], o.id, o.askResource, o.askAmount), `Kupiono ofertę #${o.id}`)
  }
  if (cancelId && account) {
    send(M.cancelOffer(account, el.dataset.seller!, cancelId), `Aktywo z oferty #${cancelId} wróciło do Ciebie`)
  }
})

$('#mint-badge').addEventListener('click', () => account && send(M.mintRiderBadge(account), 'Rider Badge wybity'))

$('#lock-btn').addEventListener('click', () => {
  const amount = $<HTMLInputElement>('#lock-amount').value
  if (account && riderIds[0]) send(M.lockHard(account, riderIds[0], amount), `Zablokowano ${amount} HARD`)
})
$('#unlock-btn').addEventListener('click', () => {
  if (account && riderIds[0]) send(M.unlockHard(account, riderIds[0]), 'Lock HARD wypłacony')
})

// Formularz oferty
const dialog = $<HTMLDialogElement>('#create-dialog')
const form = $<HTMLFormElement>('#create-form')
$('#open-create').addEventListener('click', () => dialog.showModal())

form.addEventListener('input', () => {
  const f = new FormData(form)
  const amount = Number(f.get('sellAmount') || 0)
  const price = Number(f.get('askAmount') || 0)
  $('#fee-preview').textContent = price
    ? `Przed rabatem: Ty zapłacisz ${(price * CONFIG.feePerSide).toFixed(4)} z ceny, kupujący ${(amount * CONFIG.feePerSide).toFixed(4)} z aktywa.`
    : ''
})

form.addEventListener('submit', (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null
  if (submitter?.value !== 'ok' || !account || !riderIds[0]) return
  const f = new FormData(form)
  send(
    M.createOffer({
      account,
      riderId: riderIds[0],
      sellResource: String(f.get('sellResource')).trim(),
      sellAmount: String(f.get('sellAmount')),
      askResource: String(f.get('askResource')).trim(),
      askAmount: String(f.get('askAmount')),
      expiryHours: Number(f.get('expiry')) as 1 | 6 | 72,
      reservedBuyer: String(f.get('reserved') || '').trim() || undefined,
    }),
    'Oferta utworzona, aktywo zablokowane w escrow',
  )
})

// ---------- Toast ----------
let toastTimer: number | undefined
function toast(msg: string) {
  const t = $('#toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (t.hidden = true), 6000)
}

async function init() {
  try {
    await loadDeskInfo()
  } catch (e) {
    console.error(e)
    toast('Nie udało się odczytać desku. Sprawdź adres komponentu w config.ts.')
  }
  $('#known').innerHTML = [...CONFIG.knownResources, { symbol: 'HARD', address: CONFIG.hardResource }]
    .map((r) => `<option value="${r.address}">${r.symbol}</option>`)
    .join('')
  await refreshAll()
  setInterval(refreshAll, 20_000)
}
init()
