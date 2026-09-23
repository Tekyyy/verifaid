/**
 * The chain only keeps the hash of a programme's enrollment rules, so an id is all a list of programmes can
 * show. The browser that wrote the rules remembers them, keyed by that hash, to label the programme on this
 * device. Rules, not people: nothing personal is ever typed there. Never read by anything but the pickers.
 */

const STORAGE_KEY = 'verifaid:program-policies'
const MAX_LABEL = 60

const read = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export const rememberProgramPolicy = (policyHash: string, text: string): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...read(), [policyHash.toLowerCase()]: text.trim() }))
  } catch {
    // Private windows and blocked storage: the picker falls back to the id.
  }
}

/** The rules this browser wrote for the programme, shortened for a dropdown, or null when it did not write them. */
export const programPolicyLabel = (policyHash: string): string | null => {
  const text = read()[policyHash.toLowerCase()]?.replace(/\s+/g, ' ')
  if (!text) return null
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text
}
