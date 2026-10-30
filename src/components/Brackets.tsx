import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

// Each corner, and which way it moves to close in on the middle.
const CORNERS = [
  { at: 'left-0 top-0 border-l-2 border-t-2', dx: 1, dy: 1 },
  { at: 'right-0 top-0 border-r-2 border-t-2', dx: -1, dy: 1 },
  { at: 'bottom-0 left-0 border-b-2 border-l-2', dx: 1, dy: -1 },
  { at: 'bottom-0 right-0 border-b-2 border-r-2', dx: -1, dy: -1 },
]

const TONES = {
  ink: 'border-foreground/55',
  video: 'border-on-video/70',
  live: 'border-tally',
}

/**
 * Viewfinder corners around whatever is being framed: the code to scan, a camera's picture. Each
 * time `lockKey` changes (above 0) they close in, go red and fade out: focus lock.
 */
export function Brackets({
  className,
  size = 'sm',
  tone = 'video',
  lockKey = 0,
}: {
  className?: string
  size?: 'sm' | 'lg'
  tone?: keyof typeof TONES
  lockKey?: number
}) {
  return (
    <div aria-hidden className={cn('pointer-events-none absolute', className)}>
      {CORNERS.map((c, i) => (
        <span
          key={`${i}:${lockKey}`}
          className={cn('absolute transition-colors duration-300', size === 'lg' ? 'size-10' : 'size-6', c.at, TONES[tone], lockKey > 0 && 'animate-lock')}
          style={{ '--dx': c.dx, '--dy': c.dy } as CSSProperties}
        />
      ))}
    </div>
  )
}
