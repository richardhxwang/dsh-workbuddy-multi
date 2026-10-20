/**
 * `lib/reasoning.js` 的单元测试：推理档位按「版本+模型」跨账号共享。
 *
 * 这个模块戳的是上游的两个内部面 —— 磁盘上的 probe/catalog 文件，和运行时
 * adapter 的 `piProvider.getModels`。所以测试覆盖的全是**会让用户看到的坏行为**：
 * 指纹/过期/账号优先级的汇总判据、注入映射的逐字段形状、包装的幂等与还原、
 * 以及「上游结构变了」时的降级（绝不抛出）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { ReasoningShare, REASONING_TTL_MS } from '../lib/reasoning.js'

/** 与上游 fingerprintModel 同算法（测试独立实现，正好交叉验证本地兜底）。 */
function fingerprintOf(info) {
  const basis = JSON.stringify({
    id: info.id,
    reasoning: info.reasoning ?? null,
    supportsImages: info.supportsImages ?? null,
  })
  return createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

const MODEL = {
  id: 'deepseek-v4.1-flash',
  name: 'DeepSeek V4.1 Flash',
  reasoning: { supports: true, canDisableThinking: true },
  supportsImages: false,
}

function makeRecord(account, info, { validation = 'validating', efforts = ['low', 'high'], probedAtMs, pluginVersion = '0.7.8' } = {}) {
  return {
    fingerprint: fingerprintOf(info),
    validation,
    efforts,
    probedAtMs: probedAtMs ?? Date.now(),
    pluginVersion,
    account,
  }
}

function writeVariant(home, variantKey, { catalog = [], records = {}, catalogAccounts } = {}) {
  const names =
    variantKey === 'cn'
      ? { probe: '.workbuddy-probe.json', catalog: '.workbuddy-catalog.json' }
      : { probe: '.workbuddy-ai-probe.json', catalog: '.workbuddy-ai-catalog.json' }
  // 真实的已保存目录是按账号各存一份的（entries: {account: SavedCatalog}）：
  // 缺省给每个有记录的账号各放一份同内容目录，贴近真实布局。
  const accounts = catalogAccounts ?? Object.keys(records)
  const entries = {}
  for (const account of accounts.length > 0 ? accounts : ['uid-a:']) {
    entries[account] = { account, source: 'workbuddy-ai:app', fetchedAtMs: Date.now(), models: catalog }
  }
  writeFileSync(join(home, names.catalog), JSON.stringify({ version: 1, entries }))
  writeFileSync(join(home, names.probe), JSON.stringify({ version: 2, records }))
}

function makeCtx() {
  const registrations = new Map()
  const handlers = new Map()
  return {
    registrations,
    emitted: [],
    ctx: {
      llm: { adapters: registrations },
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, new Set())
        handlers.get(event).add(fn)
        return () => handlers.get(event).delete(fn)
      },
      emit(event) {
        this.emitted?.push?.(event)
      },
    },
  }
}

/** 造一个形状与上游 WorkBuddyPiAiAdapter 一致的假 adapter。 */
function makeAdapter(routeId, models) {
  const piProvider = { id: routeId, getModels: () => models }
  const profile = { provider: routeId, piProvider }
  return {
    config: { profiles: () => new Map([[routeId, profile]]) },
    piProvider,
  }
}

function makeShare({ home, ctx, activeUid, enabled } = {}) {
  const logs = []
  const share = new ReasoningShare({
    ctx,
    pool: { activeUid: () => activeUid },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    enabled,
    home,
  })
  return { share, logs }
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'wbm-reasoning-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 汇总判据
// ---------------------------------------------------------------------------

test('汇总：任一账号的 validating 记录对同指纹模型生效', () => {
  withHome((home) => {
    writeVariant(home, 'ai', {
      catalog: [MODEL],
      records: { 'uid-a:': { [MODEL.id]: makeRecord('uid-a:', MODEL) } },
    })
    const { share } = makeShare({ home, activeUid: 'uid-b' })
    share.refresh()
    const got = share.aggregateFor('ai', MODEL.id)
    assert.equal(got.validation, 'validating')
    assert.deepEqual(got.efforts, ['low', 'high'])
    assert.equal(got.shared, true) // 记录来自别的账号
  })
})

test('汇总：生效账号自己的记录优先于别的账号的更新记录', () => {
  withHome((home) => {
    const older = makeRecord('uid-a:', MODEL, { efforts: ['low'], probedAtMs: Date.now() - 1000 })
    const own = makeRecord('uid-b:', MODEL, { efforts: ['medium'], probedAtMs: Date.now() - 9999 })
    writeVariant(home, 'ai', {
      catalog: [MODEL],
      records: { 'uid-a:': { [MODEL.id]: older }, 'uid-b:': { [MODEL.id]: own } },
    })
    const { share } = makeShare({ home, activeUid: 'uid-b' })
    share.refresh()
    const got = share.aggregateFor('ai', MODEL.id)
    assert.deepEqual(got.efforts, ['medium'])
    assert.equal(got.shared, false)
  })
})

test('汇总：指纹变了（目录换了形状）记录作废', () => {
  withHome((home) => {
    const record = makeRecord('uid-a:', MODEL)
    // 目录里的 reasoning 形状变了 → 指纹对不上
    const changed = { ...MODEL, reasoning: { supports: true, canDisableThinking: false } }
    writeVariant(home, 'ai', { catalog: [changed], records: { 'uid-a:': { [MODEL.id]: record } } })
    const { share } = makeShare({ home })
    share.refresh()
    assert.equal(share.aggregateFor('ai', MODEL.id), undefined)
  })
})

test('汇总：超过 14 天的记录不再作答', () => {
  withHome((home) => {
    const stale = makeRecord('uid-a:', MODEL, { probedAtMs: Date.now() - REASONING_TTL_MS - 1000 })
    writeVariant(home, 'ai', { catalog: [MODEL], records: { 'uid-a:': { [MODEL.id]: stale } } })
    const { share } = makeShare({ home })
    share.refresh()
    assert.equal(share.aggregateFor('ai', MODEL.id), undefined)
  })
})

test('汇总：unknown 只是「没测完」，永远不算决定性记录', () => {
  withHome((home) => {
    const unknown = makeRecord('uid-a:', MODEL, { validation: 'unknown', efforts: [] })
    writeVariant(home, 'ai', { catalog: [MODEL], records: { 'uid-a:': { [MODEL.id]: unknown } } })
    const { share } = makeShare({ home })
    share.refresh()
    assert.equal(share.aggregateFor('ai', MODEL.id), undefined)
  })
})

test('汇总：目录声明了 supportedEfforts 的模型永远不看检测记录', () => {
  withHome((home) => {
    const declared = { ...MODEL, reasoning: { supports: true, supportedEfforts: ['low', 'high'] } }
    writeVariant(home, 'ai', {
      catalog: [declared],
      records: { 'uid-a:': { [MODEL.id]: makeRecord('uid-a:', declared) } },
    })
    const { share } = makeShare({ home })
    share.refresh()
    assert.equal(share.aggregateFor('ai', MODEL.id), undefined)
  })
})

// ---------------------------------------------------------------------------
// 注入映射
// ---------------------------------------------------------------------------

test('注入：缺档位的思考模型补上汇总档位，形状与上游 reasoningFields 一致', () => {
  withHome((home) => {
    writeVariant(home, 'ai', {
      catalog: [MODEL],
      records: { 'uid-a:': { [MODEL.id]: makeRecord('uid-a:', MODEL, { efforts: ['low', 'xhigh'] }) } },
    })
    const { share } = makeShare({ home })
    share.refresh()
    const bare = { id: MODEL.id, name: MODEL.name, reasoning: false }
    const got = share.overrideModel({ key: 'ai', routeId: 'workbuddy-ai', region: 'global' }, bare)
    assert.equal(got.reasoning, true)
    assert.deepEqual(got.thinkingLevelMap, {
      off: null, // 目录没声明 supportedEfforts 时 off 恒为 null（与上游一致）
      minimal: null,
      low: 'low',
      medium: null,
      high: null,
      xhigh: 'xhigh',
      max: null,
    })
    // 不动原对象
    assert.equal(bare.reasoning, false)
  })
})

test('注入：上游已给档位的（reasoning === true）原样放行', () => {
  withHome((home) => {
    writeVariant(home, 'ai', {
      catalog: [MODEL],
      records: { 'uid-a:': { [MODEL.id]: makeRecord('uid-a:', MODEL) } },
    })
    const { share } = makeShare({ home })
    share.refresh()
    const withLevels = { id: MODEL.id, reasoning: true, thinkingLevelMap: { low: 'low' } }
    assert.equal(share.overrideModel({ key: 'ai', region: 'global' }, withLevels), withLevels)
  })
})

test('注入：non-validating 只表示「上游不校验参数」，不注入档位', () => {
  withHome((home) => {
    writeVariant(home, 'ai', {
      catalog: [MODEL],
      records: { 'uid-a:': { [MODEL.id]: makeRecord('uid-a:', MODEL, { validation: 'non-validating', efforts: [] }) } },
    })
    const { share } = makeShare({ home })
    share.refresh()
    const bare = { id: MODEL.id, reasoning: false }
    assert.equal(share.overrideModel({ key: 'ai', region: 'global' }, bare), bare)
  })
})

test('注入：功能关闭时一律放行', () => {
  withHome((home) => {
    writeVariant(home, 'ai', {
      catalog: [MODEL],
      records: { 'uid-a:': { [MODEL.id]: makeRecord('uid-a:', MODEL) } },
    })
    const { share } = makeShare({ home, enabled: false })
    share.refresh()
    const bare = { id: MODEL.id, reasoning: false }
    assert.equal(share.overrideModel({ key: 'ai', region: 'global' }, bare), bare)
  })
})

// ---------------------------------------------------------------------------
// 包装与生命周期
// ---------------------------------------------------------------------------

test('包装：getModels 每次读取都过注入，且幂等（不叠包）', () => {
  withHome((home) => {
    writeVariant(home, 'ai', {
      catalog: [MODEL],
      records: { 'uid-a:': { [MODEL.id]: makeRecord('uid-a:', MODEL) } },
    })
    const { ctx, registrations } = makeCtx()
    const adapter = makeAdapter('workbuddy-ai', [{ id: MODEL.id, reasoning: false }])
    registrations.set('workbuddy-ai', { adapter })
    const { share } = makeShare({ home, ctx })
    share.refresh()
    share.ensureWrapped()
    share.ensureWrapped() // 幂等
    assert.equal(adapter.piProvider.getModels()[0].reasoning, true)
    const first = adapter.piProvider.getModels
    share.ensureWrapped()
    assert.equal(adapter.piProvider.getModels, first)
    share.stop()
  })
})

test('包装：setEnabled(false) 干净还原，重开后再包', () => {
  withHome((home) => {
    writeVariant(home, 'ai', {
      catalog: [MODEL],
      records: { 'uid-a:': { [MODEL.id]: makeRecord('uid-a:', MODEL) } },
    })
    const { ctx, registrations } = makeCtx()
    const adapter = makeAdapter('workbuddy-ai', [{ id: MODEL.id, reasoning: false }])
    registrations.set('workbuddy-ai', { adapter })
    const original = adapter.piProvider.getModels
    const { share } = makeShare({ home, ctx })
    share.refresh()
    share.ensureWrapped()
    assert.notEqual(adapter.piProvider.getModels, original)

    share.setEnabled(false)
    assert.equal(adapter.piProvider.getModels, original)
    assert.equal(adapter.piProvider.getModels()[0].reasoning, false)

    share.setEnabled(true)
    assert.equal(adapter.piProvider.getModels()[0].reasoning, true)
    share.stop()
  })
})

test('降级：adapter 结构变了只记一笔说明，绝不抛出', () => {
  withHome((home) => {
    const { ctx, registrations } = makeCtx()
    registrations.set('workbuddy-ai', { adapter: { totally: 'different' } })
    const { share, logs } = makeShare({ home, ctx })
    share.refresh()
    assert.doesNotThrow(() => share.ensureWrapped())
    assert.ok(logs.some((line) => line.includes('adapter 结构变了')))
    share.stop()
  })
})

test('降级：llm.adapters 不存在、上游缺席、文件全缺时一律安静通过', () => {
  withHome((home) => {
    const { share } = makeShare({ home, ctx: { llm: undefined } })
    assert.doesNotThrow(() => {
      share.refresh()
      share.ensureWrapped()
      share.start()
      share.setEnabled(false)
      share.setEnabled(true)
    })
    const status = share.status()
    assert.equal(status.enabled, true)
    assert.equal(status.variants.ai.models.length, 0)
    assert.doesNotThrow(() => share.stop())
  })
})

test('status：汇总清单带 shared 标记，客户端据此隐藏「推理等级」按钮', () => {
  withHome((home) => {
    writeVariant(home, 'ai', {
      catalog: [MODEL],
      records: { 'uid-a:': { [MODEL.id]: makeRecord('uid-a:', MODEL) } },
    })
    const { share } = makeShare({ home, activeUid: 'uid-b' })
    share.refresh()
    const variants = share.status().variants
    assert.equal(variants.ai.models.length, 1)
    assert.equal(variants.ai.models[0].id, MODEL.id)
    assert.equal(variants.ai.models[0].shared, true)
    assert.deepEqual(variants.ai.models[0].efforts, ['low', 'high'])
    share.stop()
  })
})

test('惯例档族：目录声明了思考默认档（无档位列表）的模型也注入 low/medium/high/max', () => {
  withHome((home) => {
    const fixed = {
      id: 'kimi-k3',
      name: 'Kimi K3',
      reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false, defaultEffort: 'medium' },
      supportsImages: false,
    }
    writeVariant(home, 'ai', { catalog: [fixed], records: {} })
    const { share } = makeShare({ home })
    share.refresh()
    const bare = { id: 'kimi-k3', reasoning: false }
    const got = share.overrideModel({ key: 'ai', routeId: 'workbuddy-ai', region: 'global' }, bare)
    assert.equal(got.reasoning, true)
    assert.deepEqual(got.thinkingLevelMap, {
      off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: 'max',
    })
    share.stop()
  })
})

test('惯例档族：没有 defaultEffort 的候选不误注入（保持纯候选）', () => {
  withHome((home) => {
    writeVariant(home, 'ai', { catalog: [MODEL], records: {} })
    const { share } = makeShare({ home })
    share.refresh()
    const bare = { id: MODEL.id, reasoning: false }
    assert.equal(share.overrideModel({ key: 'ai', routeId: 'workbuddy-ai', region: 'global' }, bare), bare)
    share.stop()
  })
})

test('包装：共享关了但 wantsWrap()（选档）还要这层包装时不卸；都不要了才还原', () => {
  withHome((home) => {
    writeVariant(home, 'ai', {
      catalog: [MODEL],
      records: { 'uid-a:': { [MODEL.id]: makeRecord('uid-a:', MODEL) } },
    })
    const { ctx, registrations } = makeCtx()
    const adapter = makeAdapter('workbuddy-ai', [{ id: MODEL.id, reasoning: false, contextWindow: 300000 }])
    registrations.set('workbuddy-ai', { adapter })
    const original = adapter.piProvider.getModels
    const { share } = makeShare({ home, ctx })
    let tiersOn = true
    share.wantsWrap = () => tiersOn
    share.augment = (_key, models) => models.map((m) => ({ ...m, contextWindow: 1000000 }))
    share.refresh()
    share.ensureWrapped()

    share.setEnabled(false)
    assert.notEqual(adapter.piProvider.getModels, original, '选档还要包装，不能卸')
    assert.equal(adapter.piProvider.getModels()[0].reasoning, false, '共享关了：档位注入停')
    assert.equal(adapter.piProvider.getModels()[0].contextWindow, 1000000, '选档注入还在')

    tiersOn = false
    share.syncWrap()
    assert.equal(adapter.piProvider.getModels, original, '都不要了才还原')

    tiersOn = true
    share.syncWrap()
    assert.equal(adapter.piProvider.getModels()[0].contextWindow, 1000000, 'syncWrap 能重新包上')
    share.stop()
    assert.equal(adapter.piProvider.getModels, original, 'stop 一律还原')
  })
})
