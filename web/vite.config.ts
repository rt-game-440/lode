import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig, type Plugin } from 'vitest/config'

const outDir = resolve(import.meta.dirname, '../server/internal/webui/dist')

// 构建产物直接输出到 Go 的 embed 目录；emptyOutDir 会删掉占位文件，构建后补回，保持 git 干净。
function keepGitkeep(): Plugin {
  return {
    name: 'lode-keep-gitkeep',
    apply: 'build',
    closeBundle() {
      writeFileSync(resolve(outDir, '.gitkeep'), '')
    },
  }
}

const apiTarget = process.env.LODE_API ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [
    react(),
    // 只缓存应用壳；/api 请求不经过 service worker，由同步引擎负责离线
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      strategies: 'generateSW',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Lode',
        short_name: 'Lode',
        description: '自托管的 Markdown 笔记',
        lang: 'zh-CN',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
    keepGitkeep(),
  ],
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false, ws: true },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
})
