// Bundles the pairing server (and the shared protocol) into one file that runs on plain Node 18+,
// so the server needs no node_modules.
import { build } from 'esbuild'

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  // ws is CommonJS and requires Node built-ins; give the ESM bundle a real `require`.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // Optional native speed-ups of ws, not installed.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
})
