'use client'

import {
  beneficiaryRegistryAbi,
  certificationArgs,
  certificationTypedData,
  DEFAULT_CERTIFICATE_DAYS,
  encodeCertificate,
  MAX_CERTIFICATE_DAYS,
  roleRegistryAbi,
  type SignedCertificate,
} from '@poa/shared'
import { useLocale, useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, getAddress, isAddress } from 'viem'
import { useAccount, usePublicClient, useReadContract, useSignTypedData } from 'wagmi'
import { FormError, Panel, TextField } from '@/components/form'
import { Notice } from '@/components/Notice'
import { ProgramPicker } from '@/components/ProgramPicker'
import { TxStatus } from '@/components/TxStatus'
import { chainId, deployment } from '@/lib/config'
import { timestamp } from '@/lib/format'
import { useMounted, useTx } from '@/lib/hooks'

/** A few seconds behind the browser's clock, so a chain whose clock trails it still sees the certificate as issued. */
const CLOCK_SLACK_SECONDS = 60

type Signing = { phase: 'idle' } | { phase: 'signing' } | { phase: 'failed'; error: string }

/**
 * An NGO certifies one of its beneficiaries' wallets, so that person can post a need of their own. Nothing is
 * written anywhere: the NGO signs a certificate in its wallet (no gas) and hands the beneficiary a private link —
 * too long for a QR code, so it travels as a message.
 * The list of who it certified stays in the NGO's own records; the chain learns of a wallet only when its owner
 * posts a need with the certificate.
 */
export function CertifyBeneficiaryPanel() {
  const t = useTranslations('certify')
  const tErrors = useTranslations('errors')
  const locale = useLocale()
  const mounted = useMounted()
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { signTypedDataAsync } = useSignTypedData()
  const registry = deployment?.contracts.BeneficiaryRegistry as Address | undefined

  const [wallet, setWallet] = useState('')
  const [programId, setProgramId] = useState('')
  const [days, setDays] = useState(String(DEFAULT_CERTIFICATE_DAYS))
  const [error, setError] = useState<string | null>(null)
  const [signing, setSigning] = useState<Signing>({ phase: 'idle' })
  const [issued, setIssued] = useState<{ link: string; certificate: SignedCertificate } | null>(null)
  const [copied, setCopied] = useState(false)

  const valid = isAddress(wallet)
  const beneficiary = valid ? getAddress(wallet) : undefined

  // An NGO, a verifier, a supplier or a payout Safe can never post as a beneficiary: say so before signing.
  const { data: hasRole } = useReadContract({
    address: deployment?.contracts.RoleRegistry as Address | undefined,
    abi: roleRegistryAbi,
    functionName: 'holdsOperationalRole',
    args: beneficiary ? [beneficiary] : undefined,
    query: { enabled: Boolean(beneficiary && deployment) },
  })
  const { data: revokedAt } = useReadContract({
    address: registry,
    abi: beneficiaryRegistryAbi,
    functionName: 'revokedAt',
    args: address && beneficiary ? [address, beneficiary] : undefined,
    query: { enabled: Boolean(registry && address && beneficiary) },
  })

  if (!registry) return null

  const sign = async () => {
    const lifetime = Number(days)
    if (!beneficiary) return setError(t('errorWallet'))
    if (!/^\d+$/.test(programId)) return setError(tErrors('required'))
    if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_CERTIFICATE_DAYS) {
      return setError(t('errorDays', { max: MAX_CERTIFICATE_DAYS }))
    }
    if (hasRole) return setError(t('errorRole'))
    if (!address) return
    setError(null)
    setIssued(null)

    const now = BigInt(Math.floor(Date.now() / 1000))
    // A certificate issued no later than a withdrawal is void, so a fresh one must start after it.
    const floor = (revokedAt ?? 0n) + 1n
    const slack = now - BigInt(CLOCK_SLACK_SECONDS)
    const issuedAt = slack > floor ? slack : floor
    const certification = {
      beneficiary,
      ngo: address,
      programId: BigInt(programId),
      issuedAt,
      expiresAt: now + BigInt(lifetime * 86_400),
    }

    setSigning({ phase: 'signing' })
    try {
      const signature = await signTypedDataAsync(
        certificationTypedData({ chainId, registry, ...certification }),
      )
      // Ask the contract itself, so the NGO never hands out a link that would be refused.
      const accepted = await publicClient?.readContract({
        address: registry,
        abi: beneficiaryRegistryAbi,
        functionName: 'isCertified',
        args: [certificationArgs(certification), signature],
      })
      if (accepted === false) {
        setSigning({ phase: 'failed', error: t('errorRefused') })
        return
      }
      const certificate: SignedCertificate = { certification, signature, chainId, registry }
      const link = `${window.location.origin}/${locale}/apply?cert=${encodeCertificate(certificate)}`
      setIssued({ link, certificate })
      setSigning({ phase: 'idle' })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message.split('\n')[0] : String(caught)
      setSigning({ phase: 'failed', error: message ?? 'failed' })
    }
  }

  const copy = async () => {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Panel title={t('title')} description={t('body')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('wallet')}
          value={wallet}
          onChange={setWallet}
          placeholder="0x…"
          hint={t('walletHint')}
        />
        <ProgramPicker value={programId} onChange={setProgramId} />
        <TextField
          label={t('days')}
          value={days}
          onChange={setDays}
          inputMode="numeric"
          hint={t('daysHint', { max: MAX_CERTIFICATE_DAYS })}
        />
      </div>
      {hasRole ? <p className="text-sm text-red-800">{t('errorRole')}</p> : null}
      <p className="hint">{t('privacyHint')}</p>
      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={!mounted || !address || signing.phase === 'signing'}
        onClick={sign}
      >
        {signing.phase === 'signing' ? t('signing') : t('sign')}
      </button>
      {signing.phase === 'failed' ? <p className="text-sm text-red-800">{signing.error}</p> : null}

      {issued ? (
        <Notice tone="success" title={t('issuedTitle')}>
          <p>
            {t('issuedBody', {
              wallet: issued.certificate.certification.beneficiary,
              date: timestamp(Number(issued.certificate.certification.expiresAt)),
            })}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              readOnly
              value={issued.link}
              aria-label={t('link')}
            />
            <button type="button" className="btn-secondary text-xs" onClick={copy} aria-live="polite">
              {copied ? t('copied') : t('copy')}
            </button>
          </div>
          <p className="mt-2 text-xs">{t('issuedPrivate')}</p>
        </Notice>
      ) : null}
    </Panel>
  )
}

/**
 * Withdrawing a certification before it expires. It is the one step that puts a wallet on chain without its owner
 * choosing to appear, so the panel says so before the NGO signs.
 */
export function RevokeCertificationPanel() {
  const t = useTranslations('certify')
  const tx = useTx()
  const [wallet, setWallet] = useState('')
  const registry = deployment?.contracts.BeneficiaryRegistry as Address | undefined
  if (!registry) return null

  return (
    <Panel title={t('revokeTitle')} description={t('revokeBody')}>
      <TextField label={t('wallet')} value={wallet} onChange={setWallet} placeholder="0x…" />
      <button
        type="button"
        className="btn-secondary"
        disabled={!isAddress(wallet) || tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={() =>
          tx.run({
            address: registry,
            abi: beneficiaryRegistryAbi,
            functionName: 'revoke',
            args: [getAddress(wallet)],
          })
        }
      >
        {t('revoke')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}
