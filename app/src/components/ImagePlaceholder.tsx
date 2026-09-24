import { imageSrc } from '@/lib/format'

/**
 * A marked slot where a photo or illustration belongs until one is chosen: teal-tinted, dashed, and labelled with
 * what should go there, so a missing picture reads as "to do" rather than as a broken page. Never people's faces:
 * the labels say so wherever a photo would be of aid being delivered.
 */
export function ImagePlaceholder({
  label,
  hint,
  className = '',
  shape = 'rect',
  flush = false,
}: {
  /** What belongs here, e.g. "Cover photo". Also the accessible name. */
  label: string
  hint?: string
  /** Size and aspect ratio, e.g. "aspect-[16/9] w-full". */
  className?: string
  shape?: 'rect' | 'circle'
  /** Edge to edge inside a card that already rounds its corners: no border of its own but a dashed bottom edge. */
  flush?: boolean
}) {
  const circle = shape === 'circle'
  const frame = flush
    ? 'border-b-2 border-dashed border-teal-200'
    : `border-2 border-dashed border-teal-200 ${circle ? 'rounded-full' : 'rounded-xl'}`
  return (
    <div
      role="img"
      aria-label={label}
      className={`flex flex-col items-center justify-center gap-1.5 overflow-hidden bg-gradient-to-br from-teal-50
        via-white to-teal-100 text-center ${frame} ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        className={circle ? 'h-5 w-5 text-teal-500' : 'h-8 w-8 text-teal-500'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="m21 16-5-5-9 9" />
      </svg>
      {circle ? null : (
        <>
          <span className="px-3 text-xs font-semibold text-teal-800">{label}</span>
          {hint ? (
            <span className="max-w-xs px-3 text-[11px] leading-snug text-slate-500">{hint}</span>
          ) : null}
        </>
      )}
    </div>
  )
}

/** A photo when there is one, otherwise the slot it belongs in. */
export function CoverImage({
  src,
  label,
  hint,
  className = '',
  flush = false,
}: {
  src: string | null | undefined
  label: string
  hint?: string
  className?: string
  flush?: boolean
}) {
  if (!src) return <ImagePlaceholder label={label} hint={hint} className={className} flush={flush} />
  return (
    // biome-ignore lint/performance/noImgElement: images are hosted by the NGO or beneficiary; there is no loader for them
    <img
      src={imageSrc(src)}
      alt=""
      referrerPolicy="no-referrer"
      className={`${flush ? '' : 'rounded-xl '}bg-slate-100 object-cover ${className}`}
    />
  )
}
