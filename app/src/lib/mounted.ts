'use client'

import { useEffect, useState } from 'react'

/**
 * Client-only state gate: false during SSR and the hydration pass, true afterwards. Lives apart from
 * `hooks.ts` so pages without a wallet provider (the embed widget) can use it without bundling wagmi.
 */
export const useMounted = (): boolean => {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted
}
