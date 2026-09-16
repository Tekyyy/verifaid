'use client'

import { type ReactNode, useId } from 'react'

export function Panel({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  const id = `panel-${title.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <section className="card space-y-3" aria-labelledby={id}>
      <div>
        <h2 id={id} className="section-title">
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
}: Omit<BaseProps, 'placeholder' | 'inputMode'> & { options: readonly string[] }) {
  const id = useId()
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
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
