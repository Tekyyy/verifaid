import type { ConversionView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { amount, decimalsOfSymbol, tokenAmount } from '@/lib/format'

/**
 * One line for a CONVERTED donation: what was given, what it was worth at Chainlink prices, and what the swap cost.
 * The cost is computed on-chain (fair value minus output), not reported by anyone.
 */
export function ConversionNote({
  conversion,
  className = 'mt-1 text-slate-700 tabular-nums',
}: {
  conversion: ConversionView
  className?: string
}) {
  const t = useTranslations('need')
  const unit = useTranslations('common')('amountUnit')
  const fairValue = amount(conversion.fairValue)
  const fee = amount(conversion.conversionFee)

  if (!conversion.tokenInSymbol) {
    // Several sweeps of different tokens combined, or the swap event not indexed yet.
    return (
      <p className={className}>
        {conversion.fairValue === '0'
          ? t('conversionPending')
          : t('conversionMixed', { fairValue, fee, unit })}
      </p>
    )
  }

  return (
    <p className={className}>
      {t('conversionLine', {
        amountIn: tokenAmount(conversion.amountIn, decimalsOfSymbol(conversion.tokenInSymbol)),
        symbol: conversion.tokenInSymbol,
        fairValue,
        fee,
        unit,
      })}
    </p>
  )
}
