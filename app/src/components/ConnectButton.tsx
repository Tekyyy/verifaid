'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { chain } from '@/lib/config'
import { shorten } from '@/lib/format'
import { useMounted, useWrongChain } from '@/lib/hooks'
import { useNoInstalledWallet, useSwitchToAppChain, useWalletChoices } from '@/lib/wallets'

export function ConnectButton() {
  const t = useTranslations('common')
  const tErrors = useTranslations('errors')
  const mounted = useMounted()
  const { address, isConnected, connector } = useAccount()
  const { connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const network = useSwitchToAppChain()
  const wrongChain = useWrongChain()
  const wallets = useWalletChoices()
  const noWallet = useNoInstalledWallet()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // The phone menu closes on a tap anywhere else, or on Escape.
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !menuRef.current?.contains(event.target as Node)
      ) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [menuOpen])

  if (!mounted) {
    return (
      <span className="text-sm text-slate-500" aria-hidden="true">
        {t('loading')}
      </span>
    )
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        {wrongChain ? (
          <button
            type="button"
            className="btn-danger text-xs"
            disabled={network.isPending}
            onClick={network.switch}
          >
            {network.isPending ? t('connecting') : tErrors('switchNetwork', { chain: chain.name })}
          </button>
        ) : null}
        <span
          className={`font-mono text-xs text-slate-700 ${wrongChain ? 'hidden sm:inline' : ''}`}
          title={`${connector?.name ?? ''} ${address}`}
        >
          {shorten(address, 6, 4)}
        </span>
        <button
          type="button"
          className="btn-secondary hidden min-h-0 border-0 py-1.5 text-sm text-slate-500 shadow-sm sm:inline-flex"
          onClick={() => disconnect()}
        >
          {t('disconnect')}
        </button>
        {/* On a phone the word does not fit next to the address; the button says it to screen readers. */}
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white text-slate-500 shadow-sm
            hover:bg-slate-100 sm:hidden"
          onClick={() => disconnect()}
          aria-label={t('disconnect')}
          title={t('disconnect')}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    )
  }

  // Some browsers show the same wallet multiple times: we display each name only once.
  const seen = new Set<string>()
  const uniqueWallets = wallets.filter(({ connector }) => {
    if (seen.has(connector.name)) return false
    seen.add(connector.name)
    return true
  })
  const hint = noWallet ? t('noWalletHint') : undefined
  const walletLabel = (passkey: boolean, name: string) => (passkey ? t('passkeyWallet') : name)

  return (
    <>
      {/* Phone: one button. With a single wallet it connects; with several it opens a short list. */}
      <div ref={menuRef} className="relative sm:hidden">
        {uniqueWallets.length <= 1 ? (
          <button
            type="button"
            className="btn-secondary min-h-0 border-0 py-1.5 text-sm shadow-sm"
            disabled={isPending || uniqueWallets.length === 0}
            title={hint}
            onClick={() => uniqueWallets[0] && connect({ connector: uniqueWallets[0].connector })}
          >
            {isPending ? t('connecting') : t('connect')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn-secondary min-h-0 border-0 py-1.5 text-sm shadow-sm"
              disabled={isPending}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {isPending ? t('connecting') : t('connect')}
            </button>
            {menuOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-2 w-60 rounded-md border border-slate-200 bg-white p-1 shadow-lg"
              >
                {uniqueWallets.map(({ connector: option, passkey, icon }) => (
                  <button
                    key={option.uid}
                    type="button"
                    role="menuitem"
                    className="flex min-h-[44px] w-full items-center gap-2 rounded px-3 py-2 text-left text-sm
                      text-slate-800 hover:bg-slate-100"
                    onClick={() => {
                      setMenuOpen(false)
                      connect({ connector: option })
                    }}
                  >
                    {/* biome-ignore lint/performance/noImgElement: 16px icon, data URI EIP-6963 */}
                    {icon ? <img src={icon} alt="" aria-hidden="true" className="h-4 w-4 rounded" /> : null}
                    {/* The label was written to follow "Connect:"; on its own it starts a sentence. */}
                    <span className="inline-block first-letter:uppercase">
                      {walletLabel(passkey, option.name)}
                    </span>
                  </button>
                ))}
                {hint ? <p className="px-3 py-2 text-xs text-slate-600">{hint}</p> : null}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="hidden flex-wrap items-center justify-end gap-2 sm:flex">
        {uniqueWallets.map(({ connector: option, passkey, icon }) => (
          <button
            key={option.uid}
            type="button"
            className="btn-secondary inline-flex min-h-0 items-center gap-1.5 py-1.5 text-xs border-0 shadow-sm"
            disabled={isPending}
            onClick={() => connect({ connector: option })}
          >
            {/* biome-ignore lint/performance/noImgElement: 16px icon, data URI EIP-6963 */}
            {icon ? <img src={icon} alt="" aria-hidden="true" className="h-4 w-4 rounded" /> : null}
            {isPending ? t('connecting') : `${t('connect')}: ${walletLabel(passkey, option.name)}`}
          </button>
        ))}
        {hint ? <span className="text-xs text-slate-600">{hint}</span> : null}
      </div>
    </>
  )
}
