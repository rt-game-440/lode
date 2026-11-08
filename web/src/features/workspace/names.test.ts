import { describe, expect, it } from 'vitest'
import { invalidWorkspaceName, looksAbsolute } from './names'

describe('looksAbsolute', () => {
  it('认出 Unix、Windows 盘符和 UNC 路径', () => {
    expect(looksAbsolute('/home/me/vault')).toBe(true)
    expect(looksAbsolute('D:\\笔记\\我的库')).toBe(true)
    expect(looksAbsolute('d:/notes')).toBe(true)
    expect(looksAbsolute('\\\\nas\\share\\vault')).toBe(true)
    expect(looksAbsolute('  /tmp/x  ')).toBe(true)
  })
  it('拒绝相对路径', () => {
    expect(looksAbsolute('vault')).toBe(false)
    expect(looksAbsolute('./vault')).toBe(false)
    expect(looksAbsolute('..\\vault')).toBe(false)
    expect(looksAbsolute('D:vault')).toBe(false)
    expect(looksAbsolute('')).toBe(false)
  })
})

describe('invalidWorkspaceName', () => {
  it('与服务端规则一致', () => {
    expect(invalidWorkspaceName('  ')).toBe('请输入名称')
    expect(invalidWorkspaceName('长'.repeat(65))).toMatch(/64/)
    expect(invalidWorkspaceName('a\u0000b')).toMatch(/控制字符/)
    expect(invalidWorkspaceName('工作')).toBeNull()
  })
})
