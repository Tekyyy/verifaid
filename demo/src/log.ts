import { easAttestationUrl, explorerTxUrl, type NetworkName } from '@poa/shared'

/** Minimal console formatting: the demo output is read by judges, so it has to stay scannable. */

let stepNumber = 0

export const step = (title: string): void => {
  stepNumber += 1
  console.log(`\n${String(stepNumber).padStart(2, ' ')}. ${title}`)
  console.log(`    ${'-'.repeat(Math.min(title.length, 70))}`)
}

export const info = (label: string, value: string | number | bigint): void => {
  console.log(`    ${label.padEnd(22)} ${value}`)
}

export const tx = (network: NetworkName, label: string, hash: `0x${string}`): void => {
  const url = explorerTxUrl(network, hash)
  console.log(`    ${label.padEnd(22)} ${url ?? hash}`)
}

export const attestation = (network: NetworkName, label: string, uid: `0x${string}`): void => {
  const url = easAttestationUrl(network, uid)
  console.log(`    ${label.padEnd(22)} ${url ?? uid}`)
}

export const note = (message: string): void => console.log(`    ${message}`)

export const heading = (message: string): void => {
  console.log(`\n${'='.repeat(78)}\n${message}\n${'='.repeat(78)}`)
}

export const fail = (message: string): never => {
  console.error(`\nFAILED: ${message}`)
  process.exit(1)
}
