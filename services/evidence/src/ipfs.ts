import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import type { EvidenceConfig } from './config.js'

/**
 * Evidence storage. Only ciphertext ever reaches this layer — IPFS is public by construction, so the content
 * address is safe to publish while the bytes behind it are meaningless without a wrapped key.
 *
 * Pinata is used when `PINATA_JWT` is set; otherwise a local filesystem mock stands in. The mock computes a real
 * CIDv1 (raw codec, sha2-256) rather than a fake identifier, so a demo CID is a genuine content address that any
 * IPFS node would agree with for the same bytes.
 */

export type IpfsBackend = 'pinata' | 'local'

export interface IpfsPutResult {
  cid: string
  backend: IpfsBackend
}

export interface IpfsClient {
  readonly backend: IpfsBackend
  put(bytes: Uint8Array, name: string): Promise<IpfsPutResult>
  get(cid: string): Promise<Buffer | null>
}

/** CIDv1, raw codec, sha2-256 — the same address `ipfs add --cid-version 1 --raw-leaves` produces. */
export const computeCidV1 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await sha256.digest(bytes)
  return CID.create(1, raw.code, digest).toString()
}

class LocalIpfs implements IpfsClient {
  readonly backend = 'local' as const

  constructor(private readonly directory: string) {}

  async put(bytes: Uint8Array): Promise<IpfsPutResult> {
    const cid = await computeCidV1(bytes)
    await mkdir(this.directory, { recursive: true })
    await writeFile(join(this.directory, `${cid}.bin`), bytes)
    return { cid, backend: this.backend }
  }

  async get(cid: string): Promise<Buffer | null> {
    // The CID is a content address, never a path component the caller controls beyond its own alphabet.
    if (!/^[A-Za-z0-9]+$/.test(cid)) return null
    try {
      return await readFile(join(this.directory, `${cid}.bin`))
    } catch {
      return null
    }
  }
}

class PinataIpfs implements IpfsClient {
  readonly backend = 'pinata' as const

  constructor(
    private readonly jwt: string,
    private readonly gateway: string,
  ) {}

  async put(bytes: Uint8Array, name: string): Promise<IpfsPutResult> {
    const form = new FormData()
    form.append(
      'file',
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }),
      name,
    )
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }))
    // Only the ciphertext's own name is pinned as metadata; nothing about the delivery or its recipients.
    form.append('pinataMetadata', JSON.stringify({ name }))

    const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.jwt}` },
      body: form,
    })
    if (!response.ok) {
      throw new Error(`Pinata upload failed with ${response.status}`)
    }
    const body = (await response.json()) as { IpfsHash?: string }
    if (!body.IpfsHash) throw new Error('Pinata response had no IpfsHash')
    return { cid: body.IpfsHash, backend: this.backend }
  }

  async get(cid: string): Promise<Buffer | null> {
    const response = await fetch(`${this.gateway}/ipfs/${cid}`)
    if (!response.ok) return null
    return Buffer.from(await response.arrayBuffer())
  }
}

export const createIpfsClient = (config: EvidenceConfig): IpfsClient =>
  config.pinataJwt ? new PinataIpfs(config.pinataJwt, config.pinataGateway) : new LocalIpfs(config.ipfsDir)
