export const DEVNET_PROGRAM_ID = '96piBXGNG9Ga8ycf6cpEJCFugjqpCvhuGjQHJc4KvzVe'
export const DEVNET_MINT = 'BAKZoZLZakRYowjaee7aXTSvTe4hVEwCybBNMAygp8nV'
export const DEVNET_MINT_AUTHORITY = 'FBBuwcCPMr72AWnMB1u1crzjW5w72JB7Fs8c5Wb1ZM38'
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
export const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

export const DEVNET_PUBLIC_EVENTS = {
  paid: {
    event: 'SMhtCCQRnXFx2Zq7RVBRLnKDatpDd3oKvvZyome13dz',
    vault: 'GhQEZoir1k1vN5jMe2bg2Th8a363xh3xkCM6A5mWekqT',
    payout: 'H3bXbfLUoiteBuubPXxmS9bRSwd7AxErkaCp5NgByMbS',
    status: 'PAID',
  },
  refunded: {
    event: '4SZ2XvXx4eEyNPQLfFbrQTLtfFVJ4SgoagVrTTWkc87S',
    vault: '5FfRGLtUUfbKCKkk6k3SSXh6YJ4NuZ4VyLEVfQsJY8VB',
    payout: 'H3bXbfLUoiteBuubPXxmS9bRSwd7AxErkaCp5NgByMbS',
    status: 'REFUNDED',
  },
} as const

export type DevnetPublicEvent = typeof DEVNET_PUBLIC_EVENTS[keyof typeof DEVNET_PUBLIC_EVENTS]

export function devnetPublicEvent(address: string) {
  return Object.values(DEVNET_PUBLIC_EVENTS).find((target) => target.event === address)
}
