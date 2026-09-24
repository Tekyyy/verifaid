import { CATEGORIES } from '@poa/shared'

/** A basket's name in the reader's language ("WATER" → "Water"); an unknown label is shown as it is. */
export const basketName = (t: (key: string) => string, category: string): string => {
  const label = category.toUpperCase()
  return (CATEGORIES as readonly string[]).includes(label) ? t(`name.${label}`) : category
}
