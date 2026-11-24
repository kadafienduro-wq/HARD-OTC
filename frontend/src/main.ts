import { RadixDappToolkit, RadixNetwork, DataRequestBuilder } from '@radixdlt/radix-dapp-toolkit'
import { CONFIG } from './config'
import * as M from './manifests'
import {
  desk, getBalances, getLocked, getUnlock, getOffers, getRiderBadges, getTokens, getTreasuryBalance, getVaultAmount,
  loadDeskInfo, multiplierFor, short, tokenInfo, type OfferView,
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
let loaded = false

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T
const myRider = () => riderIds[0]
const balanceOf = (addr: string) => Number(balances.find((b) => b.address === addr)?.amount ?? 0)

// ---------- Formatting ----------
const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const nf = (n: number, d = 4) => n.toLocaleString('en-US', { maximumFractionDigits: d })
const pct = (m: number) => `${Math.round((1 - m) * 100)}%`
const feeRate = (locked: number) => desk.feePerSide * multiplierFor(locked)
const sym = (addr: string) => tokenInfo(addr).symbol

function icon(addr: string) {
  const t = tokenInfo(addr)
  const letter = esc(t.symbol.slice(0, 1).toUpperCase())
  return t.icon
    ? `<img class="ico" src="${esc(t.icon)}" alt="" loading="lazy" data-letter="${letter}">`
    : `<span class="ico ph">${letter}</span>`
}
/** Token icon + amount + symbol, with name and address in small print. */
function tok(addr: string, amount?: number) {
  const t = tokenInfo(addr)
  const sub = `${t.name && t.name !== t.symbol ? esc(t.name) + ' · ' : ''}${esc(short(addr))}`
  return `<span class="tok">${icon(addr)}<span><b>${amount !== undefined ? nf(amount) + ' ' : ''}${esc(t.symbol)}</b><small title="${esc(addr)}">${sub}</small></span></span>`
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
// Broken token icons fall back to a letter badge
document.addEventListener('error', (e) => {
  const img = e.target as HTMLImageElement
  if (img.tagName === 'IMG' && img.classList.contains('ico')) {
    const span = document.createElement('span')
    span.className = 'ico ph'
    span.textContent = img.dataset.letter ?? '?'
    img.replaceWith(span)
  }
}, true)

// ---------- Radix dApp Toolkit ----------
const rdt = RadixDappToolkit({
  dAppDefinitionAddress: CONFIG.dAppDefinitionAddress,
  networkId: RadixNetwork.Stokenet,
  applicationName: 'HARD ADV OTC Desk',
  applicationVersion: '0.2.0',
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
    await getTokens([
      ...offers.flatMap((o) => [o.sellResource, o.askResource]),
      ...balances.map((b) => b.address),
      ...CONFIG.knownResources.map((r) => r.address),
      CONFIG.hardResource,
      ...desk.feesCollected.map((f) => f.address),
    ])
    treasuryAll = await Promise.all(
      desk.feesCollected.map(async (f) => ({ address: f.address, amount: await getTreasuryBalance(f.address).catch(() => 0) })),
    )
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
  $('#me-badge').textContent = myRider() ? `${myRider().slice(0, 7)}…${myRider().slice(-5)}` : 'not minted'
  $('#me-hard').textContent = nf(balanceOf(CONFIG.hardResource), 2)
  $('#me-locked').textContent = nf(myLocked, 2)
  $('#me-fee').textContent = `${(feeRate(myLocked) * 100).toFixed(2)}%`
}

function renderMarket() {
  if (!loaded) return
  const open = offers.filter((o) => o.status === 'Open' && o.expiresAt > Date.now())
  const myRate = feeRate(myLocked)
  $('#market-body').innerHTML = open.length
    ? open.map((o) => {
        const mine = riderIds.includes(o.seller)
        const reservedForOther = !!o.reservedBuyer && !riderIds.includes(o.reservedBuyer)
        const get = mine ? Number(o.sellAmount) : Number(o.sellAmount) * (1 - myRate)
        let action: string
        if (mine) action = '<span class="pill">Your offer</span>'
        else if (reservedForOther) action = '<span class="pill">🔒 Reserved</span>'
        else if (!account) action = '<button disabled title="Connect your wallet">Buy</button>'
        else if (!myRider()) action = '<button disabled title="Mint your Rider Badge first">Buy</button>'
        else if (desk.paused) action = '<button disabled title="Desk is paused">Paused</button>'
        else action = `<button class="primary" data-accept="${o.id}">Buy</button>`
        return `<tr>
          <td class="n">#${o.id}${o.reservedBuyer && !reservedForOther && !mine ? '<br><small class="red">reserved for you</small>' : ''}</td>
          <td>${tok(o.sellResource, get)}</td>
          <td>${tok(o.askResource, Number(o.askAmount))}</td>
          <td class="n">${timeLeft(o.expiresAt)}</td>
          <td>${action}</td>
        </tr>`
      }).join('')
    : `<tr><td colspan="5" class="empty">No open offers yet.${myRider() ? ' Be the first: click “+ Create offer”.' : ''}</td></tr>`
  $<HTMLButtonElement>('#open-create').disabled = !myRider() || desk.paused
  $('#open-create').title = myRider() ? '' : 'Connect your wallet and mint a Rider Badge first'
}

function renderMine() {
  const mine = offers.filter((o) => riderIds.includes(o.seller)).sort((a, b) => Number(b.id) - Number(a.id))
  const myRate = feeRate(myLocked)
  $('#mine-body').innerHTML = mine.length
    ? mine.map((o) => {
        const expired = o.status === 'Open' && o.expiresAt <= Date.now()
        const status =
          o.status === 'Filled' ? '<span class="pill ok">Sold</span>'
          : o.status === 'Cancelled' ? '<span class="pill">Cancelled</span>'
          : expired ? '<span class="pill bad">Expired</span>'
          : `<span class="pill live">Open · ${timeLeft(o.expiresAt)}</span>`
        return `<tr>
          <td class="n">#${o.id}</td>
          <td>${tok(o.sellResource, Number(o.sellAmount))}</td>
          <td>${tok(o.askResource, Number(o.askAmount) * (1 - myRate))}</td>
          <td>${status}</td>
          <td>${o.status === 'Open' ? `<button data-cancel="${o.id}">${expired ? 'Reclaim tokens' : 'Cancel offer'}</button>` : ''}</td>
        </tr>`
      }).join('')
    : `<tr><td colspan="5" class="empty">${account ? 'You have no offers on this desk.' : 'Connect your wallet to see your offers.'}</td></tr>`
}

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

function renderTreasury() {
  const spent = Number(desk.treasuryWithdrawn.find((w) => w.address === CONFIG.hardResource)?.amount ?? 0)
  $('#bb-listing').textContent = `${nf(desk.listingFeesHard, 2)} HARD`
  $('#bb-ready').textContent = `${nf(treasuryHard, 2)} HARD`
  $('#bb-spent').textContent = `${nf(spent, 2)} HARD`
  $('#burned').textContent = `${nf(burned)} HARD`
  $('#listing-fee').textContent = desk.listingFee ? `${nf(desk.listingFee)} HARD` : 'Free'
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
  $('#adm-unlock-now').textContent = periodText(desk.unlockPeriod)
  $('#adm-burn-now').textContent = desk.burnShare > 0 ? `${Math.round(desk.burnShare * 100)}%` : 'off'
  $('#adm-status').textContent = desk.paused ? 'PAUSED' : 'Live'
  $('#adm-status').className = desk.paused ? 'red' : ''
  $('#adm-pause-btn').textContent = desk.paused ? 'Resume desk' : 'Pause desk'
  document.querySelectorAll<HTMLButtonElement>('[data-unlock]').forEach((b) => b.classList.toggle('on', Number(b.dataset.unlock) === desk.unlockPeriod))
  $('#adm-treasury-body').innerHTML = treasuryAll.length
    ? treasuryAll.map((t) => `<tr><td>${tok(t.address)}</td><td class="num">${nf(t.amount)}</td>
        <td>${t.amount > 0 ? `<button data-withdraw="${esc(t.address)}">Withdraw all</button>` : '<span class="muted">empty</span>'}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">Treasury is empty.</td></tr>'
}

const adminSend = (title: string, lines: [string, string][], note: string, manifest: () => string, ok: string) =>
  confirmAction(title, lines, note, () => send(manifest(), ok))

$('#adm-fee-btn').addEventListener('click', () => {
  const v = Number($<HTMLInputElement>('#adm-fee').value)
  if (!(v >= 0 && v <= 100) || $<HTMLInputElement>('#adm-fee').value === '') return toast('Listing fee must be between 0 and 100 HARD.')
  adminSend('Change listing fee', [['Now', desk.listingFee ? `${nf(desk.listingFee)} HARD` : 'free'], ['New', v ? `${nf(v)} HARD` : 'free']], 'Applies to new offers only.',
    () => M.adminSetListingFee(account!, desk.adminBadge, String(v)), `Listing fee set to ${nf(v)} HARD`)
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
document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-withdraw]') as HTMLElement | null
  if (!b || !isAdmin()) return
  const res = b.dataset.withdraw!
  const amt = treasuryAll.find((t) => t.address === res)?.amount ?? 0
  adminSend('Withdraw from treasury', [['You receive', `${nf(amt)} ${esc(sym(res))}`]],
    'Use it for HARD buyback or to add liquidity. Withdrawn HARD shows as “spent on buyback & liquidity”.',
    () => M.adminWithdrawTreasury(account!, desk.adminBadge, res), `${nf(amt)} ${sym(res)} withdrawn from treasury`)
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
  confirmAction('Mint Rider Badge', [['You receive', '1 Rider Badge (free)'], ['Cost', 'Network fee only (test XRD)']],
    'The badge is your identity on the desk. Keep it in your wallet.',
    () => account && send(M.mintRiderBadge(account), 'Rider Badge minted'))
$('#ob-mint').addEventListener('click', mint)

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  if (!el) return

  if (el.dataset.accept && account && myRider()) {
    const o = offers.find((x) => x.id === el.dataset.accept)!
    const fee = Number(o.sellAmount) * feeRate(myLocked)
    const have = balanceOf(o.askResource)
    const lines: [string, string][] = [
      ['You pay', `${nf(Number(o.askAmount))} ${esc(sym(o.askResource))}`],
      ['You receive', `${nf(Number(o.sellAmount) - fee)} ${esc(sym(o.sellResource))}`],
      ['Your trading fee', `${nf(fee)} ${esc(sym(o.sellResource))} (${(feeRate(myLocked) * 100).toFixed(2)}%)`],
    ]
    if (have < Number(o.askAmount)) return toast(`You need ${nf(Number(o.askAmount))} ${sym(o.askResource)}, you have ${nf(have)}.`)
    confirmAction(`Buy offer #${o.id}`, lines, 'Settles in one atomic transaction: you pay and receive at the same moment.',
      () => send(M.acceptOffer(account!, myRider(), o.id, o.askResource, o.askAmount), `Offer #${o.id} bought`))
  }

  if (el.dataset.cancel && account) {
    const o = offers.find((x) => x.id === el.dataset.cancel)!
    confirmAction(`Cancel offer #${o.id}`, [['You get back', `${nf(Number(o.sellAmount))} ${esc(sym(o.sellResource))}`], ['Listing fee', 'not refunded']],
      'The offer is removed from the market and the tokens return to your wallet.',
      () => send(M.cancelOffer(account!, o.seller, o.id), `Offer #${o.id} cancelled, tokens returned`))
  }

  if (el.id === 'withdraw-unlocked-btn' && account && myRider()) {
    confirmAction('Claim unlocked HARD', [['You receive', `${nf(myUnlock.amount)} HARD`]], '',
      () => send(M.withdrawUnlocked(account!, myRider()), 'HARD returned to your wallet'))
  }
})

$('#lock-btn').addEventListener('click', () => {
  if (!account || !myRider()) return toast('Connect your wallet and mint a Rider Badge first.')
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
  if (!account || !myRider()) return toast('Connect your wallet and mint a Rider Badge first.')
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

// ---------- Create offer ----------
const createDlg = $<HTMLDialogElement>('#create-dialog')
const form = $<HTMLFormElement>('#create-form')

function fillTokenSelects() {
  const sellSel = $<HTMLSelectElement>('#sell')
  const askSel = $<HTMLSelectElement>('#ask')
  const prevSell = sellSel.value
  const prevAsk = askSel.value
  const sellable = balances.filter((b) => b.address !== desk.adminBadge && b.address !== CONFIG.riderBadgeResource)
  sellSel.innerHTML = sellable.length
    ? sellable.map((b) => `<option value="${esc(b.address)}">${esc(sym(b.address))}</option>`).join('')
    : '<option value="">No tokens in wallet</option>'
  const askList = [...new Set([...CONFIG.knownResources.map((r) => r.address), CONFIG.hardResource, ...sellable.map((b) => b.address)])].filter(Boolean)
  askSel.innerHTML = askList.map((a) => `<option value="${esc(a)}">${esc(sym(a))}</option>`).join('') + '<option value="custom">Other token…</option>'
  if ([...sellSel.options].some((o) => o.value === prevSell)) sellSel.value = prevSell
  else if ([...sellSel.options].some((o) => o.value === CONFIG.hardResource)) sellSel.value = CONFIG.hardResource
  if ([...askSel.options].some((o) => o.value === prevAsk)) askSel.value = prevAsk
}

function readForm() {
  const f = new FormData(form)
  const ask = String(f.get('ask'))
  return {
    sell: String(f.get('sell') || ''),
    sellAmount: Number(f.get('sellAmount') || 0),
    ask: ask === 'custom' ? String(f.get('askCustom') || '').trim() : ask,
    askAmount: Number(f.get('askAmount') || 0),
    expiry: Number(f.get('expiry') || 72) as 1 | 6 | 72,
    reserved: String(f.get('reserved') || '').trim(),
  }
}

function validate(v: ReturnType<typeof readForm>): string {
  const hard = balanceOf(CONFIG.hardResource)
  if (!v.sell) return 'Choose the token you sell.'
  if (!(v.sellAmount > 0)) return 'Enter the amount you sell.'
  if (v.sellAmount > balanceOf(v.sell)) return `You only have ${nf(balanceOf(v.sell))} ${sym(v.sell)}.`
  if (!v.ask || !v.ask.startsWith('resource_')) return 'Choose the token you want.'
  if (v.ask === v.sell) return 'You must want a different token than the one you sell.'
  if (!(v.askAmount > 0)) return 'Enter your price.'
  const needHard = desk.listingFee + (v.sell === CONFIG.hardResource ? v.sellAmount : 0)
  if (desk.listingFee && hard < needHard) return `You need ${nf(needHard)} HARD (listing fee${v.sell === CONFIG.hardResource ? ' + amount sold' : ''}), you have ${nf(hard)}.`
  if (v.reserved && (!desk.tiers.length || myLocked < desk.tiers[0].threshold)) return `Reserved offers need at least ${nf(desk.tiers[0]?.threshold ?? 1000)} HARD locked.`
  return ''
}

function updateCreateSummary() {
  const v = readForm()
  $('#ask-custom').hidden = $<HTMLSelectElement>('#ask').value !== 'custom'
  $('#sell-hint').textContent = v.sell ? `Balance: ${nf(balanceOf(v.sell))} ${sym(v.sell)}` : ''
  $('#ask-hint').textContent = v.sellAmount > 0 && v.askAmount > 0 && v.ask.startsWith('resource_')
    ? `= ${nf(v.askAmount / v.sellAmount, 6)} ${sym(v.ask)} per ${sym(v.sell)}` : ''
  const myFee = v.askAmount * feeRate(myLocked)
  $('#create-summary').innerHTML = `
    <div class="sline"><span>Locked in escrow now</span><b>${v.sellAmount ? nf(v.sellAmount) : '–'} ${v.sell ? esc(sym(v.sell)) : ''}</b></div>
    <div class="sline"><span>Listing fee (non-refundable)</span><b>${desk.listingFee ? nf(desk.listingFee) + ' HARD' : 'Free'}</b></div>
    <div class="sline"><span>When sold, you receive</span><b>${v.askAmount ? nf(v.askAmount - myFee) : '–'} ${v.ask.startsWith('resource_') ? esc(sym(v.ask)) : ''}</b></div>
    <div class="sline sub"><span>Your trading fee (${(feeRate(myLocked) * 100).toFixed(2)}%)</span><b>${v.askAmount ? nf(myFee) : '–'}</b></div>`
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
      listingFee: desk.listingFee > 0 ? String(desk.listingFee) : undefined,
      v2: desk.v2,
    }),
    'Offer created. Your tokens are in escrow.',
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
