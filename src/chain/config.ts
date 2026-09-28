import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'

export type ChainConfig = {
  cluster: 'localnet' | 'devnet'
  rpcUrl: string
  programId: PublicKey
  mint: PublicKey
  mintAuthority: PublicKey
  expectedGenesisHash?: string
}

export function tokenAccountFor(config: ChainConfig, owner: PublicKey) {
  return getAssociatedTokenAddressSync(config.mint, owner, false, TOKEN_PROGRAM_ID)
}
