// Ustawienia sieci. Ta sama strona buduje się dwa razy: Stokenet (test) i Mainnet.
// Sieć wybiera zmienna VITE_NETWORK przy budowie (domyślnie stokenet).
const NET = (import.meta as any).env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'stokenet'
const old = location.hash === '#stary'

const NETWORKS = {
  stokenet: {
    networkId: 2,
    label: 'STOKENET · TESTNET',
    networkName: 'Stokenet',
    testnet: true,
    dAppDefinitionAddress: 'account_tdx_2_129j3eukj5fyylr8l7ehg7ug377hzpvnfywvv0k3dxqn9tzn84lmvzp',
    // Pod #stary: poprzedni desk, żeby odebrać tokeny ze starych ofert.
    deskComponent: old
      ? 'component_tdx_2_1cpv03jg856uswenlwstjvr3et58wshgd7cp0k86q2hme6tu92uvuv3'
      : 'component_tdx_2_1cz60lwtsd9sujz80hyzxlxz02062aypgml028fhf3u8a5zxsy3gauf',
    gatewayUrl: 'https://stokenet.radixdlt.com',
    xrd: 'resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc',
    explorerUrl: 'https://stokenet-dashboard.radixdlt.com',
  },
  mainnet: {
    networkId: 1,
    label: 'RADIX MAINNET',
    networkName: 'Radix Mainnet',
    testnet: false,
    // Uzupełnić po wdrożeniu na mainnet.
    dAppDefinitionAddress: '',
    deskComponent: '',
    gatewayUrl: 'https://mainnet.radixdlt.com',
    xrd: 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
    explorerUrl: 'https://dashboard.radixdlt.com',
  },
} as const

const N = NETWORKS[NET]

export const CONFIG = {
  network: NET as 'stokenet' | 'mainnet',
  networkId: N.networkId,
  networkLabel: N.label,
  networkName: N.networkName,
  testnet: N.testnet,
  dAppDefinitionAddress: N.dAppDefinitionAddress,
  deskComponent: N.deskComponent,
  oldDesk: old,
  riderBadgeResource: '', // odczytywane z desku przy starcie
  hardResource: '', // odczytywane z desku przy starcie
  gatewayUrl: N.gatewayUrl,
  knownResources: [{ symbol: 'XRD', address: N.xrd }] as { symbol: string; address: string }[],
  // Cena HARD (XRD za 1 HARD) z Ociswap – zawsze prawdziwy HARD z mainnetu.
  hardPriceFeed: 'https://api.ociswap.com/tokens/resource_rdx1thh4yr9k393uc4x45n4u9l7h57804qdhxxzdw2dpmu8cjpm6ueujpn',
  explorerUrl: N.explorerUrl,
  feePerSide: 0.005,
  hardLockForDiscount: 1000,
}
