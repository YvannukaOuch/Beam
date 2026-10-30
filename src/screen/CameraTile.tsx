import type { CamCaps } from '@shared/protocol'
import {
  Camera,
  Circle,
  Flashlight,
  FlashlightOff,
  FlipHorizontal2,
  Loader2,
  Maximize,
  Minimize,
  PictureInPicture2,
  SwitchCamera,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ComponentProps, type RefObject } from 'react'
import { Brackets } from '@/components/Brackets'
import { StreamVideo } from '@/components/StreamVideo'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { LinkStats } from '@/lib/rtc'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { flip, removeCamera, setListening, setMirror, snap, toggleRecording, torch, zoom, type Tile } from './store'

/** True while the pointer has moved in the last `ms`; the controls hide after that, like a video player. */
function useActive(ms: number): [boolean, () => void] {
  const [active, setActive] = useState(true)
  const timer = useRef(0)
  const poke = useCallback(() => {
    setActive(true)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setActive(false), ms)
  }, [ms])
  useEffect(() => {
    poke()
    return () => clearTimeout(timer.current)
  }, [poke])
  return [active, poke]
}

function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const update = () => setOn(document.fullscreenElement !== null && document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [ref])
  return on
}

const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled === true

export function CameraTile({ tile }: { tile: Tile }) {
  const figure = useRef<HTMLElement>(null)
  const video = useRef<HTMLVideoElement | null>(null)
  const onElement = useCallback((el: HTMLVideoElement | null) => {
    video.current = el
  }, [])
  const [lock, setLock] = useState(0)
  const [active, poke] = useActive(2500)
  const fullscreen = useFullscreen(figure)
  const live = tile.link === 'live'
  const chrome = !live || active
  const mirrored = tile.mirror ?? tile.caps?.facing === 'user'
  const fade = cn('transition-opacity duration-300', chrome ? 'opacity-100' : 'opacity-0 group-focus-within/tile:opacity-100')

  return (
    <figure
      ref={figure}
      onPointerMove={poke}
      onPointerDown={poke}
      onFocus={poke}
      aria-label={tile.name}
      className={cn('group/tile relative min-h-0 min-w-0 overflow-hidden rounded-xl bg-video text-on-video', !chrome && 'cursor-none')}
    >
      <StreamVideo
        stream={tile.stream}
        muted={!tile.listening}
        mirrored={mirrored}
        onPlaying={() => setLock((k) => k + 1)}
        onElement={onElement}
        className="absolute inset-0 size-full object-contain"
      />
      {/* A focus box in the middle: it holds the status while connecting, and locks on when the picture arrives. */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 grid h-36 w-[min(20rem,85%)] -translate-x-1/2 -translate-y-1/2 place-items-center">
        <Brackets className="inset-0" tone="video" lockKey={live ? lock : 0} />
        {!live && <Waiting tile={tile} />}
      </div>

      <figcaption className={cn(fade, 'absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-linear-to-b from-scrim to-transparent p-3 pb-10')}>
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', live ? 'bg-tally' : 'bg-on-video/40')} />
          <span className="truncate font-medium">{tile.name}</span>
          {tile.caps?.facing && <span className="shrink-0 text-sm text-on-video/70">{tile.caps.facing === 'user' ? 'Front camera' : 'Back camera'}</span>}
          <span className="sr-only">{live ? ', live' : ''}</span>
        </div>
        {live && tile.stats && <Readout stats={tile.stats} />}
      </figcaption>

      {tile.recordingSince !== null && <Recording since={tile.recordingSince} />}
      {tile.incoming !== null && (
        <div className="absolute inset-x-0 top-0 h-1 bg-on-video/20" role="progressbar" aria-label="Receiving photo" aria-valuenow={Math.round(tile.incoming * 100)}>
          <div className="h-full bg-on-video transition-[width]" style={{ width: `${tile.incoming * 100}%` }} />
        </div>
      )}

      {/* Until the picture arrives there's nothing to control, only the camera to remove. */}
      <div className={cn(fade, 'absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-1 bg-linear-to-t from-scrim to-transparent p-3 pt-12')}>
        {live && (
          <>
            <Button
              type="button"
              onClick={() => snap(tile.id)}
              disabled={tile.incoming !== null}
              className="mr-1 h-9 gap-2 bg-on-video px-3 text-video hover:bg-on-video/85 focus-visible:ring-on-video/60"
            >
              {tile.incoming !== null ? <Loader2 className="animate-spin" /> : <Camera />}
              Take photo
            </Button>
            <ToolButton
              label={tile.recordingSince !== null ? 'Stop recording' : 'Record a clip'}
              pressed={tile.recordingSince !== null}
              onClick={() => toggleRecording(tile.id)}
            >
              <Circle className={cn(tile.recordingSince !== null && 'fill-tally text-tally')} />
            </ToolButton>
            {(tile.caps?.canFlip || tile.caps?.torch != null || tile.caps?.zoom) && <span aria-hidden className="mx-1 h-5 w-px bg-on-video/25" />}
            {tile.caps?.canFlip && (
              <ToolButton label="Switch camera" onClick={() => flip(tile.id)}>
                <SwitchCamera />
              </ToolButton>
            )}
            {tile.caps && tile.caps.torch !== null && (
              <ToolButton label={tile.caps.torch ? 'Turn off the light' : 'Turn on the light'} pressed={tile.caps.torch} onClick={() => torch(tile.id, !tile.caps?.torch)}>
                {tile.caps.torch ? <Flashlight /> : <FlashlightOff />}
              </ToolButton>
            )}
            {tile.caps?.zoom && <ZoomControl id={tile.id} range={tile.caps.zoom} />}
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          {live && (
            <>
              <ToolButton
                label={!tile.caps?.mic ? 'The phone’s mic is off' : tile.listening ? 'Mute' : 'Listen'}
                pressed={tile.listening}
                disabled={!tile.caps?.mic}
                onClick={() => {
                  // Unmute in the click itself: browsers only allow sound that someone asked for.
                  if (video.current) video.current.muted = tile.listening
                  setListening(tile.id, !tile.listening)
                }}
              >
                {tile.listening ? <Volume2 /> : <VolumeX />}
              </ToolButton>
              <ToolButton label={mirrored ? 'Show unmirrored' : 'Mirror'} pressed={mirrored} onClick={() => setMirror(tile.id, !mirrored)}>
                <FlipHorizontal2 />
              </ToolButton>
              {pipSupported && (
                <ToolButton label="Picture in picture" onClick={() => void togglePip(video.current)}>
                  <PictureInPicture2 />
                </ToolButton>
              )}
              <ToolButton label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={() => toggleFullscreen(figure.current)}>
                {fullscreen ? <Minimize /> : <Maximize />}
              </ToolButton>
            </>
          )}
          <ToolButton label={`Remove ${tile.name}`} onClick={() => removeCamera(tile.id)}>
            <X />
          </ToolButton>
        </div>
      </div>
    </figure>
  )
}

function Waiting({ tile }: { tile: Tile }) {
  const busy = tile.link === 'connecting' || tile.link === 'reconnecting'
  const text = tile.blocked
    ? `Can’t connect directly to ${tile.name}. One of the networks blocks direct connections (common on work, school and some mobile networks). Put both on the same Wi-Fi, or try another network. Beam keeps trying.`
    : tile.link === 'connecting'
      ? `Connecting to ${tile.name}…`
      : tile.link === 'reconnecting'
        ? `Reconnecting to ${tile.name}…`
        : tile.online
          ? `${tile.name} joined. Tap Start camera on it to see the picture here.`
          : `${tile.name} is away. It reconnects when its Beam page is open again.`
  return (
    <p className="flex flex-col items-center gap-3 px-6 text-center text-sm text-on-video/80">
      {busy && <Loader2 aria-hidden className="size-5 animate-spin" />}
      {text}
    </p>
  )
}

function Readout({ stats }: { stats: LinkStats }) {
  const rate = stats.kbps >= 1000 ? `${(stats.kbps / 1000).toFixed(1)} Mb/s` : `${stats.kbps} kb/s`
  const item = 'border-l border-on-video/25 px-2 first:border-l-0 first:pl-0 last:pr-0'
  return (
    <ul aria-label="Connection" className="flex shrink-0 items-center text-xs tabular-nums text-on-video/85 font-stretch-condensed">
      {stats.height > 0 && <li className={item}>{Math.min(stats.width, stats.height)}p</li>}
      {stats.fps > 0 && <li className={item}>{stats.fps} fps</li>}
      {stats.kbps > 0 && <li className={item}>{rate}</li>}
      <li className={item}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-on-video/60">
              {stats.relayed ? 'Relayed' : 'Direct'}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">
            {stats.relayed
              ? 'These networks don’t allow a direct link, so the video goes through Beam’s relay. It stays encrypted the whole way.'
              : 'The video goes straight from the camera to this screen.'}
          </TooltipContent>
        </Tooltip>
      </li>
    </ul>
  )
}

function Recording({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const time = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return (
    <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-scrim px-2.5 py-1 text-xs font-semibold tabular-nums">
      <span aria-hidden className="size-2 rounded-full bg-tally" />
      Recording {time}
    </div>
  )
}

const toolClass =
  'size-9 text-on-video hover:bg-on-video/15 hover:text-on-video focus-visible:ring-on-video/60 aria-pressed:bg-on-video/20 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent'

/** An icon button over the video. Unavailable ones stay focusable so their tooltip can say why. */
function ToolButton({ label, pressed, disabled, onClick, className, children, ...props }: ComponentProps<'button'> & { label: string; pressed?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={label}
          aria-pressed={pressed}
          aria-disabled={disabled || undefined}
          onClick={(e) => {
            if (!disabled) onClick?.(e)
          }}
          className={cn(toolClass, className)}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ZoomControl({ id, range }: { id: string; range: NonNullable<CamCaps['zoom']> }) {
  const [value, setValue] = useState(range.value)
  const last = useRef(0)
  const pending = useRef(0)
  const change = (v: number) => {
    setValue(v)
    // At most ten zoom requests a second while dragging; the last one always goes.
    clearTimeout(pending.current)
    pending.current = window.setTimeout(
      () => {
        last.current = Date.now()
        zoom(id, v)
      },
      Math.max(0, 100 - (Date.now() - last.current)),
    )
  }
  return (
    <Popover onOpenChange={(open) => open && setValue(range.value)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type="button" size="icon" variant="ghost" aria-label="Zoom" className={toolClass}>
              <ZoomIn />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Zoom</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" className="w-64">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Zoom</span>
          <span className="tabular-nums text-muted-foreground">{value.toFixed(1)}×</span>
        </div>
        <Slider className="mt-4 mb-1" min={range.min} max={range.max} step={range.step} value={[value]} onValueChange={([v]) => change(v)} thumbLabel="Zoom" />
      </PopoverContent>
    </Popover>
  )
}

async function togglePip(el: HTMLVideoElement | null) {
  if (!el) return
  try {
    if (document.pictureInPictureElement === el) await document.exitPictureInPicture()
    else await el.requestPictureInPicture()
  } catch {
    toast('Picture in picture didn’t open.')
  }
}

function toggleFullscreen(el: HTMLElement | null) {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else el?.requestFullscreen().catch(() => toast('Full screen isn’t available here.'))
}
