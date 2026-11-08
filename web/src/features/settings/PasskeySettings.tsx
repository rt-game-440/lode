import { Fingerprint, Trash2 } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { ApiError, api } from '../../api/client'
import type { Passkey } from '../../api/types'
import { ListItem, ListPresence } from '../../components/AnimatedList'
import { confirmDialog } from '../../components/overlays'
import { Button, EmptyState, IconButton, Spinner, TextField } from '../../components/ui'
import { deviceName } from '../../lib/device'
import { createPasskey, isCancelled, passkeyAvailable } from '../../lib/webauthn'
import { useUI } from '../../stores/ui'
import { errorMessage } from '../actions'
import { useSettingsData } from './data'
import { Group, SettingsPage } from './parts'
import { SECTION_TITLE } from './stack'

// 设置里的“通行密钥”：登记、查看、删除。登录页的通行密钥登录见 features/auth。

const dateFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function lastUsed(p: Passkey) {
  return p.last_used_at ? `最后使用 ${dateFmt.format(p.last_used_at)}` : '从未使用'
}

export function PasskeysPage({ sub }: { sub: string[] }) {
  const passkeys = useSettingsData((s) => s.passkeys)
  const addPasskey = useSettingsData((s) => s.addPasskey)
  const removePasskey = useSettingsData((s) => s.removePasskey)
  const toast = useUI((s) => s.toast)
  const available = passkeyAvailable()

  const remove = async (p: Passkey) => {
    const ok = await confirmDialog({
      title: `删除“${p.name}”？`,
      message: '删除后这个通行密钥不能再用来登录；密码登录不受影响。要再次使用需要重新登记。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deletePasskey(p.id)
      removePasskey(p.id)
      toast({ message: `已删除“${p.name}”` })
    } catch (err) {
      toast({ message: errorMessage(err), tone: 'error' })
    }
  }

  return (
    <SettingsPage sub={sub} title={SECTION_TITLE.passkeys} testId="passkeys-page">
      {!available ? (
        <EmptyState icon={<Fingerprint size={28} strokeWidth={1.5} />} title="当前访问方式不能使用通行密钥">
          通行密钥只能在 HTTPS 或 localhost 下使用，并且要通过域名访问（不能用 IP 地址）。请改用 HTTPS 域名访问后再来登记；密码登录不受影响。
        </EmptyState>
      ) : (
        <>
          <p className="settings-desc">用指纹、面容或系统 PIN 一步登录，防钓鱼。手机、电脑可以分别登记；密码仍然保留，作为备用的登录方式。</p>
          <AddPasskeyForm onAdded={addPasskey} />
          <Group title="已登记的通行密钥" footer="通行密钥只在登记它的域名下可用。">
            {!passkeys ? (
              <div className="view-loading">
                <Spinner />
              </div>
            ) : !passkeys.length ? (
              <EmptyState icon={<Fingerprint size={28} strokeWidth={1.5} />} title="还没有通行密钥" />
            ) : (
              <ul className="settings-list passkey-list" aria-label="通行密钥列表">
                <ListPresence>
                  {passkeys.map((p) => (
                    <ListItem key={p.id}>
                      <div className="settings-row passkey-row">
                        <span className="passkey-text">
                          <span className="passkey-name">{p.name}</span>
                          <span className="settings-meta">
                            创建于 {dateFmt.format(p.created_at)} · {lastUsed(p)}
                          </span>
                        </span>
                        <IconButton label={`删除通行密钥“${p.name}”`} onClick={() => void remove(p)}>
                          <Trash2 size={17} />
                        </IconButton>
                      </div>
                    </ListItem>
                  ))}
                </ListPresence>
              </ul>
            )}
          </Group>
        </>
      )}
    </SettingsPage>
  )
}

function AddPasskeyForm({ onAdded }: { onAdded: (p: Passkey) => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useUI((s) => s.toast)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    // 名称留空时用这台设备的名称
    const finalName = name.trim() || deviceName()
    setBusy(true)
    setError(null)
    try {
      const { ceremony, options } = await api.passkeyRegisterBegin(finalName)
      const credential = await createPasskey(options)
      const created = await api.passkeyRegisterFinish(ceremony, credential)
      onAdded(created)
      setName('')
      toast({ message: `已添加“${created.name}”`, tone: 'success' })
    } catch (err) {
      if (isCancelled(err)) {
        setError('已取消。如果这个设备上已经登记过，浏览器会拒绝重复登记。')
      } else if (err instanceof DOMException && err.name === 'InvalidStateError') {
        setError('这个设备上的通行密钥已经登记过了。')
      } else if (err instanceof ApiError && err.code === 'passkey_unsupported') {
        setError('通行密钥需要通过域名并使用 HTTPS（或 localhost）访问。')
      } else {
        setError(errorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group title="添加通行密钥">
      <form className="token-form" onSubmit={(e) => void submit(e)}>
        <TextField
          id="passkey-name"
          label="名称"
          placeholder="例如 我的 MacBook、iPhone"
          maxLength={64}
          value={name}
          error={error}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          autoComplete="off"
        />
        <div className="token-form-actions">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? '请在系统弹窗中确认…' : '添加通行密钥'}
          </Button>
        </div>
      </form>
    </Group>
  )
}
