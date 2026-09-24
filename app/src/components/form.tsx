'use client'

import { createContext, type ReactNode, useContext, useId } from 'react'

/** Inside an accordion row the row is the frame and shows the title, so a panel drops its own card and heading. */
const BarePanel = createContext(false)

export function BarePanels({ children }: { children: ReactNode }) {
  return <BarePanel.Provider value={true}>{children}</BarePanel.Provider>
}

export function Panel({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  const bare = useContext(BarePanel)
  const id = `panel-${title.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <section className={bare ? 'space-y-3' : 'card space-y-3'} aria-labelledby={id}>
      <div>
        <h2 id={id} className={bare ? 'sr-only' : 'section-title'}>
          {title}
        </h2>
        {description ? <p className="mt-1 text-sm text-slate-700">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

interface BaseProps {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  placeholder?: string
  inputMode?: 'text' | 'numeric' | 'decimal'
  required?: boolean
}

export function TextField({ label, value, onChange, hint, placeholder, inputMode, required }: BaseProps) {
  const id = useId()
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

/** A calendar date (`YYYY-MM-DD`); empty means "not set". */
export function DateField({ label, value, onChange, hint, min }: BaseProps & { min?: string }) {
  const id = useId()
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="date"
        value={value}
        min={min}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

export function TextArea({
  label,
  value,
  onChange,
  hint,
  placeholder,
  rows = 4,
}: BaseProps & { rows?: number }) {
  const id = useId()
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="input"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  labelOf = (option) => option,
}: Omit<BaseProps, 'placeholder' | 'inputMode'> & {
  options: readonly string[]
  /** What to show for an option, when its value is not readable on its own (an id, a code). */
  labelOf?: (option: string) => string
}) {
  const id = useId()
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {labelOf(option)}
          </option>
        ))}
      </select>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p className="text-xs font-medium text-red-800" role="alert">
      {message}
    </p>
  )
}

/**
 * Everything an NGO does not have to decide to ask for money: the defaults above it are what most needs use,
 * and this holds the exact on-chain values for the ones that need to change them. Closed by default, and a
 * plain `<details>` so it works without JavaScript and is announced as a disclosure by screen readers.
 */
export function Advanced({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <details className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <summary className="cursor-pointer text-sm font-semibold text-slate-900">{title}</summary>
      {hint ? <p className="mt-1 text-xs text-slate-600">{hint}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  )
}
