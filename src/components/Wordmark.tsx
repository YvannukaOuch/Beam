import { cn } from '@/lib/utils'

/** Viewfinder corners around a tally light, and the name set wide. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-lg font-semibold tracking-tight font-stretch-expanded', className)}>
      <svg viewBox="0 0 24 24" aria-hidden className="size-5">
        <path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <circle cx="12" cy="12" r="3" className="fill-tally" />
      </svg>
      Beam
    </span>
  )
}
