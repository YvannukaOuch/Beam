import { useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * A <video> showing a live MediaStream. Muted video may always play by itself; turning the sound
 * on has to come from a click, so callers that unmute do it on the element in their click handler
 * (see `onElement`) as well as through `muted`.
 */
export function StreamVideo({
  stream,
  muted = true,
  mirrored = false,
  className,
  onPlaying,
  onElement,
}: {
  stream: MediaStream | null
  muted?: boolean
  mirrored?: boolean
  className?: string
  onPlaying?: () => void
  /** Must be stable (not a new function each render). */
  onElement?: (el: HTMLVideoElement | null) => void
}) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const setRef = useCallback(
    (el: HTMLVideoElement | null) => {
      ref.current = el
      onElement?.(el)
    },
    [onElement],
  )

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.muted = muted
    if (el.srcObject !== stream) el.srcObject = stream
    if (stream) void el.play().catch(() => {})
  }, [stream, muted])

  return <video ref={setRef} autoPlay playsInline muted={muted} onPlaying={onPlaying} className={cn(className, mirrored && '-scale-x-100')} />
}
