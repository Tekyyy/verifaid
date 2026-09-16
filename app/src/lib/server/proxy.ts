import { NextResponse } from 'next/server'

/**
 * Shared plumbing for the route handlers that forward validated input to an internal service. Upstream error
 * bodies are passed through only in the `{ error, message }` shape the services document, never verbatim.
 */

const UPSTREAM_TIMEOUT_MS = 15_000

export const badRequest = (message: string) =>
  NextResponse.json({ error: 'invalid_request', message }, { status: 400 })

export const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const body = (await request.json()) as unknown
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export type Upstream = { ok: true; status: number; body: unknown } | { ok: false; response: NextResponse }

const parse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

export const forward = async (url: string, init: RequestInit): Promise<Upstream> => {
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    const body = parse(await response.text())
    if (!response.ok) {
      const detail = (body ?? {}) as { error?: unknown; message?: unknown }
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: typeof detail.error === 'string' ? detail.error : 'upstream_error',
            message: typeof detail.message === 'string' ? detail.message : response.statusText,
          },
          // A 5xx from the service is this gateway failing, not the caller's fault.
          { status: response.status >= 500 ? 502 : response.status },
        ),
      }
    }
    return { ok: true, status: response.status, body }
  } catch (error) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'service_unavailable', message: error instanceof Error ? error.message : 'unreachable' },
        { status: 502 },
      ),
    }
  }
}

export const isNeedId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)
