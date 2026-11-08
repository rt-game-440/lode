import { KeyRound } from 'lucide-react'
import { motion } from 'motion/react'
import { type FormEvent, useEffect, useState } from 'react'
import { ApiError } from '../../api/client'
import { Button, TextField } from '../../components/ui'
import { isCancelled, passkeyAvailable } from '../../lib/webauthn'
import { useSession } from '../../stores/session'
import { springDefault } from '../../styles/tokens/motion'
import './auth.css'

/** 首启设置密码与登录。 */
export function AuthPage({ mode }: { mode: 'setup' | 'login' }) {
  const setup = useSession((s) => s.setup)
  const login = useSession((s) => s.login)
  const loginWithPasskey = useSession((s) => s.loginWithPasskey)
  const refreshPasskey = useSession((s) => s.refreshPasskey)
  const hasPasskey = useSession((s) => s.passkey)
  // 非安全上下文（http://局域网 IP）、IP 访问或浏览器不支持时不显示通行密钥选项
  const showPasskey = mode === 'login' && hasPasskey && passkeyAvailable()
  useEffect(() => {
    if (mode === 'login') void refreshPasskey()
  }, [mode, refreshPasskey])
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const showError = (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.code === 'rate_limited') {
        const wait = Number(err.body.retry_after ?? 60)
        setError(`尝试次数过多，请 ${wait} 秒后再试`)
      } else if (err.code === 'wrong_password') setError('密码不正确')
      else if (err.code === 'weak_password') setError('密码至少 8 位')
      else if (err.code === 'already_initialized') setError('已经设置过密码，请刷新页面登录')
      else if (err.code === 'passkey_failed') setError('通行密钥验证失败，可以改用密码登录')
      else if (err.code === 'ceremony_expired') setError('验证已过期，请重试')
      else setError(err.message || '出错了，请重试')
    } else setError('出错了，请重试')
  }

  const passkeyLogin = async () => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await loginWithPasskey()
    } catch (err) {
      // 用户在系统弹窗里取消：不算错误，保持在登录页
      if (!isCancelled(err)) showError(err)
      setBusy(false)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    if (mode === 'setup') {
      if (password.length < 8) return setError('密码至少 8 位')
      if (password !== confirm) return setError('两次输入的密码不一致')
    } else if (!password) {
      return setError('请输入密码')
    }
    setBusy(true)
    try {
      if (mode === 'setup') await setup(password)
      else await login(password)
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <motion.form
        className="auth-card"
        onSubmit={submit}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={springDefault}
        noValidate
      >
        <div className="auth-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="40" height="40">
            <rect x="3" y="3" width="26" height="26" rx="8" fill="var(--color-accent-fill)" />
            <path d="M11 9.5v13h10" stroke="var(--color-on-accent)" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="auth-title">{mode === 'setup' ? '欢迎使用 Lode' : '登录 Lode'}</h1>
        <p className="auth-sub">{mode === 'setup' ? '先为这台服务器设置一个访问密码。' : '输入访问密码继续。'}</p>

        {/* 让密码管理器识别为同一账户 */}
        <input type="text" name="username" autoComplete="username" value="lode" readOnly hidden />
        <TextField
          label="密码"
          type="password"
          name="password"
          autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
          autoFocus
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
            setError(null)
          }}
          placeholder={mode === 'setup' ? '至少 8 位' : ''}
        />
        {mode === 'setup' && (
          <TextField
            label="确认密码"
            type="password"
            name="confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value)
              setError(null)
            }}
          />
        )}
        <p className="auth-error" role="alert" aria-live="assertive">
          {error}
        </p>
        <Button type="submit" variant="primary" size="lg" block disabled={busy}>
          {busy ? '请稍候…' : mode === 'setup' ? '设置密码并进入' : '登录'}
        </Button>
        {showPasskey && (
          <>
            <p className="auth-or" aria-hidden="true">
              <span>或</span>
            </p>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              block
              icon={<KeyRound size={18} aria-hidden="true" />}
              disabled={busy}
              onClick={() => void passkeyLogin()}
            >
              使用通行密钥登录
            </Button>
          </>
        )}
      </motion.form>
    </main>
  )
}
