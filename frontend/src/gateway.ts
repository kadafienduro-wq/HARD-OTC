import { CONFIG } from './config'

async function post<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${CONFIG.gatewayUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Gateway ${path}: ${res.status}`)
  return res.json()
}

const toMs = (v: any) => (v == null ? 0 : Number(typeof v === 'object' ? v.seconds_since_unix_epoch : v) * 1000)

/** Zamienia programmatic JSON (SBOR) na zwykły obiekt JS. */
export function decode(v: any): any {
  if (v == null) return v
  switch (v.kind) {
    case 'Tuple': {
      const named = v.fields.every((f: any) => f.field_name)
      if (!named) return v.fields.map(decode)
      return Object.fromEntries(v.fields.map((f: any) => [f.field_name, decode(f)]))
    }
    case 'Enum':
      return { variant: v.variant_name ?? String(v.variant_id), fields: (v.fields ?? []).map(decode) }
    case 'Array':
      return (v.elements ?? []).map(decode)
    case 'Map':
      return (v.entries ?? []).map((e: any) => [decode(e.key), decode(e.value)])
    default:
      return v.value
  }
}

export type OfferView = {
  id: string
  seller: string
  sellerAccount: string
  sellResource: string
  sellAmount: string
  askResource: string
  askAmount: string
  sellRemaining: string
  askRemaining: string
  allowPartial: boolean
  featuredUntil: number
  expiresAt: number
  reservedBuyer: string | null
  status: 'Open' | 'Filled' | 'Cancelled'
}

export async function getRiderBadges(account: string): Promise<string[]> {
  const r = await post('/state/entity/details', {
    addresses: [account],
    aggregation_level: 'Vault',
    opt_ins: { non_fungible_include_nfids: true },
  })
  const nfts = r.items?.[0]?.non_fungible_resources?.items ?? []
  const rider = nfts.find((n: any) => n.resource_address === CONFIG.riderBadgeResource)
  if (!rider) return []
  return rider.vaults.items.flatMap((v: any) => v.items ?? [])
}

/** Odczytuje z desku adresy Rider Badge i HARD, żeby nie trzeba ich było wpisywać ręcznie. */
export type DeskInfo = {
  tiers: { threshold: number; multiplier: number }[]
  feePerSide: number
  burnShare: number
  listingFee: number
  v2: boolean
  feesCollected: { address: string; amount: string }[]
  burnedVault: string
  hardLocksKvs: string
  unlockingKvs: string
  unlockReadyKvs: string
  unlockPeriod: number
  listingFeesHard: number
  treasuryWithdrawn: { address: string; amount: string }[]
  treasuryKvs: string
  adminBadge: string
  paused: boolean
  verified: string[]
  promotionFee: number
  promotionFeesHard: number
  reservationFee: number
  reservationFeesHard: number
  riderStatsKvs: string
  v3: boolean
  lsuEnabled: boolean
  lsuPayout: number
  hardPrice: number
  hardPriceUpdatedAt: number
  lsuMaxPerTx: number
  buybackVault: string
  lsuRequestsKvs: string
  lsuVaultsKvs: string
  nextLsuId: number
  lsuBought: { address: string; amount: string }[]
  lsuHardPaid: number
  poolEnabled: boolean
  poolShare: string
  poolOutstanding: number
  poolPlatformShare: number
  poolProfitTotal: number
  buybackXrdVault: string
  lsuXrdShare: number
  lsuXrdPaid: number
  lsuMaxValuePerTx: number
  lsuDailyLimit: number
  lsuDayStart: number
  lsuDayUsed: number
  version: number
}
export let desk: DeskInfo = { tiers: [], feePerSide: 0.0075, burnShare: 0, listingFee: 0, v2: false, feesCollected: [], burnedVault: '', hardLocksKvs: '', unlockingKvs: '', unlockReadyKvs: '', unlockPeriod: 0, listingFeesHard: 0, treasuryWithdrawn: [], treasuryKvs: '', adminBadge: '', paused: false, verified: [], promotionFee: 0, promotionFeesHard: 0, reservationFee: 0, reservationFeesHard: 0, riderStatsKvs: '', v3: false, lsuEnabled: false, lsuPayout: 0, hardPrice: 0, hardPriceUpdatedAt: 0, lsuMaxPerTx: 0, buybackVault: '', lsuRequestsKvs: '', lsuVaultsKvs: '', nextLsuId: 1, lsuBought: [], lsuHardPaid: 0, poolEnabled: false, poolShare: '', poolOutstanding: 0, poolPlatformShare: 0, poolProfitTotal: 0, buybackXrdVault: '', lsuXrdShare: 0, lsuXrdPaid: 0, lsuMaxValuePerTx: 0, lsuDailyLimit: 0, lsuDayStart: 0, lsuDayUsed: 0, version: 0 }

export async function loadDeskInfo() {
  const r = await post('/state/entity/details', { addresses: [CONFIG.deskComponent] })
  const state = decode(r.items[0].details.state)
  CONFIG.riderBadgeResource = state.rider_badge
  CONFIG.hardResource = state.hard_resource
  desk = {
    tiers: (state.discount_tiers ?? []).map((t: any) => ({ threshold: Number(t[0]), multiplier: Number(t[1]) })),
    feePerSide: Number(state.fee_rate_per_side ?? 0.0075),
    burnShare: Number(state.hard_burn_share ?? 0),
    listingFee: Number(state.listing_fee_hard ?? 0),
    v2: state.listing_fee_hard !== undefined,
    feesCollected: (state.fees_collected ?? []).map((e: any) => ({ address: e[0], amount: String(e[1]) })),
    burnedVault: state.burned_hard ?? '',
    hardLocksKvs: state.hard_locks ?? '',
    unlockingKvs: state.unlocking ?? '',
    unlockReadyKvs: state.unlock_ready_at ?? '',
    unlockPeriod: Number(state.unlock_period_seconds ?? 0),
    listingFeesHard: Number(state.listing_fees_hard ?? 0),
    treasuryWithdrawn: (state.treasury_withdrawn ?? []).map((e: any) => ({ address: e[0], amount: String(e[1]) })),
    treasuryKvs: state.treasury ?? state.fees ?? '',
    adminBadge: state.admin_badge ?? '',
    paused: state.paused === true,
    verified: state.verified ?? [],
    promotionFee: Number(state.promotion_fee_hard ?? 0),
    promotionFeesHard: Number(state.promotion_fees_hard ?? 0),
    reservationFee: Number(state.reservation_fee_hard ?? 0),
    reservationFeesHard: Number(state.reservation_fees_hard ?? 0),
    riderStatsKvs: state.rider_stats ?? '',
    v3: state.promotion_fee_hard !== undefined,
    lsuEnabled: state.lsu_buyback_enabled === true,
    lsuPayout: Number(state.lsu_payout ?? 0),
    hardPrice: Number(state.hard_price_xrd ?? 0),
    hardPriceUpdatedAt: toMs(state.hard_price_updated_at),
    lsuMaxPerTx: Number(state.lsu_max_hard_per_tx ?? 0),
    buybackVault: state.buyback_hard ?? '',
    lsuRequestsKvs: state.lsu_requests ?? '',
    lsuVaultsKvs: state.lsu_vaults ?? '',
    nextLsuId: Number(state.next_lsu_request_id ?? 1),
    lsuBought: (state.lsu_bought ?? []).map((e: any) => ({ address: e[0], amount: String(e[1]) })),
    lsuHardPaid: Number(state.lsu_hard_paid ?? 0),
    poolEnabled: state.pool_enabled === true,
    poolShare: state.pool_share ?? '',
    poolOutstanding: Number(state.pool_outstanding_cost ?? 0),
    poolPlatformShare: Number(state.pool_platform_share ?? 0),
    poolProfitTotal: Number(state.pool_profit_total ?? 0),
    buybackXrdVault: state.buyback_xrd ?? '',
    lsuXrdShare: Number(state.lsu_xrd_share ?? 0),
    lsuXrdPaid: Number(state.lsu_xrd_paid ?? 0),
    lsuMaxValuePerTx: Number(state.lsu_max_value_per_tx ?? 0),
    lsuDailyLimit: Number(state.lsu_daily_limit ?? 0),
    lsuDayStart: Number(state.lsu_day_start ?? 0) * 1000,
    lsuDayUsed: Number(state.lsu_day_used ?? 0),
    version: Number(state.version ?? 4),
  }
  // Stary desk (v1) miał jeden próg
  if (!desk.tiers.length && state.hard_discount_threshold) {
    desk.tiers = [{ threshold: Number(state.hard_discount_threshold), multiplier: Number(state.discount_multiplier) }]
  }
}

export async function getVaultAmount(vault: string): Promise<number> {
  if (!vault) return 0
  const r = await post('/state/entity/details', { addresses: [vault] })
  return Number(r.items?.[0]?.details?.balance?.amount ?? 0)
}

/** Ile HARD ma zablokowane dany rider. */
export async function getLocked(riderId: string): Promise<number> {
  if (!desk.hardLocksKvs || !riderId) return 0
  const data = await post('/state/key-value-store/data', {
    key_value_store_address: desk.hardLocksKvs,
    keys: [{ key_json: { kind: 'NonFungibleLocalId', value: riderId } }],
  })
  const vault = data.entries?.[0]?.value?.programmatic_json?.value
  return vault ? getVaultAmount(vault) : 0
}

/** HARD w trakcie wypłaty i od kiedy można je odebrać (ms). */
export async function getUnlock(riderId: string): Promise<{ amount: number; readyAt: number }> {
  if (!desk.unlockingKvs || !riderId) return { amount: 0, readyAt: 0 }
  const key = [{ key_json: { kind: 'NonFungibleLocalId', value: riderId } }]
  const [u, t] = await Promise.all([
    post('/state/key-value-store/data', { key_value_store_address: desk.unlockingKvs, keys: key }),
    post('/state/key-value-store/data', { key_value_store_address: desk.unlockReadyKvs, keys: key }),
  ])
  const vault = u.entries?.[0]?.value?.programmatic_json?.value
  const ready = decode(t.entries?.[0]?.value?.programmatic_json)
  const sec = ready == null ? 0 : typeof ready === 'object' ? Number(ready.seconds_since_unix_epoch) : Number(ready)
  return { amount: vault ? await getVaultAmount(vault) : 0, readyAt: sec * 1000 }
}

/** Ile danego tokena jest teraz w skarbcu. */
export async function getTreasuryBalance(resource: string): Promise<number> {
  if (!desk.treasuryKvs || !resource) return 0
  const data = await post('/state/key-value-store/data', {
    key_value_store_address: desk.treasuryKvs,
    keys: [{ key_json: { kind: 'Reference', value: resource } }],
  })
  const vault = data.entries?.[0]?.value?.programmatic_json?.value
  return vault ? getVaultAmount(vault) : 0
}

export type LsuRequest = {
  id: string
  requester: string
  account: string
  lsu: string
  lsuAmount: number
  minXrdOut: number
  minHardOut: number
  createdAt: number
  status: 'Pending' | 'Accepted' | 'Rejected' | 'Cancelled'
  xrdPaid: number
  hardPaid: number
}

/** Zlecenia sprzedaży stakowanego XRD (ostatnie 200). */
export async function getLsuRequests(): Promise<LsuRequest[]> {
  if (!desk.lsuRequestsKvs || desk.nextLsuId <= 1) return []
  const ids: string[] = []
  for (let i = Math.max(1, desk.nextLsuId - 200); i < desk.nextLsuId; i++) ids.push(String(i))
  const out: LsuRequest[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const data = await post('/state/key-value-store/data', {
      key_value_store_address: desk.lsuRequestsKvs,
      keys: ids.slice(i, i + 100).map((id) => ({ key_json: { kind: 'U64', value: id } })),
    })
    for (const e of data.entries ?? []) {
      const r = decode(e.value.programmatic_json)
      out.push({
        id: String(e.key.programmatic_json.value), requester: r.requester, account: r.account, lsu: r.lsu,
        lsuAmount: Number(r.lsu_amount), minXrdOut: Number(r.min_xrd_out ?? 0), minHardOut: Number(r.min_hard_out), createdAt: toMs(r.created_at),
        status: r.status.variant, xrdPaid: Number(r.xrd_paid ?? 0), hardPaid: Number(r.hard_paid),
      })
    }
  }
  return out.sort((a, b) => Number(b.id) - Number(a.id))
}

/** Ile XRD jest warte `amount` LSU (wg walidatora: XRD w stake vault / podaż LSU). */
export async function getLsuXrdValue(lsu: string, amount: number): Promise<number> {
  const t = tokenInfo(lsu)
  if (!t.validator || !t.supply) return 0
  const r = await post('/state/entity/details', { addresses: [t.validator] })
  const st = r.items?.[0]?.details?.state ?? {}
  const vault = st.stake_xrd_vault?.entity_address ?? st.stake_xrd_vault
  const xrd = await getVaultAmount(vault)
  return (amount * xrd) / t.supply
}

/** Aktualna podaż tokena (np. udziałów puli). */
export async function getSupply(resource: string): Promise<number> {
  if (!resource) return 0
  const r = await post('/state/entity/details', { addresses: [resource] })
  return Number(r.items?.[0]?.details?.total_supply ?? 0)
}

/** Ile odkupionego LSU leży w desku. */
export async function getLsuHoldings(lsus: string[]): Promise<{ address: string; amount: number }[]> {
  if (!desk.lsuVaultsKvs || !lsus.length) return []
  const data = await post('/state/key-value-store/data', {
    key_value_store_address: desk.lsuVaultsKvs,
    keys: lsus.map((a) => ({ key_json: { kind: 'Reference', value: a } })),
  })
  return Promise.all((data.entries ?? []).map(async (e: any) => ({
    address: e.key.programmatic_json.value,
    amount: await getVaultAmount(e.value.programmatic_json.value),
  })))
}

export type RiderStats = { sells: number; buys: number; offers: number }

/** Reputacja riderów (liczba transakcji). */
export async function getRiderStats(ids: string[]): Promise<Map<string, RiderStats>> {
  const out = new Map<string, RiderStats>()
  const uniq = [...new Set(ids)].filter(Boolean)
  if (!desk.riderStatsKvs || !uniq.length) return out
  for (let i = 0; i < uniq.length; i += 50) {
    const data = await post('/state/key-value-store/data', {
      key_value_store_address: desk.riderStatsKvs,
      keys: uniq.slice(i, i + 50).map((id) => ({ key_json: { kind: 'NonFungibleLocalId', value: id } })),
    })
    for (const e of data.entries ?? []) {
      const s = decode(e.value.programmatic_json)
      out.set(e.key.programmatic_json.value, { sells: Number(s.sells), buys: Number(s.buys), offers: Number(s.offers_created) })
    }
  }
  return out
}

/** Mnożnik opłaty dla danej ilości zablokowanych HARD. */
export function multiplierFor(locked: number) {
  let m = 1
  for (const t of desk.tiers) if (locked >= t.threshold) m = t.multiplier
  return m
}

export async function getOffers(): Promise<OfferView[]> {
  const r = await post('/state/entity/details', { addresses: [CONFIG.deskComponent] })
  const state = decode(r.items[0].details.state)
  const kvs: string = state.offers
  const next = Number(state.next_offer_id)
  if (next <= 1) return []

  const ids: string[] = []
  for (let i = Math.max(1, next - 100); i < next; i++) ids.push(String(i))

  const data = await post('/state/key-value-store/data', {
    key_value_store_address: kvs,
    keys: ids.map((id) => ({ key_json: { kind: 'U64', value: id } })),
  })

  return (data.entries ?? [])
    .map((e: any) => {
      const id = String(e.key.programmatic_json.value)
      const o = decode(e.value.programmatic_json)
      const reserved = o.reserved_buyer
      return {
        id,
        seller: o.seller,
        sellerAccount: o.seller_account,
        sellResource: o.sell_resource,
        sellAmount: o.sell_amount,
        askResource: o.ask_resource,
        askAmount: o.ask_amount,
        sellRemaining: o.sell_remaining ?? o.sell_amount,
        askRemaining: o.ask_remaining ?? o.ask_amount,
        allowPartial: o.allow_partial === true,
        featuredUntil: toMs(o.featured_until),
        expiresAt: Number(typeof o.expires_at === 'object' ? o.expires_at.seconds_since_unix_epoch : o.expires_at) * 1000,
        reservedBuyer: reserved.variant === 'Some' || reserved.variant === '1' ? reserved.fields[0] : null,
        status: o.status.variant,
      } as OfferView
    })
    .sort((a: OfferView, b: OfferView) => Number(b.id) - Number(a.id))
}

export type TokenInfo = { address: string; symbol: string; name: string; icon: string | null; validator?: string; validatorName?: string; validatorIcon?: string | null; supply?: number }

const tokenCache = new Map<string, TokenInfo>()

/** Pobiera symbol, nazwę i ikonę tokenów (z metadanych na ledgerze). */
export async function getTokens(addresses: string[]): Promise<Map<string, TokenInfo>> {
  const todo = [...new Set(addresses)].filter((a) => a && !tokenCache.has(a))
  for (let i = 0; i < todo.length; i += 20) {
    const r = await post('/state/entity/details', { addresses: todo.slice(i, i + 20) })
    for (const item of r.items ?? []) {
      const meta = item.metadata?.items ?? []
      const get = (k: string) => meta.find((m: any) => m.key === k)?.value?.typed?.value as string | undefined
      const icon = get('icon_url')
      tokenCache.set(item.address, {
        address: item.address,
        symbol: get('symbol') || get('name') || short(item.address),
        name: get('name') || '',
        icon: icon && icon.startsWith('https://') ? icon : null,
        validator: get('validator') || undefined,
        supply: Number(item.details?.total_supply ?? 0),
      })
    }
  }
  // Dla stakowanego XRD: nazwa i logo walidatora
  const lsus = todo.map((a) => tokenCache.get(a)).filter((t): t is TokenInfo => !!t?.validator)
  const vals = [...new Set(lsus.map((t) => t.validator!))]
  for (let i = 0; i < vals.length; i += 20) {
    try {
      const r = await post('/state/entity/details', { addresses: vals.slice(i, i + 20) })
      for (const item of r.items ?? []) {
        const meta = item.metadata?.items ?? []
        const get = (k: string) => meta.find((m: any) => m.key === k)?.value?.typed?.value as string | undefined
        const icon = get('icon_url')
        for (const t of lsus)
          if (t.validator === item.address) {
            t.validatorName = get('name') || short(item.address)
            t.validatorIcon = icon && icon.startsWith('https://') ? icon : null
          }
      }
    } catch { /* nazwa walidatora jest tylko dodatkiem */ }
  }
  return tokenCache
}

export const tokenInfo = (addr: string): TokenInfo =>
  tokenCache.get(addr) ?? { address: addr, symbol: short(addr), name: '', icon: null }

/** Salda tokenów fungible na koncie. */
export async function getBalances(account: string): Promise<{ address: string; amount: string }[]> {
  const r = await post('/state/entity/details', { addresses: [account], aggregation_level: 'Global' })
  const items = r.items?.[0]?.fungible_resources?.items ?? []
  return items
    .map((i: any) => ({ address: i.resource_address, amount: String(i.amount) }))
    .filter((b: any) => Number(b.amount) > 0)
}

export const short = (a: string) => (a.length > 20 ? `${a.slice(0, 12)}…${a.slice(-6)}` : a)

/** Aktualna cena HARD w XRD (ile XRD za 1 HARD) z Ociswap. */
/** Ostatnio pobrana cena HARD i jej wartości sprzed 1 h i 24 h (do wykrywania skoków). */
export const hardPriceInfo = { now: 0, h1: 0, h24: 0 }

export async function getLiveHardPrice(): Promise<number> {
  const res = await fetch(CONFIG.hardPriceFeed)
  if (!res.ok) throw new Error(`Ociswap ${res.status}`)
  const j = await res.json()
  const p = Number(j?.price?.xrd?.now)
  if (!(p > 0)) throw new Error('No price')
  hardPriceInfo.now = p
  hardPriceInfo.h1 = Number(j?.price?.xrd?.['1h'] ?? 0)
  hardPriceInfo.h24 = Number(j?.price?.xrd?.['24h'] ?? 0)
  return p
}
