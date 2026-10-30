import { create } from 'zustand'

interface Toast {
  id: number
  text: string
}

export const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }))

let next = 1

/** A short message at the bottom of the page that goes away by itself. */
export function toast(text: string) {
  const id = next++
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-2), { id, text }] }))
  setTimeout(() => useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3500)
}
