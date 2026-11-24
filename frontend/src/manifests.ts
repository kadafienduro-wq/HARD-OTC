import { CONFIG } from './config'
import { desk as deskInfo } from './gateway'

const desk = () => CONFIG.deskComponent
/** Kontrakt v5+ przyjmuje kwotę przy wypłatach (0 = całość). */
const v5amt = (amount: string) => (deskInfo.version >= 5 ? ` Decimal("${amount}")` : '')

const riderProof = (account: string, riderId: string) => `
CALL_METHOD Address("${account}") "create_proof_of_non_fungibles"
  Address("${CONFIG.riderBadgeResource}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${riderId}"));
POP_FROM_AUTH_ZONE Proof("rider");`

const depositAll = (account: string) => `
CALL_METHOD Address("${account}") "deposit_batch" Expression("ENTIRE_WORKTOP");`

export const mintRiderBadge = (account: string) => `
CALL_METHOD Address("${desk()}") "mint_rider_badge";${depositAll(account)}`

export function createOffer(p: {
  account: string
  riderId: string
  sellResource: string
  sellAmount: string
  askResource: string
  askAmount: string
  expiryHours: 1 | 6 | 72
  reservedBuyer?: string
  listingFee?: string
  v2?: boolean
  v3?: boolean
  allowPartial?: boolean
}) {
  const reserved = p.reservedBuyer
    ? `Enum<1u8>(NonFungibleLocalId("${p.reservedBuyer}"))`
    : 'Enum<0u8>()'
  const fee = p.listingFee && Number(p.listingFee) > 0 ? p.listingFee : '0'
  return `
CALL_METHOD Address("${p.account}") "withdraw" Address("${p.sellResource}") Decimal("${p.sellAmount}");
TAKE_FROM_WORKTOP Address("${p.sellResource}") Decimal("${p.sellAmount}") Bucket("sell");
${!p.v2 ? '' : fee !== '0' ? `CALL_METHOD Address("${p.account}") "withdraw" Address("${CONFIG.hardResource}") Decimal("${fee}");
` : ''}${p.v2 ? `TAKE_FROM_WORKTOP Address("${CONFIG.hardResource}") Decimal("${fee}") Bucket("listing");` : ''}${riderProof(p.account, p.riderId)}
CALL_METHOD Address("${desk()}") "create_offer"
  Proof("rider")
  Bucket("sell")
  Address("${p.askResource}")
  Decimal("${p.askAmount}")
  ${p.expiryHours}u8
  ${reserved}
  Address("${p.account}")${p.v2 ? '\n  Bucket("listing")' : ''}${p.v3 ? `\n  ${p.allowPartial ? 'true' : 'false'}` : ''};${depositAll(p.account)}`
}

/** `payAmount` = ile płacisz (całość albo część przy częściowym kupnie). */
export const acceptOffer = (account: string, riderId: string, offerId: string, askResource: string, payAmount: string, minReceive = '0') => `
CALL_METHOD Address("${account}") "withdraw" Address("${askResource}") Decimal("${payAmount}");
TAKE_ALL_FROM_WORKTOP Address("${askResource}") Bucket("pay");${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "accept_offer" ${offerId}u64 Proof("rider") Bucket("pay")${deskInfo.version >= 8 ? ` Decimal("${minReceive}")` : ''};${depositAll(account)}`

export const cancelOffer = (account: string, riderId: string, offerId: string) => `${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "cancel_offer" ${offerId}u64 Proof("rider");${depositAll(account)}`

export const lockHard = (account: string, riderId: string, amount: string) => `
CALL_METHOD Address("${account}") "withdraw" Address("${CONFIG.hardResource}") Decimal("${amount}");
TAKE_ALL_FROM_WORKTOP Address("${CONFIG.hardResource}") Bucket("hard");${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "lock_hard" Proof("rider") Bucket("hard");${depositAll(account)}`

export const unlockHard = (account: string, riderId: string) => `${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "unlock_hard" Proof("rider");${depositAll(account)}`

export const requestUnlock = (account: string, riderId: string, amount: string) => `${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "request_unlock" Proof("rider") Decimal("${amount}");${depositAll(account)}`

export const withdrawUnlocked = (account: string, riderId: string) => `${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "withdraw_unlocked" Proof("rider");${depositAll(account)}`

// ---------- Admin (wymaga badge'a admina w portfelu) ----------
const adminProof = (account: string, adminBadge: string) => `
CALL_METHOD Address("${account}") "create_proof_of_amount" Address("${adminBadge}") Decimal("1");`

export const adminSetListingFee = (account: string, adminBadge: string, amount: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_listing_fee" Decimal("${amount}");`

export const adminSetUnlockPeriod = (account: string, adminBadge: string, seconds: number) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_unlock_period" ${Math.round(seconds)}i64;`

export const adminSetPaused = (account: string, adminBadge: string, paused: boolean) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_paused" ${paused};`

export const adminWithdrawTreasury = (account: string, adminBadge: string, resource: string, amount = '0') => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "withdraw_treasury" Address("${resource}")${v5amt(amount)};${depositAll(account)}`

export const promoteOffer = (account: string, riderId: string, offerId: string, hardResource: string, fee: string, days: number) => `
CALL_METHOD Address("${account}") "withdraw" Address("${hardResource}") Decimal("${fee}");
TAKE_FROM_WORKTOP Address("${hardResource}") Decimal("${fee}") Bucket("fee");${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "promote_offer" ${offerId}u64 Proof("rider") Bucket("fee") ${days}u8;${depositAll(account)}`

export const adminSetPromotionFee = (account: string, adminBadge: string, amount: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_promotion_fee" Decimal("${amount}");`

export const adminAddVerified = (account: string, adminBadge: string, resources: string[]) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "add_verified" Array<Address>(${resources.map((r) => `Address("${r}")`).join(', ')});`

export const adminRemoveVerified = (account: string, adminBadge: string, resource: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "remove_verified" Address("${resource}");`

export const adminSetReservationFee = (account: string, adminBadge: string, amount: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_reservation_fee" Decimal("${amount}");`

// ---------- Quick buy: stakowane XRD (LSU) za HARD ----------
export const requestLsuSale = (account: string, riderId: string, lsu: string, amount: string, minXrdOut: string, minHardOut: string) => `
CALL_METHOD Address("${account}") "withdraw" Address("${lsu}") Decimal("${amount}");
TAKE_ALL_FROM_WORKTOP Address("${lsu}") Bucket("lsu");${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "request_lsu_sale" Proof("rider") Bucket("lsu") Decimal("${minXrdOut}") Decimal("${minHardOut}") Address("${account}");${depositAll(account)}`

export const cancelLsuSale = (account: string, riderId: string, id: string) => `${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "cancel_lsu_sale" ${id}u64 Proof("rider");${depositAll(account)}`

export const adminAcceptLsu = (account: string, adminBadge: string, id: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "accept_lsu_sale" ${id}u64;`

export const adminRejectLsu = (account: string, adminBadge: string, id: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "reject_lsu_sale" ${id}u64;`

export const adminSetLsuBuyback = (account: string, adminBadge: string, enabled: boolean, payout: string, maxPerTx: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_lsu_buyback" ${enabled} Decimal("${payout}") Decimal("${maxPerTx}");`

export const adminSetHardPrice = (account: string, adminBadge: string, xrdPerHard: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_hard_price" Decimal("${xrdPerHard}");`

export const adminFundBuyback = (account: string, adminBadge: string, hard: string, amount: string) => `
CALL_METHOD Address("${account}") "withdraw" Address("${hard}") Decimal("${amount}");
TAKE_ALL_FROM_WORKTOP Address("${hard}") Bucket("hard");${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "fund_lsu_buyback" Bucket("hard");`

export const adminWithdrawBuybackHard = (account: string, adminBadge: string, amount = '0') => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "withdraw_buyback_hard"${v5amt(amount)};${depositAll(account)}`

export const adminWithdrawLsu = (account: string, adminBadge: string, lsu: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "withdraw_lsu" Address("${lsu}");${depositAll(account)}`

// ---------- Wspólna pula skupu ----------
export const depositPool = (account: string, hard: string, amount: string) => `
CALL_METHOD Address("${account}") "withdraw" Address("${hard}") Decimal("${amount}");
TAKE_ALL_FROM_WORKTOP Address("${hard}") Bucket("hard");
CALL_METHOD Address("${desk()}") "deposit_pool" Bucket("hard");${depositAll(account)}`

export const withdrawPool = (account: string, share: string, amount: string) => `
CALL_METHOD Address("${account}") "withdraw" Address("${share}") Decimal("${amount}");
TAKE_ALL_FROM_WORKTOP Address("${share}") Bucket("shares");
CALL_METHOD Address("${desk()}") "withdraw_pool" Bucket("shares");${depositAll(account)}`

export const adminSetPool = (account: string, adminBadge: string, enabled: boolean, platformShare: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_pool" ${enabled} Decimal("${platformShare}");`

export const adminMintInitialShares = (account: string, adminBadge: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "mint_initial_pool_shares";${depositAll(account)}`

export const adminSettlePool = (account: string, adminBadge: string, hard: string, amount: string, cost: string) => `
CALL_METHOD Address("${account}") "withdraw" Address("${hard}") Decimal("${amount}");
TAKE_ALL_FROM_WORKTOP Address("${hard}") Bucket("hard");${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "settle_pool" Bucket("hard") Decimal("${cost}");`

/** Akceptacja z ceną HARD z chwili podpisu: ustawia cenę i akceptuje w jednej transakcji. */
export const adminAcceptLsuAtPrice = (account: string, adminBadge: string, id: string, xrdPerHard: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_hard_price" Decimal("${xrdPerHard}");
CALL_METHOD Address("${desk()}") "accept_lsu_sale" ${id}u64;`

export const adminFundBuybackXrd = (account: string, adminBadge: string, xrd: string, amount: string) => `
CALL_METHOD Address("${account}") "withdraw" Address("${xrd}") Decimal("${amount}");
TAKE_ALL_FROM_WORKTOP Address("${xrd}") Bucket("xrd");${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "fund_lsu_buyback_xrd" Bucket("xrd");`

export const adminWithdrawBuybackXrd = (account: string, adminBadge: string, amount = '0') => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "withdraw_buyback_xrd"${v5amt(amount)};${depositAll(account)}`

export const adminSetLsuLimits = (account: string, adminBadge: string, perTx: string, daily: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_lsu_limits" Decimal("${perTx}") Decimal("${daily}");`

export const adminSetLsuSplit = (account: string, adminBadge: string, xrdShare: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_lsu_split" Decimal("${xrdShare}");`

export const adminSetTradingFee = (account: string, adminBadge: string, rate: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_trading_fee" Decimal("${rate}");`

export const claimFaucet = (account: string, riderId: string) => `${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "claim_faucet" Proof("rider");${depositAll(account)}`

export const adminFundFaucet = (account: string, adminBadge: string, hard: string, amount: string) => `
CALL_METHOD Address("${account}") "withdraw" Address("${hard}") Decimal("${amount}");
TAKE_ALL_FROM_WORKTOP Address("${hard}") Bucket("h");${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "fund_faucet" Bucket("h");`

export const adminSetFaucetAmount = (account: string, adminBadge: string, amount: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_faucet_amount" Decimal("${amount}");`

export const adminWithdrawFaucet = (account: string, adminBadge: string, amount = '0') => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "withdraw_faucet" Decimal("${amount}");${depositAll(account)}`

/** Zwrot wygasłych ofert sprzedającym — bez badge'a, może każdy (v8+). */
export const reclaimExpired = (account: string, offerIds: string[]) =>
  offerIds.map((id) => `\nCALL_METHOD Address("${desk()}") "reclaim_expired_offer" ${id}u64;`).join('') + depositAll(account)

export const adminReturnOffer = (account: string, adminBadge: string, offerId: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "admin_return_offer" ${offerId}u64;`

export const adminSetOnlyVerified = (account: string, adminBadge: string, on: boolean) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_only_verified" ${on};`

export const claimTestTokens = (account: string) => `
CALL_METHOD Address("${CONFIG.testFaucet}") "claim" Address("${account}");${depositAll(account)}`
