// 生成 PWA 图标：用 Playwright 的 Chromium 把 SVG 渲染成 PNG，输出到 web/public/。
// 用法：node scripts/gen-icons.mjs（图标设计变化时重新运行，产物提交到仓库）
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const out = resolve(import.meta.dirname, '../public')
mkdirSync(out, { recursive: true })

const BLUE = '#0071e3'
// 白色 “L”，位于 512 网格中心；笔画外沿离中心不超过 190，落在 maskable 安全区（半径 205）内
const GLYPH = `<path d="M158 128v256h197" stroke="#fff" stroke-width="52" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`

/** 普通图标：圆角方块，四角透明 */
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="114" fill="${BLUE}"/>${GLYPH}</svg>`
/** maskable / apple-touch-icon：铺满背景，由系统裁切形状 */
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${BLUE}"/>${GLYPH}</svg>`

const targets = [
  { file: 'pwa-192.png', svg: rounded, size: 192 },
  { file: 'pwa-512.png', svg: rounded, size: 512 },
  { file: 'pwa-maskable-512.png', svg: fullBleed, size: 512 },
  { file: 'apple-touch-icon.png', svg: fullBleed, size: 180 },
]

writeFileSync(resolve(out, 'favicon.svg'), rounded + '\n')

const browser = await chromium.launch()
try {
  for (const t of targets) {
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size } })
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${t.svg.replace('<svg ', `<svg width="${t.size}" height="${t.size}" `)}</body></html>`,
    )
    await page.screenshot({ path: resolve(out, t.file), omitBackground: true })
    await page.close()
    console.log(`${t.file} ${t.size}x${t.size}`)
  }
} finally {
  await browser.close()
}
