import { CONFIG } from './config'

const desk = () => CONFIG.deskComponent

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
export const acceptOffer = (account: string, riderId: string, offerId: string, askResource: string, payAmount: string) => `
CALL_METHOD Address("${account}") "withdraw" Address("${askResource}") Decimal("${payAmount}");
TAKE_ALL_FROM_WORKTOP Address("${askResource}") Bucket("pay");${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "accept_offer" ${offerId}u64 Proof("rider") Bucket("pay");${depositAll(account)}`

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

export const adminSetBurnShare = (account: string, adminBadge: string, share: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_burn_share" Decimal("${share}");`

export const adminSetPaused = (account: string, adminBadge: string, paused: boolean) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_paused" ${paused};`

export const adminWithdrawTreasury = (account: string, adminBadge: string, resource: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "withdraw_treasury" Address("${resource}");${depositAll(account)}`

export const promoteOffer = (account: string, riderId: string, offerId: string, hardResource: string, fee: string) => `
CALL_METHOD Address("${account}") "withdraw" Address("${hardResource}") Decimal("${fee}");
TAKE_FROM_WORKTOP Address("${hardResource}") Decimal("${fee}") Bucket("fee");${riderProof(account, riderId)}
CALL_METHOD Address("${desk()}") "promote_offer" ${offerId}u64 Proof("rider") Bucket("fee");${depositAll(account)}`

export const adminSetPromotionFee = (account: string, adminBadge: string, amount: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_promotion_fee" Decimal("${amount}");`

export const adminAddVerified = (account: string, adminBadge: string, resources: string[]) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "add_verified" Array<Address>(${resources.map((r) => `Address("${r}")`).join(', ')});`

export const adminRemoveVerified = (account: string, adminBadge: string, resource: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "remove_verified" Address("${resource}");`

export const adminSetReservationFee = (account: string, adminBadge: string, amount: string) => `${adminProof(account, adminBadge)}
CALL_METHOD Address("${desk()}") "set_reservation_fee" Decimal("${amount}");`
