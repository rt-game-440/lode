import { EyeOff, Fingerprint, History, KeyRound, Keyboard, Layers, Palette, PenLine, Plug, Sparkles } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { EmptyState } from '../../components/ui'
import { useAgent } from '../../stores/agent'
import { useUI } from '../../stores/ui'
import { useWorkspace, workspaceName } from '../../stores/workspace'
import { useEditorPrefs } from '../../stores/editorPrefs'
import { passkeyAvailable } from '../../lib/webauthn'
import { AgentPage, ProviderPage, agentSummary } from './AgentSettings'
import { AppearancePage, EditorPage, KeyboardPage, SHORTCUT_COUNT, THEME_LABEL } from './GeneralSettings'
import { NavStack } from './NavStack'
import { PasskeysPage } from './PasskeySettings'
import { useSettingsData } from './data'
import { settingsBack } from './nav'
import { Group, NavRow, RowIcon, SettingsContext, SettingsPage } from './parts'
import { AuditPage, McpPage, TokenPage, TokensPage } from './TokenSettings'
import { WorkspacePage, WorkspacesPage } from './WorkspaceSettings'
import { ROOT_TITLE, SECTION_TITLE, settingsPage } from './stack'
import './settings.css'

const shortFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * 设置：iOS / macOS“设置”式的多级页面。第一级是分组列表，每行有图标、名称、状态摘要和 ›；
 * 点进去是子页面，单个供应商、单个 token 可以再进一层。每一级有自己的地址（见 stack.ts），
 * 浏览器后退、Android 返回键、返回按钮和左缘手势都逐级返回。
 */
export function SettingsView({ mobile }: { mobile: boolean }) {
  const route = useUI((s) => s.route)
  // 手机上离开设置时，详情层滑出期间路由已经变了：继续显示最后的设置页面
  const last = useRef<string[]>([])
  if (route.view === 'settings') last.current = route.sub ?? []
  const sub = last.current

  useSettingsSync()

  return (
    <SettingsContext.Provider value={{ mobile }}>
      <NavStack path={sub} renderPage={(s) => <Page sub={s} />} onBack={() => settingsBack(sub)} edgeSwipe={mobile} />
    </SettingsContext.Provider>
  )
}

/** 首页的状态摘要和各子页面共用的数据：进入设置时加载，从别的应用切回来时刷新。 */
function useSettingsSync() {
  useEffect(() => {
    const load = () => {
      void useAgent.getState().loadConfig()
      void useWorkspace.getState().load()
      void useSettingsData.getState().loadTokens()
      if (passkeyAvailable()) {
        void useSettingsData.getState().loadPasskeys()
        void useSettingsData.getState().loadKeyProtection()
      }
      void useSettingsData.getState().loadAudit()
    }
    load()
    const onVisible = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
}

function Page({ sub }: { sub: string[] }) {
  const page = settingsPage(sub)
  switch (page?.id) {
    case 'root':
      return <SettingsHome />
    case 'appearance':
      return <AppearancePage sub={sub} />
    case 'editor':
      return <EditorPage sub={sub} />
    case 'keyboard':
      return <KeyboardPage sub={sub} />
    case 'passkeys':
      return <PasskeysPage sub={sub} />
    case 'workspaces':
      return <WorkspacesPage sub={sub} />
    case 'workspace':
      return <WorkspacePage sub={sub} id={page.param!} />
    case 'agent':
      return <AgentPage sub={sub} />
    case 'provider':
      return <ProviderPage sub={sub} id={page.param!} />
    case 'mcp':
      return <McpPage sub={sub} />
    case 'tokens':
      return <TokensPage sub={sub} />
    case 'token':
      return <TokenPage sub={sub} id={page.param!} />
    case 'audit':
      return <AuditPage sub={sub} />
    default:
      return (
        <SettingsPage sub={sub} title={ROOT_TITLE}>
          <EmptyState icon={<EyeOff size={28} strokeWidth={1.5} />} title="找不到这个设置页面" />
        </SettingsPage>
      )
  }
}

/** 第一级：分组列表。 */
function SettingsHome() {
  const theme = useUI((s) => s.theme)
  const formatToolbar = useEditorPrefs((s) => s.formatToolbar)
  const config = useAgent((s) => s.config)
  const tokens = useSettingsData((s) => s.tokens)
  const passkeys = useSettingsData((s) => s.passkeys)
  const audit = useSettingsData((s) => s.audit)
  const workspaceCount = useWorkspace((s) => s.list.length)
  const currentName = useWorkspace((s) => workspaceName(s.list, s.current))
  const latest = audit?.[0]
  return (
    <SettingsPage sub={[]} title={ROOT_TITLE} testId="settings-home">
      <Group title="通用">
        <ul className="settings-list">
          <li>
            <NavRow
              to={['appearance']}
              icon={
                <RowIcon tone="indigo">
                  <Palette size={17} />
                </RowIcon>
              }
              label={SECTION_TITLE.appearance}
              value={THEME_LABEL[theme]}
            />
          </li>
          <li>
            <NavRow
              to={['editor']}
              icon={
                <RowIcon tone="azure">
                  <PenLine size={17} />
                </RowIcon>
              }
              label={SECTION_TITLE.editor}
              value={formatToolbar ? '显示格式工具栏' : '隐藏格式工具栏'}
            />
          </li>
          <li>
            <NavRow
              to={['keyboard']}
              icon={
                <RowIcon tone="slate">
                  <Keyboard size={17} />
                </RowIcon>
              }
              label={SECTION_TITLE.keyboard}
              value={`${SHORTCUT_COUNT} 个快捷键`}
            />
          </li>
        </ul>
      </Group>
      {/* 非安全上下文（http://局域网 IP）和 IP 访问下不显示通行密钥 */}
      {passkeyAvailable() && (
        <Group title="安全" footer="用指纹、面容或系统 PIN 一步登录。密码仍然保留，作为备用的登录方式。">
          <ul className="settings-list">
            <li>
              <NavRow
                to={['passkeys']}
                icon={
                  <RowIcon tone="emerald">
                    <Fingerprint size={17} />
                  </RowIcon>
                }
                label={SECTION_TITLE.passkeys}
                value={passkeys ? (passkeys.length ? `${passkeys.length} 个` : '未登记') : ''}
                testId="settings-passkeys"
              />
            </li>
          </ul>
        </Group>
      )}
      <Group title="工作空间" footer="每个工作空间是一套互相独立的笔记库：笔记、搜索、标签、回收站和助手对话互不影响。">
        <ul className="settings-list">
          <li>
            <NavRow
              to={['workspaces']}
              icon={
                <RowIcon tone="azure">
                  <Layers size={17} />
                </RowIcon>
              }
              label={SECTION_TITLE.workspaces}
              value={workspaceCount > 1 ? `${workspaceCount} 个` : currentName}
              testId="settings-workspaces"
            />
          </li>
        </ul>
      </Group>
      <Group title="助手" footer="模型供应商、模型、API key 和默认选项。">
        <ul className="settings-list">
          <li>
            <NavRow
              to={['agent']}
              icon={
                <RowIcon tone="violet">
                  <Sparkles size={17} />
                </RowIcon>
              }
              label={SECTION_TITLE.agent}
              value={agentSummary(config)}
            />
          </li>
        </ul>
      </Group>
      <Group title="agent 接入" footer="Claude Code、Codex、Cursor 等 agent 通过 MCP 搜索、阅读和编辑你的笔记。">
        <ul className="settings-list">
          <li>
            <NavRow
              to={['mcp']}
              icon={
                <RowIcon tone="azure">
                  <Plug size={17} />
                </RowIcon>
              }
              label={SECTION_TITLE.mcp}
              value={`${location.host}/mcp`}
            />
          </li>
          <li>
            <NavRow
              to={['tokens']}
              icon={
                <RowIcon tone="emerald">
                  <KeyRound size={17} />
                </RowIcon>
              }
              label={SECTION_TITLE.tokens}
              value={tokens ? (tokens.length ? `${tokens.length} 个` : '未创建') : ''}
            />
          </li>
          <li>
            <NavRow
              to={['audit']}
              icon={
                <RowIcon tone="amber">
                  <History size={17} />
                </RowIcon>
              }
              label={SECTION_TITLE.audit}
              value={audit ? (latest ? `最近 ${shortFmt.format(latest.at)}` : '暂无') : ''}
            />
          </li>
        </ul>
      </Group>
    </SettingsPage>
  )
}
