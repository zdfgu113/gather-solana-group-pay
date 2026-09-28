import { useMemo } from 'react'
import ChainMode from '../chain/ChainMode'
import { DEVNET_SETTINGS, parseDevnetConfig } from './config'

export default function DevnetMode() {
  const config = useMemo(() => parseDevnetConfig(DEVNET_SETTINGS), [])
  if (!config) return <p role="alert" className="local-loading">
    {document.documentElement.lang === 'zh-CN'
      ? 'Devnet 配置尚未经过审核并补齐；钱包连接与签名均已禁用。请返回模拟模式。'
      : 'Devnet configuration has not been reviewed and completed. Wallet connection and signing are disabled. Return to simulation.'}
  </p>
  // No fixture wallet or private key is included in this entry. Wallet discovery is opt-in only.
  return <ChainMode config={config} mode="devnet" adapters={[]} />
}
