import { PublicKey } from '@solana/web3.js'
import idl from '../idl/group_pay.devnet.json'
import type { ChainConfig } from '../chain/config'
import { DEVNET_GENESIS, DEVNET_MINT, DEVNET_MINT_AUTHORITY } from './public-events.ts'

const LOCAL_PROGRAM = '6JrQobtnXBeNv4khZhBGCLEEfXk7pJ8Dw1UozaEhXK8R'
const LOCAL_MINT = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj'

export type DevnetPublicSettings = {
  programId?: string; mint?: string; mintAuthority?: string; genesisHash?: string; rpcUrl?: string
}

function publicKey(raw: string | undefined) {
  if (!raw) return null
  try { return new PublicKey(raw) } catch { return null }
}

export function parseDevnetConfig(settings: DevnetPublicSettings, committedIdlAddress = idl.address): ChainConfig | null {
  const programId = publicKey(settings.programId)
  const mint = publicKey(settings.mint)
  const mintAuthority = publicKey(settings.mintAuthority)
  const genesis = publicKey(settings.genesisHash)
  if (!programId || !mint || !mintAuthority || !genesis ||
    programId.toBase58() === LOCAL_PROGRAM || mint.toBase58() === LOCAL_MINT ||
    programId.toBase58() !== committedIdlAddress || mint.toBase58() !== DEVNET_MINT ||
    mintAuthority.toBase58() !== DEVNET_MINT_AUTHORITY || genesis.toBase58() !== DEVNET_GENESIS) return null
  try {
    const url = new URL(settings.rpcUrl ?? '')
    // ponytail: one public, keyless endpoint for the first Devnet candidate; a private provider needs a reviewed proxy.
    if (url.protocol !== 'https:' || url.hostname !== 'api.devnet.solana.com' ||
      url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null
    return {
      cluster: 'devnet', rpcUrl: url.toString(), programId, mint, mintAuthority,
      expectedGenesisHash: genesis.toBase58(),
    }
  } catch { return null }
}

const env = import.meta.env ?? {}
export const DEVNET_SETTINGS: DevnetPublicSettings = {
  programId: env.VITE_DEVNET_PROGRAM_ID,
  mint: env.VITE_DEVNET_TEST_MINT,
  mintAuthority: env.VITE_DEVNET_MINT_AUTHORITY,
  genesisHash: env.VITE_DEVNET_GENESIS_HASH,
  rpcUrl: env.VITE_DEVNET_RPC_URL,
}
