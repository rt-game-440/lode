import { useEffect } from 'react'
import { Button, Spinner } from './components/ui'
import { AuthPage } from './features/auth/AuthPage'
import { AppShell } from './features/shell/AppShell'
import { useSession } from './stores/session'

export function App() {
  const phase = useSession((s) => s.phase)
  const check = useSession((s) => s.check)

  useEffect(() => {
    void check()
  }, [check])

  switch (phase) {
    case 'loading':
      return (
        <div className="boot" aria-busy="true">
          <Spinner size={22} />
        </div>
      )
    case 'setup':
      return <AuthPage mode="setup" />
    case 'login':
      return <AuthPage mode="login" />
    case 'offline':
      return (
        <div className="boot">
          <p>无法连接到 Lode 服务器。</p>
          <Button variant="secondary" onClick={() => void check()}>
            重试
          </Button>
        </div>
      )
    default:
      return <AppShell />
  }
}
