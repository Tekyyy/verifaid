'use client'

import { easAbi, roleRegistryAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, isAddress } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { FormError, Panel, TextField } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { communityAttestationRequest, hasCommunitySchema } from '@/lib/eas'
import { useTx } from '@/lib/hooks'

/**
 * An organisation states its tax standing, and the platform admin can sign that it checked it. Both are the
 * same attestation under the same schema — who signed it is what separates a claim from a verification, which
 * is the only honest way to put this on a chain that cannot read a tax register.
 *
 * The number published here is an organisation's public registration number (an EIN for a US 501(c)(3)).
 * A donor's tax number has no place in this system and is never asked for.
 */
export function TaxStatusPanel() {
  const t = useTranslations('tax')
  const tx = useTx()
  const { address } = useAccount()
  const [org, setOrg] = useState('')
  const [jurisdiction, setJurisdiction] = useState('US')
  const [taxId, setTaxId] = useState('')
  const [legalName, setLegalName] = useState('')
  const [source, setSource] = useState('')
  const [error, setError] = useState<string | null>(null)

  const roles = deployment?.contracts.RoleRegistry as Address | undefined
  const { data: adminRole } = useReadContract({
    address: roles,
    abi: roleRegistryAbi,
    functionName: 'DEFAULT_ADMIN_ROLE',
    query: { enabled: Boolean(roles) },
  })
  const { data: isAdmin } = useReadContract({
    address: roles,
    abi: roleRegistryAbi,
    functionName: 'hasRole',
    args: adminRole && address ? [adminRole, address] : undefined,
    query: { enabled: Boolean(roles && adminRole && address) },
  })

  if (!hasCommunitySchema('OrgTaxStatus')) return null

  // An organisation signs for itself; the admin signs for someone else, which is what marks it checked.
  const subject = isAdmin && org.trim() ? org.trim() : (address ?? '')

  const publish = async () => {
    if (!isAddress(subject)) return setError(t('errorOrg'))
    if (!jurisdiction.trim() || !taxId.trim() || !legalName.trim()) return setError(t('errorFields'))
    setError(null)
    await tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        communityAttestationRequest('OrgTaxStatus', [
          subject as Address,
          jurisdiction.trim(),
          taxId.trim(),
          legalName.trim(),
          source.trim(),
        ]),
      ],
    })
  }

  return (
    <Panel title={t('statusTitle')} description={t('statusBody')}>
      {isAdmin ? (
        <TextField
          label={t('statusOrg')}
          value={org}
          onChange={setOrg}
          placeholder="0x…"
          hint={t('statusOrgHint')}
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('statusJurisdiction')} value={jurisdiction} onChange={setJurisdiction} />
        <TextField label={t('statusTaxId')} value={taxId} onChange={setTaxId} hint={t('statusTaxIdHint')} />
      </div>
      <TextField label={t('statusLegalName')} value={legalName} onChange={setLegalName} />
      <TextField
        label={isAdmin ? t('statusCheckedVia') : t('statusSource')}
        value={source}
        onChange={setSource}
        placeholder={isAdmin ? t('statusCheckedViaPlaceholder') : 'https://…'}
        hint={isAdmin ? t('statusCheckedViaHint') : t('statusSourceHint')}
      />

      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={publish}
      >
        {isAdmin && org.trim() ? t('statusVerify') : t('statusPublish')}
      </button>
      <TxStatus state={tx} />
      <p className="hint">{isAdmin && org.trim() ? t('statusVerifyHint') : t('statusPublishHint')}</p>
    </Panel>
  )
}
