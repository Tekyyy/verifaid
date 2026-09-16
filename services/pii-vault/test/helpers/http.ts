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

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
