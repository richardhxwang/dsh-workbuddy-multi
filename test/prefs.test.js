/**
 * `lib/prefs.js` 的单元测试：设置页开关落盘。
 * 坏行为：写了读不回来、未知键/非布尔混进文件、文件坏掉时整个插件起不来。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Prefs } from '../lib/prefs.js'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wbm-prefs-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('写入后新实例读得回来；没写过的键是 undefined（回落 Config）', () => {
  withDir((dir) => {
    const file = join(dir, 'settings.json')
    new Prefs({ file }).set('creditsChip', false)
    const again = new Prefs({ file })
    assert.equal(again.get('creditsChip'), false)
    assert.equal(again.get('pinned'), undefined)
  })
})

test('未知键与非布尔值拒绝写入', () => {
  withDir((dir) => {
    const prefs = new Prefs({ file: join(dir, 'settings.json') })
    assert.throws(() => prefs.set('policy', true))
    assert.throws(() => prefs.set('pinned', 'yes'))
  })
})

test('文件坏了或混进杂项：按没存过处理，不抛', () => {
  withDir((dir) => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{not json')
    assert.equal(new Prefs({ file }).get('pinned'), undefined)
    writeFileSync(file, JSON.stringify({ version: 1, values: { pinned: 'yes', bogus: true, contextTiers: false } }))
    const prefs = new Prefs({ file })
    assert.equal(prefs.get('pinned'), undefined)
    assert.equal(prefs.get('contextTiers'), false)
    prefs.set('reasoningCache', true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).values, { contextTiers: false, reasoningCache: true })
  })
})
