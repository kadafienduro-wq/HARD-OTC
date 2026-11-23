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
export async function loadDeskInfo() {
  const r = await post('/state/entity/details', { addresses: [CONFIG.deskComponent] })
  const state = decode(r.items[0].details.state)
  CONFIG.riderBadgeResource = state.rider_badge
  CONFIG.hardResource = state.hard_resource
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

const symbolCache = new Map<string, string>()

export async function getSymbols(addresses: string[]): Promise<Map<string, string>> {
  const missing = [...new Set(addresses)].filter((a) => !symbolCache.has(a))
  for (const known of CONFIG.knownResources) symbolCache.set(known.address, known.symbol)
  const todo = missing.filter((a) => !symbolCache.has(a))
  if (todo.length) {
    const r = await post('/state/entity/details', { addresses: todo })
    for (const item of r.items ?? []) {
      const meta = item.metadata?.items ?? []
      const sym = meta.find((m: any) => m.key === 'symbol')?.value?.typed?.value
      const name = meta.find((m: any) => m.key === 'name')?.value?.typed?.value
      symbolCache.set(item.address, sym || name || short(item.address))
    }
  }
  return symbolCache
}

export const short = (a: string) => (a.length > 20 ? `${a.slice(0, 12)}…${a.slice(-6)}` : a)
