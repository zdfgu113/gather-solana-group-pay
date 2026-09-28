import { useEffect, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'
import type { Language } from './copy'
import { DEVNET_PUBLIC_EVENTS } from './devnet/public-events'
import './styles.css'

globalThis.Buffer = Buffer

const COPY = {
  en: {
    region: 'Devnet test mode', title: 'Devnet demo · TEST only',
    enter: 'Review Devnet test mode', leave: 'Return to simulation',
    loading: 'Loading Devnet test mode…', loadError: 'Devnet module could not load. Return to simulation and retry.',
    examples: 'Completed examples · choose Devnet:',
    exampleHelp: 'Completed on-chain examples. No wallet is needed to view them; choose Devnet mode after opening a link.',
    paid: 'Full group paid', refunded: 'Both refunded',
  },
  zh: {
    region: 'Devnet 测试模式', title: 'Devnet 演示 · 仅测试币',
    enter: '查看 Devnet 测试模式', leave: '返回模拟模式',
    loading: '正在加载 Devnet 测试模式…', loadError: 'Devnet 模块无法加载，请返回模拟模式重试。',
    examples: '已完成示例 · 选择 Devnet：',
    exampleHelp: '已完成的链上示例。无需钱包即可查看；打开链接后选择 Devnet 模式。',
    paid: '满员已放款', refunded: '两人已退款',
  },
} as const

function DevnetEntry() {
  const [language, setLanguage] = useState<Language>(() => {
    try { return localStorage.getItem('gather-language') === 'zh' ? 'zh' : 'en' } catch { return 'en' }
  })
  const [chosen, setChosen] = useState(false)
  const [mode, setMode] = useState<ComponentType | null>(null)
  const [loadError, setLoadError] = useState(false)
  useEffect(() => {
    const observer = new MutationObserver(() => setLanguage(document.documentElement.lang === 'zh-CN' ? 'zh' : 'en'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!chosen) return
    let cancelled = false
    import('./devnet/DevnetMode').then((module) => {
      if (!cancelled) setMode(() => module.default)
    }).catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
  }, [chosen])
  const t = COPY[language]
  const Mode = mode
  return <>
    <div className="local-mode-switch" role="region" aria-label={t.region}>
      <span>{t.title}</span>
      <button type="button" data-testid="devnet-mode-switch" onClick={() => {
        if (chosen) { setMode(null); setChosen(false); setLoadError(false) }
        else setChosen(true)
      }}>{chosen ? t.leave : t.enter}</button>
    </div>
    <nav className="devnet-example-links" aria-label={t.exampleHelp}>
      <span>{t.examples}</span>
      <a href={`./devnet.html?event=${DEVNET_PUBLIC_EVENTS.paid.event}`}>{t.paid}</a>
      <a href={`./devnet.html?event=${DEVNET_PUBLIC_EVENTS.refunded.event}`}>{t.refunded}</a>
    </nav>
    {Mode ? <Mode /> : chosen ? <p role={loadError ? 'alert' : 'status'} className="local-loading">{loadError ? t.loadError : t.loading}</p> : <App />}
  </>
}

createRoot(document.getElementById('root')!).render(<DevnetEntry />)
