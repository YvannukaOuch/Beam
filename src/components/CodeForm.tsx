import { parseCode } from '@shared/protocol'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'

/** As people type: capitals, letters and digits only, and the dash after the third. */
function shape(input: string) {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw
}

/** The six-character code from the screen; going to it makes this device a camera for that screen. */
export function CodeForm({
  className,
  label = 'Code from the screen',
  autoFocus,
  onCode = (code) => navigate(`/${code}`),
}: {
  className?: string
  label?: string
  autoFocus?: boolean
  onCode?: (code: string) => void
}) {
  const id = useId()
  const [value, setValue] = useState('')
  const [checked, setChecked] = useState(false)
  const code = parseCode(value)
  const error = checked && !code ? (value ? 'Codes are 6 letters and numbers, like K7M-2QX. They never use O, 0, I, 1 or L.' : 'Type the code shown on the screen.') : null

  return (
    <form
      noValidate
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        setChecked(true)
        if (code) onCode(code)
      }}
    >
      <Label htmlFor={id}>
        {label}
        <span className="sr-only"> (required)</span>
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => setValue(shape(e.target.value))}
        onBlur={() => value && setChecked(true)}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        placeholder="K7M-2QX"
        maxLength={7}
        className={cn('mt-2 h-14 text-center text-2xl font-semibold tracking-[0.12em] uppercase font-stretch-expanded md:text-2xl', 'placeholder:text-muted-foreground/40')}
      />
      {error && (
        <p id={`${id}-error`} className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="mt-4 h-12 w-full text-base">
        Connect
      </Button>
    </form>
  )
}
