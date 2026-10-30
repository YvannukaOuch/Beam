import { Toasts } from '@/components/Toasts'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CameraPage } from '@/camera/CameraPage'
import { JoinPage } from '@/join/JoinPage'
import { isHandheld } from '@/lib/device'
import { useRoute } from '@/lib/route'
import { ScreenPage } from '@/screen/ScreenPage'

export default function App() {
  const route = useRoute()
  let page
  switch (route.page) {
    case 'camera':
      page = <CameraPage key={route.code} code={route.code} />
      break
    case 'join':
      page = <JoinPage />
      break
    case 'screen':
      page = <ScreenPage />
      break
    default:
      // The address on its own: a computer shows the code, a phone asks for it.
      page = isHandheld ? <JoinPage /> : <ScreenPage />
  }
  return (
    <TooltipProvider delayDuration={300}>
      {page}
      <Toasts placement={route.page === 'camera' ? 'top' : 'bottom'} />
    </TooltipProvider>
  )
}
