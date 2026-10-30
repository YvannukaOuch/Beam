import { useToasts } from '@/lib/toast'
import { cn } from '@/lib/utils'

/** Short confirmations ("Photo sent") that go away by themselves; read out by screen readers too. */
export function Toasts({ placement = 'bottom' }: { placement?: 'top' | 'bottom' }) {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4',
        placement === 'top' ? 'top-[calc(max(1rem,env(safe-area-inset-top))+3.5rem)]' : 'bottom-[max(1rem,env(safe-area-inset-bottom))]',
      )}
    >
      {toasts.map((t) => (
        <div key={t.id} className="rounded-lg bg-foreground px-3.5 py-2 text-sm text-background shadow-lg animate-in fade-in slide-in-from-bottom-2">
          {t.text}
        </div>
      ))}
    </div>
  )
}
