import { RadixDappToolkit, RadixNetwork, DataRequestBuilder } from '@radixdlt/radix-dapp-toolkit'
import { CONFIG } from './config'
import * as M from './manifests'
import {
  desk, getBalances, getLocked, getUnlock, getOffers, getRiderBadges, getRiderStats, getTokens, getTreasuryBalance,
  getVaultAmount, loadDeskInfo, multiplierFor, short, tokenInfo, type OfferView, type RiderStats,
} from './gateway'

// ---------- State ----------
let account: string | null = null
let riderIds: string[] = []
let offers: OfferView[] = []
let balances: { address: string; amount: string }[] = []
let myLocked = 0
let myUnlock = { amount: 0, readyAt: 0 }
let burned = 0
let treasuryHard = 0
let treasuryAll: { address: string; amount: number }[] = []
let stats = new Map<string, RiderStats>()
let loaded = false

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T
const myRider = () => riderIds[0]
const balanceOf = (addr: string) => Number(balances.find((b) => b.address === addr)?.amount ?? 0)
const XRD = CONFIG.knownResources[0]?.address ?? ''
/** "#12#" -> "#12" (numbered badges); older random IDs are shortened. */
const badgeNo = (id: string) => (/^#\d+#$/.test(id) ? id.slice(0, -1) : `${id.slice(0, 7)}…${id.slice(-5)}`)

// ---------- Formatting ----------
const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const nf = (n: number, d = 4) => n.toLocaleString('en-US', { maximumFractionDigits: d })
const pct = (m: number) => `${Math.round((1 - m) * 100)}%`
const feeRate = (locked: number) => desk.feePerSide * multiplierFor(locked)
const sym = (addr: string) => tokenInfo(addr).symbol
const isVerified = (addr: string) => desk.verified.includes(addr)
const symV = (addr: string) => `${sym(addr)}${isVerified(addr) ? ' ✓' : ''}`

function icon(addr: string) {
  const t = tokenInfo(addr)
  const letter = esc(t.symbol.slice(0, 1).toUpperCase())
  return t.icon
    ? `<img class="ico" src="${esc(t.icon)}" alt="" loading="lazy" data-letter="${letter}">`
    : `<span class="ico ph">${letter}</span>`
}
/** Token icon + amount + symbol (✓ if verified), with name and address in small print. */
function tok(addr: string, amount?: number) {
  const t = tokenInfo(addr)
  const mark = isVerified(addr) ? '<span class="ver" title="Verified by HARD ADV">✓</span>' : '<span class="unver" title="Not verified. Check the address.">UNVERIFIED</span>'
  const sub = `${t.name && t.name !== t.symbol ? esc(t.name) + ' · ' : ''}${esc(short(addr))}`
  return `<span class="tok">${icon(addr)}<span><b>${amount !== undefined ? nf(amount) + ' ' : ''}${esc(t.symbol)}${mark}</b><small title="${esc(addr)}">${sub}</small></span></span>`
}
function timeLeft(ms: number) {
  const diff = ms - Date.now()
  if (diff <= 0) return 'expired'
  const d = Math.floor(diff / 86_400_000)
  const h = Math.floor((diff % 86_400_000) / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}
function periodText(sec: number) {
  if (sec >= 86400) return `${Math.round(sec / 86400)} day${Math.round(sec / 86400) === 1 ? '' : 's'}`
  if (sec >= 3600) return `${Math.round(sec / 3600)} hours`
  return `${Math.max(1, Math.round(sec / 60))} minutes`
}
document.addEventListener('error', (e) => {
  const img = e.target as HTMLImageElement
  if (img.tagName === 'IMG' && img.classList.contains('ico')) {
    const span = document.createElement('span')
    span.className = 'ico ph'
    span.textContent = img.dataset.letter ?? '?'
    img.replaceWith(span)
  }
}, true)

// ---------- Offer helpers ----------
/** "buy" = buy request (someone locks XRD to get a token); "sell" = sell offer. */
const kindOf = (o: OfferView): 'buy' | 'sell' => (o.sellResource === XRD ? 'buy' : 'sell')
const baseOf = (o: OfferView) => (kindOf(o) === 'buy' ? o.askResource : o.sellResource)
const quoteOf = (o: OfferView) => (kindOf(o) === 'buy' ? o.sellResource : o.askResource)
/** Price as quote per 1 base token. */
const priceOf = (o: OfferView) =>
  kindOf(o) === 'buy' ? Number(o.sellAmount) / Number(o.askAmount) : Number(o.askAmount) / Number(o.sellAmount)
const filledPct = (o: OfferView) => Math.round((1 - Number(o.askRemaining) / Number(o.askAmount)) * 100)
const isFeatured = (o: OfferView) => o.featuredUntil > Date.now()
const repText = (id: string) => {
  const s = stats.get(id)
  const n = s ? s.sells + s.buys : 0
  return `Badge ${badgeNo(id)} · ${n ? `${n} trade${n === 1 ? '' : 's'}` : 'new trader'}`
}

// ---------- Radix dApp Toolkit ----------
const rdt = RadixDappToolkit({
  dAppDefinitionAddress: CONFIG.dAppDefinitionAddress,
  networkId: RadixNetwork.Stokenet,
  applicationName: 'HARD ADV OTC Desk',
  applicationVersion: '0.3.0',
})
rdt.walletApi.setRequestData(DataRequestBuilder.accounts().exactly(1))
rdt.walletApi.walletData$.subscribe(async (data) => {
  account = data.accounts[0]?.address ?? null
  await refreshAll()
})

async function send(manifest: string, okMsg: string) {
  if (!account) return toast('Connect your Radix Wallet first.')
  toast('Check your Radix Wallet to review and sign…', 0)
  const result = await rdt.walletApi.sendTransaction({ transactionManifest: manifest, version: 1 })
  if (result.isErr()) {
    console.error(result.error)
    const reason = result.error.error === 'rejectedByUser' ? 'You rejected it in the wallet.' : (result.error.message || result.error.error || 'Unknown error')
    return toast(`Transaction not completed. ${reason}`)
  }
  const tx = result.value.transactionIntentHash
  toast(`✓ ${okMsg}`, 7000, `https://stokenet-dashboard.radixdlt.com/transaction/${tx}`)
  await refreshAll()
}

// ---------- Confirm dialog (used for every action) ----------
const confirmDlg = $<HTMLDialogElement>('#confirm-dialog')
let pending: (() => void) | null = null
function confirmAction(title: string, lines: [string, string][], note: string, run: () => void) {
  $('#confirm-title').textContent = title
  $('#confirm-body').innerHTML =
    lines.map(([k, v]) => `<div class="sline"><span>${k}</span><b>${v}</b></div>`).join('') +
    (note ? `<p class="snote">${note}</p>` : '')
  pending = run
  confirmDlg.showModal()
}
$('#confirm-ok').addEventListener('click', () => {
  confirmDlg.close()
  pending?.()
  pending = null
})
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => (b.closest('dialog') as HTMLDialogElement).close()),
)
const unverifiedNote = (...addrs: string[]) =>
  addrs.some((a) => !isVerified(a))
    ? '<span class="warnline">⚠ This offer includes an UNVERIFIED token. Anyone can create a token with any name. Check the address before you sign.</span><br>'
    : ''

// ---------- Data ----------
async function refreshAll() {
  try {
    await loadDeskInfo().catch(() => {})
    riderIds = account ? await getRiderBadges(account).catch(() => []) : []
    ;[offers, balances, myLocked, myUnlock, burned, treasuryHard] = await Promise.all([
      getOffers(),
      account ? getBalances(account).catch(() => []) : Promise.resolve([]),
      myRider() ? getLocked(myRider()).catch(() => 0) : Promise.resolve(0),
      myRider() ? getUnlock(myRider()).catch(() => ({ amount: 0, readyAt: 0 })) : Promise.resolve({ amount: 0, readyAt: 0 }),
      getVaultAmount(desk.burnedVault).catch(() => 0),
      getTreasuryBalance(CONFIG.hardResource).catch(() => 0),
    ])
    ;[stats, treasuryAll] = await Promise.all([
      getRiderStats(offers.map((o) => o.seller)).catch(() => new Map()),
      Promise.all(desk.feesCollected.map(async (f) => ({ address: f.address, amount: await getTreasuryBalance(f.address).catch(() => 0) }))),
    ])
    await getTokens([
      ...offers.flatMap((o) => [o.sellResource, o.askResource]),
      ...balances.map((b) => b.address),
      ...CONFIG.knownResources.map((r) => r.address),
      CONFIG.hardResource,
      ...desk.feesCollected.map((f) => f.address),
      ...desk.verified,
    ])
    loaded = true
  } catch (e) {
    console.error(e)
    toast('Could not load data from the Radix network. Retrying shortly.')
  }
  render()
}

// ---------- Render ----------
function render() {
  renderOnboarding()
  renderMe()
  renderFilters()
  renderMarket()
  renderMine()
  renderLock()
  renderTreasury()
  renderAdmin()
  if (($('#create-dialog') as HTMLDialogElement).open) updateCreateSummary()
}

function renderOnboarding() {
  const hard = balanceOf(CONFIG.hardResource)
  const s1 = !!account
  const s2 = !!myRider()
  const s3 = desk.listingFee === 0 || hard >= desk.listingFee
  $('#ob-1').classList.toggle('done', s1)
  $('#ob-2').classList.toggle('done', s2)
  $('#ob-3').classList.toggle('done', s1 && s3)
  $('#ob-mint').hidden = !s1 || s2
  $('#ob-3-text').textContent = desk.listingFee
    ? `Creating an offer costs ${nf(desk.listingFee)} HARD.${s1 ? ` You have ${nf(hard)} HARD.` : ''} Buying only costs the trading fee.`
    : 'Listing is free right now. Buying only costs the trading fee.'
  $('#onboard').hidden = s1 && s2 && s3
}

function renderMe() {
  $('#me').hidden = !account
  if (!account) return
  $('#me-badge').textContent = myRider() ? badgeNo(myRider()) : 'not minted'
  $('#me-hard').textContent = nf(balanceOf(CONFIG.hardResource), 2)
  $('#me-locked').textContent = nf(myLocked, 2)
  $('#me-fee').textContent = `${(feeRate(myLocked) * 100).toFixed(2)}%`
}

// ---------- Market ----------
const openOffers = () => offers.filter((o) => o.status === 'Open' && o.expiresAt > Date.now())

function renderFilters() {
  const sel = $<HTMLSelectElement>('#f-token')
  const prev = sel.value
  const tokens = [...new Set(openOffers().map(baseOf))]
  sel.innerHTML = '<option value="">All tokens</option>' + tokens.map((t) => `<option value="${esc(t)}">${esc(symV(t))}</option>`).join('')
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev
}

function filteredOffers() {
  const type = (document.querySelector('input[name=ftype]:checked') as HTMLInputElement).value
  const token = $<HTMLSelectElement>('#f-token').value
  const sort = $<HTMLSelectElement>('#f-sort').value
  const onlyVerified = $<HTMLInputElement>('#f-verified').checked
  let list = openOffers().filter((o) =>
    (type === 'all' || kindOf(o) === type) &&
    (!token || baseOf(o) === token) &&
    (!onlyVerified || (isVerified(o.sellResource) && isVerified(o.askResource))))
  list.sort((a, b) => {
    if (sort === 'exp') return a.expiresAt - b.expiresAt
    if (sort === 'price') {
      if (kindOf(a) !== kindOf(b)) return kindOf(a) === 'sell' ? -1 : 1
      return kindOf(a) === 'sell' ? priceOf(a) - priceOf(b) : priceOf(b) - priceOf(a)
    }
    return Number(b.id) - Number(a.id)
  })
  // Promoted offers always on top
  list = [...list.filter(isFeatured), ...list.filter((o) => !isFeatured(o))]
  return list
}

function renderMarket() {
  if (!loaded) return
  const list = filteredOffers()
  const myRate = feeRate(myLocked)
  $('#market-body').innerHTML = list.length
    ? list.map((o) => {
        const mine = riderIds.includes(o.seller)
        const reservedForOther = !!o.reservedBuyer && !riderIds.includes(o.reservedBuyer)
        const sellRem = Number(o.sellRemaining)
        const get = mine ? sellRem : sellRem * (1 - myRate)
        const verb = kindOf(o) === 'buy' ? 'Sell' : 'Buy'
        let action: string
        if (mine) action = '<span class="pill">Your offer</span>'
        else if (reservedForOther) action = '<span class="pill">🔒 Reserved</span>'
        else if (!account) action = `<button disabled title="Connect your wallet">${verb}</button>`
        else if (!myRider()) action = `<button disabled title="Mint your HARD OTC Badge first">${verb}</button>`
        else if (desk.paused) action = '<button disabled title="Desk is paused">Paused</button>'
        else action = `<button class="primary" data-accept="${o.id}">${verb}</button>`
        const filled = filledPct(o)
        return `<tr class="${isFeatured(o) ? 'featured' : ''}">
          <td class="n">#${o.id} ${isFeatured(o) ? '<span class="star">★ FEATURED</span>' : ''}<br>
            <span class="kind ${kindOf(o)}">${kindOf(o) === 'buy' ? 'BUY REQUEST' : 'SELL OFFER'}</span>
            ${o.reservedBuyer && !reservedForOther && !mine ? '<br><small class="red">reserved for you</small>' : ''}
            <small class="rep">${esc(repText(o.seller))}</small></td>
          <td>${tok(o.sellResource, get)}
            ${filled > 0 ? `<div class="fillbar" title="${filled}% filled"><i style="width:${filled}%"></i></div><small class="rep">${filled}% filled</small>` : ''}
            ${o.allowPartial ? '<small class="rep">partial fills OK</small>' : ''}</td>
          <td>${tok(o.askResource, Number(o.askRemaining))}</td>
          <td class="n">${nf(priceOf(o), 6)} ${esc(sym(quoteOf(o)))}<br><small class="rep">per ${esc(sym(baseOf(o)))}</small></td>
          <td class="n">${timeLeft(o.expiresAt)}</td>
          <td>${action}</td>
        </tr>`
      }).join('')
    : `<tr><td colspan="6" class="empty">${openOffers().length ? 'No offers match your filters.' : `No open offers yet.${myRider() ? ' Be the first: click “+ Create offer”.' : ''}`}</td></tr>`
  $<HTMLButtonElement>('#open-create').disabled = !myRider() || desk.paused
  $('#open-create').title = myRider() ? '' : 'Connect your wallet and mint a HARD OTC Badge first'
}
document.querySelectorAll('input[name=ftype]').forEach((i) => i.addEventListener('change', renderMarket))
;['#f-token', '#f-sort', '#f-verified'].forEach((s) => $(s).addEventListener('change', renderMarket))

// ---------- My offers ----------
function renderMine() {
  const mine = offers.filter((o) => riderIds.includes(o.seller)).sort((a, b) => Number(b.id) - Number(a.id))
  const myRate = feeRate(myLocked)
  $('#mine-body').innerHTML = mine.length
    ? mine.map((o) => {
        const expired = o.status === 'Open' && o.expiresAt <= Date.now()
        const filled = filledPct(o)
        const status =
          o.status === 'Filled' ? '<span class="pill ok">Completed</span>'
          : o.status === 'Cancelled' ? '<span class="pill">Cancelled</span>'
          : expired ? '<span class="pill bad">Expired</span>'
          : `<span class="pill live">Open · ${timeLeft(o.expiresAt)}</span>`
        const actions: string[] = []
        if (o.status === 'Open' && !expired && desk.v3)
          actions.push(`<button data-promote="${o.id}">${isFeatured(o) ? '★ Extend' : '★ Promote'}</button>`)
        if (o.status === 'Open') actions.push(`<button data-cancel="${o.id}">${expired ? 'Reclaim tokens' : 'Cancel'}</button>`)
        return `<tr class="${isFeatured(o) ? 'featured' : ''}">
          <td class="n">#${o.id}<br><span class="kind ${kindOf(o)}">${kindOf(o) === 'buy' ? 'BUY REQUEST' : 'SELL OFFER'}</span></td>
          <td>${tok(o.sellResource, Number(o.sellAmount))}</td>
          <td>${tok(o.askResource, Number(o.askAmount) * (1 - myRate))}
            ${filled > 0 && filled < 100 ? `<div class="fillbar"><i style="width:${filled}%"></i></div><small class="rep">${filled}% filled</small>` : ''}</td>
          <td>${status}${isFeatured(o) ? `<br><span class="star">★ until ${new Date(o.featuredUntil).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span>` : ''}</td>
          <td><span class="actions">${actions.join('')}</span></td>
        </tr>`
      }).join('')
    : `<tr><td colspan="5" class="empty">${account ? 'You have no offers on this desk.' : 'Connect your wallet to see your offers.'}</td></tr>`
}

// ---------- Lock ----------
function renderLock() {
  const tiers = [{ threshold: 0, multiplier: 1 }, ...desk.tiers]
  const names = ['Base', 'Bronze', 'Silver', 'Gold', 'Platinum']
  const current = [...tiers].reverse().find((t) => myLocked >= t.threshold)!
  $('#tier-cards').innerHTML = tiers.map((t, i) => `
    <div class="tier ${t === current ? 'on' : ''}">
      <span>${names[i] ?? 'Tier ' + i}</span>
      <b>${(desk.feePerSide * t.multiplier * 100).toFixed(2)}%</b>
      <small>${t.threshold ? `${nf(t.threshold)}+ HARD locked` : 'No lock'}${t.multiplier < 1 ? ` · −${pct(t.multiplier)}` : ''}</small>
      ${i === 1 ? '<small class="red">+ reserved offers</small>' : ''}
    </div>`).join('')
  const next = desk.tiers.find((t) => myLocked < t.threshold)
  $('#tier-progress').innerHTML = !account ? '' : next
    ? `<div class="meter"><i style="width:${Math.min(100, (myLocked / next.threshold) * 100)}%"></i></div>
       <p class="muted">You have <b>${nf(myLocked)}</b> HARD locked. Lock <b>${nf(next.threshold - myLocked)}</b> more to pay ${(desk.feePerSide * next.multiplier * 100).toFixed(2)}%.</p>`
    : `<p class="muted">You are on the highest tier. 🎉</p>`

  if (desk.unlockPeriod) {
    $('#unlock-period-info').textContent = `Unlocking takes two steps: request now, claim after ${periodText(desk.unlockPeriod)}. HARD being unlocked no longer counts toward your discount.`
  }
  const u = myUnlock
  if (!u.amount) {
    $('#unlock-box').innerHTML = ''
  } else {
    const ready = Date.now() >= u.readyAt
    $('#unlock-box').innerHTML = `<div class="pendingbox">
      <div><span>Unlocking</span><b>${nf(u.amount)} HARD</b>
      <small>${ready ? 'Ready to claim.' : `Claimable from ${new Date(u.readyAt).toLocaleString('en-GB')} (in ${timeLeft(u.readyAt)})`}</small></div>
      <button id="withdraw-unlocked-btn" class="primary" ${ready ? '' : 'disabled'}>Claim HARD</button></div>`
  }
}

// ---------- Treasury ----------
function renderTreasury() {
  const spent = Number(desk.treasuryWithdrawn.find((w) => w.address === CONFIG.hardResource)?.amount ?? 0)
  $('#bb-listing').textContent = `${nf(desk.listingFeesHard + desk.promotionFeesHard + desk.reservationFeesHard, 2)} HARD`
  $('#res-fee').textContent = desk.v3 ? (desk.reservationFee ? `${nf(desk.reservationFee)} HARD` : 'Free') : '–'
  $('#bb-ready').textContent = `${nf(treasuryHard, 2)} HARD`
  $('#bb-spent').textContent = `${nf(spent, 2)} HARD`
  $('#burned').textContent = `${nf(burned)} HARD`
  $('#listing-fee').textContent = desk.listingFee ? `${nf(desk.listingFee)} HARD` : 'Free'
  $('#promo-fee').textContent = desk.v3 ? (desk.promotionFee ? `${nf(desk.promotionFee)} HARD` : 'Free') : '–'
  $('#trading-fee').textContent = `${(desk.feePerSide * 100).toFixed(2)}% / side`
  $('#burn-share').textContent = desk.burnShare > 0 ? `${Math.round(desk.burnShare * 100)}% of HARD fees` : 'Off'
  $('#fees-body').innerHTML = desk.feesCollected.length
    ? desk.feesCollected.map((f) => `<tr><td>${tok(f.address)}</td><td class="num">${nf(Number(f.amount))}</td></tr>`).join('')
    : '<tr><td colspan="2" class="empty">No fees yet. The first trade will fund the treasury.</td></tr>'
}

// ---------- Admin ----------
const isAdmin = () => !!desk.adminBadge && balanceOf(desk.adminBadge) >= 1

function renderAdmin() {
  const admin = isAdmin()
  $('#admin-tab').hidden = !admin
  if (!admin) {
    if (!$('#tab-admin').hidden) showTab('market')
    return
  }
  $('#adm-fee-now').textContent = desk.listingFee ? `${nf(desk.listingFee)} HARD` : 'free'
  $('#adm-res-now').textContent = desk.reservationFee ? `${nf(desk.reservationFee)} HARD` : 'free'
  $('#adm-promo-now').textContent = desk.promotionFee ? `${nf(desk.promotionFee)} HARD` : 'free'
  $('#adm-unlock-now').textContent = periodText(desk.unlockPeriod)
  $('#adm-burn-now').textContent = desk.burnShare > 0 ? `${Math.round(desk.burnShare * 100)}%` : 'off'
  $('#adm-status').textContent = desk.paused ? 'PAUSED' : 'Live'
  $('#adm-status').className = desk.paused ? 'red' : ''
  $('#adm-pause-btn').textContent = desk.paused ? 'Resume desk' : 'Pause desk'
  document.querySelectorAll<HTMLButtonElement>('[data-unlock]').forEach((b) => b.classList.toggle('on', Number(b.dataset.unlock) === desk.unlockPeriod))
  $('#adm-verified-body').innerHTML = desk.verified.length
    ? desk.verified.map((v) => `<tr><td>${tok(v)}</td><td><button data-unverify="${esc(v)}">Remove</button></td></tr>`).join('')
    : '<tr><td colspan="2" class="empty">No verified tokens.</td></tr>'
  $('#adm-treasury-body').innerHTML = treasuryAll.length
    ? treasuryAll.map((t) => `<tr><td>${tok(t.address)}</td><td class="num">${nf(t.amount)}</td>
        <td>${t.amount > 0 ? `<button data-withdraw="${esc(t.address)}">Withdraw all</button>` : '<span class="muted">empty</span>'}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">Treasury is empty.</td></tr>'
}

const adminSend = (title: string, lines: [string, string][], note: string, manifest: () => string, ok: string) =>
  confirmAction(title, lines, note, () => send(manifest(), ok))

$('#adm-fee-btn').addEventListener('click', () => {
  const raw = $<HTMLInputElement>('#adm-fee').value
  const v = Number(raw)
  if (raw === '' || !(v >= 0 && v <= 100)) return toast('Listing fee must be between 0 and 100 HARD.')
  adminSend('Change listing fee', [['Now', desk.listingFee ? `${nf(desk.listingFee)} HARD` : 'free'], ['New', v ? `${nf(v)} HARD` : 'free']], 'Applies to new offers only.',
    () => M.adminSetListingFee(account!, desk.adminBadge, String(v)), `Listing fee set to ${nf(v)} HARD`)
})
$('#adm-promo-btn').addEventListener('click', () => {
  const raw = $<HTMLInputElement>('#adm-promo').value
  const v = Number(raw)
  if (raw === '' || !(v >= 0)) return toast('Enter the promotion fee in HARD.')
  adminSend('Change promotion fee', [['Now', desk.promotionFee ? `${nf(desk.promotionFee)} HARD` : 'free'], ['New', v ? `${nf(v)} HARD per 24h` : 'free']], '',
    () => M.adminSetPromotionFee(account!, desk.adminBadge, String(v)), `Promotion fee set to ${nf(v)} HARD`)
})
$('#adm-res-btn').addEventListener('click', () => {
  const raw = $<HTMLInputElement>('#adm-res').value
  const v = Number(raw)
  if (raw === '' || !(v >= 0)) return toast('Enter the reservation fee in HARD.')
  adminSend('Change reservation fee', [['Now', desk.reservationFee ? `${nf(desk.reservationFee)} HARD` : 'free'], ['New', v ? `${nf(v)} HARD` : 'free']], 'Charged on top of the listing fee when an offer is reserved for a badge number.',
    () => M.adminSetReservationFee(account!, desk.adminBadge, String(v)), `Reservation fee set to ${nf(v)} HARD`)
})
$('#adm-verify-btn').addEventListener('click', () => {
  const addr = $<HTMLInputElement>('#adm-verify').value.trim()
  if (!/^resource_/.test(addr)) return toast('Paste a token address starting with resource_.')
  adminSend('Verify token', [['Token', esc(addr)]], 'This token will show ✓ everywhere on the site. Double-check the address.',
    () => M.adminAddVerified(account!, desk.adminBadge, [addr]), 'Token verified')
})
document.querySelectorAll<HTMLButtonElement>('[data-unlock]').forEach((b) =>
  b.addEventListener('click', () => {
    const sec = Number(b.dataset.unlock)
    adminSend('Change unlock waiting period', [['Now', periodText(desk.unlockPeriod)], ['New', periodText(sec)]],
      'Applies to new unlock requests. Requests already waiting keep their date.',
      () => M.adminSetUnlockPeriod(account!, desk.adminBadge, sec), `Unlock period set to ${periodText(sec)}`)
  }),
)
$('#adm-burn-btn').addEventListener('click', () => {
  const raw = $<HTMLInputElement>('#adm-burn').value
  const v = Number(raw)
  if (raw === '' || !(v >= 0 && v <= 100)) return toast('Burn share must be between 0 and 100%.')
  adminSend('Change HARD burn', [['Now', desk.burnShare > 0 ? `${Math.round(desk.burnShare * 100)}%` : 'off'], ['New', v ? `${v}%` : 'off']],
    'Burned HARD is locked in the contract forever. This cannot be undone for HARD already burned.',
    () => M.adminSetBurnShare(account!, desk.adminBadge, String(v / 100)), v ? `Burn set to ${v}%` : 'Burn turned off')
})
$('#adm-pause-btn').addEventListener('click', () => {
  const to = !desk.paused
  adminSend(to ? 'Pause desk' : 'Resume desk', [['Status after', to ? 'PAUSED' : 'Live']],
    to ? 'New offers and purchases are blocked until you resume. Cancelling still works.' : 'Trading opens again for everyone.',
    () => M.adminSetPaused(account!, desk.adminBadge, to), to ? 'Desk paused' : 'Desk resumed')
})

// ---------- Tabs ----------
const TABS = ['market', 'mine', 'lock', 'treasury', 'how', 'admin']
function showTab(t: string) {
  document.querySelectorAll<HTMLButtonElement>('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t))
  for (const x of TABS) $(`#tab-${x}`).hidden = x !== t
}
document.querySelectorAll<HTMLButtonElement>('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab!)))

// ---------- Actions ----------
$('#refresh').addEventListener('click', () => { toast('Refreshing…', 1500); refreshAll() })

const mint = () =>
  confirmAction('Mint HARD OTC Badge', [['You receive', '1 HARD OTC Badge (free)'], ['Cost', 'Network fee only (test XRD)']],
    'The badge is your identity on the desk. Keep it in your wallet.',
    () => account && send(M.mintRiderBadge(account), 'HARD OTC Badge minted'))
$('#ob-mint').addEventListener('click', mint)

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  if (!el) return

  if (el.dataset.accept && account && myRider()) {
    const o = offers.find((x) => x.id === el.dataset.accept)!
    if (o.allowPartial) return openBuy(o)
    const pay = Number(o.askRemaining)
    const have = balanceOf(o.askResource)
    if (have < pay) return toast(`You need ${nf(pay)} ${sym(o.askResource)}, you have ${nf(have)}.`)
    const fee = Number(o.sellRemaining) * feeRate(myLocked)
    confirmAction(`${kindOf(o) === 'buy' ? 'Sell into request' : 'Buy offer'} #${o.id}`, [
      ['You pay', `${nf(pay)} ${esc(symV(o.askResource))}`],
      ['You receive', `${nf(Number(o.sellRemaining) - fee)} ${esc(symV(o.sellResource))}`],
      ['Your trading fee', `${nf(fee)} ${esc(sym(o.sellResource))} (${(feeRate(myLocked) * 100).toFixed(2)}%)`],
      ['Counterparty', esc(repText(o.seller))],
    ], unverifiedNote(o.sellResource, o.askResource) + 'Settles in one atomic transaction: you pay and receive at the same moment.',
    () => send(M.acceptOffer(account!, myRider(), o.id, o.askResource, String(pay)), `Offer #${o.id} filled`))
  }

  if (el.dataset.cancel && account) {
    const o = offers.find((x) => x.id === el.dataset.cancel)!
    confirmAction(`Cancel offer #${o.id}`, [['You get back', `${nf(Number(o.sellRemaining))} ${esc(sym(o.sellResource))}`], ['Listing fee', 'not refunded']],
      'The offer is removed from the market and the remaining tokens return to your wallet.',
      () => send(M.cancelOffer(account!, o.seller, o.id), `Offer #${o.id} cancelled, tokens returned`))
  }

  if (el.dataset.promote && account && myRider()) {
    const o = offers.find((x) => x.id === el.dataset.promote)!
    const fee = desk.promotionFee
    if (balanceOf(CONFIG.hardResource) < fee) return toast(`Promotion costs ${nf(fee)} HARD, you have ${nf(balanceOf(CONFIG.hardResource))}.`)
    const from = Math.max(Date.now(), o.featuredUntil)
    confirmAction(`Promote offer #${o.id}`, [
      ['Cost', fee ? `${nf(fee)} HARD` : 'free'],
      ['★ Featured until', new Date(from + 86_400_000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })],
    ], 'Your offer is pinned at the top of the market with a ★ badge. The fee goes to the treasury and is not refunded.',
    () => send(M.promoteOffer(account!, myRider(), o.id, CONFIG.hardResource, String(fee)), `Offer #${o.id} promoted for 24h`))
  }

  if (el.dataset.unverify && isAdmin()) {
    const r = el.dataset.unverify
    adminSend('Remove verification', [['Token', esc(sym(r))]], 'The ✓ mark disappears from this token.',
      () => M.adminRemoveVerified(account!, desk.adminBadge, r), 'Verification removed')
  }

  if (el.dataset.withdraw && isAdmin()) {
    const res = el.dataset.withdraw
    const amt = treasuryAll.find((t) => t.address === res)?.amount ?? 0
    adminSend('Withdraw from treasury', [['You receive', `${nf(amt)} ${esc(sym(res))}`]],
      'Use it for HARD buyback or to add liquidity. Withdrawn HARD shows as “spent on buyback & liquidity”.',
      () => M.adminWithdrawTreasury(account!, desk.adminBadge, res), `${nf(amt)} ${sym(res)} withdrawn from treasury`)
  }

  if (el.id === 'withdraw-unlocked-btn' && account && myRider()) {
    confirmAction('Claim unlocked HARD', [['You receive', `${nf(myUnlock.amount)} HARD`]], '',
      () => send(M.withdrawUnlocked(account!, myRider()), 'HARD returned to your wallet'))
  }
})

$('#lock-btn').addEventListener('click', () => {
  if (!account || !myRider()) return toast('Connect your wallet and mint a HARD OTC Badge first.')
  const amount = Number($<HTMLInputElement>('#lock-amount').value)
  if (!(amount > 0)) return toast('Enter how much HARD to lock.')
  if (amount > balanceOf(CONFIG.hardResource)) return toast(`You only have ${nf(balanceOf(CONFIG.hardResource))} HARD.`)
  const after = myLocked + amount
  confirmAction('Lock HARD', [
    ['You lock', `${nf(amount)} HARD`],
    ['Locked after', `${nf(after)} HARD`],
    ['Your trading fee', `${(feeRate(myLocked) * 100).toFixed(2)}% → ${(feeRate(after) * 100).toFixed(2)}%`],
  ], desk.unlockPeriod ? `Unlocking later takes ${periodText(desk.unlockPeriod)}.` : '',
  () => send(M.lockHard(account!, myRider(), String(amount)), `${nf(amount)} HARD locked`))
})

$('#request-unlock-btn').addEventListener('click', () => {
  if (!account || !myRider()) return toast('Connect your wallet and mint a HARD OTC Badge first.')
  const amount = Number($<HTMLInputElement>('#unlock-amount').value)
  if (!(amount > 0)) return toast('Enter how much HARD to unlock.')
  if (amount > myLocked) return toast(`You only have ${nf(myLocked)} HARD locked.`)
  const after = myLocked - amount
  confirmAction('Request unlock', [
    ['Unlocking', `${nf(amount)} HARD`],
    ['Claimable in', periodText(desk.unlockPeriod)],
    ['Your trading fee', `${(feeRate(myLocked) * 100).toFixed(2)}% → ${(feeRate(after) * 100).toFixed(2)}%`],
  ], 'The discount drops right away. A new request restarts the waiting period for everything being unlocked.',
  () => send(M.requestUnlock(account!, myRider(), String(amount)), `Unlock of ${nf(amount)} HARD requested`))
})

// ---------- Buy (partial fills) ----------
const buyDlg = $<HTMLDialogElement>('#buy-dialog')
let buying: OfferView | null = null

function openBuy(o: OfferView) {
  buying = o
  const max = Math.min(Number(o.askRemaining), balanceOf(o.askResource))
  $('#buy-title').textContent = `${kindOf(o) === 'buy' ? 'Sell into request' : 'Buy from offer'} #${o.id}`
  $('#buy-sub').innerHTML = `Available: <b>${nf(Number(o.sellRemaining))} ${esc(symV(o.sellResource))}</b> for <b>${nf(Number(o.askRemaining))} ${esc(symV(o.askResource))}</b> · ${esc(repText(o.seller))}`
  $<HTMLInputElement>('#buy-amount').value = String(max > 0 ? +max.toFixed(6) : 0)
  $<HTMLInputElement>('#buy-range').value = String(Math.round((max / Number(o.askRemaining)) * 100))
  updateBuy()
  buyDlg.showModal()
}
function updateBuy() {
  const o = buying
  if (!o) return
  const pay = Number($<HTMLInputElement>('#buy-amount').value || 0)
  const askRem = Number(o.askRemaining)
  const gross = (Number(o.sellRemaining) * Math.min(pay, askRem)) / askRem
  const fee = gross * feeRate(myLocked)
  $('#buy-hint').textContent = `You have ${nf(balanceOf(o.askResource))} ${sym(o.askResource)} · ${Math.round((Math.min(pay, askRem) / askRem) * 100)}% of the offer`
  const warn = unverifiedNote(o.sellResource, o.askResource)
  $('#buy-summary').innerHTML = `
    <div class="sline"><span>You pay</span><b>${nf(Math.min(pay, askRem))} ${esc(symV(o.askResource))}</b></div>
    <div class="sline"><span>You receive</span><b>${nf(gross - fee)} ${esc(symV(o.sellResource))}</b></div>
    <div class="sline sub"><span>Your trading fee (${(feeRate(myLocked) * 100).toFixed(2)}%)</span><b>${nf(fee)} ${esc(sym(o.sellResource))}</b></div>
    ${warn ? `<p class="snote">${warn}</p>` : ''}`
  let err = ''
  if (!(pay > 0)) err = 'Enter how much you want to pay.'
  else if (pay > balanceOf(o.askResource)) err = `You only have ${nf(balanceOf(o.askResource))} ${sym(o.askResource)}.`
  $('#buy-error').textContent = err
  $<HTMLButtonElement>('#buy-ok').disabled = !!err
}
$('#buy-amount').addEventListener('input', () => {
  if (!buying) return
  $<HTMLInputElement>('#buy-range').value = String(Math.round((Number($<HTMLInputElement>('#buy-amount').value || 0) / Number(buying.askRemaining)) * 100))
  updateBuy()
})
$('#buy-range').addEventListener('input', () => {
  if (!buying) return
  const v = (Number($<HTMLInputElement>('#buy-range').value) / 100) * Number(buying.askRemaining)
  $<HTMLInputElement>('#buy-amount').value = String(+v.toFixed(6))
  updateBuy()
})
$('#buy-max').addEventListener('click', () => {
  if (!buying) return
  $<HTMLInputElement>('#buy-amount').value = String(+Math.min(Number(buying.askRemaining), balanceOf(buying.askResource)).toFixed(6))
  $<HTMLInputElement>('#buy-range').value = '100'
  updateBuy()
})
$('#buy-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const o = buying
  if (!o || !account || !myRider()) return
  const pay = Math.min(Number($<HTMLInputElement>('#buy-amount').value || 0), Number(o.askRemaining))
  if (!(pay > 0) || pay > balanceOf(o.askResource)) return
  buyDlg.close()
  send(M.acceptOffer(account, myRider(), o.id, o.askResource, String(pay)), `Filled ${nf(pay)} ${sym(o.askResource)} of offer #${o.id}`)
})

// ---------- Create offer ----------
const createDlg = $<HTMLDialogElement>('#create-dialog')
const form = $<HTMLFormElement>('#create-form')
const mode = () => (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as 'sell' | 'buy'
const walletTokens = () => balances.filter((b) => b.address !== desk.adminBadge && b.address !== CONFIG.riderBadgeResource).map((b) => b.address)
const anyTokens = () => [...new Set([XRD, CONFIG.hardResource, ...desk.verified, ...walletTokens()])].filter(Boolean)

function fillSelect(sel: HTMLSelectElement, list: string[], prefer: string, withCustom: boolean) {
  const prev = sel.value
  sel.innerHTML = (list.length ? list.map((a) => `<option value="${esc(a)}">${esc(symV(a))}</option>`).join('') : '<option value="">No tokens in wallet</option>') +
    (withCustom ? '<option value="custom">Other token…</option>' : '')
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev
  else if ([...sel.options].some((o) => o.value === prefer)) sel.value = prefer
}
function fillTokenSelects() {
  const sell = mode() === 'sell'
  // leg 1 = sell mode: what you sell (from wallet) | buy mode: what you want to buy (any token)
  fillSelect($<HTMLSelectElement>('#token1'), sell ? walletTokens() : anyTokens(), CONFIG.hardResource, !sell)
  // leg 2 = sell mode: what you want (any token) | buy mode: what you pay (from wallet)
  fillSelect($<HTMLSelectElement>('#token2'), sell ? anyTokens() : walletTokens(), XRD, sell)
  $('#leg1-title').textContent = sell ? 'You sell' : 'You want to buy'
  $('#leg2-title').textContent = sell ? 'You want in total' : 'You pay in total (locked in escrow)'
}

function readForm() {
  const f = new FormData(form)
  const t = (n: 1 | 2) => (f.get(`token${n}`) === 'custom' ? String(f.get(`custom${n}`) || '').trim() : String(f.get(`token${n}`) || ''))
  const a1 = Number(f.get('amount1') || 0)
  const a2 = Number(f.get('amount2') || 0)
  const sellMode = mode() === 'sell'
  return {
    sell: sellMode ? t(1) : t(2),
    sellAmount: sellMode ? a1 : a2,
    ask: sellMode ? t(2) : t(1),
    askAmount: sellMode ? a2 : a1,
    expiry: Number(f.get('expiry') || 72) as 1 | 6 | 72,
    reserved: (() => {
      const raw = String(f.get('reserved') || '').trim().replace(/^#|#$/g, '')
      return raw ? (/^\d+$/.test(raw) ? `#${raw}#` : raw) : ''
    })(),
    partial: f.get('partial') === 'on',
  }
}

const resFee = (v: { reserved: string }) => (v.reserved && desk.v3 ? desk.reservationFee : 0)
const totalFees = (v: { reserved: string }) => desk.listingFee + resFee(v)

function validate(v: ReturnType<typeof readForm>): string {
  const hard = balanceOf(CONFIG.hardResource)
  if (!v.sell.startsWith('resource_')) return mode() === 'sell' ? 'Choose the token you sell.' : 'Choose the token you pay with.'
  if (!v.ask.startsWith('resource_')) return mode() === 'sell' ? 'Choose the token you want.' : 'Choose the token you want to buy.'
  if (v.ask === v.sell) return 'The two tokens must be different.'
  if (!(v.sellAmount > 0) || !(v.askAmount > 0)) return 'Enter both amounts.'
  if (v.sellAmount > balanceOf(v.sell)) return `You only have ${nf(balanceOf(v.sell))} ${sym(v.sell)}.`
  const fees = totalFees(v)
  const needHard = fees + (v.sell === CONFIG.hardResource ? v.sellAmount : 0)
  if (fees && hard < needHard) return `You need ${nf(needHard)} HARD (fees${v.sell === CONFIG.hardResource ? ' + amount locked' : ''}), you have ${nf(hard)}.`
  if (v.reserved && (!desk.tiers.length || myLocked < desk.tiers[0].threshold)) return `Reserved offers need at least ${nf(desk.tiers[0]?.threshold ?? 1000)} HARD locked.`
  return ''
}

function updateCreateSummary() {
  const v = readForm()
  $('#custom1').hidden = $<HTMLSelectElement>('#token1').value !== 'custom'
  $('#custom2').hidden = $<HTMLSelectElement>('#token2').value !== 'custom'
  const sellMode = mode() === 'sell'
  const t1 = sellMode ? v.sell : v.ask
  const t2 = sellMode ? v.ask : v.sell
  const ok = (a: string) => a.startsWith('resource_')
  $('#hint1').textContent = ok(t1) ? (sellMode ? `Balance: ${nf(balanceOf(t1))} ${sym(t1)}` : (isVerified(t1) ? '✓ Verified token' : '⚠ Unverified token: check the address')) : ''
  const priceHint = v.sellAmount > 0 && v.askAmount > 0 && ok(v.sell) && ok(v.ask)
    ? (sellMode ? `= ${nf(v.askAmount / v.sellAmount, 6)} ${sym(v.ask)} per ${sym(v.sell)}` : `= ${nf(v.sellAmount / v.askAmount, 6)} ${sym(v.sell)} per ${sym(v.ask)}`)
    : ''
  $('#hint2').textContent = [priceHint, !sellMode && ok(t2) ? `Balance: ${nf(balanceOf(t2))} ${sym(t2)}` : ''].filter(Boolean).join(' · ')
  const myFee = v.askAmount * feeRate(myLocked)
  $('#create-summary').innerHTML = `
    <div class="sline"><span>Locked in escrow now</span><b>${v.sellAmount ? nf(v.sellAmount) : '–'} ${ok(v.sell) ? esc(symV(v.sell)) : ''}</b></div>
    <div class="sline"><span>Listing fee (non-refundable)</span><b>${desk.listingFee ? nf(desk.listingFee) + ' HARD' : 'Free'}</b></div>
    ${v.reserved ? `<div class="sline"><span>Reservation fee (non-refundable)</span><b>${resFee(v) ? nf(resFee(v)) + ' HARD' : 'Free'}</b></div>` : ''}
    <div class="sline"><span>When completed, you receive</span><b>${v.askAmount ? nf(v.askAmount - myFee) : '–'} ${ok(v.ask) ? esc(symV(v.ask)) : ''}</b></div>
    <div class="sline sub"><span>Your trading fee (${(feeRate(myLocked) * 100).toFixed(2)}%)</span><b>${v.askAmount ? nf(myFee) : '–'}</b></div>
    <div class="sline sub"><span>Partial fills</span><b>${v.partial ? 'allowed' : 'all at once only'}</b></div>`
  const err = validate(v)
  $('#create-error').textContent = (v.sellAmount || v.askAmount) ? err : ''
  $<HTMLButtonElement>('#submit-offer').disabled = !!err
  const canReserve = desk.tiers.length > 0 && myLocked >= desk.tiers[0].threshold
  $<HTMLInputElement>('#reserved').disabled = !canReserve
}

$('#open-create').addEventListener('click', () => {
  fillTokenSelects()
  updateCreateSummary()
  createDlg.showModal()
})
document.querySelectorAll('input[name=mode]').forEach((i) =>
  i.addEventListener('change', () => {
    $<HTMLInputElement>('#amount1').value = ''
    $<HTMLInputElement>('#amount2').value = ''
    $<HTMLSelectElement>('#token1').innerHTML = ''
    $<HTMLSelectElement>('#token2').innerHTML = ''
    fillTokenSelects()
    updateCreateSummary()
  }),
)
form.addEventListener('input', updateCreateSummary)
form.addEventListener('change', updateCreateSummary)
form.addEventListener('submit', (e) => {
  e.preventDefault()
  const v = readForm()
  const err = validate(v)
  if (err || !account || !myRider()) return ($('#create-error').textContent = err)
  createDlg.close()
  send(
    M.createOffer({
      account, riderId: myRider(),
      sellResource: v.sell, sellAmount: String(v.sellAmount),
      askResource: v.ask, askAmount: String(v.askAmount),
      expiryHours: v.expiry,
      reservedBuyer: v.reserved || undefined,
      listingFee: totalFees(v) > 0 ? String(totalFees(v)) : undefined,
      v2: desk.v2,
      v3: desk.v3,
      allowPartial: v.partial,
    }),
    mode() === 'sell' ? 'Sell offer created. Your tokens are in escrow.' : 'Buy request created. Your payment is in escrow.',
  )
})

// ---------- Toast ----------
let toastTimer: number | undefined
function toast(msg: string, ms = 6000, link?: string) {
  const t = $('#toast')
  t.innerHTML = esc(msg) + (link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">View transaction ↗</a>` : '')
  t.hidden = false
  clearTimeout(toastTimer)
  if (ms) toastTimer = window.setTimeout(() => (t.hidden = true), ms)
}

// ---------- Start ----------
window.addEventListener('hashchange', () => location.reload())

async function init() {
  if (CONFIG.oldDesk) {
    $('#legacy-bar').hidden = false
    $('#desk-switch').textContent = '← Back to the current desk'
    $('#desk-switch').setAttribute('href', '#')
  }
  await refreshAll()
  setInterval(refreshAll, 20_000)
}
init()
