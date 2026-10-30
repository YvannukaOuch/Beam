import { ID_PATTERN } from '@shared/protocol'

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_')
}

/** An id for this tab that survives reloads (sessionStorage), so a reload picks up where it left off. */
export function tabId(key: string) {
  try {
    const saved = sessionStorage.getItem(key)
    if (saved && ID_PATTERN.test(saved)) return saved
    const id = newId()
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return newId()
  }
}

const ua = navigator.userAgent
const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)

/** Phones and tablets open the code form; computers become the screen. */
export const isHandheld = /Android|iPhone|iPod|Mobile/i.test(ua) || isIPad

interface UAData {
  mobile?: boolean
  getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string }>
}

/** What the screen calls this camera: the phone's model where the browser says (Chrome on Android), else its kind. */
export async function deviceName() {
  try {
    const data = (navigator as Navigator & { userAgentData?: UAData }).userAgentData
    if (data?.mobile && data.getHighEntropyValues) {
      const { model } = await data.getHighEntropyValues(['model'])
      if (model) return model
    }
  } catch {
    // fall through to the generic names
  }
  if (/iPhone/.test(ua)) return 'iPhone'
  if (isIPad) return 'iPad'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
  if (/CrOS/.test(ua)) return 'Chromebook'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Linux/.test(ua)) return 'Linux PC'
  return 'Camera'
}

/** Keeps the screen from dimming and locking (which would stop the camera on a phone). Returns a release function. */
export function keepScreenOn() {
  let lock: WakeLockSentinel | null = null
  let wanted = true
  const request = () => {
    if (!wanted || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return
    navigator.wakeLock.request('screen').then(
      (l) => {
        if (wanted) lock = l
        else void l.release()
      },
      () => {
        // Refused (battery saver, or not allowed here): the camera still works while the screen is on.
      },
    )
  }
  // The browser lets go of the lock whenever the page is hidden; take it again on return.
  document.addEventListener('visibilitychange', request)
  request()
  return () => {
    wanted = false
    document.removeEventListener('visibilitychange', request)
    void lock?.release()
    lock = null
  }
}
