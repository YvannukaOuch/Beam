import { Copy, Download, Play, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { deleteShot, markSaved, type Shot } from './store'

const two = (n: number) => String(n).padStart(2, '0')
const frame = (shot: Shot) => two(shot.number)
const title = (shot: Shot) => `${shot.kind === 'photo' ? 'Photo' : 'Clip'} ${frame(shot)}`
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function extension(type: string) {
  if (type.includes('png')) return 'png'
  if (type.includes('webp')) return 'webp'
  if (type.includes('mp4')) return 'mp4'
  if (type.includes('webm')) return 'webm'
  return 'jpg'
}

function fileName(shot: Shot) {
  const d = new Date(shot.at)
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  return `beam-${stamp}-${frame(shot)}.${extension(shot.blob.type)}`
}

function size(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

async function toPng(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), 'image/png'))
}

/** Clipboards take PNG, not JPEG: convert on the way in. */
async function copyPhoto(shot: Shot) {
  try {
    const png = shot.blob.type === 'image/png' ? shot.blob : toPng(shot.blob)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    markSaved(shot.id)
    toast(`${title(shot)} copied. Paste it anywhere.`)
  } catch {
    toast('This browser won’t copy images. Save the photo instead.')
  }
}

/** Photos from the cameras and clips recorded here, newest first, numbered in the order they came in. */
export function ShotTray({ shots }: { shots: Shot[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const open = shots.find((s) => s.id === openId) ?? null
  return (
    <aside aria-label="Photos and clips" className="flex max-h-[38dvh] min-h-0 shrink-0 flex-col border-t bg-card md:max-h-none md:w-72 md:border-t-0 md:border-l lg:w-80">
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <h2 className="text-sm font-semibold">Photos and clips</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{shots.length}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ol className="grid grid-cols-2 gap-x-3 gap-y-5 p-4 md:grid-cols-1">
          {shots.map((shot) => (
            <ShotItem key={shot.id} shot={shot} onOpen={() => setOpenId(shot.id)} />
          ))}
        </ol>
      </ScrollArea>
      <ShotViewer shot={open} onClose={() => setOpenId(null)} />
    </aside>
  )
}

function ShotItem({ shot, onOpen }: { shot: Shot; onOpen: () => void }) {
  return (
    <li className="min-w-0 animate-in fade-in slide-in-from-top-2 duration-300">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${title(shot)}`}
        className="relative block w-full overflow-hidden rounded-md bg-video outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {shot.kind === 'photo' ? (
          <img src={shot.url} alt="" className="max-h-52 w-full object-contain" />
        ) : (
          <>
            <video src={shot.url} muted preload="metadata" className="max-h-52 w-full object-contain" />
            <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-sm bg-scrim px-1.5 py-0.5 text-xs text-on-video">
              <Play aria-hidden className="size-3" />
              Clip
            </span>
          </>
        )}
      </button>
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        <span className="font-semibold tabular-nums font-stretch-condensed">{frame(shot)}</span>
        <span className="min-w-0 truncate text-muted-foreground">{clock(shot.at)}</span>
        <div className="-mr-1 ml-auto flex items-center">
          <SmallAction label={`Save ${title(shot)}`} saved={shot.saved}>
            <a href={shot.url} download={fileName(shot)} onClick={() => markSaved(shot.id)}>
              <Download />
            </a>
          </SmallAction>
          {shot.kind === 'photo' && (
            <SmallAction label={`Copy ${title(shot)}`} onClick={() => void copyPhoto(shot)}>
              <Copy />
            </SmallAction>
          )}
          <SmallAction label={`Delete ${title(shot)}`} onClick={() => deleteShot(shot.id)}>
            <Trash2 />
          </SmallAction>
        </div>
      </div>
    </li>
  )
}

/** A tiny icon button; with an <a> child it becomes that link (Save is a download link). */
function SmallAction({ label, onClick, saved, children }: { label: string; onClick?: () => void; saved?: boolean; children: ReactNode }) {
  const asLink = !onClick
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type={asLink ? undefined : 'button'} asChild={asLink} size="icon-xs" variant="ghost" aria-label={label} onClick={onClick} className={cn('text-muted-foreground', saved === false && 'text-foreground')}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ShotViewer({ shot, onClose }: { shot: Shot | null; onClose: () => void }) {
  const details = shot
    ? [shot.camera, clock(shot.at), shot.width && shot.height ? `${shot.width} × ${shot.height}` : null, size(shot.blob.size)].filter(Boolean).join(', ')
    : ''
  return (
    <Dialog open={shot !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-3 sm:max-w-[min(calc(100vw-2rem),72rem)]">
        {shot && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pr-10">
              <DialogTitle className="text-base">{title(shot)}</DialogTitle>
              <DialogDescription>{details}</DialogDescription>
            </div>
            <div className="grid min-h-0 place-items-center overflow-hidden rounded-lg bg-video">
              {shot.kind === 'photo' ? (
                <img src={shot.url} alt={`${title(shot)} from ${shot.camera}`} className="max-h-[70dvh] w-auto max-w-full object-contain" />
              ) : (
                <video src={shot.url} controls autoPlay className="max-h-[70dvh] max-w-full" />
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  deleteShot(shot.id)
                  onClose()
                }}
              >
                <Trash2 />
                Delete
              </Button>
              {shot.kind === 'photo' && (
                <Button variant="outline" onClick={() => void copyPhoto(shot)}>
                  <Copy />
                  Copy
                </Button>
              )}
              <Button asChild>
                <a href={shot.url} download={fileName(shot)} onClick={() => markSaved(shot.id)}>
                  <Download />
                  Save
                </a>
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
