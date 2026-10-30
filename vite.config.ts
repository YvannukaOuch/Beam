import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const SERVER_PORT = Number(process.env.PORT ?? 8794)

// The pairing server only answers /ws and /api; in production Caddy sends those to it and serves
// the built files itself. Dev and preview proxy the same two paths.
const proxy = {
  '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
  '/api': `http://127.0.0.1:${SERVER_PORT}`,
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@shared': path.resolve(import.meta.dirname, './shared'),
    },
  },
  server: { port: 6190, strictPort: true, proxy },
  preview: { port: 6191, strictPort: true, proxy },
})
