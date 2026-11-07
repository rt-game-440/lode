# 局域网 HTTPS 访问（手机测试）

Service Worker、PWA 安装和部分离线能力要求**安全上下文**：只有 `https://` 或 `http://localhost` 下才生效。手机通过 `http://192.168.x.x:8787` 访问时，应用能用，但不会注册 Service Worker，也装不了 PWA。下面用 [Caddy](https://caddyserver.com/) 签发本地证书，在局域网里提供 HTTPS。

## 1. 选择被代理的服务

| 场景 | 启动方式 | Caddy 代理到 |
| --- | --- | --- |
| 测 PWA、离线、安装到主屏（推荐） | `scripts/build.sh` 后运行 `bin/lode serve` | `127.0.0.1:8787` |
| 只调界面和同步逻辑 | `scripts/dev.sh` | `127.0.0.1:5173`（Vite，会把 `/api` 转给 8787） |

开发模式（Vite）下不注册 Service Worker，`vite-plugin-pwa` 只在构建产物里生成 SW。所以测 PWA 要用构建好的二进制。

两种方式的服务都只监听 127.0.0.1，由 Caddy 对外。不需要把 `LODE_ADDR` 改成 `0.0.0.0`。

## 2. 安装 Caddy

- Windows：`winget install CaddyServer.Caddy`，或从官网下载 `caddy.exe` 放进 PATH。
- macOS：`brew install caddy`。
- Linux：按官网说明安装发行版的包。

## 3. Caddyfile

在仓库外（或 `data-dev/` 里，它被 git 忽略）新建 `Caddyfile`。把 `192.168.1.23` 换成电脑的局域网 IP（Windows 用 `ipconfig`，macOS/Linux 用 `ip addr` 或 `ifconfig` 查看）：

```caddyfile
{
	# 使用 Caddy 自己的本地 CA 签发证书，不去申请公网证书
	local_certs
}

https://192.168.1.23:8443 {
	tls internal
	reverse_proxy 127.0.0.1:8787
}
```

在 Caddyfile 所在目录运行：

```bash
caddy run
```

第一次运行时 Caddy 会生成本地根证书，并尝试把它装进本机信任库，系统可能会弹窗确认。

说明：

- Caddy 默认原样转发 `Host` 头并自动代理 WebSocket。**不要**加 `header_up Host ...` 改写 Host：`/api/ws` 会校验 `Origin` 与 `Host` 是否一致，改写后 WebSocket 会被拒绝（同步状态会一直显示离线）。
- Caddy 会带上 `X-Forwarded-Proto: https`。Lode 默认信任来自 127.0.0.1 的代理，据此给会话 cookie 加上 `Secure`。Caddy 不在本机运行时，要把它的地址加进 `LODE_TRUSTED_PROXIES`。
- 代理 Vite（5173）时，Vite 默认允许以 IP 地址作为 Host 访问。如果改用主机名（例如 `lode.local`），需要在 `web/vite.config.ts` 的 `server.allowedHosts` 里加上它。

## 4. 让手机信任 Caddy 的根证书

根证书位置：

- Windows：`%AppData%\Caddy\pki\authorities\local\root.crt`
- macOS：`~/Library/Application Support/Caddy/pki/authorities/local/root.crt`
- Linux：`~/.local/share/caddy/pki/authorities/local/root.crt`

把 `root.crt` 传到手机上（数据线、网盘或聊天软件都可以）：

- **Android**：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书，选 `root.crt`。不同厂商的菜单名称略有差异，可以在设置里搜索“CA 证书”。
- **iOS**：用 Safari 或“文件”打开 `root.crt`，按提示安装描述文件（设置 → 通用 → VPN 与设备管理）。然后到设置 → 通用 → 关于本机 → 证书信任设置，打开该根证书的“完全信任”。少了这一步，Safari 仍会提示证书不受信任。

## 5. 防火墙

Windows 需要放行 8443 端口的入站连接（管理员 PowerShell）：

```powershell
New-NetFirewallRule -DisplayName "Lode dev HTTPS" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow
```

不再需要时用 `Remove-NetFirewallRule -DisplayName "Lode dev HTTPS"` 删除。macOS 首次运行 Caddy 时在弹窗里允许接入即可。

## 6. 验证

1. 手机和电脑连同一个 Wi-Fi，用手机浏览器打开 `https://192.168.1.23:8443`。地址栏显示锁形图标、没有证书警告，说明证书配置正确。
2. 登录后，侧栏底部的同步状态应显示“已同步”。在电脑上改一篇手机正打开的笔记，手机应在约 2 秒内看到。如果要切走再切回页面才更新，说明 WebSocket 没连上，检查第 3 节关于 Host 头的说明。
3. 安装到主屏：
   - Android Chrome：菜单 → 添加到主屏幕（或“安装应用”）。
   - iOS Safari：分享 → 添加到主屏幕。
4. 手动验收步骤见 `docs/checklist/stage-2.md`。

## 常见问题

- **iOS 上添加到主屏后图标是网页截图**：确认 `/apple-touch-icon.png` 能访问（构建产物里有）。iOS 会缓存图标，删除主屏图标后清除 Safari 网站数据再添加。
- **手机上一直提示“有新版本，点击刷新”**：每次重新构建都会生成新的 SW；点击刷新即可。
- **换了局域网 IP**：Caddyfile 里的地址要跟着改。证书由 Caddy 自动重签，手机上信任的根证书不用重装。
