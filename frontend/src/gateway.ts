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
}
export let desk: DeskInfo = { tiers: [], feePerSide: 0.0075, burnShare: 0, listingFee: 0, v2: false, feesCollected: [], burnedVault: '', hardLocksKvs: '', unlockingKvs: '', unlockReadyKvs: '', unlockPeriod: 0 }

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
        expiresAt: Number(typeof o.expires_at === 'object' ? o.expires_at.seconds_since_unix_epoch : o.expires_at) * 1000,
        reservedBuyer: reserved.variant === 'Some' || reserved.variant === '1' ? reserved.fields[0] : null,
        status: o.status.variant,
      } as OfferView
    })
    .sort((a: OfferView, b: OfferView) => Number(b.id) - Number(a.id))
}

export type TokenInfo = { address: string; symbol: string; name: string; icon: string | null }

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
      })
    }
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
