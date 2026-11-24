// Uzupełnij po wdrożeniu (adresy z receiptu transakcji instantiate).
export const CONFIG = {
  // Konto skonfigurowane jako dApp Definition (Developer Console -> Configure dApp Definition)
  dAppDefinitionAddress: 'account_tdx_2_129j3eukj5fyylr8l7ehg7ug377hzpvnfywvv0k3dxqn9tzn84lmvzp',
  // Desk v4. Pod #stary: poprzedni desk (v3), żeby odebrać tokeny ze starych ofert.
  deskComponent: location.hash === '#stary'
    ? 'component_tdx_2_1cpwp59jnv62skzepkew9hxf998cwjs92epz4nksvp4526c52u77840'
    : 'component_tdx_2_1cpv03jg856uswenlwstjvr3et58wshgd7cp0k86q2hme6tu92uvuv3',
  oldDesk: location.hash === '#stary',
  riderBadgeResource: '', // odczytywane z desku przy starcie
  hardResource: '', // odczytywane z desku przy starcie
  gatewayUrl: 'https://stokenet.radixdlt.com',
  // Zasoby do szybkiego wyboru w formularzu (dopisz swoje LSU / LP)
  knownResources: [
    { symbol: 'XRD', address: 'resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc' },
  ] as { symbol: string; address: string }[],
  // Aktualna cena HARD (XRD za 1 HARD) z Ociswap. Na Stokenet testowy HARD nie ma rynku,
  // więc używamy ceny prawdziwego HARD z mainnetu.
  hardPriceFeed: 'https://api.ociswap.com/tokens/resource_rdx1thh4yr9k393uc4x45n4u9l7h57804qdhxxzdw2dpmu8cjpm6ueujpn',
  // Eksplorator do podglądu tokenów (na mainnecie: https://dashboard.radixdlt.com)
  explorerUrl: 'https://stokenet-dashboard.radixdlt.com',
  feePerSide: 0.0075,
  hardLockForDiscount: 1000,
}
