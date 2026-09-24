'use client'

import { useEffect, useRef, useState } from 'react'

const FRAME = 'h-16 w-16 shrink-0 overflow-hidden rounded-lg sm:h-24 sm:w-36'

/**
 * An article's preview image, hosted by the news site; the category's icon instead when there is none, or when the
 * site refuses to serve it to us (hotlink protection is common). No referrer, so the site does not learn which need
 * the reader was on.
 */
export function NewsThumb({ src, icon }: { src: string | null; icon: string }) {
  const [failed, setFailed] = useState(false)
  const image = useRef<HTMLImageElement>(null)

  // An image that failed before the page hydrated fired its error event with no one listening.
  useEffect(() => {
    const element = image.current
    if (element?.complete && element.naturalWidth === 0) setFailed(true)
  }, [])

  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        className={`${FRAME} grid place-items-center bg-gradient-to-br from-teal-50 to-teal-100 text-2xl sm:text-3xl`}
      >
        {icon}
      </span>
    )
  }
  return (
    // biome-ignore lint/performance/noImgElement: news sites host these; there is no loader for them
    <img
      ref={image}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${FRAME} bg-slate-100 object-cover`}
    />
  )
}
