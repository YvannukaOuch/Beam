import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { join as joinPath } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  ID_PATTERN,
  MAX_CAMERAS,
  parseCode,
  type CameraInfo,
  type ClientMsg,
  type EndReason,
  type ErrorCode,
  type IceServer,
  type ServerMsg,
  type Signal,
} from '../shared/protocol'

/**
 * Beam's pairing server. It hands out codes, introduces a phone to the screen showing its code, and
 * passes their connection details along. The video and photos then go straight between the two
 * browsers (or through the TURN relay, still encrypted end to end), so this only ever handles a few
 * small messages per call. Sessions live in memory; on restart they're written to DATA_DIR and read
 * back, so a deploy doesn't interrupt anyone: calls already connected don't need this server at all.
 */

const PORT = Number(process.env.PORT ?? 8794)
const HOST = process.env.HOST ?? '127.0.0.1'
const DATA_DIR = process.env.DATA_DIR ?? ''

// A screen or camera that drops off (reload, phone locked, laptop asleep) keeps its place this long.
const GRACE_MS = 10 * 60_000
const MAX_ROOMS = 2000
const MAX_SOCKETS_PER_IP = 60

const STUN_URLS = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').filter(Boolean)
// The relay for networks that won't connect directly: coturn with a shared secret (TURN_SECRET).
const TURN_URLS = (process.env.TURN_URLS ?? '').split(',').filter(Boolean)
const TURN_SECRET = process.env.TURN_SECRET ?? ''
const TURN_TTL_S = 24 * 3600

interface Camera {
  id: string
  name: string
  ws: WebSocket | null
  leaveTimer?: NodeJS.Timeout
}

interface Room {
  code: string
  /** The screen's proof that the session is theirs, for taking it back after a reload. */
  token: string
  screenWs: WebSocket | null
  /** The screen page holding the session; null while it's away. */
  screenSession: string | null
  closeTimer?: NodeJS.Timeout
  cameras: Map<string, Camera>
}

type Role = { kind: 'screen'; room: Room } | { kind: 'camera'; room: Room; camera: Camera }

interface Conn {
  ip: string
  role: Role | null
  alive: boolean
  windowStart: number
  count: number
}

const rooms = new Map<string, Room>()
const conns = new Map<WebSocket, Conn>()
const socketsPerIp = new Map<string, number>()

/** Counts events per key over a sliding window. */
class Window {
  private hits = new Map<string, number[]>()
  private ms: number
  constructor(ms: number) {
    this.ms = ms
  }
  count(key: string) {
    const now = Date.now()
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.ms)
    if (recent.length) this.hits.set(key, recent)
    else this.hits.delete(key)
    return recent.length
  }
  hit(key: string) {
    this.hits.set(key, [...(this.hits.get(key) ?? []), Date.now()])
  }
  sweep() {
    for (const key of [...this.hits.keys()]) this.count(key)
  }
}

// New sessions per address, and wrong codes per address (so codes can't be guessed by brute force).
const created = new Window(10 * 60_000)
const wrongCodes = new Window(10 * 60_000)

function send(ws: WebSocket | null | undefined, msg: ServerMsg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function fail(ws: WebSocket, code: ErrorCode) {
  send(ws, { t: 'error', code })
}

function iceServers(): IceServer[] {
  const servers: IceServer[] = [{ urls: STUN_URLS }]
  if (TURN_URLS.length && TURN_SECRET) {
    // coturn's shared-secret scheme: the username is an expiry time, the password its HMAC.
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:beam${randomBytes(4).toString('hex')}`
    const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64')
    servers.push({ urls: TURN_URLS, username, credential })
  }
  return servers
}

const info = (cam: Camera): CameraInfo => ({ id: cam.id, name: cam.name, online: cam.ws !== null })

function newCode() {
  for (;;) {
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    if (!rooms.has(code)) return code
  }
}

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)

function cleanName(v: unknown) {
  const name = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : ''
  return name || 'Camera'
}

/** This socket no longer stands for anyone; its closing won't touch the session. */
function detach(ws: WebSocket | null) {
  const conn = ws && conns.get(ws)
  if (conn) conn.role = null
}

function endRoom(room: Room, reason: EndReason) {
  clearTimeout(room.closeTimer)
  rooms.delete(room.code)
  for (const cam of room.cameras.values()) {
    clearTimeout(cam.leaveTimer)
    detach(cam.ws)
    send(cam.ws, { t: 'ended', reason })
    cam.ws?.close(1000)
  }
  room.cameras.clear()
}

function removeCamera(room: Room, cam: Camera, reason?: EndReason) {
  clearTimeout(cam.leaveTimer)
  if (room.cameras.get(cam.id) !== cam) return
  room.cameras.delete(cam.id)
  if (cam.ws) {
    detach(cam.ws)
    if (reason) send(cam.ws, { t: 'ended', reason })
    cam.ws.close(1000)
    cam.ws = null
  }
  send(room.screenWs, { t: 'camera-left', id: cam.id })
}

function host(ws: WebSocket, conn: Conn, msg: Extract<ClientMsg, { t: 'host' }>) {
  if (conn.role || !isId(msg.screen)) return fail(ws, 'bad-request')
  // Taking back a session after a reload (or a dropped connection).
  if (typeof msg.room === 'string' && typeof msg.token === 'string') {
    const room = rooms.get(msg.room)
    if (room && sameSecret(room.token, msg.token)) {
      if (room.screenWs && room.screenWs !== ws) {
        // Another tab had it (a duplicated tab carries the same session); the newest one wins.
        const old = room.screenWs
        detach(old)
        send(old, { t: 'ended', reason: 'replaced' })
        old.close(1000)
      }
      clearTimeout(room.closeTimer)
      room.screenWs = ws
      room.screenSession = msg.screen
      conn.role = { kind: 'screen', room }
      send(ws, { t: 'hosted', room: room.code, token: room.token, ice: iceServers(), cameras: [...room.cameras.values()].map(info) })
      for (const cam of room.cameras.values()) send(cam.ws, { t: 'screen', screen: msg.screen })
      return
    }
  }
  if (created.count(conn.ip) >= 30) return fail(ws, 'rate-limited')
  if (rooms.size >= MAX_ROOMS) return fail(ws, 'busy')
  created.hit(conn.ip)
  const room: Room = { code: newCode(), token: randomBytes(24).toString('base64url'), screenWs: ws, screenSession: msg.screen, cameras: new Map() }
  rooms.set(room.code, room)
  conn.role = { kind: 'screen', room }
  send(ws, { t: 'hosted', room: room.code, token: room.token, ice: iceServers(), cameras: [] })
}

function join(ws: WebSocket, conn: Conn, msg: Extract<ClientMsg, { t: 'join' }>) {
  const code = typeof msg.room === 'string' ? parseCode(msg.room) : null
  if (conn.role || !code || !isId(msg.id)) return fail(ws, 'bad-request')
  if (wrongCodes.count(conn.ip) >= 20) return fail(ws, 'rate-limited')
  const room = rooms.get(code)
  if (!room) {
    wrongCodes.hit(conn.ip)
    return fail(ws, 'no-room')
  }
  const name = cleanName(msg.name)
  let cam = room.cameras.get(msg.id)
  if (cam) {
    // The same camera coming back. An older connection from it is stale, or a duplicated tab.
    if (cam.ws && cam.ws !== ws) {
      const old = cam.ws
      detach(old)
      send(old, { t: 'ended', reason: 'replaced' })
      old.close(1000)
    }
    clearTimeout(cam.leaveTimer)
    cam.ws = ws
    cam.name = name
  } else {
    if (room.cameras.size >= MAX_CAMERAS) return fail(ws, 'full')
    cam = { id: msg.id, name, ws }
    room.cameras.set(cam.id, cam)
  }
  conn.role = { kind: 'camera', room, camera: cam }
  send(ws, { t: 'joined', room: room.code, ice: iceServers(), screen: room.screenWs ? room.screenSession : null })
  send(room.screenWs, { t: 'camera', camera: info(cam) })
}

/** Only the fields each kind needs, size-checked: anything else isn't passed on. */
function cleanSignal(v: unknown): Signal | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (!isId(s.pid)) return null
  const pid = s.pid
  const sdp = typeof s.sdp === 'string' && s.sdp.length < 40_000 ? s.sdp : null
  switch (s.kind) {
    case 'offer':
      return sdp ? { kind: 'offer', pid, sdp } : null
    case 'answer':
      return sdp && isId(s.screen) ? { kind: 'answer', pid, sdp, screen: s.screen } : null
    case 'ice': {
      const c = s.candidate as Record<string, unknown> | null
      if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 2000) return null
      return {
        kind: 'ice',
        pid,
        candidate: {
          candidate: c.candidate,
          sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 32) : null,
          sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null,
          usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : null,
        },
      }
    }
    case 'restart':
      return { kind: 'restart', pid }
  }
  return null
}

function relay(conn: Conn, msg: Extract<ClientMsg, { t: 'signal' }>) {
  const role = conn.role
  const data = cleanSignal(msg.data)
  if (!role || !data) return
  if (role.kind === 'screen') {
    const cam = typeof msg.to === 'string' ? role.room.cameras.get(msg.to) : undefined
    send(cam?.ws, { t: 'signal', from: 'screen', data })
  } else {
    send(role.room.screenWs, { t: 'signal', from: role.camera.id, data })
  }
}

function onClose(ws: WebSocket, conn: Conn) {
  conns.delete(ws)
  const left = (socketsPerIp.get(conn.ip) ?? 1) - 1
  if (left > 0) socketsPerIp.set(conn.ip, left)
  else socketsPerIp.delete(conn.ip)

  const role = conn.role
  if (!role) return
  const { room } = role
  if (role.kind === 'screen') {
    if (room.screenWs !== ws) return
    room.screenWs = null
    room.screenSession = null
    for (const cam of room.cameras.values()) send(cam.ws, { t: 'screen', screen: null })
    room.closeTimer = setTimeout(() => endRoom(room, 'expired'), GRACE_MS)
  } else {
    const cam = role.camera
    if (cam.ws !== ws) return
    cam.ws = null
    send(room.screenWs, { t: 'camera', camera: info(cam) })
    cam.leaveTimer = setTimeout(() => removeCamera(room, cam), GRACE_MS)
  }
}

function handle(ws: WebSocket, conn: Conn, msg: ClientMsg) {
  switch (msg.t) {
    case 'ping':
      return send(ws, { t: 'pong' })
    case 'host':
      return host(ws, conn, msg)
    case 'join':
      return join(ws, conn, msg)
    case 'signal':
      return relay(conn, msg)
    case 'kick': {
      if (conn.role?.kind !== 'screen' || typeof msg.id !== 'string') return
      const room = conn.role.room
      const cam = room.cameras.get(msg.id)
      if (cam) removeCamera(room, cam, 'kicked')
      return
    }
    case 'leave': {
      if (conn.role?.kind !== 'camera') return
      const { room, camera } = conn.role
      conn.role = null
      camera.ws = null
      removeCamera(room, camera)
      return
    }
    case 'close': {
      if (conn.role?.kind !== 'screen') return
      const room = conn.role.room
      conn.role = null
      room.screenWs = null
      endRoom(room, 'closed')
      return
    }
  }
}

/** Behind Caddy, the last X-Forwarded-For entry is the one Caddy added (the real client). */
function clientIp(req: IncomingMessage) {
  const fwd = req.headers['x-forwarded-for']
  const last = (Array.isArray(fwd) ? fwd.join(',') : (fwd ?? '')).split(',').pop()?.trim()
  return last || req.socket.remoteAddress || '?'
}

/** Only pages from this site may use the server (browsers always send Origin on WebSockets). */
function sameOrigin(req: IncomingMessage) {
  try {
    return new URL(req.headers.origin ?? '').host === req.headers.host
  } catch {
    return false
  }
}

// ---- Surviving restarts ----------------------------------------------------------------------

interface SavedRoom {
  code: string
  token: string
  cameras: { id: string; name: string }[]
}

const savedFile = () => joinPath(DATA_DIR, 'sessions.json')

function saveRooms() {
  if (!DATA_DIR) return
  const saved: SavedRoom[] = [...rooms.values()].map((r) => ({
    code: r.code,
    token: r.token,
    cameras: [...r.cameras.values()].map((c) => ({ id: c.id, name: c.name })),
  }))
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(savedFile() + '.tmp', JSON.stringify({ savedAt: Date.now(), rooms: saved }))
  renameSync(savedFile() + '.tmp', savedFile())
}

/** Sessions from before a restart wait for their screen and cameras to reconnect, as after any drop-out. */
function loadRooms() {
  if (!DATA_DIR) return
  let data: { savedAt: number; rooms: SavedRoom[] }
  try {
    data = JSON.parse(readFileSync(savedFile(), 'utf8'))
  } catch {
    return
  }
  rmSync(savedFile(), { force: true })
  if (!(Date.now() - data.savedAt < GRACE_MS) || !Array.isArray(data.rooms)) return
  for (const s of data.rooms) {
    if (parseCode(s.code) !== s.code || typeof s.token !== 'string' || rooms.has(s.code)) continue
    const room: Room = { code: s.code, token: s.token, screenWs: null, screenSession: null, cameras: new Map() }
    for (const c of s.cameras ?? []) {
      if (!isId(c.id)) continue
      const cam: Camera = { id: c.id, name: cleanName(c.name), ws: null }
      cam.leaveTimer = setTimeout(() => removeCamera(room, cam), GRACE_MS)
      room.cameras.set(cam.id, cam)
    }
    room.closeTimer = setTimeout(() => endRoom(room, 'expired'), GRACE_MS)
    rooms.set(room.code, room)
  }
  console.log(`[beam] restored ${rooms.size} session(s)`)
}

// ---- HTTP + WebSocket ------------------------------------------------------------------------

const server = createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, sessions: rooms.size, connections: conns.size, relay: TURN_URLS.length > 0 && TURN_SECRET !== '' }))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('Not found')
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

server.on('upgrade', (req, socket, head) => {
  const ip = clientIp(req)
  const ok = req.url?.split('?')[0] === '/ws' && sameOrigin(req) && (socketsPerIp.get(ip) ?? 0) < MAX_SOCKETS_PER_IP
  if (!ok) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const conn: Conn = { ip: clientIp(req), role: null, alive: true, windowStart: Date.now(), count: 0 }
  conns.set(ws, conn)
  socketsPerIp.set(conn.ip, (socketsPerIp.get(conn.ip) ?? 0) + 1)
  ws.on('pong', () => {
    conn.alive = true
  })
  ws.on('message', (raw, isBinary) => {
    conn.alive = true
    if (isBinary) return
    const now = Date.now()
    if (now - conn.windowStart > 10_000) {
      conn.windowStart = now
      conn.count = 0
    }
    if (++conn.count > 300) {
      ws.close(1008, 'Too many messages')
      return
    }
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg && typeof msg === 'object') handle(ws, conn, msg)
  })
  ws.on('close', () => onClose(ws, conn))
  ws.on('error', () => {})
})

// Drop connections that stopped answering (a phone that died, a laptop that went to sleep).
setInterval(() => {
  for (const [ws, conn] of conns) {
    if (!conn.alive) {
      ws.terminate()
      continue
    }
    conn.alive = false
    ws.ping()
  }
}, 30_000)

// Relay credentials last a day; long sessions get fresh ones well before that.
setInterval(() => {
  for (const [ws, conn] of conns) if (conn.role) send(ws, { t: 'ice', ice: iceServers() })
}, 6 * 3600_000)

setInterval(() => {
  created.sweep()
  wrongCodes.sweep()
}, 10 * 60_000)

function shutdown() {
  try {
    saveRooms()
  } catch (err) {
    console.error('[beam] could not save sessions', err)
  }
  for (const ws of conns.keys()) ws.close(1012, 'Restarting')
  server.close()
  setTimeout(() => process.exit(0), 300).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

loadRooms()
server.listen(PORT, HOST, () => {
  console.log(`[beam] listening on http://${HOST}:${PORT} (relay ${TURN_URLS.length && TURN_SECRET ? 'on' : 'off'})`)
})
