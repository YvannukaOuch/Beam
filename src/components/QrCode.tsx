import { useMemo } from 'react'
import { encode } from 'uqr'

/**
 * A QR code drawn as one SVG path (runs of dark modules merged), dark on white in both themes:
 * not every phone reads a light-on-dark code.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 0 })
    let d = ''
    qr.data.forEach((row, y) => {
      for (let x = 0; x < row.length; ) {
        if (!row[x]) {
          x++
          continue
        }
        let end = x
        while (end < row.length && row[end]) end++
        d += `M${x} ${y}h${end - x}v1h${x - end}z`
        x = end
      }
    })
    return { path: d, size: qr.size }
  }, [value])

  // Two modules of white all round (the "quiet zone" scanners need), inside the white card.
  return (
    <svg viewBox={`-2 -2 ${size + 4} ${size + 4}`} role="img" aria-label={label} shapeRendering="crispEdges" className={className}>
      <rect x={-2} y={-2} width={size + 4} height={size + 4} className="fill-qr-bg" />
      <path d={path} className="fill-qr-fg" />
    </svg>
  )
}
