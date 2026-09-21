'use client'

import { easAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { useAccount } from 'wagmi'
import { ConnectButton } from '@/components/ConnectButton'
import { FormError, Panel, TextArea, TextField } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { communityAttestationRequest, hasCommunitySchema } from '@/lib/eas'
import { ZERO_BYTES32 } from '@/lib/format'
import { useTx } from '@/lib/hooks'

/**
 * Applying to be a supplier. Anyone can sign one of these for their own address — it is a public request, and
 * the attestation is what an admin reviews. It grants nothing: `SUPPLIER_ROLE` stays an admin decision on
 * chain, because "this supplier is independent of the NGO" is a judgement the chain cannot make (THREAT_MODEL
 * §3.15). What the chain does give you is that the request, and who signed it, are public and dated.
 */
export function SupplierApplyPanel() {
  const t = useTranslations('suppliers')
  const tx = useTx()
  const { address, isConnected } = useAccount()
  const [name, setName] = useState('')
  const [services, setServices] = useState('')
  const [uri, setUri] = useState('')
  const [credential, setCredential] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!hasCommunitySchema('SupplierApplication')) return null

  const credentialHash: Hex = credential.trim() ? keccak256(stringToHex(credential.trim())) : ZERO_BYTES32

  const apply = async () => {
    if (!address) return setError(t('applyErrorConnect'))
    if (!name.trim() || !services.trim()) return setError(t('applyErrorFields'))
    setError(null)
    await tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        communityAttestationRequest('SupplierApplication', [
          address,
          name.trim(),
          services.trim(),
          uri.trim(),
          credentialHash,
        ]),
      ],
    })
  }

  return (
    <Panel title={t('applyTitle')} description={t('applyBody')}>
      {!isConnected ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-700">{t('applyConnect')}</p>
          <ConnectButton />
        </div>
      ) : (
        <p className="hint mono">{address}</p>
      )}

      <TextField label={t('applyName')} value={name} onChange={setName} />
      <TextArea label={t('applyServices')} value={services} onChange={setServices} rows={3} />
      <TextField label={t('applyUri')} value={uri} onChange={setUri} placeholder="https://…" />
      <TextField
        label={t('applyCredential')}
        value={credential}
        onChange={setCredential}
        hint={t('applyCredentialHint')}
      />

      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={!isConnected || tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={apply}
      >
        {t('applySubmit')}
      </button>
      <TxStatus state={tx} />
      <p className="hint">{t('applyAfter')}</p>
    </Panel>
  )
}
