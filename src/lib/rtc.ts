import type { IceServer, PeerMsg } from '@shared/protocol'

/** `?relay` in the address forces the call through the TURN relay (handy for testing it). */
export const relayOnly = new URLSearchParams(location.search).has('relay')

export function rtcConfig(ice: IceServer[]): RTCConfiguration {
  return { iceServers: ice, iceTransportPolicy: relayOnly ? 'relay' : 'all' }
}

/** The data channel both ends create with the same id, so neither has to wait to be offered one. */
export function openChannel(pc: RTCPeerConnection) {
  const dc = pc.createDataChannel('beam', { negotiated: true, id: 0 })
  dc.binaryType = 'arraybuffer'
  return dc
}

type Stat = Record<string, unknown> & { type: string; id: string }

/** Whether the connection in use goes through the relay rather than directly between the devices. */
function relayed(report: RTCStatsReport) {
  let pair: Stat | undefined
  report.forEach((s: Stat) => {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = report.get(s.selectedCandidatePairId)
  })
  // Firefox and Safari don't name the selected pair on the transport.
  if (!pair)
    report.forEach((s: Stat) => {
      if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s
    })
  if (!pair) return false
  const local = report.get(pair.localCandidateId as string) as Stat | undefined
  const remote = report.get(pair.remoteCandidateId as string) as Stat | undefined
  return local?.candidateType === 'relay' || remote?.candidateType === 'relay'
}

export async function isRelayed(pc: RTCPeerConnection) {
  return relayed(await pc.getStats())
}

/** What the screen shows over a live camera. */
export interface LinkStats {
  width: number
  height: number
  fps: number
  kbps: number
  relayed: boolean
}

/** Reads the incoming video's size, frame rate and bitrate (bitrate from the change since the last read). */
export function statsReader(pc: RTCPeerConnection) {
  let lastBytes = 0
  let lastAt = 0
  return async (): Promise<LinkStats | null> => {
    const report = await pc.getStats()
    let video: Stat | undefined
    report.forEach((s: Stat) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') video = s
    })
    if (!video) return null
    const bytes = Number(video.bytesReceived ?? 0)
    const at = Number(video.timestamp ?? 0)
    // bytes × 8 / milliseconds = kilobits per second
    const kbps = lastAt && at > lastAt ? ((bytes - lastBytes) * 8) / (at - lastAt) : 0
    lastBytes = bytes
    lastAt = at
    return {
      width: Number(video.frameWidth ?? 0),
      height: Number(video.frameHeight ?? 0),
      fps: Math.round(Number(video.framesPerSecond ?? 0)),
      kbps: Math.max(0, Math.round(kbps)),
      relayed: relayed(report),
    }
  }
}

const CHUNK = 16 * 1024
const HIGH_WATER = 1024 * 1024

function drained(dc: RTCDataChannel) {
  return new Promise<void>((resolve) => {
    dc.bufferedAmountLowThreshold = HIGH_WATER / 4
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done)
      dc.removeEventListener('close', done)
      resolve()
    }
    dc.addEventListener('bufferedamountlow', done)
    dc.addEventListener('close', done)
  })
}

/** Sends a photo in 16 KB pieces (the size every browser accepts), pausing whenever the channel backs up. */
export async function sendPhoto(dc: RTCDataChannel, id: string, blob: Blob) {
  const header: PeerMsg = { t: 'photo', id, size: blob.size, type: blob.type || 'image/jpeg' }
  dc.send(JSON.stringify(header))
  const buf = await blob.arrayBuffer()
  for (let at = 0; at < buf.byteLength; at += CHUNK) {
    if (dc.bufferedAmount > HIGH_WATER) await drained(dc)
    if (dc.readyState !== 'open') throw new Error('The connection closed')
    dc.send(buf.slice(at, at + CHUNK))
  }
  const end: PeerMsg = { t: 'photo-end', id }
  dc.send(JSON.stringify(end))
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
