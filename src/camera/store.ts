import type { CamCaps, EndReason, ErrorCode, IceCandidate, IceServer, PeerMsg, ServerMsg, Signal } from '@shared/protocol'
import { create } from 'zustand'
import { deviceName, keepScreenOn, newId, tabId } from '@/lib/device'
import { isRelayed, openChannel, rtcConfig, sendPhoto, withTimeout } from '@/lib/rtc'
import { SignalSocket, type ConnState } from '@/lib/signal'
import { toast } from '@/lib/toast'

/**
 * The phone side. It joins the screen's session, and once the camera is on, calls the screen: it
 * makes the offer, sends the video (and the mic, when turned on), and carries out what the screen
 * asks for over the call's data channel (take a photo, switch camera, light, zoom).
 *
 * A call is replaced by a fresh one when it breaks, or when the screen page reloads (a new screen
 * id). Losing the pairing server alone doesn't touch the call: the video goes directly between the
 * two devices and keeps going.
 */

export type Phase = 'joining' | 'ready' | 'starting' | 'live' | 'ended' | 'error'
export type Link = 'idle' | 'connecting' | 'connected' | 'reconnecting'

export interface Problem {
  title: string
  detail: string
}

interface CamState {
  code: string
  phase: Phase
  conn: ConnState
  screenOnline: boolean
  link: Link
  relayed: boolean
  preview: MediaStream | null
  facing: CamCaps['facing']
  canFlip: boolean
  torch: boolean | null
  zoom: CamCaps['zoom']
  mic: boolean
  micBusy: boolean
  /** Photos still on their way to the screen. */
  sending: number
  /** Photos taken so far: each one flashes the preview. */
  shots: number
  problem: Problem | null
  ended: EndReason | 'left' | null
  /** A direct connection couldn't be made (one of the networks blocks it; there's no relay). */
  blocked: boolean
}

const initial = (code: string): CamState => ({
  code,
  phase: 'joining',
  conn: 'connecting',
  screenOnline: false,
  link: 'idle',
  relayed: false,
  preview: null,
  facing: null,
  canFlip: false,
  torch: null,
  zoom: null,
  mic: false,
  micBusy: false,
  sending: 0,
  shots: 0,
  problem: null,
  ended: null,
  blocked: false,
})

export const useCam = create<CamState>(() => initial(''))
const set = useCam.setState
const get = useCam.getState

interface Call {
  pc: RTCPeerConnection
  dc: RTCDataChannel
  pid: string
  /** The screen page this call is with. */
  screen: string
  video: RTCRtpSender
  audio: RTCRtpSender
  pending: RTCIceCandidateInit[]
  startedAt: number
  downTimer: number
  watchdog: number
}

type Lens = { facing: 'user' | 'environment'; exact?: boolean } | { deviceId: string }

const camId = tabId('beam:camera')
let session = 0
let signal: SignalSocket | null = null
let ice: IceServer[] = []
/** The screen page holding the session right now (null while it's away). */
let screen: string | null = null
let name = 'Camera'
let video: MediaStreamTrack | null = null
let mic: MediaStreamTrack | null = null
let call: Call | null = null
let releaseWake: (() => void) | null = null
let previewEl: HTMLVideoElement | null = null
let lastDialAt = 0
let redialTimer = 0
/** Switching or reopening the camera. */
let busy = false

export function setPreviewEl(el: HTMLVideoElement | null) {
  previewEl = el
}

/** Opens the camera page for this code; returns the clean-up for when the page goes away. */
export function openCamera(code: string) {
  document.addEventListener('visibilitychange', onVisible)
  begin(code)
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    session++
    stopAll()
  }
}

function begin(code: string) {
  const mine = ++session
  set(initial(code))
  void deviceName().then((n) => {
    if (mine !== session) return
    name = n
    signal = new SignalSocket(hello, onServer, (conn) => set({ conn }))
    signal.start()
  })
}

/** After the session ended for this camera: join the same code again. */
export function rejoin() {
  stopAll()
  begin(get().code)
}

function hello() {
  signal?.send({ t: 'join', room: get().code, id: camId, name })
}

// Whether this tab was live for this code, so a reload (by hand, or by the phone itself after a
// while in the background) carries straight on instead of asking to start the camera again.
const LIVE_KEY = 'beam:live'

function rememberLive(on: boolean) {
  try {
    if (on) sessionStorage.setItem(LIVE_KEY, get().code)
    else sessionStorage.removeItem(LIVE_KEY)
  } catch {
    // Storage blocked: after a reload, Start camera is one tap away.
  }
}

function wasLive() {
  try {
    return sessionStorage.getItem(LIVE_KEY) === get().code
  } catch {
    return false
  }
}

function onServer(msg: ServerMsg) {
  switch (msg.t) {
    case 'joined':
      ice = msg.ice
      screenIs(msg.screen)
      if (get().phase === 'joining') {
        set({ phase: 'ready' })
        if (wasLive()) void startCamera()
      }
      return
    case 'screen':
      screenIs(msg.screen)
      return
    case 'ice':
      ice = msg.ice
      return
    case 'signal':
      void onSignal(msg.data)
      return
    case 'ended':
      finish(msg.reason)
      return
    case 'error':
      onError(msg.code)
      return
  }
}

function screenIs(id: string | null) {
  screen = id
  set({ screenOnline: id !== null })
  if (!id || !video) return
  // A reloaded screen page is a new screen and needs a new call; the same page keeps the call it
  // has, unless that call is broken or still waiting for an answer that may have been lost.
  const c = call
  if (!c || c.screen !== id || c.pc.signalingState === 'have-local-offer' || ['failed', 'closed'].includes(c.pc.connectionState)) dial()
}

const joinProblems: Record<Exclude<ErrorCode, 'bad-request'>, Problem> = {
  'no-room': { title: 'No screen is using this code', detail: 'Check the code on your computer. It changes each time the screen starts a new session.' },
  full: { title: 'This screen already has 4 cameras', detail: 'Remove one on the screen, then try again.' },
  busy: { title: 'Beam is full right now', detail: 'Try again in a minute.' },
  'rate-limited': { title: 'Too many tries', detail: 'Wait a few minutes, then try again.' },
}

function onError(code: ErrorCode) {
  if (code === 'bad-request') return
  // Coming back to a session that ended while this phone was away.
  if (code === 'no-room' && get().phase !== 'joining') return finish('expired')
  stopAll()
  rememberLive(false)
  set({ phase: 'error', problem: joinProblems[code] })
}

function finish(reason: EndReason | 'left') {
  stopAll()
  rememberLive(false)
  set({ phase: 'ended', ended: reason, link: 'idle', screenOnline: false })
}

/** The person on the phone stopped: the screen drops this camera straight away. */
export function leave() {
  signal?.send({ t: 'leave' })
  finish('left')
}

function stopAll() {
  clearTimeout(redialTimer)
  signal?.stop()
  signal = null
  hangUp()
  video?.removeEventListener('ended', onVideoEnded)
  video?.stop()
  video = null
  mic?.stop()
  mic = null
  releaseWake?.()
  releaseWake = null
  set({ preview: null, mic: false, torch: null, zoom: null, sending: 0 })
}

// ---- The camera ------------------------------------------------------------------------------

function cameraProblem(err: unknown): Problem {
  const e = err as Error | undefined
  if (e?.message === 'insecure') return { title: 'The camera needs a secure page', detail: 'Open this page with https:// at the start of the address.' }
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { title: 'Camera access is blocked', detail: 'Allow the camera for this site in your browser’s settings, then tap Start camera again.' }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { title: 'No camera found', detail: 'This device doesn’t have a camera Beam can use.' }
    case 'NotReadableError':
    case 'AbortError':
      return { title: 'The camera is busy', detail: 'Another app is using it. Close that app, then try again.' }
  }
  return { title: 'The camera didn’t start', detail: 'Try again. If it keeps happening, reload the page.' }
}

async function openVideo(lens: Lens) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure')
  const which: MediaTrackConstraints =
    'deviceId' in lens ? { deviceId: { exact: lens.deviceId } } : { facingMode: lens.exact ? { exact: lens.facing } : { ideal: lens.facing } }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { ...which, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false })
  } catch (err) {
    // A camera that can't do 1080p: take whatever it offers.
    if ('deviceId' in lens || lens.exact || (err as Error).name !== 'OverconstrainedError') throw err
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
  }
  const track = stream.getVideoTracks()[0]
  track.addEventListener('ended', onVideoEnded)
  return track
}

/** The lens in use now, to open again after the system took the camera away. */
function currentLens(): Lens {
  const facing = get().facing
  if (facing) return { facing }
  const deviceId = video?.getSettings().deviceId
  return deviceId ? { deviceId } : { facing: 'environment' }
}

export async function startCamera() {
  if (get().phase !== 'ready') return
  const mine = session
  set({ phase: 'starting', problem: null })
  let track: MediaStreamTrack
  try {
    track = await openVideo({ facing: 'environment' })
  } catch (err) {
    if (mine === session) set({ phase: 'ready', problem: cameraProblem(err) })
    return
  }
  if (mine !== session) {
    track.stop()
    return
  }
  video = track
  set({ phase: 'live' })
  rememberLive(true)
  releaseWake = keepScreenOn()
  showPreview()
  await readCaps()
  // (A 'screen' message during readCaps may have dialled already.)
  if (mine === session && screen && !call) dial()
}

function showPreview() {
  set({ preview: video ? new MediaStream([video]) : null })
}

function swapVideo(track: MediaStreamTrack) {
  const old = video
  video = track
  if (old && old !== track) {
    old.removeEventListener('ended', onVideoEnded)
    old.stop()
  }
  const c = call
  if (c) void c.video.replaceTrack(track).catch(() => redial(c))
  showPreview()
  void readCaps()
}

// The system takes the camera away when the page is in the background (iOS) or another app wants
// it; get it back as soon as the page is in front again.
function onVideoEnded() {
  if (get().phase === 'live' && document.visibilityState === 'visible') void reopen()
}

function onVisible() {
  if (document.visibilityState !== 'visible' || get().phase !== 'live') return
  if (!video || video.readyState === 'ended') void reopen()
}

async function reopen() {
  if (busy) return
  busy = true
  try {
    swapVideo(await openVideo(currentLens()))
  } catch (err) {
    set({ problem: cameraProblem(err) })
  } finally {
    busy = false
  }
}

export async function flipCamera() {
  const { canFlip, facing } = get()
  const old = video
  if (!canFlip || busy || !old) return
  busy = true
  // Most phones can't have two cameras open at once: let go of this one first.
  old.removeEventListener('ended', onVideoEnded)
  old.stop()
  try {
    if (facing) {
      const next = facing === 'user' ? 'environment' : 'user'
      swapVideo(await openVideo({ facing: next, exact: true }).catch(() => openVideo({ facing: next })))
    } else {
      // A computer with several webcams: go round them in order.
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
      const at = cams.findIndex((d) => d.deviceId === old.getSettings().deviceId)
      swapVideo(await openVideo({ deviceId: cams[(at + 1) % cams.length].deviceId }))
    }
  } catch {
    try {
      swapVideo(await openVideo(facing ? { facing } : { facing: 'environment' }))
    } catch (err) {
      set({ problem: cameraProblem(err) })
    }
  } finally {
    busy = false
  }
}

type TrackCaps = { torch?: unknown; zoom?: { min: number; max: number; step?: number } }
type TrackSettings = { torch?: boolean; zoom?: number }

async function readCaps() {
  const track = video
  if (!track) return
  const caps = (track.getCapabilities?.() ?? {}) as TrackCaps
  const settings = track.getSettings() as MediaTrackSettings & TrackSettings
  let cameras = 0
  try {
    cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length
  } catch {
    // leave it at "can't switch"
  }
  if (track !== video) return
  const z = caps.zoom
  set({
    facing: settings.facingMode === 'user' || settings.facingMode === 'environment' ? settings.facingMode : null,
    canFlip: cameras > 1,
    torch: caps.torch ? Boolean(settings.torch) : null,
    zoom: z && z.max > z.min ? { min: z.min, max: z.max, step: z.step || 0.1, value: settings.zoom ?? z.min } : null,
  })
  sendCaps()
}

function caps(): CamCaps {
  const s = get()
  const settings = video?.getSettings()
  return { facing: s.facing, canFlip: s.canFlip, torch: s.torch, zoom: s.zoom, mic: s.mic, width: settings?.width ?? 0, height: settings?.height ?? 0 }
}

function tell(msg: PeerMsg) {
  if (call?.dc.readyState === 'open') call.dc.send(JSON.stringify(msg))
}

function sendCaps() {
  tell({ t: 'caps', caps: caps() })
}

export async function setTorch(on: boolean) {
  const track = video
  if (!track || get().torch === null) return
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
    if (track === video) set({ torch: on })
  } catch {
    // Some phones refuse while the camera is still starting up.
  }
  sendCaps()
}

let zoomBusy = false
let zoomNext: number | null = null

/** Zooms to `value`; a burst of requests (a slider being dragged) is coalesced to the latest. */
export async function setZoom(value: number) {
  const z = get().zoom
  if (!video || !z) return
  zoomNext = Math.min(z.max, Math.max(z.min, value))
  if (zoomBusy) return
  zoomBusy = true
  while (zoomNext !== null && video) {
    const v = zoomNext
    zoomNext = null
    try {
      await video.applyConstraints({ advanced: [{ zoom: v } as MediaTrackConstraintSet] })
      const now = get().zoom
      if (now) set({ zoom: { ...now, value: v } })
    } catch {
      // out of range for this lens; keep the previous zoom
    }
  }
  zoomBusy = false
  sendCaps()
}

export async function toggleMic() {
  const s = get()
  if (s.micBusy || s.phase !== 'live') return
  if (s.mic) {
    mic?.stop()
    mic = null
    if (call) void call.audio.replaceTrack(null)
    set({ mic: false })
    sendCaps()
    return
  }
  set({ micBusy: true })
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    mic = stream.getAudioTracks()[0]
    if (call) await call.audio.replaceTrack(mic)
    set({ mic: true })
  } catch (err) {
    set({
      problem:
        (err as Error).name === 'NotAllowedError'
          ? { title: 'Microphone access is blocked', detail: 'Allow the microphone for this site in your browser’s settings, then try again.' }
          : { title: 'The microphone didn’t start', detail: 'Another app may be using it. Close that app, then try again.' },
    })
  } finally {
    set({ micBusy: false })
    sendCaps()
  }
}

export function dismissProblem() {
  set({ problem: null })
}

// ---- The call --------------------------------------------------------------------------------

function dial() {
  if (!video || !screen) return
  hangUp()
  clearTimeout(redialTimer)
  lastDialAt = Date.now()
  const pc = new RTCPeerConnection(rtcConfig(ice))
  const dc = openChannel(pc)
  const stream = new MediaStream([video])
  const c: Call = {
    pc,
    dc,
    pid: newId(),
    screen,
    video: pc.addTransceiver(video, { direction: 'sendonly', streams: [stream] }).sender,
    // The mic can be switched on later without a new call: the slot for it is there from the start.
    audio: pc.addTransceiver(mic ?? 'audio', { direction: 'sendonly', streams: [stream] }).sender,
    pending: [],
    startedAt: Date.now(),
    downTimer: 0,
    // Not connected after 20 seconds: most likely a network that blocks direct connections. Say so,
    // and keep trying (the person may switch networks).
    watchdog: window.setTimeout(() => {
      if (call !== c || c.pc.connectionState === 'connected') return
      set({ blocked: true })
      redial(c)
    }, 20_000),
  }
  call = c
  set({ link: 'connecting', relayed: false })
  pc.onicecandidate = (e) => {
    if (e.candidate && call === c) signal?.send({ t: 'signal', data: { kind: 'ice', pid: c.pid, candidate: e.candidate.toJSON() as IceCandidate } })
  }
  pc.onconnectionstatechange = () => onLinkState(c)
  dc.onopen = () => sendCaps()
  dc.onmessage = (e) => onCommand(e.data)
  void (async () => {
    try {
      await pc.setLocalDescription(await pc.createOffer())
      if (call === c) signal?.send({ t: 'signal', data: { kind: 'offer', pid: c.pid, sdp: pc.localDescription!.sdp } })
    } catch {
      redial(c)
    }
  })()
}

function hangUp() {
  const c = call
  if (!c) return
  call = null
  clearTimeout(c.downTimer)
  clearTimeout(c.watchdog)
  c.pc.close()
}

/** Start a new call, at most one every 3 seconds so two sides that keep failing don't flood each other. */
function redial(c: Call) {
  if (call !== c) return
  clearTimeout(redialTimer)
  redialTimer = window.setTimeout(
    () => {
      if (call === c) dial()
    },
    Math.max(0, 3000 - (Date.now() - lastDialAt)),
  )
}

function onLinkState(c: Call) {
  if (call !== c) return
  clearTimeout(c.downTimer)
  switch (c.pc.connectionState) {
    case 'connected':
      set({ link: 'connected', blocked: false })
      void tune(c)
      return
    case 'disconnected':
      // Often comes back by itself (a Wi-Fi hiccup); if not, start a new call.
      set({ link: 'reconnecting' })
      c.downTimer = window.setTimeout(() => redial(c), 5000)
      return
    case 'failed':
      set({ link: 'reconnecting', blocked: true })
      redial(c)
      return
  }
}

/** Generous bitrate when the devices are connected directly; gentler when the relay server carries it. */
async function tune(c: Call) {
  const relayed = await isRelayed(c.pc).catch(() => false)
  if (call !== c) return
  set({ relayed })
  const params = c.video.getParameters()
  if (!params.encodings?.length) return
  params.encodings[0].maxBitrate = relayed ? 1_500_000 : 6_000_000
  await c.video.setParameters(params).catch(() => {})
}

async function onSignal(data: Signal) {
  const c = call
  if (!c || data.pid !== c.pid) return
  switch (data.kind) {
    case 'answer':
      if (c.pc.signalingState !== 'have-local-offer') return
      try {
        await c.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
        c.screen = data.screen
        for (const cand of c.pending.splice(0)) await c.pc.addIceCandidate(cand).catch(() => {})
      } catch {
        redial(c)
      }
      return
    case 'ice':
      if (c.pc.remoteDescription) await c.pc.addIceCandidate(data.candidate).catch(() => {})
      else c.pending.push(data.candidate)
      return
    case 'restart':
      // The screen lost the picture. Start over, unless this call has only just begun.
      if (Date.now() - c.startedAt > 4000) redial(c)
      return
  }
}

function onCommand(data: unknown) {
  if (typeof data !== 'string') return
  let msg: PeerMsg
  try {
    msg = JSON.parse(data)
  } catch {
    return
  }
  switch (msg.t) {
    case 'snap':
      takePhoto()
      return
    case 'flip':
      void flipCamera()
      return
    case 'torch':
      void setTorch(Boolean(msg.on))
      return
    case 'zoom':
      if (typeof msg.value === 'number' && Number.isFinite(msg.value)) void setZoom(msg.value)
      return
  }
}

// ---- Photos ----------------------------------------------------------------------------------

type ImageCaptureCtor = new (track: MediaStreamTrack) => { takePhoto(): Promise<Blob> }

/** A full-resolution still where the browser can take one (Chrome on Android), else a frame of the video. */
async function capture(): Promise<Blob> {
  const track = video
  if (!track) throw new Error('No camera')
  const ImageCapture = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture
  if (ImageCapture) {
    try {
      return await withTimeout(new ImageCapture(track).takePhoto(), 4000)
    } catch {
      // fall back to a frame of the video
    }
  }
  const el = previewEl
  if (!el || !el.videoWidth) throw new Error('No picture yet')
  const canvas = document.createElement('canvas')
  canvas.width = el.videoWidth
  canvas.height = el.videoHeight
  canvas.getContext('2d')!.drawImage(el, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), 'image/jpeg', 0.92))
}

let outbox = Promise.resolve()

/** Takes a photo now and sends it to the screen (one at a time, in order). */
export function takePhoto() {
  const c = call
  if (!c || c.dc.readyState !== 'open' || !video) return
  set((s) => ({ shots: s.shots + 1, sending: s.sending + 1 }))
  const shot = capture()
  outbox = outbox.then(async () => {
    try {
      await sendPhoto(c.dc, newId(), await shot)
      toast('Photo sent to the screen')
    } catch {
      tell({ t: 'photo-failed' })
      toast('The photo didn’t send. Try again.')
    } finally {
      set((s) => ({ sending: Math.max(0, s.sending - 1) }))
    }
  })
}
