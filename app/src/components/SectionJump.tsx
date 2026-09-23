'use client'

import { useEffect, useId, useState } from 'react'

interface Heading {
  id: string
  text: string
}

/**
 * A phone-only "go to" list for long consoles: thirteen panels are a long thumb-scroll. It reads the section
 * headings from the page itself, so it never drifts from what is actually there.
 */
export function SectionJump({ label, placeholder }: { label: string; placeholder: string }) {
  const id = useId()
  const [headings, setHeadings] = useState<Heading[]>([])

  useEffect(() => {
    const found = [...document.querySelectorAll<HTMLElement>('main section[aria-labelledby] > div > h2[id]')]
      .concat([...document.querySelectorAll<HTMLElement>('main section[aria-labelledby] > h2[id]')])
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((heading) => ({ id: heading.id, text: heading.innerText.trim() }))
      .filter((heading) => heading.text)
    setHeadings(found)
  }, [])

  if (headings.length < 3) return null

  return (
    <div className="sm:hidden">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="input"
        value=""
        onChange={(event) => {
          document.getElementById(event.target.value)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {headings.map((heading) => (
          <option key={heading.id} value={heading.id}>
            {heading.text}
          </option>
        ))}
      </select>
    </div>
  )
}
