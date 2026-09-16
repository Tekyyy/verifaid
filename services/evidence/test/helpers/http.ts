import type { FastifyInstance } from 'fastify'
import type { HDAccount } from 'viem/accounts'

/** Completes the SIWE handshake against the running app and returns a bearer token. */
export const login = async (app: FastifyInstance, account: HDAccount): Promise<string> => {
  const challenge = await app.inject({
    method: 'POST',
    url: '/auth/nonce',
    payload: { address: account.address },
  })
  if (challenge.statusCode !== 200) throw new Error(`nonce failed: ${challenge.body}`)
  const { message } = challenge.json<{ message: string }>()

  const verified = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { message, signature: await account.signMessage({ message }) },
  })
  if (verified.statusCode !== 200) throw new Error(`verify failed: ${verified.body}`)
  return verified.json<{ token: string }>().token
}

export interface MultipartFile {
  field: string
  filename: string
  contentType: string
  data: Buffer
}

/**
 * Serialises a multipart body with the platform's own encoder, so `fastify.inject` receives exactly the bytes a
 * browser would send instead of a hand-rolled approximation of the format under test.
 */
export const multipartBody = async (
  fields: Record<string, string>,
  files: MultipartFile[],
): Promise<{ payload: Buffer; headers: Record<string, string> }> => {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) form.append(name, value)
  for (const file of files) {
    form.append(
      file.field,
      new Blob([file.data as unknown as Uint8Array<ArrayBuffer>], { type: file.contentType }),
      file.filename,
    )
  }

  const encoded = new Response(form)
  return {
    payload: Buffer.from(await encoded.arrayBuffer()),
    headers: { 'content-type': encoded.headers.get('content-type') ?? 'multipart/form-data' },
  }
}
