import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
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
  plugins: [react(), keepGitkeep()],
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
