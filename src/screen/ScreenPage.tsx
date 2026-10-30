import { formatCode, MAX_CAMERAS } from '@shared/protocol'
import { Plus, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Brackets } from '@/components/Brackets'
import { QrCode } from '@/components/QrCode'
import { Wordmark } from '@/components/Wordmark'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { CameraTile } from './CameraTile'
import { ShotTray } from './ShotTray'
import { newSession, openScreen, retry, useScreen } from './store'

const cameraUrl = (room: string) => `${location.origin}/${room}`

export function ScreenPage() {
  useEffect(() => openScreen(), [])
  const { conn, room, tiles, shots, ended, problem } = useScreen()

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <Wordmark />
        {room && tiles.length > 0 && <AddCamera room={room} full={tiles.length >= MAX_CAMERAS} />}
        <div className="ml-auto flex items-center gap-3">
          {conn !== 'open' && room && (
            <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden className="size-2 rounded-full bg-standby" />
              Reconnecting…
            </span>
          )}
          {room && <StartOver cameras={tiles.length} />}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section className="flex min-h-0 min-w-0 flex-1 overflow-auto">
          {problem ? (
            <div className="m-auto max-w-sm p-6 text-center">
              <p className="font-medium">{problem}</p>
              <Button className="mt-5" onClick={retry}>
                Try again
              </Button>
            </div>
          ) : tiles.length > 0 ? (
            <div className={cn('grid min-h-0 flex-1 auto-rows-fr gap-3 p-3', tiles.length > 1 && 'sm:grid-cols-2')}>
              {tiles.map((t) => (
                <CameraTile key={t.id} tile={t} />
              ))}
            </div>
          ) : (
            <Pairing room={room} offline={conn === 'offline'} />
          )}
        </section>
        {shots.length > 0 && <ShotTray shots={shots} />}
      </main>

      {ended === 'replaced' && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-background/95 p-6 backdrop-blur-sm">
          <div className="max-w-sm text-center">
            <h2 className="text-xl font-semibold">This session is open in another tab</h2>
            <p className="mt-2 text-muted-foreground">Only one tab at a time can show its cameras.</p>
            <Button className="mt-6" onClick={retry}>
              Show the cameras here
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Pairing({ room, offline }: { room: string | null; offline: boolean }) {
  return (
    <div className="m-auto grid w-full max-w-4xl items-center gap-10 px-6 py-10 md:grid-cols-[auto_minmax(0,1fr)] md:gap-16">
      <div className="relative mx-auto p-6">
        <Brackets className="inset-0" size="lg" tone="ink" />
        <div className="rounded-xl bg-qr-bg p-3 shadow-sm ring-1 ring-border">
          {room ? (
            <QrCode value={cameraUrl(room)} label={`QR code that opens ${location.host}/${room} on a phone`} className="size-56 md:size-64" />
          ) : (
            <div className="size-56 animate-pulse rounded-md bg-muted md:size-64" />
          )}
        </div>
      </div>

      <div className="max-w-md">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight text-balance font-stretch-semi-expanded md:text-4xl">
          Point your phone’s camera at this code
        </h1>
        <p className="mt-4 text-muted-foreground">It opens Beam on the phone. Tap Start camera there, and the picture shows up on this screen.</p>

        <div className="mt-8 border-t pt-6">
          <p className="text-sm text-muted-foreground">
            No QR scanner? Go to <span className="font-medium text-foreground">{location.host}</span> on the phone and type
          </p>
          <p data-testid="room-code" className="mt-2 text-5xl font-bold tracking-tight tabular-nums font-stretch-expanded">
            {room ? formatCode(room) : <span className="text-muted-foreground/40">{offline ? 'Offline' : '···-···'}</span>}
          </p>
          {offline && <p className="mt-2 text-sm text-muted-foreground">Can’t reach Beam right now. This page keeps trying.</p>}
        </div>

        <p className="mt-8 text-sm text-muted-foreground">
          The video is encrypted and goes from the phone to this screen. Beam’s server only introduces the two devices; it never sees the picture.
        </p>
        <Button variant="link" className="mt-4 h-auto px-0 text-muted-foreground" onClick={() => navigate('/join')}>
          Use this computer’s camera for another screen instead
        </Button>
      </div>
    </div>
  )
}

function AddCamera({ room, full }: { room: string; full: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus />
          Add camera
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-4">
        {full ? (
          <p className="max-w-60 text-sm">This screen is showing {MAX_CAMERAS} cameras, the most it can. Remove one to add another.</p>
        ) : (
          <div className="flex items-center gap-4">
            <div className="shrink-0 rounded-lg bg-qr-bg p-1.5 ring-1 ring-border">
              <QrCode value={cameraUrl(room)} label={`QR code that opens ${location.host}/${room} on a phone`} className="size-32" />
            </div>
            <div>
              <p className="text-sm font-medium">Scan with another phone</p>
              <p className="mt-1 text-sm text-muted-foreground">or type this code at {location.host}</p>
              <p className="mt-2 text-2xl font-bold tracking-tight font-stretch-expanded">{formatCode(room)}</p>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function StartOver({ cameras }: { cameras: number }) {
  const [open, setOpen] = useState(false)
  const trigger = (
    <Button variant="ghost" size="sm" onClick={cameras ? undefined : newSession}>
      <RefreshCw />
      New code
    </Button>
  )
  if (!cameras) return trigger
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start over with a new code?</DialogTitle>
          <DialogDescription>
            {cameras === 1 ? 'The camera' : `All ${cameras} cameras`} will be disconnected, and the old code stops working. Photos and clips stay in the tray.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={() => {
              newSession()
              setOpen(false)
            }}
          >
            Disconnect and get a new code
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
