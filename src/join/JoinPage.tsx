import { CodeForm } from '@/components/CodeForm'
import { Wordmark } from '@/components/Wordmark'
import { Button } from '@/components/ui/button'
import { navigate } from '@/lib/route'

/** For a phone that came to the site without a code (and for a computer whose webcam is wanted elsewhere). */
export function JoinPage() {
  return (
    <main className="flex min-h-dvh flex-col bg-background px-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header>
        <Wordmark />
      </header>
      <div className="mx-auto my-auto w-full max-w-sm py-10">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight text-balance font-stretch-semi-expanded">Use this device as a camera</h1>
        <p className="mt-3 text-muted-foreground">
          Open <span className="font-medium text-foreground">{location.host}</span> on the computer you want the picture on. It shows a code: scan it with
          your camera app, or type it here.
        </p>
        <CodeForm className="mt-8" autoFocus />
      </div>
      <footer className="mx-auto w-full max-w-sm">
        <Button variant="link" className="h-auto px-0 text-muted-foreground" onClick={() => navigate('/screen')}>
          Show cameras on this device instead
        </Button>
      </footer>
    </main>
  )
}
