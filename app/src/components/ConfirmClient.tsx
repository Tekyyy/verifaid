'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'

/**
 * The beneficiary confirmation flow.
 *
 * Four rules shape this component:
 * 1. The identity secret never leaves the device. It is read from and written to local storage only, and is
 *    never put in a URL, a log or a request body.
 * 2. One identity per programme. Semaphore publishes every commitment in a group, so reusing one commitment
 *    across two programmes would let anyone intersect the two member lists and learn exactly who is in both.
 *    The device secret stays global; the identity handed to Semaphore is derived per programme.
 * 3. The proof is generated here, in the browser, and submitted through the relayer route — if the
 *    beneficiary sent the transaction themselves, their address would be linked to the confirmation on chain
 *    and the anonymity the proof provides would be lost.
 * 4. Everything expensive (`@semaphore-protocol/*`, snarkjs, the QR encoder) is imported dynamically, so the
 *    initial payload of this page stays small on a low-end phone.
 */

const STORAGE_KEY = 'poa.identity.v1'

/** Domain separation between programmes; see rule 2 and docs/THREAT_MODEL.md §4. */
const programScopedSecret = (secret: string, programId: string): string => `${secret}:program:${programId}`

type Phase = 'loading' | 'ready' | 'proving' | 'submitting' | 'done' | 'error'

const randomSecret = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const readStoredSecret = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

const writeStoredSecret = (secret: string): boolean => {
  try {
    localStorage.setItem(STORAGE_KEY, secret)
    return true
  } catch {
    return false
  }
}

export function ConfirmClient({
  deliveryId,
  programId,
  message,
  members,
  deliveryOpen,
}: {
  deliveryId: string
  programId: string
  /** `AID_RECEIVED_MESSAGE` as a decimal string, computed on the server so this bundle needs no crypto lib. */
  message: string
  /** Inlined when the group is small; otherwise fetched on demand. */
  members: string[] | null
  deliveryOpen: boolean
}) {
  const t = useTranslations('confirm')
  const tCommon = useTranslations('common')

  const [phase, setPhase] = useState<Phase>('loading')
  const [secret, setSecret] = useState<string | null>(null)
  const [commitment, setCommitment] = useState<string | null>(null)
  const [persisted, setPersisted] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [qr, setQr] = useState<{ path: string; size: number } | null>(null)
  const [cardSecret, setCardSecret] = useState('')
  const [copied, setCopied] = useState(false)

  /** Always derives through the programme scope, so no two programmes ever see the same commitment. */
  const deriveCommitment = useCallback(
    async (deviceSecret: string) => {
      const { Identity } = await import('@semaphore-protocol/identity')
      return new Identity(programScopedSecret(deviceSecret, programId)).commitment.toString()
    },
    [programId],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let stored = readStoredSecret()
      let kept = true
      if (!stored) {
        stored = randomSecret()
        kept = writeStoredSecret(stored)
      }
      const derived = await deriveCommitment(stored)
      if (cancelled) return
      setSecret(stored)
      setCommitment(derived)
      setPersisted(kept)
      setPhase('ready')
    })()
    return () => {
      cancelled = true
    }
  }, [deriveCommitment])

  const showQr = async () => {
    if (qr) return setQr(null)
    if (!commitment) return
    const { encodeQr, qrToSvgPath } = await import('@/lib/qr')
    setQr(qrToSvgPath(encodeQr(commitment)))
  }

  const copy = async () => {
    if (!commitment) return
    try {
      await navigator.clipboard.writeText(commitment)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const useCard = async () => {
    const value = cardSecret.trim()
    if (!value) return
    const derived = await deriveCommitment(value)
    // Deliberately not written to storage: a kiosk must not keep a card holder's secret.
    setSecret(value)
    setCommitment(derived)
    setPersisted(false)
    setQr(null)
  }

  const forget = () => {
    if (!window.confirm(t('clearConfirm'))) return
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Nothing to remove if storage is unavailable.
    }
    const next = randomSecret()
    const kept = writeStoredSecret(next)
    void deriveCommitment(next).then((derived) => {
      setSecret(next)
      setCommitment(derived)
      setPersisted(kept)
      setQr(null)
    })
  }

  const loadMembers = async (): Promise<string[]> => {
    if (members) return members
    const response = await fetch(`/api/indexer/programs/${encodeURIComponent(programId)}/members`, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error('members')
    const data = (await response.json()) as { members?: string[] }
    if (!data.members) throw new Error('members')
    return data.members
  }

  const confirm = async () => {
    if (!secret) return
    setError(null)
    setPhase('proving')
    try {
      const list = await loadMembers()
      const [{ Identity }, { Group }, { generateProof }] = await Promise.all([
        import('@semaphore-protocol/identity'),
        import('@semaphore-protocol/group'),
        import('@semaphore-protocol/proof'),
      ])

      const identity = new Identity(programScopedSecret(secret, programId))
      const group = new Group(list.map((value) => BigInt(value)))
      if (group.indexOf(identity.commitment) < 0) {
        setError(t('notEnrolled'))
        setPhase('error')
        return
      }

      // scope = deliveryId makes the nullifier unique per beneficiary per delivery.
      const proof = await generateProof(identity, group, message, deliveryId)

      setPhase('submitting')
      const response = await fetch('/api/relay/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryId, proof }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `${response.status}`)
        setPhase('error')
        return
      }
      setPhase('done')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setPhase('error')
    }
  }

  if (phase === 'done') {
    return (
      <div className="mt-8 rounded-lg border-2 border-emerald-500 bg-emerald-50 p-5 text-center">
        <p className="text-xl font-bold text-emerald-900">{t('done')}</p>
        <p className="mt-2 text-sm text-emerald-900">{t('doneBody')}</p>
      </div>
    )
  }

  const busy = phase === 'proving' || phase === 'submitting'

  return (
    <div className="mt-6 space-y-6">
      <section aria-labelledby="identity">
        <h2 id="identity" className="text-lg font-semibold">
          {t('step1')}
        </h2>
        <p className="mt-1 text-sm text-slate-700">{t('step1Body')}</p>

        {phase === 'loading' ? (
          <p className="mt-3 text-sm text-slate-600">{t('generating')}</p>
        ) : (
          <>
            <p className="mt-3 text-xs text-slate-600">{t('commitment')}</p>
            <p className="mono select-all rounded-md border border-slate-300 bg-white p-3 text-[13px] leading-5">
              {commitment}
            </p>
            <p className="mt-1 text-xs text-slate-600">{t('programScoped')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" onClick={copy}>
                {copied ? tCommon('copied') : tCommon('copy')}
              </button>
              <button type="button" className="btn-secondary" onClick={showQr}>
                {qr ? t('hideQr') : t('showQr')}
              </button>
            </div>

            {qr ? (
              <svg
                className="mt-3 h-auto w-full max-w-[280px] bg-white"
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                role="img"
                aria-label={t('qrAlt')}
                shapeRendering="crispEdges"
              >
                <rect width={qr.size} height={qr.size} fill="#ffffff" />
                <path d={qr.path} fill="#000000" />
              </svg>
            ) : null}

            {!persisted ? <p className="mt-2 text-xs text-amber-800">{t('storageUnavailable')}</p> : null}
          </>
        )}
      </section>

      <section aria-labelledby="confirm">
        <h2 id="confirm" className="text-lg font-semibold">
          {t('step2')}
        </h2>
        <p className="mt-1 text-sm text-slate-700">{t('step2Body')}</p>

        {!deliveryOpen ? <p className="mt-2 text-sm font-medium text-amber-800">{t('notOpen')}</p> : null}

        <button
          type="button"
          className="btn-primary btn-lg mt-4 w-full"
          disabled={phase === 'loading' || busy || !deliveryOpen}
          onClick={confirm}
        >
          {phase === 'proving' ? t('proving') : phase === 'submitting' ? t('submitting') : t('confirmButton')}
        </button>

        <p aria-live="polite" className="mt-2 min-h-[1.25rem] text-sm">
          {phase === 'error' ? (
            <span className="text-red-800">
              {t('failed')} {error}
            </span>
          ) : null}
        </p>

        {phase === 'error' ? (
          <button type="button" className="btn-secondary w-full" onClick={confirm}>
            {t('retry')}
          </button>
        ) : null}
      </section>

      <details className="rounded-md border border-slate-300 bg-white p-3">
        <summary className="cursor-pointer text-sm font-semibold">{t('advanced')}</summary>

        <div className="mt-3 space-y-3">
          <div className="rounded-md border border-amber-400 bg-amber-50 p-3">
            <p className="text-sm font-semibold text-amber-900">{t('cardModeTitle')}</p>
            <p className="mt-1 text-xs text-amber-900">{t('cardModeWarning')}</p>
            <p className="mt-1 text-xs text-amber-900">{t('cardModeBody')}</p>
            <label className="label mt-2" htmlFor="card-secret">
              {t('cardSecret')}
            </label>
            <input
              id="card-secret"
              className="input"
              value={cardSecret}
              autoComplete="off"
              onChange={(event) => setCardSecret(event.target.value)}
            />
            <button type="button" className="btn-secondary mt-2 w-full" onClick={useCard}>
              {t('useCard')}
            </button>
          </div>

          <button type="button" className="btn-danger w-full" onClick={forget}>
            {t('clearIdentity')}
          </button>
        </div>
      </details>
    </div>
  )
}
