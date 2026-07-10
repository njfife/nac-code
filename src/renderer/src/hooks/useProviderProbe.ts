import { useCallback, useEffect, useState } from 'react'
import type { ProviderProbe } from '../../../shared/runtime'

// Shared live-CLI probe (CliRegistry v0): both the model modal and the Inspector's CLI Connections
// panel need the same real `window.nac.registry.providers()` result, interpreted the same way — no
// per-surface fake/static statuses (M0-5 honesty sweep). `providers === null` means still probing;
// `refresh()` re-probes on demand (bumping `nonce` re-runs the effect below).
export interface UseProviderProbe {
  probing: boolean
  providers: ProviderProbe[] | null
  refresh: () => void
}

export function useProviderProbe(): UseProviderProbe {
  const [providers, setProviders] = useState<ProviderProbe[] | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    setProviders(null) // re-probing (initial mount, or a manual refresh) always shows "probing" first
    const registry = window.nac?.registry
    if (!registry) {
      // No preload bridge (tests, stale preload) — degrade to "no providers detected", never stuck probing.
      setProviders([])
      return
    }
    registry
      .providers()
      .then((r) => {
        if (live) setProviders(r)
      })
      .catch(() => {
        if (live) setProviders([])
      })
    return () => {
      live = false
    }
  }, [nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  return { probing: providers === null, providers, refresh }
}
