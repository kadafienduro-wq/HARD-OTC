// Uzupełnij po wdrożeniu (adresy z receiptu transakcji instantiate).
export const CONFIG = {
  // Konto skonfigurowane jako dApp Definition (Developer Console -> Configure dApp Definition)
  dAppDefinitionAddress: 'account_tdx_2_PODMIEN',
  deskComponent: 'component_tdx_2_PODMIEN',
  riderBadgeResource: 'resource_tdx_2_PODMIEN',
  hardResource: 'resource_tdx_2_PODMIEN',
  gatewayUrl: 'https://stokenet.radixdlt.com',
  // Zasoby do szybkiego wyboru w formularzu (dopisz swoje LSU / LP)
  knownResources: [
    { symbol: 'XRD', address: 'resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc' },
  ] as { symbol: string; address: string }[],
  feePerSide: 0.0075,
  hardLockForDiscount: 1000,
}
