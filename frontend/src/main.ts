import { RadixDappToolkit, RadixNetwork, DataRequestBuilder } from '@radixdlt/radix-dapp-toolkit'
import { CONFIG } from './config'
import * as M from './manifests'
import { getBalances, getOffers, getRiderBadges, getTokens, loadDeskInfo, short, tokenInfo, type OfferView } from './gateway'

// ---------- Stan ----------
let account: string | null = null
let riderIds: string[] = []
let offers: OfferView[] = []
let balances: { address: string; amount: string }[] = []

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
    balances = account ? await getBalances(account).catch(() => []) : []
    await getTokens([
      ...offers.flatMap((o) => [o.sellResource, o.askResource]),
      ...balances.map((b) => b.address),
      ...CONFIG.knownResources.map((r) => r.address),
      CONFIG.hardResource,
    ])
  } catch (e) {
    console.error(e)
    toast('Nie udało się pobrać ofert. Sprawdź adresy w config.ts.')
  }
  await refreshRider()
  render()
}

// ---------- Widok ----------
const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const fmtAmount = (a: string) => Number(a).toLocaleString('pl-PL', { maximumFractionDigits: 6 })

function icon(addr: string) {
  const t = tokenInfo(addr)
  return t.icon
    ? `<img class="ico" src="${esc(t.icon)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ico ph',textContent:'${esc(t.symbol.slice(0, 1).toUpperCase())}'}))">`
    : `<span class="ico ph">${esc(t.symbol.slice(0, 1).toUpperCase())}</span>`
}

/** Ikona + ilość + symbol, adres zasobu małym drukiem pod spodem. */
function tok(addr: string, amount?: string) {
  const t = tokenInfo(addr)
  return `<span class="tok">${icon(addr)}<span><b>${amount ? fmtAmount(amount) + ' ' : ''}${esc(t.symbol)}</b><small title="${esc(addr)}">${esc(t.name && t.name !== t.symbol ? t.name + ' · ' : '')}${esc(short(addr))}</small></span></span>`
}

function timeLeft(ms: number) {
  const diff = ms - Date.now()
  if (diff <= 0) return 'wygasła'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

async function render() {
  const myRider = riderIds[0]
  renderForm()

  // Rynek
  const open = offers.filter((o) => o.status === 'Open' && o.expiresAt > Date.now())
  const visible = open.filter((o) => !o.reservedBuyer || riderIds.includes(o.reservedBuyer) || riderIds.includes(o.seller))
  $('#market-body').innerHTML = visible.length
    ? visible
        .map((o) => {
          const mine = riderIds.includes(o.seller)
          return `<tr>
            <td>${o.id}${o.reservedBuyer ? ' 🔒' : ''}</td>
            <td>${tok(o.sellResource, o.sellAmount)}</td>
            <td>${tok(o.askResource, o.askAmount)}</td>
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
            <td>${tok(o.sellResource, o.sellAmount)}</td>
            <td>${tok(o.askResource, o.askAmount)}</td>
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

// ---------- Formularz: listy tokenów ----------
function renderForm() {
  const sellSel = $<HTMLSelectElement>('#sell')
  const askSel = $<HTMLSelectElement>('#ask')
  const prevSell = sellSel.value
  const prevAsk = askSel.value
  sellSel.innerHTML = balances.length
    ? balances
        .map((b) => `<option value="${esc(b.address)}">${esc(tokenInfo(b.address).symbol)} (masz ${fmtAmount(b.amount)})</option>`)
        .join('')
    : '<option value="">Połącz portfel, żeby zobaczyć swoje tokeny</option>'
  const askList = [...new Set([...CONFIG.knownResources.map((r) => r.address), CONFIG.hardResource, ...balances.map((b) => b.address)])].filter(Boolean)
  askSel.innerHTML =
    askList.map((a) => `<option value="${esc(a)}">${esc(tokenInfo(a).symbol)}${tokenInfo(a).name && tokenInfo(a).name !== tokenInfo(a).symbol ? ' · ' + esc(tokenInfo(a).name) : ''}</option>`).join('') +
    '<option value="custom">Inny token (wklej adres)…</option>'
  if ([...sellSel.options].some((o) => o.value === prevSell)) sellSel.value = prevSell
  if ([...askSel.options].some((o) => o.value === prevAsk)) askSel.value = prevAsk
  updatePreviews()
}

function updatePreviews() {
  const sell = $<HTMLSelectElement>('#sell').value
  const ask = $<HTMLSelectElement>('#ask').value
  $('#sell-preview').innerHTML = sell ? tok(sell) : ''
  $('#ask-preview').innerHTML = ask && ask !== 'custom' ? tok(ask) : ''
  $('#ask-custom-wrap').hidden = ask !== 'custom'
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

form.addEventListener('change', updatePreviews)

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
      sellResource: String(f.get('sell')),
      sellAmount: String(f.get('sellAmount')),
      askResource: f.get('ask') === 'custom' ? String(f.get('askCustom')).trim() : String(f.get('ask')),
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
  await refreshAll()
  setInterval(refreshAll, 20_000)
}
init()
