import { parseCode } from '@shared/protocol'
import { useMemo, useSyncExternalStore } from 'react'

/**
 * /          a computer becomes the screen; a phone gets the code form
 * /screen    this device is the screen, whatever it is
 * /join      the code form
 * /K7M2QX    this device is a camera for the screen showing that code (what the QR code opens)
 */
export type Route = { page: 'home' } | { page: 'screen' } | { page: 'join' } | { page: 'camera'; code: string }

function parse(path: string): Route {
  if (path === '/screen') return { page: 'screen' }
  if (path === '/join') return { page: 'join' }
  const code = parseCode(decodeURIComponent(path.slice(1)))
  return code ? { page: 'camera', code } : { page: 'home' }
}

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
window.addEventListener('popstate', notify)

export function navigate(path: string, replace = false) {
  if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path)
  notify()
}

export function useRoute(): Route {
  const path = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => location.pathname,
  )
  return useMemo(() => parse(path), [path])
}
