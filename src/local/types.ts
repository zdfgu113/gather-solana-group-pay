import type { ReactNode } from 'react'
import type { Language } from '../copy'
import type { Action, DemoState } from '../simulation'

export interface LocalAppBridge {
  mode?: 'local' | 'devnet'
  state: DemoState
  send: (action: Action) => void
  address?: string
  requestedAddress?: string
  readStatus?: 'loading' | 'failed' | 'idle'
  retryRead?: () => void
  busy: boolean
  pending: boolean
  createPayout: string
  payoutOptions: string[]
  controls: (language: Language) => ReactNode
}
