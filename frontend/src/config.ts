// Uzupełnij po wdrożeniu (adresy z receiptu transakcji instantiate).
export const CONFIG = {
  // Konto skonfigurowane jako dApp Definition (Developer Console -> Configure dApp Definition)
  dAppDefinitionAddress: 'account_tdx_2_129j3eukj5fyylr8l7ehg7ug377hzpvnfywvv0k3dxqn9tzn84lmvzp',
  // Desk v3. Pod #stary: poprzedni desk (v2), żeby odebrać tokeny ze starych ofert.
  deskComponent: location.hash === '#stary'
    ? 'component_tdx_2_1cz2clk7v9q8d3hacnxgmzr2tk47s56chu99lf834vtcz4eg5hp7g2m'
    : 'component_tdx_2_1cpwp59jnv62skzepkew9hxf998cwjs92epz4nksvp4526c52u77840',
  oldDesk: location.hash === '#stary',
  riderBadgeResource: '', // odczytywane z desku przy starcie
  hardResource: '', // odczytywane z desku przy starcie
  gatewayUrl: 'https://stokenet.radixdlt.com',
  // Zasoby do szybkiego wyboru w formularzu (dopisz swoje LSU / LP)
  knownResources: [
    { symbol: 'XRD', address: 'resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc' },
  ] as { symbol: string; address: string }[],
  feePerSide: 0.0075,
  hardLockForDiscount: 1000,
}
