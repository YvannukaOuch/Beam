import type { CamCaps, CameraInfo, EndReason, ErrorCode, IceCandidate, IceServer, PeerMsg, ServerMsg, Signal } from '@shared/protocol'
import { create } from 'zustand'
import { newId } from '@/lib/device'
import { openChannel, rtcConfig, statsReader, type LinkStats } from '@/lib/rtc'
import { SignalSocket, type ConnState } from '@/lib/signal'
import { toast } from '@/lib/toast'

/**
 * The screen side. It holds the session (and its code), answers each camera's call, shows the
 * video, and keeps what arrives (photos) and what it records (clips) in a tray. Photos and clips
 * only ever live in this page; nothing is uploaded anywhere.
 */

export type TileLink = 'waiting' | 'connecting' | 'live' | 'reconnecting'

export interface Tile {
  id: string
  name: string
  /** Connected to the pairing server (the call itself can outlive a drop-out). */
  online: boolean
  link: TileLink
  stream: MediaStream | null
  caps: CamCaps | null
  stats: LinkStats | null
  /** A photo on its way, 0 to 1. */
  incoming: number | null
  recordingSince: number | null
  listening: boolean
  /** null: automatic, which mirrors the front camera the way the phone shows it. */
  mirror: boolean | null
  /** A direct connection couldn't be made (a network blocks it; there's no relay). */
  blocked: boolean
}

export interface Shot {
  id: string
  kind: 'photo' | 'clip'
  number: number
  url: string
  blob: Blob
  camera: string
  at: number
  width: number | null
  height: number | null
  /** Saved or copied somewhere, so closing the page won't lose it. */
  saved: boolean
}

interface ScreenState {
  conn: ConnState
  room: string | null
  tiles: Tile[]
  shots: Shot[]
  ended: EndReason | null
  problem: string | null
}

export const useScreen = create<ScreenState>(() => ({ conn: 'connecting', room: null, tiles: [], shots: [], ended: null, problem: null }))
const set = useScreen.setState
const get = useScreen.getState

interface Peer {
  pc: RTCPeerConnection
  dc: RTCDataChannel
  pid: string
  tracks: MediaStreamTrack[]
  pending: RTCIceCandidateInit[]
  stats: () => Promise<LinkStats | null>
  statsTimer: number
  incoming: { id: string; type: string; size: number; chunks: ArrayBuffer[]; received: number; shown: number } | null
  recorder: MediaRecorder | null
}

/** This page load. A reload is a new screen as far as the cameras are concerned, so they call again. */
const screenId = newId()
const SAVED = 'beam:screen'
const MAX_PHOTO = 40 * 1024 * 1024
const MAX_SHOTS = 200
let signal: SignalSocket | null = null
let ice: IceServer[] = []
const peers = new Map<string, Peer>()
let shotNumber = 0

function loadSaved(): { room: string; token: string } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(SAVED) ?? 'null')
    return v && typeof v.room === 'string' && typeof v.token === 'string' ? v : null
  } catch {
    return null
  }
}

function save(v: { room: string; token: string } | null) {
  try {
    if (v) sessionStorage.setItem(SAVED, JSON.stringify(v))
    else sessionStorage.removeItem(SAVED)
  } catch {
    // Storage blocked: a reload starts a new session with a new code.
  }
}

const tile = (id: string) => get().tiles.find((t) => t.id === id)

function patch(id: string, change: Partial<Tile>) {
  set((s) => ({ tiles: s.tiles.map((t) => (t.id === id ? { ...t, ...change } : t)) }))
}

/** Opens the screen; returns the clean-up for when the page goes away. */
export function openScreen() {
  signal = new SignalSocket(hello, onServer, (conn) => set({ conn }))
  signal.start()
  window.addEventListener('beforeunload', onLeave)
  return () => {
    window.removeEventListener('beforeunload', onLeave)
    signal?.stop()
    signal = null
    for (const id of [...peers.keys()]) dropPeer(id)
    set({ room: null, tiles: [] })
  }
}

// Photos and clips only live in this page: ask before closing it with some not saved yet.
function onLeave(e: BeforeUnloadEvent) {
  if (get().shots.some((s) => !s.saved)) e.preventDefault()
}

function hello() {
  const saved = loadSaved()
  signal?.send({ t: 'host', screen: screenId, room: saved?.room, token: saved?.token })
}

/** After an error or another tab taking over: try again. */
export function retry() {
  set({ problem: null, ended: null })
  signal?.start()
}

/** Disconnects every camera and starts over with a new code. */
export function newSession() {
  signal?.send({ t: 'close' })
  for (const id of [...peers.keys()]) dropPeer(id)
  save(null)
  set({ room: null, tiles: [] })
  signal?.send({ t: 'host', screen: screenId })
}

function onServer(msg: ServerMsg) {
  switch (msg.t) {
    case 'hosted': {
      ice = msg.ice
      save({ room: msg.room, token: msg.token })
      if (get().room !== msg.room) {
        // A different session (the old one ended while this page was away): its cameras are gone.
        for (const id of [...peers.keys()]) dropPeer(id)
        set({ tiles: [] })
      }
      set({ room: msg.room, problem: null, ended: null })
      const known = new Set(msg.cameras.map((c) => c.id))
      for (const t of get().tiles) if (!known.has(t.id)) removeTile(t.id)
      for (const cam of msg.cameras) upsert(cam)
      return
    }
    case 'camera':
      if (!tile(msg.camera.id)) toast(`${msg.camera.name} joined`)
      upsert(msg.camera)
      return
    case 'camera-left': {
      const t = tile(msg.id)
      if (t) toast(`${t.name} left`)
      removeTile(msg.id)
      return
    }
    case 'signal':
      void onSignal(msg.from, msg.data)
      return
    case 'ice':
      ice = msg.ice
      return
    case 'ended':
      if (msg.reason === 'replaced') {
        // Another tab has this session now. Stay quiet until asked to take it back.
        signal?.stop()
        for (const id of [...peers.keys()]) dropPeer(id)
        set({ ended: 'replaced', tiles: [] })
      }
      return
    case 'error':
      onError(msg.code)
      return
  }
}

function onError(code: ErrorCode) {
  const problems: Partial<Record<ErrorCode, string>> = {
    'rate-limited': 'This network has started a lot of sessions in the last few minutes. Wait a few minutes, then try again.',
    busy: 'Beam is full right now. Try again in a minute.',
  }
  const problem = problems[code]
  if (!problem) return
  signal?.stop()
  set({ problem })
}

function upsert(cam: CameraInfo) {
  set((s) => {
    const i = s.tiles.findIndex((t) => t.id === cam.id)
    if (i < 0) {
      const t: Tile = { id: cam.id, name: cam.name, online: cam.online, link: 'waiting', stream: null, caps: null, stats: null, incoming: null, recordingSince: null, listening: false, mirror: null, blocked: false }
      return { tiles: [...s.tiles, t] }
    }
    const tiles = s.tiles.slice()
    tiles[i] = { ...tiles[i], name: cam.name, online: cam.online }
    return { tiles }
  })
}

function removeTile(id: string) {
  dropPeer(id)
  set((s) => ({ tiles: s.tiles.filter((t) => t.id !== id) }))
}

/** Removes a camera: it's disconnected and told why. */
export function removeCamera(id: string) {
  signal?.send({ t: 'kick', id })
  removeTile(id)
}

function dropPeer(id: string) {
  const p = peers.get(id)
  if (!p) return
  peers.delete(id)
  clearInterval(p.statsTimer)
  // Stopping the recorder keeps what it has so far (it lands in the tray).
  if (p.recorder?.state === 'recording') p.recorder.stop()
  p.pc.close()
  patch(id, { link: 'waiting', stream: null, stats: null, incoming: null })
}

// ---- Calls -----------------------------------------------------------------------------------

async function onSignal(from: string, data: Signal) {
  if (!tile(from)) return
  if (data.kind === 'offer') return answer(from, data)
  const p = peers.get(from)
  if (!p || p.pid !== data.pid || data.kind !== 'ice') return
  if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate).catch(() => {})
  else p.pending.push(data.candidate)
}

async function answer(from: string, offer: Extract<Signal, { kind: 'offer' }>) {
  dropPeer(from)
  const pc = new RTCPeerConnection(rtcConfig(ice))
  const p: Peer = { pc, dc: openChannel(pc), pid: offer.pid, tracks: [], pending: [], stats: statsReader(pc), statsTimer: 0, incoming: null, recorder: null }
  peers.set(from, p)
  patch(from, { link: 'connecting', caps: null, stats: null, incoming: null })
  const current = () => peers.get(from) === p
  pc.onicecandidate = (e) => {
    if (e.candidate && current()) signal?.send({ t: 'signal', to: from, data: { kind: 'ice', pid: p.pid, candidate: e.candidate.toJSON() as IceCandidate } })
  }
  pc.ontrack = (e) => {
    if (!current()) return
    p.tracks.push(e.track)
    patch(from, { stream: new MediaStream(p.tracks) })
  }
  pc.onconnectionstatechange = () => onLinkState(from, p)
  // Still not connected after 15 seconds: most likely a network blocking direct connections.
  window.setTimeout(() => {
    if (current() && pc.connectionState !== 'connected') patch(from, { blocked: true })
  }, 15_000)
  p.dc.onmessage = (e) => onPeerData(from, p, e.data)
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
    for (const c of p.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {})
    await pc.setLocalDescription(await pc.createAnswer())
    if (current()) signal?.send({ t: 'signal', to: from, data: { kind: 'answer', pid: p.pid, sdp: pc.localDescription!.sdp, screen: screenId } })
  } catch {
    if (!current()) return
    dropPeer(from)
    patch(from, { link: 'reconnecting' })
    signal?.send({ t: 'signal', to: from, data: { kind: 'restart', pid: offer.pid } })
  }
}

function onLinkState(id: string, p: Peer) {
  if (peers.get(id) !== p) return
  switch (p.pc.connectionState) {
    case 'connected':
      patch(id, { link: 'live', blocked: false })
      if (!p.statsTimer) p.statsTimer = window.setInterval(() => void readStats(id, p), 1000)
      return
    case 'disconnected':
      patch(id, { link: 'reconnecting' })
      return
    case 'failed':
      // The camera starts a new call when it notices too; this makes sure it does.
      patch(id, { link: 'reconnecting', blocked: true })
      signal?.send({ t: 'signal', to: id, data: { kind: 'restart', pid: p.pid } })
      return
  }
}

async function readStats(id: string, p: Peer) {
  const stats = await p.stats().catch(() => null)
  if (peers.get(id) === p && stats) patch(id, { stats })
}

// ---- What the cameras send -------------------------------------------------------------------

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Cameras are other people's devices: only take the shape we expect. */
function cleanCaps(v: unknown): CamCaps | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  const z = c.zoom as Record<string, unknown> | null
  const zoom =
    z && typeof z === 'object' && num(z.max) > num(z.min)
      ? { min: num(z.min), max: num(z.max), step: num(z.step, 0.1) || 0.1, value: num(z.value, num(z.min)) }
      : null
  return {
    facing: c.facing === 'user' || c.facing === 'environment' ? c.facing : null,
    canFlip: c.canFlip === true,
    torch: typeof c.torch === 'boolean' ? c.torch : null,
    zoom,
    mic: c.mic === true,
    width: num(c.width),
    height: num(c.height),
  }
}

/** Only image types: a received file must never be able to open as a web page. */
const imageType = (t: string) => (/^image\/(jpeg|png|webp)$/.test(t) ? t : 'image/jpeg')

function onPeerData(id: string, p: Peer, data: unknown) {
  if (data instanceof ArrayBuffer) {
    const inc = p.incoming
    if (!inc) return
    inc.received += data.byteLength
    if (inc.received > inc.size) {
      p.incoming = null
      patch(id, { incoming: null })
      return
    }
    inc.chunks.push(data)
    const shown = Math.floor((inc.received / inc.size) * 20) / 20
    if (shown !== inc.shown) {
      inc.shown = shown
      patch(id, { incoming: shown })
    }
    return
  }
  if (typeof data !== 'string') return
  let msg: PeerMsg
  try {
    msg = JSON.parse(data)
  } catch {
    return
  }
  switch (msg.t) {
    case 'caps':
      patch(id, { caps: cleanCaps(msg.caps) })
      return
    case 'photo':
      if (typeof msg.size !== 'number' || msg.size <= 0 || msg.size > MAX_PHOTO) return
      p.incoming = { id: String(msg.id), type: String(msg.type), size: msg.size, chunks: [], received: 0, shown: 0 }
      patch(id, { incoming: 0 })
      return
    case 'photo-end': {
      const inc = p.incoming
      if (!inc || inc.id !== msg.id) return
      p.incoming = null
      patch(id, { incoming: null })
      if (inc.received === inc.size) addShot('photo', new Blob(inc.chunks, { type: imageType(inc.type) }), tile(id)?.name ?? 'Camera')
      return
    }
    case 'photo-failed':
      p.incoming = null
      patch(id, { incoming: null })
      toast(`${tile(id)?.name ?? 'The camera'} couldn’t take the photo. Try again.`)
      return
  }
}

function addShot(kind: Shot['kind'], blob: Blob, camera: string) {
  const shot: Shot = { id: newId(), kind, number: ++shotNumber, url: URL.createObjectURL(blob), blob, camera, at: Date.now(), width: null, height: null, saved: false }
  set((s) => {
    const shots = [shot, ...s.shots]
    for (const old of shots.splice(MAX_SHOTS)) URL.revokeObjectURL(old.url)
    return { shots }
  })
  if (kind === 'photo')
    createImageBitmap(blob).then(
      (bmp) => {
        patchShot(shot.id, { width: bmp.width, height: bmp.height })
        bmp.close()
      },
      () => {},
    )
  toast(kind === 'photo' ? `Photo ${shot.number} from ${camera}` : `Clip ${shot.number} from ${camera}`)
}

function patchShot(id: string, change: Partial<Shot>) {
  set((s) => ({ shots: s.shots.map((x) => (x.id === id ? { ...x, ...change } : x)) }))
}

export const markSaved = (id: string) => patchShot(id, { saved: true })

export function deleteShot(id: string) {
  const shot = get().shots.find((s) => s.id === id)
  if (shot) URL.revokeObjectURL(shot.url)
  set((s) => ({ shots: s.shots.filter((x) => x.id !== id) }))
}

// ---- What the screen asks of a camera --------------------------------------------------------

function command(id: string, msg: PeerMsg) {
  const p = peers.get(id)
  if (p?.dc.readyState === 'open') p.dc.send(JSON.stringify(msg))
}

export const snap = (id: string) => command(id, { t: 'snap' })
export const flip = (id: string) => command(id, { t: 'flip' })
export const torch = (id: string, on: boolean) => command(id, { t: 'torch', on })
export const zoom = (id: string, value: number) => command(id, { t: 'zoom', value })

export const setListening = (id: string, listening: boolean) => patch(id, { listening })
export const setMirror = (id: string, mirror: boolean) => patch(id, { mirror })

const CLIP_TYPES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']

/** Records what a camera shows, into the tray. */
export function toggleRecording(id: string) {
  const p = peers.get(id)
  const t = tile(id)
  if (!p || !t?.stream) return
  if (p.recorder?.state === 'recording') {
    p.recorder.stop()
    return
  }
  if (typeof MediaRecorder === 'undefined') {
    toast('This browser can’t record video.')
    return
  }
  const tracks = t.caps?.mic ? p.tracks : p.tracks.filter((tr) => tr.kind === 'video')
  const mimeType = CLIP_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 8_000_000 })
  } catch {
    toast('Recording didn’t start. Try again.')
    return
  }
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  rec.onstop = () => {
    if (p.recorder === rec) p.recorder = null
    patch(id, { recordingSince: null })
    if (chunks.length) addShot('clip', new Blob(chunks, { type: rec.mimeType || 'video/webm' }), t.name)
  }
  rec.start(1000)
  p.recorder = rec
  patch(id, { recordingSince: Date.now() })
}
