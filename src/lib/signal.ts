import type { ClientMsg, ServerMsg } from '@shared/protocol'

export type ConnState = 'connecting' | 'open' | 'offline'

/**
 * One WebSocket to the pairing server that reconnects by itself: with backoff, and straight away
 * when the network or the tab comes back. `onOpen` runs after every (re)connect so the page can say
 * who it is again. Messages sent while disconnected are dropped rather than queued: connection
 * details go stale, and both sides start a fresh call once they're back anyway.
 */
export class SignalSocket {
  private ws: WebSocket | null = null
  private retries = 0
  private retryTimer = 0
  private pingTimer = 0
  private pongTimer = 0
  private stopped = true
  private onOpen: () => void
  private onMessage: (msg: ServerMsg) => void
  private onState: (state: ConnState) => void

  constructor(onOpen: () => void, onMessage: (msg: ServerMsg) => void, onState: (state: ConnState) => void) {
    this.onOpen = onOpen
    this.onMessage = onMessage
    this.onState = onState
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    window.addEventListener('online', this.reconnectNow)
    document.addEventListener('visibilitychange', this.onVisible)
    this.connect()
  }

  stop() {
    this.stopped = true
    window.removeEventListener('online', this.reconnectNow)
    document.removeEventListener('visibilitychange', this.onVisible)
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  send(msg: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  private connect = () => {
    this.clearTimers()
    if (this.stopped) return
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    this.ws = socket
    this.onState('connecting')
    socket.onopen = () => {
      if (this.ws !== socket) return
      this.retries = 0
      this.onState('open')
      this.pingTimer = window.setInterval(() => this.check(10_000), 20_000)
      this.onOpen()
    }
    socket.onmessage = (e) => {
      if (this.ws !== socket) return
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }
      clearTimeout(this.pongTimer)
      if (msg.t !== 'pong') this.onMessage(msg)
    }
    socket.onclose = () => {
      if (this.ws !== socket) return
      this.ws = null
      this.clearTimers()
      if (this.stopped) return
      this.onState('offline')
      this.retryTimer = window.setTimeout(this.connect, Math.min(8000, 500 * 2 ** this.retries++))
    }
  }

  /** Ask the server for a sign of life; a connection that died without noticing gets replaced. */
  private check(timeout: number) {
    if (!this.send({ t: 'ping' })) return
    clearTimeout(this.pongTimer)
    this.pongTimer = window.setTimeout(this.reconnectNow, timeout)
  }

  /** Give up on the current socket (it may be dead without knowing it) and connect again now. */
  private reconnectNow = () => {
    if (this.stopped) return
    const old = this.ws
    this.ws = null
    old?.close()
    this.retries = 0
    this.onState('offline')
    this.connect()
  }

  // Phones freeze pages in the background: when this one is back, make sure the connection is too.
  private onVisible = () => {
    if (document.visibilityState !== 'visible' || this.stopped) return
    if (this.ws?.readyState === WebSocket.OPEN) this.check(4000)
    else if (!this.ws || this.ws.readyState !== WebSocket.CONNECTING) this.reconnectNow()
  }

  private clearTimers() {
    clearTimeout(this.retryTimer)
    clearInterval(this.pingTimer)
    clearTimeout(this.pongTimer)
  }
}
