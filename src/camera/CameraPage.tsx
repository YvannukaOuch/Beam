import { formatCode } from '@shared/protocol'
import { Camera, Flashlight, FlashlightOff, Loader2, Mic, MicOff, SwitchCamera, X } from 'lucide-react'
import { useEffect, type ComponentProps, type ReactNode } from 'react'
import { Brackets } from '@/components/Brackets'
import { CodeForm } from '@/components/CodeForm'
import { StreamVideo } from '@/components/StreamVideo'
import { Wordmark } from '@/components/Wordmark'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import {
  dismissProblem,
  flipCamera,
  leave,
  openCamera,
  rejoin,
  setPreviewEl,
  setTorch,
  setZoom,
  startCamera,
  takePhoto,
  toggleMic,
  useCam,
  type Problem,
} from './store'

export function CameraPage({ code }: { code: string }) {
  useEffect(() => openCamera(code), [code])
  const phase = useCam((s) => s.phase)
  return phase === 'live' ? <Live /> : <Steps />
}

/** A new code, or the same one again (which navigation alone wouldn't restart). */
function goTo(code: string) {
  if (code === useCam.getState().code) rejoin()
  else navigate(`/${code}`)
}

function Steps() {
  const s = useCam()
  const code = formatCode(s.code)
  return (
    <main className="flex min-h-dvh flex-col bg-background px-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header>
        <Wordmark />
      </header>
      <div className="mx-auto my-auto w-full max-w-sm py-10">
        {s.phase === 'joining' && (
          <>
            <Code label="Connecting to the screen showing" code={code} />
            <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
              {s.conn === 'offline' ? 'Can’t reach Beam. Check this phone’s connection; the page keeps trying.' : 'Connecting…'}
            </p>
          </>
        )}

        {(s.phase === 'ready' || s.phase === 'starting') && (
          <>
            <Code label="Camera for the screen showing" code={code} />
            <Button size="lg" className="mt-8 h-14 w-full text-base" disabled={s.phase === 'starting'} onClick={() => void startCamera()}>
              {s.phase === 'starting' ? <Loader2 className="animate-spin" /> : <Camera />}
              {s.phase === 'starting' ? 'Starting camera…' : 'Start camera'}
            </Button>
            {s.problem && <ProblemNote problem={s.problem} className="mt-4" />}
            {!s.screenOnline && <p className="mt-4 text-sm text-muted-foreground">The screen isn’t connected right now. Start anyway: the picture appears there once it’s back.</p>}
            <p className="mt-8 text-sm text-muted-foreground">
              The picture goes to that screen, encrypted, and nowhere else. Keep this page open while you use the camera.
            </p>
          </>
        )}

        {s.phase === 'error' && s.problem && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{s.problem.title}</h1>
            <p className="mt-2 text-muted-foreground">{s.problem.detail}</p>
            <Button variant="outline" className="mt-6 h-11 w-full" onClick={rejoin}>
              Try {code} again
            </Button>
            <CodeForm className="mt-10" label="Or type a different code" onCode={goTo} />
          </>
        )}

        {s.phase === 'ended' && <Ended code={code} reason={s.ended} />}
      </div>
    </main>
  )
}

function Code({ label, code }: { label: string; code: string }) {
  return (
    <>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-5xl font-bold tracking-tight tabular-nums font-stretch-expanded">{code}</p>
    </>
  )
}

const ENDINGS: Record<string, { title: string; detail: string; again?: string }> = {
  closed: { title: 'The screen ended the session', detail: 'To connect again, scan the new code on the screen.' },
  expired: { title: 'The screen went away', detail: 'It was closed, or offline for too long. Scan its code again to reconnect.' },
  kicked: { title: 'The screen removed this camera', detail: 'You can connect again while the screen still shows this code.', again: 'Reconnect' },
  replaced: { title: 'This camera is open in another tab', detail: 'Only one tab at a time can be the camera.', again: 'Use this tab' },
  left: { title: 'Camera stopped', detail: 'The screen no longer shows this phone.', again: 'Reconnect' },
}

function Ended({ code, reason }: { code: string; reason: string | null }) {
  const ending = ENDINGS[reason ?? 'left'] ?? ENDINGS.left
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-balance">{ending.title}</h1>
      <p className="mt-2 text-muted-foreground">{ending.detail}</p>
      {ending.again && (
        <Button size="lg" className="mt-6 h-12 w-full text-base" onClick={rejoin}>
          {ending.again} to {code}
        </Button>
      )}
      <CodeForm className="mt-10" label={ending.again ? 'Or type a different code' : 'Code from the screen'} onCode={goTo} />
    </>
  )
}

function ProblemNote({ problem, className, onDismiss }: { problem: Problem; className?: string; onDismiss?: () => void }) {
  return (
    <div role="alert" className={cn('rounded-lg border bg-card p-4 text-card-foreground', className)}>
      <p className="font-medium">{problem.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{problem.detail}</p>
      {onDismiss && (
        <Button size="sm" variant="outline" className="mt-3" onClick={onDismiss}>
          Dismiss
        </Button>
      )}
    </div>
  )
}

const BLOCKED: Problem = {
  title: 'Can’t connect directly to the screen',
  detail: 'One of the networks blocks direct connections (common on work, school and some mobile networks). Put both devices on the same Wi-Fi, or try another network. Beam keeps trying.',
}

function Live() {
  const s = useCam()
  const live = s.link === 'connected'
  return (
    <div className="fixed inset-0 overflow-hidden bg-video text-on-video">
      <StreamVideo stream={s.preview} mirrored={s.facing === 'user'} onElement={setPreviewEl} className="absolute inset-0 size-full object-cover" />
      {/* The frame turns red while the screen is getting the picture: this phone is on air. */}
      <Brackets
        size="lg"
        tone={live ? 'live' : 'video'}
        className="inset-x-4 top-[calc(max(1rem,env(safe-area-inset-top))+3.25rem)] bottom-[calc(max(1.5rem,env(safe-area-inset-bottom))+7.5rem)]"
      />
      {s.shots > 0 && <div key={s.shots} aria-hidden className="pointer-events-none absolute inset-0 bg-on-video animate-flash" />}

      <header className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 bg-linear-to-b from-scrim to-transparent px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-8">
        <LinkPill />
        <div className="flex items-center gap-2">
          {s.torch !== null && (
            <RoundButton label={s.torch ? 'Turn off the light' : 'Turn on the light'} pressed={s.torch} onClick={() => void setTorch(!s.torch)}>
              {s.torch ? <Flashlight /> : <FlashlightOff />}
            </RoundButton>
          )}
          <RoundButton label="Stop camera" onClick={leave}>
            <X />
          </RoundButton>
        </div>
      </header>

      {s.blocked && !live && !s.problem && (
        <ProblemNote problem={BLOCKED} className="absolute inset-x-4 top-[calc(max(1rem,env(safe-area-inset-top))+4rem)] shadow-lg" />
      )}
      {s.problem && <ProblemNote problem={s.problem} onDismiss={dismissProblem} className="absolute inset-x-4 top-[calc(max(1rem,env(safe-area-inset-top))+4rem)] shadow-lg" />}

      <footer className="absolute inset-x-0 bottom-0 bg-linear-to-t from-scrim to-transparent px-6 pt-16 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {s.zoom && (
          <div className="mx-auto mb-6 flex max-w-xs items-center gap-3">
            <Slider
              min={s.zoom.min}
              max={s.zoom.max}
              step={s.zoom.step}
              value={[s.zoom.value]}
              onValueChange={([v]) => void setZoom(v)}
              thumbLabel="Zoom"
              className="[&_[data-slot=slider-range]]:bg-on-video [&_[data-slot=slider-thumb]]:size-5 [&_[data-slot=slider-track]]:bg-on-video/30"
            />
            <span className="w-10 text-right text-sm tabular-nums">{s.zoom.value.toFixed(1)}×</span>
          </div>
        )}
        <div className="mx-auto grid max-w-xs grid-cols-3 items-center">
          <RoundButton
            label={s.mic ? 'Turn off the mic' : 'Turn on the mic'}
            pressed={s.mic}
            disabled={s.micBusy}
            onClick={() => void toggleMic()}
            className="justify-self-start"
          >
            {s.mic ? <Mic /> : <MicOff />}
          </RoundButton>
          <Shutter disabled={!live} sending={s.sending > 0} />
          {s.canFlip ? (
            <RoundButton label="Switch camera" onClick={() => void flipCamera()} className="justify-self-end">
              <SwitchCamera />
            </RoundButton>
          ) : (
            <span />
          )}
        </div>
      </footer>
    </div>
  )
}

function LinkPill() {
  const { link, screenOnline, conn } = useCam()
  let dot = 'bg-standby'
  let text: ReactNode = 'Connecting to the screen…'
  if (link === 'connected') {
    dot = 'bg-tally'
    text = 'Live on the screen'
  } else if (!screenOnline) text = conn === 'open' ? 'Waiting for the screen…' : 'Reconnecting…'
  else if (link === 'reconnecting') text = 'Reconnecting…'
  return (
    <div role="status" className="flex min-w-0 items-center gap-2 rounded-full bg-scrim px-3 py-1.5 text-sm font-medium backdrop-blur-md">
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dot)} />
      <span className="truncate">{text}</span>
    </div>
  )
}

function RoundButton({ label, pressed, className, children, ...props }: ComponentProps<'button'> & { label: string; pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        'grid size-12 place-items-center rounded-full bg-scrim text-on-video backdrop-blur-md transition outline-none active:scale-95 disabled:opacity-40 aria-pressed:bg-on-video aria-pressed:text-video focus-visible:ring-3 focus-visible:ring-on-video/60 [&_svg]:size-5',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

function Shutter({ disabled, sending }: { disabled: boolean; sending: boolean }) {
  return (
    <button
      type="button"
      aria-label="Take photo"
      aria-describedby="shutter-hint"
      disabled={disabled}
      onClick={takePhoto}
      className="relative grid size-20 place-items-center justify-self-center rounded-full border-4 border-on-video transition outline-none active:scale-95 disabled:opacity-40 focus-visible:ring-4 focus-visible:ring-on-video/50"
    >
      <span className="size-15 rounded-full bg-on-video" />
      {sending && <Loader2 aria-hidden className="absolute size-7 animate-spin text-video" />}
      <span id="shutter-hint" className="sr-only">
        The photo goes to the screen
      </span>
    </button>
  )
}
