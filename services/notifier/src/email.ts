import type { NotifierConfig } from './config.js'

/**
 * Email drivers. The notifier needs no mail library: with `EMAIL_API_URL` and `EMAIL_API_KEY` it POSTs to a
 * Resend-compatible HTTP API, and without them the "outbox" driver accepts the message and does nothing else, so
 * the rendered email stays visible at `GET /outbox` for demos that have no provider.
 *
 * The recipient address is decrypted by the caller immediately before `send` and never logged or persisted; error
 * messages carry the HTTP status only, because some providers echo the recipient back in their error bodies.
 */

export interface EmailMessage {
  to: string
  subject: string
  text: string
}

export interface EmailDriver {
  readonly name: 'api' | 'outbox'
  send(message: EmailMessage): Promise<void>
}

export const outboxDriver = (): EmailDriver => ({ name: 'outbox', send: async () => {} })

export const apiDriver = (
  options: { url: string; apiKey: string; from: string; timeoutMs: number },
  doFetch: typeof fetch = fetch,
): EmailDriver => ({
  name: 'api',
  send: async (message) => {
    let response: Response
    try {
      response = await doFetch(options.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          'user-agent': 'ProofOfAid-Notifier/1',
        },
        body: JSON.stringify({
          from: options.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'unreachable'
      throw new Error(`email API ${reason}`)
    }
    await response.body?.cancel()
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`email API responded HTTP ${response.status}`)
    }
  },
})

export const createEmailDriver = (config: NotifierConfig, doFetch: typeof fetch = fetch): EmailDriver =>
  config.email.apiUrl && config.email.apiKey
    ? apiDriver(
        {
          url: config.email.apiUrl,
          apiKey: config.email.apiKey,
          from: config.email.from,
          timeoutMs: config.webhookTimeoutMs,
        },
        doFetch,
      )
    : outboxDriver()
