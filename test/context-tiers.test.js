/**
 * `lib/context-tiers.js` 的单元测试：按模型选上下文窗口（设置项驱动）。
 *
 * 覆盖的是会让用户看到的坏行为：覆盖的校验与持久化、目录档位消失后的自动失效、
 * 「全部最高/最低/恢复默认」一把切、以及 getModels 注入时选择器仍保持一个名字。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ContextTiers, tierLabel } from '../lib/context-tiers.js'

const ROWS = [
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 300000, supportedContextWindows: [300000, 1000000] },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 272000, supportedContextWindows: [272000, 600000, 1000000] },
  { id: 'plain', name: 'Plain', contextWindow: 200000 },
]

function makeTiers({ rows = ROWS, enabled = true, withFile = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wbm-ctx-'))
  const file = withFile ? join(dir, 'context-windows.json') : undefined
  const tiers = new ContextTiers({ enabled, rowsForVariant: () => rows, file })
  return { tiers, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('逐模型设置：写入生效并落盘；null 恢复默认', () => {
  const { tiers, file, cleanup } = makeTiers()
  try {
    tiers.setTier('ai', 'kimi-k3', 1000000)
    assert.equal(tiers.overrideFor('ai', 'kimi-k3'), 1000000)
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.tiers.ai['kimi-k3'], 1000000)

    tiers.setTier('ai', 'kimi-k3', null)
    assert.equal(tiers.overrideFor('ai', 'kimi-k3'), undefined)
  } finally {
    cleanup()
  }
})

test('覆盖的档必须在目录声明里：没声明的一律拒绝', () => {
  const { tiers, cleanup } = makeTiers()
  try {
    assert.throws(() => tiers.setTier('ai', 'kimi-k3', 600000), /没有声明/)
    assert.throws(() => tiers.setTier('ai', 'plain', 500000), /没有声明/)
  } finally {
    cleanup()
  }
})

test('目录档位变了（声明里没了），旧覆盖自动失效回到目录档', () => {
  const { tiers, cleanup } = makeTiers()
  try {
    tiers.setTier('ai', 'kimi-k3', 1000000)
    assert.equal(tiers.overrideFor('ai', 'kimi-k3'), 1000000)
    // 目录更新：1M 档没了
    tiers.rowsForVariant = () => [{ id: 'kimi-k3', contextWindow: 300000, supportedContextWindows: [300000] }]
    assert.equal(tiers.overrideFor('ai', 'kimi-k3'), undefined)
  } finally {
    cleanup()
  }
})

test('augment：只改 contextWindow 标量，不新增条目、不改名字、不动 baseUrl', () => {
  const { tiers, cleanup } = makeTiers()
  try {
    tiers.setTier('ai', 'kimi-k3', 1000000)
    const models = [
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 300000, baseUrl: 'http://127.0.0.1:39999/v1' },
      { id: 'plain', name: 'Plain', contextWindow: 200000, baseUrl: 'http://127.0.0.1:39999/v1' },
    ]
    const out = tiers.augment('ai', models)
    assert.equal(out.length, 2, '不新增条目')
    assert.equal(out[0].name, 'Kimi K3', '名字不变')
    assert.equal(out[0].contextWindow, 1000000)
    assert.equal(out[0].baseUrl, 'http://127.0.0.1:39999/v1', 'baseUrl 不动')
    assert.equal(out[1].contextWindow, 200000)
  } finally {
    cleanup()
  }
})

test('一把切：max/min/default', () => {
  const { tiers, cleanup } = makeTiers()
  try {
    tiers.setAll('ai', 'max')
    assert.equal(tiers.overrideFor('ai', 'kimi-k3'), 1000000)
    assert.equal(tiers.overrideFor('ai', 'gpt-6.1-sol'), 1000000)
    tiers.setAll('ai', 'min')
    // 最低档正好是目录默认档：不存覆盖（= 恢复默认），生效窗口仍是最低档。
    assert.equal(tiers.overrideFor('ai', 'kimi-k3'), undefined)
    assert.equal(tiers.overrideFor('ai', 'gpt-6.1-sol'), undefined)
    const models = [{ id: 'kimi-k3', contextWindow: 300000 }, { id: 'gpt-6.1-sol', contextWindow: 272000 }]
    assert.deepEqual(tiers.augment('ai', models).map((m) => m.contextWindow), [300000, 272000])
    tiers.setAll('ai', 'default')
    assert.equal(tiers.overrideFor('ai', 'kimi-k3'), undefined)
  } finally {
    cleanup()
  }
})

test('开关关闭：覆盖一律不注入', () => {
  const { tiers, cleanup } = makeTiers({ enabled: false })
  try {
    tiers.setTier('ai', 'kimi-k3', 1000000)
    const models = [{ id: 'kimi-k3', contextWindow: 300000 }]
    assert.equal(tiers.augment('ai', models)[0].contextWindow, 300000)
  } finally {
    cleanup()
  }
})

test('tierLabel：整千整兆用紧凑标记', () => {
  assert.equal(tierLabel(300000), '300K')
  assert.equal(tierLabel(1000000), '1M')
  assert.equal(tierLabel(272000), '272K')
})

test('status：按 variant 给出可选档与当前选择（设置页逐行选择器的数据）', () => {
  const { tiers, cleanup } = makeTiers()
  try {
    tiers.setTier('ai', 'kimi-k3', 1000000)
    const s = tiers.status()
    assert.equal(s.enabled, true)
    assert.equal(s.overridden, 1)
    // 设置页「N 个模型有可选窗口档」读的字段（此前客户端读它、宿主不给，提示永远不显示）
    assert.equal(s.tieredModels, 4, '两个版本各 2 个多档模型')
    assert.deepEqual(s.tiers.ai['kimi-k3'].options, [300000, 1000000])
    assert.equal(s.tiers.ai['kimi-k3'].default, 300000)
    assert.equal(s.tiers.ai['kimi-k3'].current, 1000000)
    assert.equal(s.tiers.ai['gpt-6.1-sol'].current, null)
    assert.equal(s.tiers.ai['plain'], undefined)
  } finally {
    cleanup()
  }
})

test('选中目录默认档 = 恢复默认，不存成覆盖', () => {
  const { tiers, file, cleanup } = makeTiers()
  try {
    tiers.setTier('ai', 'kimi-k3', 1000000)
    tiers.setTier('ai', 'kimi-k3', 300000)
    assert.equal(tiers.overrideFor('ai', 'kimi-k3'), undefined)
    assert.equal(tiers.status().overridden, 0)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).tiers, {})
  } finally {
    cleanup()
  }
})
