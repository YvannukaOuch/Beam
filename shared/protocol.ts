/**
 * Two kinds of messages:
 * - ClientMsg / ServerMsg go through the pairing server. It hands out codes, introduces a phone to
 *   the screen showing that code, and passes their connection details back and forth.
 * - PeerMsg go straight between a camera and the screen on their own encrypted connection, along
 *   with the video and any photos. The server never sees those.
 */

/** Codes people read off a screen and type on a phone: no 0/O or 1/I/L to mix up. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const CODE_LENGTH = 6
export const MAX_CAMERAS = 4

/** "k7m2qx", "K7M-2QX", " k7m 2qx " → "K7M2QX"; null if it can't be a code. */
export function parseCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== CODE_LENGTH) return null
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null
  return code
}

/** K7M2QX → K7M-2QX: easier to read out and type. */
export const formatCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`

/** Random ids the browsers make up themselves (camera slots, call attempts, screen pages). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface IceCandidate {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
}

/**
 * Connection details passed between a camera and the screen. `pid` names the call attempt they
 * belong to, so anything left over from an earlier attempt is ignored. `screen` in the answer is
 * the screen page that took the call: if the screen reloads, cameras can tell it's a new page.
 */
export type Signal =
  | { kind: 'offer'; pid: string; sdp: string }
  | { kind: 'answer'; pid: string; sdp: string; screen: string }
  | { kind: 'ice'; pid: string; candidate: IceCandidate }
  | { kind: 'restart'; pid: string }

export interface CameraInfo {
  id: string
  name: string
  online: boolean
}

/** Why a session ended for this page: the screen ended it, it was away too long, the screen removed this camera, or another tab took over. */
export type EndReason = 'closed' | 'expired' | 'kicked' | 'replaced'
export type ErrorCode = 'no-room' | 'full' | 'busy' | 'rate-limited' | 'bad-request'

export type ClientMsg =
  /** Screen: open a new session, or take back `room` after a reload. */
  | { t: 'host'; screen: string; room?: string; token?: string }
  /** Camera: join the session with this code (again, after a reload, with the same id). */
  | { t: 'join'; room: string; id: string; name: string }
  /** Camera → screen (no `to`), or screen → the camera `to`. */
  | { t: 'signal'; to?: string; data: Signal }
  /** Screen: remove a camera. */
  | { t: 'kick'; id: string }
  /** Camera: stop now (rather than being kept for a while in case it comes back). */
  | { t: 'leave' }
  /** Screen: end the session; every camera is disconnected. */
  | { t: 'close' }
  | { t: 'ping' }

export type ServerMsg =
  | { t: 'hosted'; room: string; token: string; ice: IceServer[]; cameras: CameraInfo[] }
  | { t: 'joined'; room: string; ice: IceServer[]; screen: string | null }
  /** To the screen: a camera joined, or went offline / came back. */
  | { t: 'camera'; camera: CameraInfo }
  | { t: 'camera-left'; id: string }
  /** To cameras: the screen page now holding the session, or null while it's away. */
  | { t: 'screen'; screen: string | null }
  | { t: 'signal'; from: string; data: Signal }
  /** Fresh relay credentials for long sessions. */
  | { t: 'ice'; ice: IceServer[] }
  | { t: 'ended'; reason: EndReason }
  | { t: 'error'; code: ErrorCode }
  | { t: 'pong' }

/** What a camera can do right now; sent to the screen whenever it changes. */
export interface CamCaps {
  facing: 'user' | 'environment' | null
  canFlip: boolean
  /** null: this camera has no light. */
  torch: boolean | null
  zoom: { min: number; max: number; step: number; value: number } | null
  mic: boolean
  width: number
  height: number
}

/** On the direct channel. A 'photo' header is followed by the image in raw binary chunks, then 'photo-end'. */
export type PeerMsg =
  | { t: 'caps'; caps: CamCaps }
  | { t: 'snap' }
  | { t: 'flip' }
  | { t: 'torch'; on: boolean }
  | { t: 'zoom'; value: number }
  | { t: 'photo'; id: string; size: number; type: string }
  | { t: 'photo-end'; id: string }
  | { t: 'photo-failed' }
