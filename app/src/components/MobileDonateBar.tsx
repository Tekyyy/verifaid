'use client'

import { useEffect, useState } from 'react'

/**
 * On a phone the donation panel comes after the terms, tranches and the whole timeline — thousands of pixels
 * down. This bar keeps the way to it one tap away while the need is open, and steps aside once the panel itself
 * is on screen. Larger screens show the panel beside the content and never render it.
 */
export function MobileDonateBar({ label, summary }: { label: string; summary: string }) {
  const [panelVisible, setPanelVisible] = useState(false)

  useEffect(() => {
    const panel = document.getElementById('donate')?.closest('section')
    if (!panel) return
    const observer = new IntersectionObserver(([entry]) => setPanelVisible(Boolean(entry?.isIntersecting)))
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])

  if (panelVisible) return null

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur
        [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))] lg:hidden"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium tabular-nums text-slate-800">{summary}</p>
        <a href="#donate" className="btn-primary shrink-0 no-underline">
          {label}
        </a>
      </div>
    </div>
  )
}
