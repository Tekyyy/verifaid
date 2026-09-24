'use client'

import {
  beneficiaryRegistryAbi,
  certificationArgs,
  decodeCertificate,
  needsRegistryAbi,
  type SignedCertificate,
} from '@poa/shared'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, isAddressEqual } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { CreateNeedPanel } from '@/components/CreateNeedPanel'
import { ExplorerLink } from '@/components/ExplorerLink'
import { TextArea } from '@/components/form'
import { Notice } from '@/components/Notice'
import { Link } from '@/i18n/navigation'
import { chainId, deployment } from '@/lib/config'
import { timestamp } from '@/lib/format'
import { useMounted } from '@/lib/hooks'

/** Statuses after which a need is over, and its beneficiary may post the next one. */
const OVER = new Set([5, 6, 7]) // Completed, Cancelled, Expired

/** The certificate code from a pasted link, or the code itself when that is what was pasted. */
const codeFrom = (text: string): string | null => {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).searchParams.get('cert')
  } catch {
    return trimmed
  }
}

/**
 * Where a certified beneficiary posts a need of their own. They arrive with the link their NGO gave them (or paste
 * it); the page reads the certificate, checks it is theirs and still stands, and only then shows the need form.
 */
export function ApplyForNeed() {
  const t = useTranslations('apply')
  const fromLink = useSearchParams().get('cert')
  const [pasted, setPasted] = useState('')
  const code = fromLink ?? codeFrom(pasted)
  const decoded = code ? decodeCertificate(code) : null
  const registry = deployment?.contracts.BeneficiaryRegistry as Address | undefined

  if (!registry)
    return (
      <Notice tone="warning" title={t('unsupportedTitle')}>
        {t('unsupportedBody')}
      </Notice>
    )

  return (
    <div className="space-y-6">
      {!fromLink ? (
        <div className="card">
          <TextArea
            label={t('pasteLabel')}
            value={pasted}
            onChange={setPasted}
            rows={3}
            hint={t('pasteHint')}
          />
        </div>
      ) : null}
      {decoded && !decoded.ok ? (
        <Notice tone="error" title={t('badLink')}>
          {decoded.error}
        </Notice>
      ) : null}
      {decoded?.ok ? <CertifiedApplication certificate={decoded.value} registry={registry} /> : null}
      {!code ? <Notice title={t('noLinkTitle')}>{t('noLinkBody')}</Notice> : null}
    </div>
  )
}

function CertifiedApplication({
  certificate,
  registry,
}: {
  certificate: SignedCertificate
  registry: Address
}) {
  const t = useTranslations('apply')
  const mounted = useMounted()
  const { address } = useAccount()
  const c = certificate.certification
  const sameNetwork = certificate.chainId === chainId && isAddressEqual(certificate.registry, registry)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const expired = now >= c.expiresAt
  const theirs = Boolean(address && isAddressEqual(address, c.beneficiary))

  const { data: accepted } = useReadContract({
    address: registry,
    abi: beneficiaryRegistryAbi,
    functionName: 'isCertified',
    args: [certificationArgs(c), certificate.signature],
    query: { enabled: sameNetwork },
  })
  const { data: lastNeed } = useReadContract({
    address: registry,
    abi: beneficiaryRegistryAbi,
    functionName: 'lastNeedOf',
    args: [c.beneficiary],
    query: { enabled: sameNetwork },
  })
  const { data: lastStatus } = useReadContract({
    address: deployment?.contracts.NeedsRegistry as Address,
    abi: needsRegistryAbi,
    functionName: 'statusOf',
    args: lastNeed ? [lastNeed] : undefined,
    query: { enabled: Boolean(lastNeed) },
  })
  const openNeed = lastNeed && lastStatus !== undefined && !OVER.has(Number(lastStatus)) ? lastNeed : null

  const facts = (
    <section className="card space-y-2" aria-labelledby="certificate-title">
      <h2 id="certificate-title" className="section-title">
        {t('certificateTitle')}
      </h2>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-600">{t('ngo')}</dt>
          <dd>
            <ExplorerLink kind="address" value={c.ngo} />
          </dd>
        </div>
        <div>
          <dt className="text-slate-600">{t('program')}</dt>
          <dd>#{c.programId.toString()}</dd>
        </div>
        <div>
          <dt className="text-slate-600">{t('wallet')}</dt>
          <dd>
            <ExplorerLink kind="address" value={c.beneficiary} />
          </dd>
        </div>
        <div>
          <dt className="text-slate-600">{t('validUntil')}</dt>
          <dd>{timestamp(Number(c.expiresAt))}</dd>
        </div>
      </dl>
      <p className="hint">{t('certificateHint')}</p>
    </section>
  )

  const blocker = (() => {
    if (!sameNetwork)
      return (
        <Notice tone="error" title={t('otherNetworkTitle')}>
          {t('otherNetworkBody')}
        </Notice>
      )
    if (expired)
      return (
        <Notice tone="error" title={t('expiredTitle')}>
          {t('expiredBody')}
        </Notice>
      )
    if (!mounted || !address)
      return <Notice title={t('connectTitle')}>{t('connectBody', { wallet: c.beneficiary })}</Notice>
    if (!theirs) {
      return (
        <Notice tone="warning" title={t('wrongWalletTitle')}>
          {t('wrongWalletBody', { wallet: c.beneficiary })}
        </Notice>
      )
    }
    if (accepted === false)
      return (
        <Notice tone="error" title={t('refusedTitle')}>
          {t('refusedBody')}
        </Notice>
      )
    if (openNeed) {
      return (
        <Notice title={t('openNeedTitle', { id: openNeed.toString() })}>
          <p>{t('openNeedBody')}</p>
          <p className="mt-2">
            <Link href={`/beneficiary?need=${openNeed.toString()}`}>{t('openNeedLink')}</Link>
          </p>
        </Notice>
      )
    }
    return null
  })()

  return (
    <div className="space-y-6">
      {facts}
      {blocker ?? <CreateNeedPanel certificate={certificate} />}
    </div>
  )
}
