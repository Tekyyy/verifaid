'use client'

/**
 * localStorage that never throws. Private windows, blocked site data and storage quotas all make the accessor
 * throw or return nothing; every caller must work without it, so a failure here just reads as "nothing saved".
 */

export const readStored = <T>(key: string, isValid: (value: unknown) => value is T): T | null => {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    return isValid(value) ? value : null
  } catch {
    return null
  }
}

/** Returns false when the value could not be kept. `null` removes the key. */
export const writeStored = (key: string, value: unknown): boolean => {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}
