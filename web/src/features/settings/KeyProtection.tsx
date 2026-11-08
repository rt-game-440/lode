import { Lock, LockOpen } from 'lucide-react'
import { ApiError, api } from '../../api/client'
import type { KeyProtection, KeyProtectionAction, Passkey } from '../../api/types'
import { confirmDialog } from '../../components/overlays'
import { getPasskey, isCancelled } from '../../lib/webauthn'
import { useAgent } from '../../stores/agent'
import { useUI } from '../../stores/ui'
import { errorMessage } from '../actions'
import { useSettingsData } from './data'
import { ActionRow, Group } from './parts'

// “用通行密钥保护 API key”（#29）：开启后服务器不再保存明文主密钥，重启后要用通行密钥解锁助手才能用 API key。

function toast(message: string, tone?: 'error' | 'success') {
  useUI.getState().toast({ message, tone })
}

function failMessage(err: unknown): string {
  if (isCancelled(err)) return '已取消验证'
  // 保护相关的错误说明由服务端给出（不支持 PRF、解不开、没加入保护等）
  if (err instanceof ApiError && err.status < 500 && err.code !== 'network') return err.message
  return errorMessage(err)
}

/** 操作后刷新通行密钥列表（加入保护的标记）、保护状态和助手配置（是否锁定）。 */
async function refresh(next?: KeyProtection) {
  const data = useSettingsData.getState()
  if (next) data.setKeyProtection(next)
  await Promise.all([data.loadPasskeys(), data.loadKeyProtection(), useAgent.getState().loadConfig()])
}

/** 做一次带 PRF 的通行密钥验证并按 action 开启、解锁或加入保护。 */
async function verify(action: KeyProtectionAction, passkey?: string): Promise<KeyProtection> {
  const { ceremony, options } = await api.keyProtectionBegin(action, passkey)
  const credential = await getPasskey(options)
  return api.keyProtectionFinish(ceremony, credential)
}

async function run(fn: () => Promise<KeyProtection | void>, done?: string) {
  try {
    const next = await fn()
    if (done) toast(done, 'success')
    await refresh(next ?? undefined)
  } catch (err) {
    toast(failMessage(err), 'error')
    void refresh()
  }
}

export function enrollPasskey(p: Passkey) {
  return run(() => verify('enroll', p.id), `“${p.name}”已加入保护，可以用它解锁 API key`)
}

/** 删除通行密钥前的确认：它是最后一个能解锁 API key 的通行密钥时说明后果。返回 null 表示取消，否则返回是否要带 force。 */
export async function confirmPasskeyDelete(p: Passkey, kp: KeyProtection | null): Promise<boolean | null> {
  const last = !!kp?.enabled && !!p.key_wrapped && kp.wrapped <= 1
  if (!last) {
    const ok = await confirmDialog({
      title: `删除“${p.name}”？`,
      message: '删除后这个通行密钥不能再用来登录；密码登录不受影响。要再次使用需要重新登记。',
      confirmLabel: '删除',
      danger: true,
    })
    return ok ? false : null
  }
  const ok = await confirmDialog({
    title: `删除最后一个能解锁 API key 的通行密钥？`,
    message: kp!.unlocked
      ? `删除“${p.name}”后会关闭“用通行密钥保护 API key”，主密钥写回服务器数据目录的 secret.key，已保存的 API key 不受影响。`
      : `当前处于锁定状态，主密钥拿不回来：删除“${p.name}”会关闭保护并清除已保存的全部 API key，之后需要重新填写。可以先用它解锁再删除，key 就能保留。`,
    confirmLabel: kp!.unlocked ? '删除' : '删除并清除 API key',
    danger: true,
    initialFocus: 'cancel',
  })
  return ok ? true : null
}

export function KeyProtectionGroup({ passkeys }: { passkeys: Passkey[] | null }) {
  const kp = useSettingsData((s) => s.keyProtection)
  if (!kp) return null

  const enable = async () => {
    const ok = await confirmDialog({
      title: '用通行密钥保护 API key？',
      message:
        '开启后服务器的数据目录里不再保存主密钥（secret.key），已保存的 API key 只能用加入保护的通行密钥解开，单独拿到数据目录或备份文件也解不开。服务器每次重启后，需要用通行密钥登录一次（或在这里解锁），助手才能使用 API key。不支持 PRF 扩展的通行密钥不能加入；通行密钥全部丢失时，只能放弃已保存的 API key 重新填写。',
      confirmLabel: '继续',
    })
    if (ok) await run(() => verify('enable'), '已开启：API key 由通行密钥保护')
  }

  const disable = async () => {
    if (kp.unlocked) {
      const ok = await confirmDialog({
        title: '关闭通行密钥保护？',
        message: '主密钥会写回服务器数据目录的 secret.key，已保存的 API key 不受影响，重启后也不再需要解锁。',
        confirmLabel: '关闭',
      })
      if (ok) await run(async () => (await api.keyProtectionDisable(false)).key_protection, '已关闭通行密钥保护')
      return
    }
    const ok = await confirmDialog({
      title: '放弃已保存的 API key 并关闭保护？',
      message: '当前处于锁定状态，主密钥拿不回来：关闭会清除已保存的全部 API key，之后需要重新填写。还有能解锁的通行密钥时，请先解锁再关闭。',
      confirmLabel: '放弃并关闭',
      danger: true,
      initialFocus: 'cancel',
    })
    if (ok) await run(async () => (await api.keyProtectionDisable(true)).key_protection, '已关闭通行密钥保护，请重新填写 API key')
  }

  const lock = () => run(() => api.keyProtectionLock(), '已锁定')
  const unlock = () => run(() => verify('unlock'), '已解锁，助手可以使用 API key 了')

  const noPasskeys = !passkeys?.length
  let meta: string
  if (!kp.available) meta = '服务器用环境变量 LODE_SECRET_KEY 提供主密钥，这时不能用通行密钥保护。'
  else if (kp.enabled) meta = `${kp.unlocked ? '已解锁' : '已锁定，助手暂时不能使用 API key'} · ${kp.wrapped} 个通行密钥可以解锁`
  else if (noPasskeys) meta = '先在上面添加一个通行密钥。'
  else meta = '开启后数据目录里不再保存主密钥，重启后用通行密钥解锁。'

  return (
    <Group
      title="用通行密钥保护 API key"
      footer="需要通行密钥支持 PRF 扩展：较新的 Chrome / Edge、Safari 18 及以上，以及 Google 密码管理器、iCloud 钥匙串、Windows Hello（Windows 11）等。备份文件里同样没有主密钥，恢复后用通行密钥登录即可解锁。"
    >
      <label className="settings-row">
        <span className="settings-row-text row-stack">
          <span className="settings-row-label">保护 API key</span>
          <span className="settings-meta" data-testid="key-protection-state">
            {meta}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={kp.enabled}
          disabled={!kp.available || (!kp.enabled && noPasskeys)}
          onChange={() => void (kp.enabled ? disable() : enable())}
          data-testid="key-protection-switch"
        />
      </label>
      {kp.enabled && !kp.unlocked && (
        <ActionRow icon={<LockOpen size={17} aria-hidden="true" />} onClick={() => void unlock()} data-testid="key-protection-unlock">
          用通行密钥解锁
        </ActionRow>
      )}
      {kp.enabled && kp.unlocked && (
        <ActionRow icon={<Lock size={17} aria-hidden="true" />} onClick={() => void lock()} data-testid="key-protection-lock">
          立即锁定
        </ActionRow>
      )}
    </Group>
  )
}
