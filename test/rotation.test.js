/**
 * test/rotation.test.js — lib/rotation.js 的单测 + 反向（变异）测试。
 *
 * 约定（PLAN §5、task-1 验收标准）：
 *  - 依赖全注入：假 clock、假 pool、假 ctx、假 fs reader，不碰真实 ~/.dsh 与桌面 auth 文件。
 *  - 假 pool 严格照 `lib/pool.js` 的实测语义建模（`advance` 按**全量账号顺序**环形前进、
 *    跳过冷却/停用/失效；`ensureActive` 优先保持可用中的当前账号）。语义若与真实 pool 漂移，
 *    这些测试就会失去意义，所以假 pool 的注释里都标了对应的真实代码行为。
 *  - 反向测试：把 lib/rotation.js 源码做**定向文本突变**写成临时模块再 import，然后用
 *    **同一套行为断言**跑一遍，断言它现在必须失败。这样证明那些断言是「吃劲」的，
 *    而不是恰好为真 —— 且突变锚点缺失会显式报错，不会静默放过。
 *    运行方式：`cd dsh-workbuddy-multi && node --test test/rotation.test.js`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROTATION_PATH = join(HERE, '..', 'lib', 'rotation.js')
const rotation = await import(pathToFileURL(ROTATION_PATH).href)

const {
  RotationEngine,
  RATE_LIMIT_CODES,
  parseRateLimitReset,
  scanAuthFileOverrides,
  variantKeyForProvider,
  classifyRetryEvent,
  planCooldown,
  defaultPatchFiles,
} = rotation

// ── 测试素材 ────────────────────────────────────────────────────────────────

/** PLAN §2.1/§2.4 里实测到的那条上游 6004 文案。 */
const RESET_TEXT =
  '您的使用量已超出频率限制，将在 2026-10-19 05:11:08 UTC+8 重置，您也可以切换其他模型继续使用。'
/** 文案里的时刻 → epoch（2026-10-19 05:11:08 +08:00）。 */
const RESET_MS = Date.UTC(2026, 9, 18, 21, 11, 8)
/** 假的「现在」：2026-10-19 03:00:00 +08:00，比重置时刻早 2h11m。 */
const T0 = Date.UTC(2026, 9, 18, 19, 0, 0)
const MIN = 60_000

const silentLogger = () => {
  const lines = []
  return {
    lines,
    info: (m) => lines.push(`info:${m}`),
    warn: (m) => lines.push(`warn:${m}`),
    error: (m) => lines.push(`error:${m}`),
  }
}

/** 假 pool：照 lib/pool.js 的实测语义。 */
function makePool({ accounts = { cn: ['uid-a', 'uid-b'], ai: [] }, policy = 'on-rate-limit', clock } = {}) {
  const now = () => clock.t
  const state = {
    policy,
    active: {},
    metas: {},
    listeners: new Map(),
    calls: [],
    files: {},
  }
  for (const [key, uids] of Object.entries(accounts)) {
    state.metas[key] = uids.map((uid, i) => ({
      variantKey: key,
      uid,
      label: uid,
      enabled: true,
      capturedAt: T0 + i, // 与真实 pool 一致：按 capturedAt 排序 → 顺序稳定
      cooldownUntil: undefined,
      cooldownReason: undefined,
    }))
    if (uids.length > 0) state.active[key] = uids[0]
    state.files[key] = `/pool/active/${key}.info`
  }
  const emit = (payload) => {
    for (const fn of [...(state.listeners.get('changed') ?? [])]) fn(payload)
  }
  const usableAt = (meta, at) =>
    meta.enabled &&
    (typeof meta.cooldownUntil !== 'number' || meta.cooldownUntil <= at)

  const pool = {
    // 测试辅助（非冻结接口）
    calls: state.calls,
    setActiveRaw(key, uid) {
      state.active[key] = uid
    },
    selectableUids: (key, opts) => pool.selectable(key, opts).map((m) => m.uid),
    list(key) {
      state.calls.push(`list:${key}`)
      return [...(state.metas[key] ?? [])]
    },
    get(key, uid) {
      return (state.metas[key] ?? []).find((m) => m.uid === uid)
    },
    activeUid(key) {
      return state.active[key]
    },
    policy() {
      return state.policy
    },
    async setPolicy(next) {
      state.policy = next
      emit({ variantKey: null, reason: 'policy' })
      return next
    },
    selectable(key, { at = now(), includeCooling = false } = {}) {
      return (state.metas[key] ?? []).filter((m) => (includeCooling ? m.enabled : usableAt(m, at)))
    },
    async setCooldown(key, uid, { until, reason } = {}) {
      state.calls.push(`setCooldown:${key}:${uid}:${until}`)
      const meta = pool.get(key, uid)
      if (!meta) throw new Error(`account not found: ${key}/${uid}`)
      meta.cooldownUntil = typeof until === 'number' ? until : now()
      meta.cooldownReason = typeof reason === 'string' ? reason : 'rate-limit'
      emit({ variantKey: key, reason: 'cooldown' })
      return meta
    },
    async clearCooldown(key, uid) {
      const meta = pool.get(key, uid)
      if (meta) {
        meta.cooldownUntil = undefined
        meta.cooldownReason = undefined
        emit({ variantKey: key, reason: 'cooldown' })
      }
      return meta
    },
    async noteUsed(key, uid) {
      const meta = pool.get(key, uid)
      if (meta) meta.lastUsedAt = now()
      return meta
    },
    // 真实 pool.advance：按全量顺序环形前进、跳过不可用者（不能只在 selectable 里找当前位置）。
    async advance(key, { reason, at = now() } = {}) {
      state.calls.push(`advance:${key}`)
      const all = state.metas[key] ?? []
      if (all.length === 0) return undefined
      const current = state.active[key]
      const startIdx = current === undefined ? -1 : all.findIndex((m) => m.uid === current)
      for (let step = 1; step <= all.length; step += 1) {
        const cand = all[(startIdx + step + all.length) % all.length]
        if (usableAt(cand, at)) {
          state.active[key] = cand.uid
          meta_used(key, cand.uid)
          emit({ variantKey: key, reason: reason ?? 'advance' })
          return cand.uid
        }
      }
      return undefined
    },
    // 真实 pool.ensureActive：当前账号可用且文件在 → 保持；否则挑第一个可用。
    async ensureActive(key, { at = now() } = {}) {
      state.calls.push(`ensureActive:${key}`)
      const current = state.active[key]
      const meta = current === undefined ? undefined : pool.get(key, current)
      // 与真实 pool 一致：冷却中的账号**仍然保持生效**（冷却只影响 advance 的挑选）。
      if (meta && meta.enabled) return current
      const cands = pool.selectable(key, { at })
      if (cands.length === 0) return undefined
      state.active[key] = cands[0].uid
      emit({ variantKey: key, reason: 'active' })
      return cands[0].uid
    },
    activeFilePath(key) {
      return state.files[key]
    },
    snapshotPath(key, uid) {
      return `/pool/accounts/${key}/${uid}.info`
    },
    on(evt, fn) {
      let set = state.listeners.get(evt)
      if (!set) state.listeners.set(evt, (set = new Set()))
      set.add(fn)
      return () => set.delete(fn)
    },
    off(evt, fn) {
      state.listeners.get(evt)?.delete(fn)
    },
  }
  function meta_used(key, uid) {
    const meta = pool.get(key, uid)
    if (meta) meta.lastUsedAt = now()
  }
  return pool
}

/** 假 ctx：记录监听器，`fire()` 就是 cordis emit。 */
function makeCtx({ mode = 'normal' } = {}) {
  const handlers = new Map()
  const ctx = {
    handlers,
    get() {
      return undefined
    },
    async fire(name, ...args) {
      const set = handlers.get(name)
      if (!set) return []
      const out = []
      for (const fn of [...set]) out.push(await fn(...args))
      return out
    },
    off(name, fn) {
      handlers.get(name)?.delete(fn)
    },
  }
  if (mode === 'normal') {
    ctx.on = (name, fn) => {
      let set = handlers.get(name)
      if (!set) handlers.set(name, (set = new Set()))
      set.add(fn)
      return () => set.delete(fn)
    }
  } else if (mode === 'throws') {
    ctx.on = () => {
      throw new Error('cordis: on() is not available in this generation')
    }
  } // mode === 'missing' → 完全没有 ctx.on
  return ctx
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** 轮询等待（真实 pool 会落盘，单个 setImmediate 不够）。 */
async function waitFor(predicate, { timeout = 2000, step = 5 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  return false
}

/**
 * 组装一个完整场景：假 clock / pool / ctx / logger / engine。
 * `changed → sync()` 的接线照 lib/index.js 的真实行为（去抖 50ms → 这里用待办队列代替）。
 */
function scenario({ RotationEngine: Engine = RotationEngine, accounts, policy, config } = {}) {
  const clock = { t: T0 }
  const pool = makePool({ accounts, policy, clock })
  const ctx = makeCtx()
  const logger = silentLogger()
  const engine = new Engine({
    pool,
    ctx,
    logger,
    // 假时钟必须同时注入引擎（否则冷却会退化成真实 Date.now()，断言就不可复现）
    config: { cooldownMs: 5 * MIN, minCooldownMs: 30_000, now: () => clock.t, ...(config ?? {}) },
  })
  // 照 lib/index.js：`changed` 去抖后才 sync，不能和 setCooldown/advance 抢跑。
  const pending = []
  let timer = null
  pool.on('changed', () => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      pending.push(engine.sync())
    }, 0)
  })
  const envBackup = new Map()
  for (const name of ['WORKBUDDY_AUTH_FILE', 'WORKBUDDY_AI_AUTH_FILE']) {
    envBackup.set(name, Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined)
    delete process.env[name]
  }
  return {
    clock,
    pool,
    ctx,
    logger,
    engine,
    async flush() {
      for (let guard = 0; guard < 20; guard += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        if (pending.length === 0 && timer === null) return
        const batch = pending.splice(0)
        if (batch.length > 0) await Promise.all(batch)
      }
    },
    async teardown() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      await engine.stop()
      for (const [name, value] of envBackup) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    },
  }
}

/** 构造一个 llm/retry session 事件（形状取自 dsh-llm-retry 的 append 实参）。 */
function retryEvent({
  provider = 'workbuddy',
  code = 'RATE_LIMIT',
  message = RESET_TEXT,
  retryId = 'retry-1',
  turn = 1,
  step = 1,
  retry = 1,
  failureExtra,
} = {}) {
  return {
    type: 'llm/retry',
    seq: 42,
    time: T0,
    data: {
      retryId,
      turn,
      step,
      provider,
      mode: 'normal',
      policyKey: 'normal',
      retry,
      delayMs: 1000,
      failure: { message, code, status: 429, ...(failureExtra ?? {}) },
    },
  }
}

/** 喂一个 session 事件并等所有派生 promise 落定（含 sync 去抖）。 */
async function feed(s, event, session = { id: 'session-1' }) {
  await s.ctx.fire('session/event', session, event)
  await settle()
  await s.flush()
}

// ── 行为断言（正/反向测试共用） ─────────────────────────────────────────────
// 反向测试的做法：把 lib/rotation.js 突变后，用**同样的这些函数**跑一遍，
// 断言它们现在必然失败。

/** on-rate-limit：频控 → 当前账号冷却到重置时刻 + 换到下一个账号 + 去重。 */
async function assertRotatesOnRateLimit(mod) {
  const s = scenario({ RotationEngine: mod.RotationEngine })
  try {
    await s.engine.start()
    assert.equal(s.pool.activeUid('cn'), 'uid-a', '起始生效账号')

    await feed(s, retryEvent())
    assert.equal(s.pool.activeUid('cn'), 'uid-b', '频控后应换到下一个账号')

    const cn = s.engine.status().variants.cn
    assert.deepEqual(
      cn.cooling.map((c) => c.uid),
      ['uid-a'],
      '被频控的账号必须进入冷却',
    )
    assert.equal(cn.cooling[0].until, RESET_MS, '冷却应延续到上游给的重置时刻')
    assert.equal(cn.cooling[0].reason, 'RATE_LIMIT')
    assert.equal(cn.lastAdvanceReason, 'rate-limit:RATE_LIMIT')

    // 场外先初始化，再验去重（同一 retryId/turn/step/retry 的重复事件不得再次换号）
    // 这里用三个账号的独立场景见 assertDedupesRetryEvents。
    return s
  } finally {
    await s.teardown()
  }
}

/** 冷却期间不被重复选中：两个账号都冷却时 advance 不应回到冷却中的账号。 */
async function assertCoolingBlocksReselection(mod) {
  const s = scenario({ RotationEngine: mod.RotationEngine, accounts: { cn: ['uid-a', 'uid-b'], ai: [] } })
  try {
    await s.engine.start()
    await feed(s, retryEvent()) // a 冷却（到 RESET_MS，2h11m 之后）
    assert.equal(s.pool.activeUid('cn'), 'uid-b')

    // b 也被频控：这次文案里没有可解析时刻 → 用 config.cooldownMs 兜底（5min）
    await feed(s, retryEvent({ retryId: 'retry-2', retry: 2, message: '请求过于频繁，请稍后再试' }))
    assert.equal(s.pool.activeUid('cn'), 'uid-b', '没有别的可用账号时应留在当前账号')
    assert.deepEqual(
      s.pool.selectableUids('cn', { at: s.clock.t }),
      [],
      'a（冷却中）不能被重新选中',
    )
    assert.match(s.engine.status().warnings.join('\n'), /没有其他可用账号/)
    const cooling = s.engine.status().variants.cn.cooling.map((c) => [c.uid, c.until - T0])
    assert.deepEqual(cooling, [
      ['uid-a', RESET_MS - T0],
      ['uid-b', 5 * MIN],
    ])

    // 时间推进到 b 的冷却到期之后：可选的只剩 b，a 仍在冷却中（没有被错误放行）
    s.clock.t = T0 + 6 * MIN
    assert.deepEqual(s.pool.selectableUids('cn', { at: s.clock.t }), ['uid-b'])
    const grown = s.engine.status().variants.cn
    assert.deepEqual(
      grown.cooling.map((c) => c.uid),
      ['uid-a'],
      '冷却到期的账号应从 cooling 列表消失',
    )
    return s
  } finally {
    await s.teardown()
  }
}

/** 去重：同一失败的重复事件只换一次号。 */
async function assertDedupesRetryEvents(mod) {
  const s = scenario({ RotationEngine: mod.RotationEngine, accounts: { cn: ['uid-a', 'uid-b', 'uid-c'], ai: [] } })
  try {
    await s.engine.start()
    const event = retryEvent()
    await feed(s, event)
    assert.equal(s.pool.activeUid('cn'), 'uid-b', '第一次频控换到 b')
    await feed(s, event) // 完全相同的四元组 → 应被去重
    assert.equal(s.pool.activeUid('cn'), 'uid-b', '重复事件不得再次换号')
    assert.equal(s.pool.calls.filter((c) => c.startsWith('advance:cn')).length, 1, 'advance 只应被调用一次')
    // 新的 retryId 或递增的 retry 是**新**失败 → 应该换
    await feed(s, retryEvent({ retry: 2 }))
    assert.equal(s.pool.activeUid('cn'), 'uid-c', '新的失败应继续换号')
    return s
  } finally {
    await s.teardown()
  }
}

/** 环境变量接管：两个 variant 都要指向池子的 active 文件。 */
async function assertTakesOverEnv(mod) {
  const s = scenario({ RotationEngine: mod.RotationEngine, config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    assert.equal(
      process.env.WORKBUDDY_AUTH_FILE,
      s.pool.activeFilePath('cn'),
      '环境变量必须指向池子的 active 文件（CN）',
    )
    assert.equal(
      process.env.WORKBUDDY_AI_AUTH_FILE,
      s.pool.activeFilePath('ai'),
      '环境变量必须指向池子的 active 文件（AI）',
    )
    return s
  } finally {
    await s.teardown()
  }
}

/** 优雅降级：ctx.on 不可用/抛异常时 start() 必须成功返回，只留一条 warning。 */
async function assertDegradesGracefully(mod) {
  for (const mode of ['missing', 'throws']) {
    const clock = { t: T0 }
    const pool = makePool({ clock })
    const ctx = makeCtx({ mode })
    const logger = silentLogger()
    const engine = new mod.RotationEngine({
      pool,
      ctx,
      logger,
      config: { detectConflicts: () => [], cooldownMs: 5 * MIN, now: () => clock.t },
    })
    await engine.start() // 关键：不得抛
    const warnings = engine.status().warnings.join('\n')
    assert.match(warnings, /ctx\.on/)
    assert.ok(engine.status().unavailable.length > 0 || mode === 'throws')
    assert.equal(engine.status().started, true)
    await engine.stop()
  }
}

/** 冲突检测：上游显式 authFile 时必须告警，并且**不要**去设那个 variant 的 env。 */
async function assertDetectsAuthFileConflict(mod) {
  const patch = [
    'plugins:',
    '  dsh-workbuddy-connect:',
    '    config:',
    '      authFile: "/Users/someone/custom.info"',
    '      authFileAI: ""',
    '',
  ].join('\n')
  const s = scenario({
    RotationEngine: mod.RotationEngine,
    config: { patchFiles: ['/fake/cordis.patch.yml'], readFile: async () => patch },
  })
  try {
    await s.engine.start()
    assert.equal(process.env.WORKBUDDY_AUTH_FILE, undefined, '有显式 authFile 时不应接管 CN env')
    assert.equal(process.env.WORKBUDDY_AI_AUTH_FILE, s.pool.activeFilePath('ai'), '空值的 authFileAI 不算冲突')
    const st = s.engine.status()
    assert.equal(st.conflicts.length, 1)
    assert.equal(st.conflicts[0].field, 'authFile')
    assert.equal(st.conflicts[0].source, '/fake/cordis.patch.yml')
    assert.match(st.warnings.join('\n'), /authFile/)
    assert.match(s.logger.lines.join('\n'), /warn:.*authFile/)
    return s
  } finally {
    await s.teardown()
  }
}

// ── A. parseRateLimitReset ─────────────────────────────────────────────────

test('parseRateLimitReset: 实测 6004 文案 → 重置时刻', () => {
  assert.equal(parseRateLimitReset(RESET_TEXT), RESET_MS)
  assert.equal(new Date(parseRateLimitReset(RESET_TEXT)).toISOString(), '2026-10-18T21:11:08.000Z')
})

test('parseRateLimitReset: 各种写法', () => {
  // 斜杠日期 + 无秒
  assert.equal(parseRateLimitReset('2026/10/19 05:11 UTC+8 重置'), Date.UTC(2026, 9, 18, 21, 11, 0))
  // ISO + Z
  assert.equal(parseRateLimitReset('reset at 2026-10-19T05:11:08Z'), Date.UTC(2026, 9, 19, 5, 11, 8))
  // 无 UTC 前缀的 ±HHMM
  assert.equal(parseRateLimitReset('重置时间 2026-10-19 05:11:08 +0800'), RESET_MS)
  assert.equal(parseRateLimitReset('重置时间 2026-10-19 05:11:08-05:00'), Date.UTC(2026, 9, 19, 10, 11, 8))
  // GMT-5
  assert.equal(parseRateLimitReset('2026-10-19 05:11:08 GMT-5'), Date.UTC(2026, 9, 19, 10, 11, 8))
  // UTC 无偏移 = UTC
  assert.equal(parseRateLimitReset('2026-10-19 05:11:08 UTC'), Date.UTC(2026, 9, 19, 5, 11, 8))
  // 小数秒（秒精度足够）
  assert.equal(parseRateLimitReset('2026-10-19T05:11:08.987Z'), Date.UTC(2026, 9, 19, 5, 11, 8))
  // 无时区 → 本机本地时间
  const naive = new Date(2026, 9, 19, 5, 11, 8).getTime()
  assert.equal(parseRateLimitReset('将在 2026-10-19 05:11:08 重置'), naive)
  // 只取第一个可解析的日期
  assert.equal(parseRateLimitReset('2026-13-40 00:00:00 UTC | 2026-10-19 05:11:08 UTC+8'), RESET_MS)
})

test('parseRateLimitReset: 解析不出时必须返回 undefined（绝不编造时刻）', () => {
  for (const bad of [
    undefined,
    null,
    42,
    {},
    '',
    '   ',
    '您的使用量已超出频率限制，请稍后再试',
    '将在 05:11:08 重置',
    '2026-02-30 05:11:08 UTC+8', // 日历上不存在
    '2026-10-32 05:11:08 UTC+8',
    '2026-10-19 25:11:08 UTC+8', // 小时非法
    '2026-10-19 05:61:08 UTC+8', // 分钟非法
    '2026-10-19 05:11:61 UTC+8', // 秒非法
    '2026-10-19 05:11:08 UTC+20', // 偏移越界
    '2026-10-19 05:11:08 UTC+14:30', // +14:00 是现实上限
  ]) {
    assert.equal(parseRateLimitReset(bad), undefined, `应拒绝：${String(bad)}`)
  }
})

// ── B. scanAuthFileOverrides ───────────────────────────────────────────────

test('scanAuthFileOverrides: 只把「非空的显式赋值」算作冲突', () => {
  const yaml = [
    'plugins:',
    '  dsh-workbuddy-connect:',
    '    config:',
    '      authFile: "/Users/me/custom.info"   # 显式',
    '      authFileAI: ""',
    '  other-plugin:',
    '    authFile: ~',
    '    authFileAI: null',
  ].join('\n')
  const hits = scanAuthFileOverrides(yaml)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].field, 'authFile')
  assert.equal(hits[0].value, '/Users/me/custom.info')
  assert.equal(hits[0].line, 4)
  assert.equal(hits[0].scoped, true)

  // JSON 形态
  const json = '{"workbuddy":{"authFileAI":"/tmp/ai.info"}}'
  assert.deepEqual(scanAuthFileOverrides(json).map((h) => h.field), ['authFileAI'])

  // 与 workbuddy 无关的远距离 authFile（>40 行）不算 scoped，但仍会被报出来（字段名够独特）
  const far = `${'# padding\n'.repeat(45)}plugins:\n  other:\n    authFile: /tmp/x\n`
  assert.equal(scanAuthFileOverrides(far)[0].scoped, false)

  assert.deepEqual(scanAuthFileOverrides(undefined), [])
  assert.deepEqual(scanAuthFileOverrides('# authFile: ""\n'), [])
})

// ── C. variantKeyForProvider ───────────────────────────────────────────────

test('variantKeyForProvider: 只认两个基础 route，pinned 路由不认', () => {
  assert.equal(variantKeyForProvider('workbuddy'), 'cn')
  assert.equal(variantKeyForProvider('workbuddy-ai'), 'ai')
  assert.equal(variantKeyForProvider('  WorkBuddy  '), 'cn')
  // pinned 路由（pinned.js 的 DEFAULT_PROVIDER_PREFIX）是用户显式钉住的单个账号，
  // 它绕过池子的 active 文件，绝不能被当成 cn/ai 触发轮换。
  assert.equal(variantKeyForProvider('workbuddy-m-5f1e0c3a'), undefined)
  assert.equal(variantKeyForProvider('workbuddy-m-8c3d9e21'), undefined)
  assert.equal(variantKeyForProvider('pi-ai'), undefined)
  assert.equal(variantKeyForProvider(''), undefined)
  assert.equal(variantKeyForProvider(undefined), undefined)
  assert.equal(variantKeyForProvider(42), undefined)
})

// ── D. classifyRetryEvent ─────────────────────────────────────────────────

test('classifyRetryEvent: 只对「我们的 provider + 该换号的 code」出计划', () => {
  const plan = classifyRetryEvent(retryEvent(), { now: T0, fallbackCooldownMs: 5 * MIN })
  assert.equal(plan.variantKey, 'cn')
  assert.equal(plan.code, 'RATE_LIMIT')
  assert.equal(plan.resetAt, RESET_MS)
  assert.equal(plan.signature, 'retry-1|1|1|1')

  // QUOTA / ACCOUNT_QUOTA 也该换号
  for (const code of ['QUOTA', 'ACCOUNT_QUOTA']) {
    assert.equal(classifyRetryEvent(retryEvent({ code }), { now: T0 }).code, code)
  }
  // 换号无用的 code 不动
  for (const code of ['MISSING_CREDENTIAL', 'INVALID_REQUEST', 'TIMEOUT', 'SERVER', '']) {
    assert.equal(classifyRetryEvent(retryEvent({ code }), { now: T0 }), undefined, code)
  }
  // 别的 provider 不动
  assert.equal(classifyRetryEvent(retryEvent({ provider: 'workbuddy-m-5f1e0c3a' }), { now: T0 }), undefined)
  assert.equal(classifyRetryEvent(retryEvent({ provider: 'pi-ai' }), { now: T0 }), undefined)
  // 不是 llm/retry / 结构不对 不动
  assert.equal(classifyRetryEvent({ type: 'llm/retry-started', data: {} }, { now: T0 }), undefined)
  assert.equal(classifyRetryEvent(undefined, { now: T0 }), undefined)
  assert.equal(classifyRetryEvent({ type: 'llm/retry' }, { now: T0 }), undefined)
  assert.equal(classifyRetryEvent({ type: 'llm/retry', data: { provider: 'workbuddy' } }, { now: T0 }), undefined)
  // 两个 variant 都要认
  assert.equal(classifyRetryEvent(retryEvent({ provider: 'workbuddy-ai' }), { now: T0 }).variantKey, 'ai')
})

test('classifyRetryEvent: 没有可解析的重置时刻时用 providerRetryAfterMs / 兜底时长', () => {
  const viaProvider = classifyRetryEvent(
    retryEvent({ message: '请求过于频繁', failureExtra: { providerRetryAfterMs: 90_000 } }),
    { now: T0, fallbackCooldownMs: 5 * MIN },
  )
  assert.equal(viaProvider.resetAt, undefined)
  assert.equal(viaProvider.retryAt, T0 + 90_000)

  const viaFallback = classifyRetryEvent(retryEvent({ message: '请求过于频繁' }), {
    now: T0,
    fallbackCooldownMs: 5 * MIN,
  })
  assert.equal(viaFallback.retryAt, T0 + 5 * MIN)

  const neither = classifyRetryEvent(retryEvent({ message: '请求过于频繁' }), { now: T0 })
  assert.equal(neither.retryAt, undefined)
})

// ── E. planCooldown ───────────────────────────────────────────────────────

test('planCooldown: 重置时刻优先，其次兜底，最后抬到最小时长', () => {
  assert.equal(planCooldown({ resetAt: RESET_MS, now: T0, cooldownMs: 5 * MIN, minCooldownMs: 0 }), RESET_MS)
  assert.equal(planCooldown({ now: T0, cooldownMs: 5 * MIN }), T0 + 5 * MIN)
  assert.equal(planCooldown({ resetAt: 1, now: T0, cooldownMs: 5 * MIN }), T0 + 5 * MIN) // 已过去的时刻→兜底? 不：抬到下限
  assert.equal(planCooldown({ resetAt: T0 - 1000, now: T0, minCooldownMs: 30_000 }), T0 + 30_000)
  assert.equal(planCooldown({ resetAt: undefined, now: T0, cooldownMs: 0, minCooldownMs: 30_000 }), T0 + 30_000)
})

// ── F. 构造期 fail fast ────────────────────────────────────────────────────

test('构造函数: pool 缺冻结方法时 fail fast 并列出缺什么（不自己给 pool 打补丁）', () => {
  const full = makePool({})
  assert.doesNotThrow(() => new RotationEngine({ pool: full, ctx: makeCtx() }))

  const broken = { ...full }
  delete broken.advance
  delete broken.setCooldown
  assert.throws(
    () => new RotationEngine({ pool: broken, ctx: makeCtx() }),
    /pool is missing frozen methods: setCooldown, advance/,
  )
  assert.throws(() => new RotationEngine({}), TypeError)
  // 上游 variant 表可被注入覆盖（pool.POOL_VARIANTS 为准）
  const injected = new RotationEngine({
    pool: { ...full, POOL_VARIANTS: [{ key: 'cn', routeId: 'workbuddy', env: 'CUSTOM_CN_ENV' }] },
    ctx: makeCtx(),
  })
  assert.equal(injected.status().variants.cn.env, 'CUSTOM_CN_ENV')
  assert.equal(injected.status().variants.ai.env, 'WORKBUDDY_AI_AUTH_FILE')
})

// ── G. start()：冲突检测 / env 接管 / 空池 ─────────────────────────────────

test('start(): 检测到上游显式 authFile → 告警 + 不接管该 variant 的 env（R1）', async () => {
  const s = await assertDetectsAuthFileConflict(rotation)
  assert.equal(s.engine.status().envApplied.ai, s.pool.activeFilePath('ai'))
  assert.equal(s.engine.status().envApplied.cn, undefined)
})

test('start(): 无冲突时接管两个 env（上游每次请求重读 env，无需重启）', async () => {
  const s = await assertTakesOverEnv(rotation)
  const st = s.engine.status()
  assert.deepEqual(st.envApplied, { cn: '/pool/active/cn.info', ai: '/pool/active/ai.info' })
  assert.equal(st.variants.cn.activeUid, 'uid-a')
  assert.equal(st.variants.cn.accounts, 2)
  assert.equal(st.variants.cn.selectable, 2)
})

test('start(): config.envOverride=false 时完全不动 env', async () => {
  const s = scenario({ config: { envOverride: false, detectConflicts: () => [] } })
  try {
    await s.engine.start()
    assert.equal(process.env.WORKBUDDY_AUTH_FILE, undefined)
    assert.equal(process.env.WORKBUDDY_AI_AUTH_FILE, undefined)
    assert.equal(s.engine.status().envOverride, false)
    // 但 active 文件仍要喂好
    assert.equal(s.engine.status().variants.cn.activeUid, 'uid-a')
  } finally {
    await s.teardown()
  }
})

test('start(): 空池只告警，不抛', async () => {
  const s = scenario({ accounts: { cn: [], ai: [] }, config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    const st = s.engine.status()
    assert.equal(st.variants.cn.activeUid, undefined)
    assert.match(st.warnings.join('\n'), /暂无可用账号/)
    assert.equal(st.variants.cn.accounts, 0)
  } finally {
    await s.teardown()
  }
})

test('start(): 显式 config.policy 才会改写池子策略；未给就不动', async () => {
  const untouched = scenario({ policy: 'manual', config: { detectConflicts: () => [] } })
  try {
    await untouched.engine.start()
    assert.equal(untouched.pool.policy(), 'manual')
  } finally {
    await untouched.teardown()
  }

  const explicit = scenario({ policy: 'manual', config: { detectConflicts: () => [], policy: 'round-robin' } })
  try {
    await explicit.engine.start()
    assert.equal(explicit.pool.policy(), 'round-robin')
    assert.equal(explicit.engine.status().policy, 'round-robin')
  } finally {
    await explicit.teardown()
  }
})

test('start(): 幂等（index.js 只调一次，但多调一次也不该重复接管）', async () => {
  const s = scenario({ config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    const before = s.logger.lines.length
    await s.engine.start()
    assert.equal(s.logger.lines.length, before)
    assert.equal(s.ctx.handlers.get('session/event').size, 1)
    assert.equal(s.ctx.handlers.get('llm/stream').size, 1)
  } finally {
    await s.teardown()
  }
})

// ── H. on-rate-limit ──────────────────────────────────────────────────────

test('on-rate-limit: 频控 → 冷却当前账号（到重置时刻）+ 换号', async () => {
  await assertRotatesOnRateLimit(rotation)
})

test('on-rate-limit: 冷却期间不被重复选中；全部冷却时留在原地 + 告警', async () => {
  await assertCoolingBlocksReselection(rotation)
})

test('on-rate-limit: 同一失败的重复事件去重，不连换几号', async () => {
  await assertDedupesRetryEvents(rotation)
})

test('on-rate-limit: 去重按 session 隔离 —— 另一个会话的同样失败是新的失败', async () => {
  const s = scenario({ RotationEngine: rotation.RotationEngine, accounts: { cn: ['uid-a', 'uid-b', 'uid-c'], ai: [] } })
  try {
    await s.engine.start()
    const event = retryEvent() // 无 retryId 的最坏情况：四元组完全一样
    await feed(s, event, { id: 'session-1' })
    assert.equal(s.pool.activeUid('cn'), 'uid-b')
    await feed(s, event, { id: 'session-1' })
    assert.equal(s.pool.activeUid('cn'), 'uid-b', '同会话重复投递 → 去重')
    await feed(s, event, { id: 'session-2' })
    assert.equal(s.pool.activeUid('cn'), 'uid-c', '不同会话的相同失败必须各自生效')
  } finally {
    await s.teardown()
  }
})

test('on-rate-limit: 与工作无关的 session 事件不触发换号', async () => {
  const s = scenario({ config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    await feed(s, { type: 'assistant/message', seq: 1, data: { text: 'hi' } })
    await feed(s, retryEvent({ provider: 'pi-ai' }))
    await feed(s, retryEvent({ provider: 'workbuddy-m-5f1e0c3a' }))
    await feed(s, retryEvent({ code: 'TIMEOUT' }))
    assert.equal(s.pool.activeUid('cn'), 'uid-a')
    assert.equal(s.pool.calls.filter((c) => c.startsWith('advance:')).length, 0)
  } finally {
    await s.teardown()
  }
})

test('on-rate-limit: respectCooldown=false 时只换号不冷却', async () => {
  const s = scenario({ config: { detectConflicts: () => [], respectCooldown: false } })
  try {
    await s.engine.start()
    await feed(s, retryEvent())
    assert.equal(s.pool.activeUid('cn'), 'uid-b')
    assert.deepEqual(s.engine.status().variants.cn.cooling, [])
    assert.equal(s.pool.calls.filter((c) => c.startsWith('setCooldown')).length, 0)
  } finally {
    await s.teardown()
  }
})

test('on-rate-limit: manual 策略下只记录冷却，不自动换号', async () => {
  const s = scenario({ policy: 'manual', config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    await feed(s, retryEvent())
    assert.equal(s.pool.activeUid('cn'), 'uid-a')
    assert.deepEqual(
      s.engine.status().variants.cn.cooling.map((c) => c.uid),
      ['uid-a'],
    )
  } finally {
    await s.teardown()
  }
})

test('on-rate-limit: 频控但无其它账号 → 告警 + 留在原地', async () => {
  const s = scenario({ accounts: { cn: ['uid-a'], ai: [] }, config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    await feed(s, retryEvent())
    assert.equal(s.pool.activeUid('cn'), 'uid-a')
    assert.match(s.engine.status().warnings.join('\n'), /没有其他可用账号/)
  } finally {
    await s.teardown()
  }
})

test('on-rate-limit: pool 抛异常时只记 warning，不把 rejection 漏给宿主', async () => {
  const s = scenario({ config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    s.pool.advance = async () => {
      throw new Error('disk full')
    }
    await feed(s, retryEvent())
    assert.match(s.engine.status().warnings.join('\n'), /账号池操作失败：disk full/)
    assert.match(s.logger.lines.join('\n'), /warn:/)
  } finally {
    await s.teardown()
  }
})

// ── I. round-robin ────────────────────────────────────────────────────────

test('round-robin: 每次分发前换号，且保留 next() 的流', async () => {
  const s = scenario({ policy: 'round-robin', config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    const seen = []
    const makeNext = () =>
      (async function* () {
        seen.push(s.pool.activeUid('cn')) // 记录「分发那一刻」的生效账号
        yield { delta: 'x' }
      })()

    const [gen] = await s.ctx.fire('llm/stream', { provider: 'workbuddy', model: 'm', sessionId: 's1' }, makeNext)
    assert.equal(s.pool.activeUid('cn'), 'uid-a', '分发前的 advance 只能发生在 generator 体内')
    const chunks = []
    for await (const chunk of gen) chunks.push(chunk)
    assert.deepEqual(chunks, [{ delta: 'x' }], 'next() 的流必须原样透传')
    assert.deepEqual(seen, ['uid-b'], '请求实际落在换过号之后的账号上')
    assert.equal(s.engine.status().variants.cn.lastAdvanceReason, 'round-robin')

    // 第二次分发继续前进
    const [gen2] = await s.ctx.fire('llm/stream', { provider: 'workbuddy' }, makeNext)
    for await (const _ of gen2) void _
    assert.deepEqual(seen, ['uid-b', 'uid-a'], '环形前进')
  } finally {
    await s.teardown()
  }
})

test('round-robin: 别的 provider / 别的策略 / 内部请求都不动弹，且直接透传 next()', async () => {
  const rr = scenario({ policy: 'round-robin', config: { detectConflicts: () => [] } })
  try {
    await rr.engine.start()
    const marker = { marker: true }
    const direct = () => marker
    for (const options of [
      { provider: 'pi-ai' },
      { provider: 'workbuddy-m-5f1e0c3a' },
      { provider: 'workbuddy', purpose: 'title' },
    ]) {
      const [out] = await rr.ctx.fire('llm/stream', options, direct)
      assert.equal(out, marker, `应原样返回 next() 的结果：${JSON.stringify(options)}`)
    }
    assert.equal(rr.pool.calls.filter((c) => c.startsWith('advance:')).length, 0)
    assert.equal(rr.pool.activeUid('cn'), 'uid-a')

    // rotateInternalRequests=true 时内部请求才转动
    const withInternal = scenario({
      policy: 'round-robin',
      config: { detectConflicts: () => [], rotateInternalRequests: true },
    })
    try {
      await withInternal.engine.start()
      const [gen] = await withInternal.ctx.fire(
        'llm/stream',
        { provider: 'workbuddy', purpose: 'title' },
        () => (async function* () {})(),
      )
      for await (const _ of gen) void _
      assert.equal(withInternal.pool.activeUid('cn'), 'uid-b')
    } finally {
      await withInternal.teardown()
    }
  } finally {
    await rr.teardown()
  }

  const onRate = scenario({ config: { detectConflicts: () => [] } }) // 默认 on-rate-limit
  try {
    await onRate.engine.start()
    const marker = { marker: true }
    const [out] = await onRate.ctx.fire('llm/stream', { provider: 'workbuddy' }, () => marker)
    assert.equal(out, marker)
    assert.equal(onRate.pool.calls.filter((c) => c.startsWith('advance:')).length, 0)
  } finally {
    await onRate.teardown()
  }
})

test('round-robin: 只有一个可用账号时不重写 active 文件（廉价）', async () => {
  const s = scenario({
    accounts: { cn: ['uid-a'], ai: [] },
    policy: 'round-robin',
    config: { detectConflicts: () => [] },
  })
  try {
    await s.engine.start()
    const [gen] = await s.ctx.fire('llm/stream', { provider: 'workbuddy' }, () => (async function* () {})())
    for await (const _ of gen) void _
    assert.equal(s.pool.calls.filter((c) => c.startsWith('advance:')).length, 0)
  } finally {
    await s.teardown()
  }
})

test('round-robin: 换号失败不吞掉这次请求（只记 warning，流照常走）', async () => {
  const s = scenario({ policy: 'round-robin', config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    s.pool.advance = async () => {
      throw new Error('boom')
    }
    const [gen] = await s.ctx.fire('llm/stream', { provider: 'workbuddy' }, () =>
      (async function* () {
        yield 'ok'
      })(),
    )
    const chunks = []
    for await (const chunk of gen) chunks.push(chunk)
    assert.deepEqual(chunks, ['ok'])
    assert.match(s.logger.lines.join('\n'), /换号失败：boom|账号池操作失败：boom/)
  } finally {
    await s.teardown()
  }
})

// ── J. 优雅降级 / stop / sync ─────────────────────────────────────────────

test('优雅降级: ctx.on 缺失或抛异常时 start() 仍然成功，只留 warning（R4）', async () => {
  await assertDegradesGracefully(rotation)
})

test('stop(): 卸掉钩子但**不回滚** env（回滚会让上游退回用户真实桌面文件）', async () => {
  const s = scenario({ config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    const envPath = process.env.WORKBUDDY_AUTH_FILE
    await s.engine.stop()
    assert.equal(process.env.WORKBUDDY_AUTH_FILE, envPath, 'stop() 不得回滚 env')
    assert.equal(s.engine.status().started, false)
    assert.equal(s.ctx.handlers.get('session/event')?.size ?? 0, 0)
    assert.equal(s.ctx.handlers.get('llm/stream')?.size ?? 0, 0)
    // 卸载后事件不再换号
    await feed(s, retryEvent())
    assert.equal(s.pool.activeUid('cn'), 'uid-a')
  } finally {
    await s.teardown()
  }
})

test('sync(): 幂等且廉价；env 被外部改掉会拉回来', async () => {
  const s = scenario({ config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    const callsBefore = s.pool.calls.length
    await s.engine.sync()
    await s.engine.sync()
    assert.equal(s.pool.activeUid('cn'), 'uid-a', 'sync 不该换号')
    const writes = s.pool.calls.slice(callsBefore).filter((c) => c.startsWith('advance:'))
    assert.deepEqual(writes, [], 'sync 不该调 advance')

    process.env.WORKBUDDY_AUTH_FILE = '/wrong/path'
    await s.engine.sync()
    assert.equal(process.env.WORKBUDDY_AUTH_FILE, s.pool.activeFilePath('cn'))

    // 池子换人之后 sync 跟上
    await s.pool.advance('cn', { reason: 'manual' })
    await s.flush()
    assert.equal(s.engine.status().variants.cn.activeUid, 'uid-b')
  } finally {
    await s.teardown()
  }
})

test('sync()/status(): 池子未 load（方法抛异常）时不炸', async () => {
  const s = scenario({ config: { detectConflicts: () => [] } })
  try {
    s.pool.list = () => {
      throw new Error('pool not loaded')
    }
    const st = s.engine.status() // 不抛
    assert.equal(st.variants.cn.accounts, 0)
    assert.match(st.warnings.join('\n'), /pool not loaded/)
    // 同一条告警只记一次（status 会被频繁调用）
    const count = st.warnings.filter((w) => /pool not loaded/.test(w)).length
    assert.equal(count, 1)
  } finally {
    await s.teardown()
  }
})

test('status(): 冻结形状在（policy / variants.{cn,ai} 四要素 / warnings）', async () => {
  const s = scenario({ config: { detectConflicts: () => [] } })
  try {
    await s.engine.start()
    const st = s.engine.status()
    assert.equal(typeof st.policy, 'string')
    for (const key of ['cn', 'ai']) {
      const v = st.variants[key]
      assert.ok('activeUid' in v && 'lastAdvanceAt' in v && 'lastAdvanceReason' in v)
      assert.ok(Array.isArray(v.cooling))
      assert.ok(v.cooling.every((c) => 'uid' in c && 'until' in c && 'reason' in c))
    }
    assert.ok(Array.isArray(st.warnings))
    assert.equal(JSON.parse(JSON.stringify(st)).variants.cn.activeUid, 'uid-a', 'status 必须可序列化')
  } finally {
    await s.teardown()
  }
})

test('defaultPatchFiles(): 只从 DSH_HOME / DSH_PROFILE* 推导，不硬编码 desktop', () => {
  assert.deepEqual(defaultPatchFiles({ DSH_HOME: '/h' }), ['/h/cordis.patch.yml', '/h/settings.yaml'])
  assert.deepEqual(defaultPatchFiles({ DSH_HOME: '/h', DSH_PROFILE: 'desktop' }), [
    '/h/cordis.patch.yml',
    '/h/settings.yaml',
    '/h/profiles/desktop/cordis.patch.yml',
  ])
  assert.deepEqual(defaultPatchFiles({ DSH_HOME: '/h', DSH_PROFILE_DIR: '/p' }), [
    '/h/cordis.patch.yml',
    '/h/settings.yaml',
    '/p/cordis.patch.yml',
  ])
  assert.deepEqual(defaultPatchFiles({ DSH_HOME: '/h', DSH_PROFILE: '/abs' }), [
    '/h/cordis.patch.yml',
    '/h/settings.yaml',
    '/abs/cordis.patch.yml',
  ])
})

test('constants: code 集合就是三个该换号的稳定 code', () => {
  assert.deepEqual([...RATE_LIMIT_CODES], ['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA'])
})

// ── K. 与真实 lib/pool.js 的集成契约（PLAN §3.2 冻结接口） ────────────────
// 上面的假 pool 只证明 rotation 自己的逻辑；这条用**真实的** WorkBuddyPool + 真实文件系统，
// 证明冻结契约的调用顺序/语义对得上。pool.js 若漂移，这条会红 —— 这正是它存在的意义。

test('集成: 真实 pool.js + 真实文件系统 —— env 接管 / 换号 / 冷却到重置时刻', async () => {
  const { WorkBuddyPool } = await import(pathToFileURL(join(HERE, '..', 'lib', 'pool.js')).href)
  const root = await mkdtemp(join(tmpdir(), 'rotation-pool-'))
  const seed = await mkdtemp(join(tmpdir(), 'rotation-seed-'))
  const envBackup = {}
  for (const name of ['WORKBUDDY_AUTH_FILE', 'WORKBUDDY_AI_AUTH_FILE']) {
    envBackup[name] = process.env[name]
    delete process.env[name]
  }
  try {
    const expiresAt = T0 + 3600_000
    const refreshExpiresAt = T0 + 86400_000
    const seedFiles = []
    for (const uid of ['uid-a', 'uid-b']) {
      const file = join(seed, `${uid}.info`)
      await writeFile(
        file,
        JSON.stringify({
          account: { uid, uin: String(1000 + uid.length), nickname: `N-${uid}` },
          auth: { domain: 'www.workbuddy.cn', expiresAt, refreshExpiresAt },
          accounts: [],
        }),
      )
      seedFiles.push(file)
    }
    const pool = new WorkBuddyPool({ root, logger: silentLogger(), now: () => T0 })
    await pool.load()
    const imported = await pool.importFiles('cn', seedFiles)
    assert.deepEqual(imported.map((m) => m.uid), ['uid-a', 'uid-b'], '账号必须进池')
    await pool.ensureActive('cn')

    const ctx = makeCtx()
    const engine = new RotationEngine({ pool, ctx, config: { detectConflicts: () => [], now: () => T0 } })
    await engine.start()
    assert.equal(pool.activeUid('cn'), 'uid-a')
    assert.equal(process.env.WORKBUDDY_AUTH_FILE, pool.activeFilePath('cn'), 'env 指向池子的 active 文件')
    const before = engine.status().variants.cn
    assert.equal(before.activeUid, 'uid-a')
    assert.equal(before.accounts, 2)
    assert.equal(before.selectable, 2)

    await ctx.fire('session/event', { id: 's' }, retryEvent())
    assert.ok(
      await waitFor(() => pool.activeUid('cn') === 'uid-b'),
      '真实 pool 上也要换到下一个账号',
    )
    const cooling = engine.status().variants.cn.cooling
    assert.deepEqual(cooling.map((c) => c.uid), ['uid-a'])
    assert.equal(cooling[0].until, RESET_MS, '冷却到上游给的重置时刻')
    // 生效文件里必须是 uid-b 的真实字节（上游下一次请求就会读它）
    const active = pool.get('cn', 'uid-b')
    assert.ok(active.bytes > 0)
    assert.equal(JSON.parse(await readFile(pool.activeFilePath('cn'), 'utf8')).account.uid, 'uid-b')
    await engine.stop()
  } finally {
    for (const [name, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
    await rm(seed, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 反向（变异）测试
//
// 做法：把源码做**定向文本突变**写成临时模块，import 后用上面**同一套断言函数**跑，
// 断言它现在必然失败。若突变没生效（锚点漂移/已被改名），测试直接红 —— 不允许静默通过。
// ─────────────────────────────────────────────────────────────────────────────

const MUTATION_DIR = await mkdtemp(join(tmpdir(), 'rotation-mutation-'))

/**
 * 定向突变：`anchor` 是源码里的注释锚点（保证改的是对的地方），`from`/`to` 是文本替换。
 * @returns {Promise<Record<string, any>>} 突变后的模块命名空间
 */
async function loadMutated({ anchor, from, to, name }) {
  const source = await readFile(ROTATION_PATH, 'utf8')
  assert.ok(
    source.includes(anchor),
    `突变锚点已漂移：${anchor} —— lib/rotation.js 改了判断逻辑就必须同步更新本测试`,
  )
  assert.ok(source.includes(from), `突变的原文找不到：${JSON.stringify(from)}`)
  const mutated = source.replace(from, to)
  assert.notEqual(mutated, source, '突变没有生效')
  const file = join(MUTATION_DIR, `rotation.${name}.mjs`)
  await writeFile(file, mutated)
  return import(pathToFileURL(file).href)
}

test('反向: 破坏 code 过滤（清空 RATE_LIMIT_CODES）后，换号断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'empty-codes',
    anchor: '/* [anchor:codes]',
    from: "Object.freeze(['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA'])",
    to: 'Object.freeze([])',
  })
  assert.deepEqual([...mod.RATE_LIMIT_CODES], [])
  await assert.rejects(assertRotatesOnRateLimit(mod), /频控后应换到下一个账号/)
})

test('反向: 破坏「冷却当前账号」后，冷却断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'no-cooldown',
    anchor: '/* [anchor:cooldown]',
    from: 'await this.#pool.setCooldown(variantKey, failed, cooldown)',
    to: 'void cooldown',
  })
  // 换号本身还在（环形前进会自然跳过刚被冷却的账号），所以先证明「冷却」这条是吃劲的：
  await assert.rejects(assertRotatesOnRateLimit(mod), /被频控的账号必须进入冷却/)
  await assert.rejects(
    assertCoolingBlocksReselection(mod),
    /没有别的可用账号时应留在当前账号|冷却中/,
  )
})

test('反向: 破坏重置时刻优先（忽略 resetAt）后，until 断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'ignore-reset',
    anchor: '/* [anchor:reset]',
    from: 'const base = usable ? resetAt : now + cooldownMs',
    to: 'const base = now + cooldownMs',
  })
  assert.equal(mod.planCooldown({ resetAt: RESET_MS, now: T0, cooldownMs: 5 * MIN }), T0 + 5 * MIN)
  await assert.rejects(assertRotatesOnRateLimit(mod), /冷却应延续到上游给的重置时刻/)
})

test('反向: 破坏去重后，重复事件会连换几号', async () => {
  const mod = await loadMutated({
    name: 'no-dedupe',
    anchor: '/* [anchor:dedupe]',
    from: 'this.#seenRetries.has(plan.signature)',
    to: 'false',
  })
  await assert.rejects(assertDedupesRetryEvents(mod), /重复事件不得再次换号|advance 只应被调用一次/)
})

test('反向: 破坏 provider 精确匹配（改成前缀匹配）后，pinned 路由被误判 → 断言失败', async () => {
  const mod = await loadMutated({
    name: 'prefix-match',
    anchor: '/* [anchor:provider]',
    from: 'if (id.toLowerCase() === norm) return v.key',
    to: 'if (norm.startsWith(id.toLowerCase())) return v.key',
  })
  assert.equal(mod.variantKeyForProvider('workbuddy-m-5f1e0c3a'), 'cn', '突变应把 pinned 误判成 cn')
  // 主测试断言的正是「pinned → undefined」；突变后这条断言必然失败。
  assert.throws(() => assert.equal(mod.variantKeyForProvider('workbuddy-m-5f1e0c3a'), undefined))
  // 连端到端也一起证明：pinned provider 的 retry 在突变版里会真的换号。
  const mutated = scenario({ RotationEngine: mod.RotationEngine, config: { detectConflicts: () => [] } })
  try {
    await mutated.engine.start()
    await feed(mutated, retryEvent({ provider: 'workbuddy-m-5f1e0c3a' }))
    assert.equal(mutated.pool.activeUid('cn'), 'uid-b', '突变版：pinned 也会触发池子换号（错误行为）')
  } finally {
    await mutated.teardown()
  }
  // 正版行为（对照）：不换号
  const ok = scenario({ config: { detectConflicts: () => [] } })
  try {
    await ok.engine.start()
    await feed(ok, retryEvent({ provider: 'workbuddy-m-5f1e0c3a' }))
    assert.equal(ok.pool.activeUid('cn'), 'uid-a')
  } finally {
    await ok.teardown()
  }
})

test('反向: 破坏环境变量接管后，env 断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'no-env',
    anchor: '/* [anchor:env]',
    from: 'process.env[variant.env] = target',
    to: 'void target',
  })
  await assert.rejects(assertTakesOverEnv(mod), /环境变量必须指向池子的 active 文件/)
  await assert.rejects(assertDetectsAuthFileConflict(mod), /空值的 authFileAI 不算冲突/)
})

test('反向: 破坏「空值不算冲突」后，扫描断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'empty-as-conflict',
    anchor: '/* [anchor:scan-empty]',
    from: "if (value === '') return",
    to: 'if (false) return',
  })
  assert.equal(mod.scanAuthFileOverrides('  dsh-workbuddy-connect:\n    authFileAI: ""\n').length, 1)
  await assert.rejects(assertDetectsAuthFileConflict(mod), /空值的 authFileAI 不算冲突/)
})

test('反向: 破坏优雅降级（改成抛异常）后，降级断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'throw-on-missing-ctx-on',
    anchor: '/* [anchor:degradation]',
    from: "this.#unavailable.push('ctx.on')",
    to: "throw new Error('ctx.on unavailable (mutated)')",
  })
  await assert.rejects(assertDegradesGracefully(mod), /ctx\.on unavailable \(mutated\)/)
})

/* ────────── 撞限后直接跳过冷却账号（2026-10-19 用户反馈：别再在限流账号上试一次） ────────── */

/** 走一次 llm/stream waterfall，返回「实际发出请求时」生效的是哪个账号。 */
async function dispatch(s, options) {
  const fn = [...(s.ctx.handlers.get('llm/stream') ?? [])][0]
  assert.equal(typeof fn, 'function', 'llm/stream 监听必须已安装')
  let servedBy
  const next = () =>
    (async function* upstream() {
      servedBy = s.pool.activeUid('cn')
      yield 'chunk'
    })()
  const out = fn({ provider: 'workbuddy', model: 'm', messages: [], ...options }, next)
  for await (const _ of out) {
    /* drain */
  }
  return servedBy
}

/** 冷却中的生效账号：下一次分发前直接换掉，请求根本不会发到它身上。 */
async function assertSkipsCoolingBeforeDispatch(mod) {
  const s = scenario({ RotationEngine: mod.RotationEngine, accounts: { cn: ['uid-a', 'uid-b', 'uid-c'], ai: [] } })
  try {
    await s.engine.start()
    await s.pool.setCooldown('cn', 'uid-a', { until: T0 + 30 * MIN, reason: 'RATE_LIMIT' })
    await s.flush()
    assert.equal(s.pool.activeUid('cn'), 'uid-a', '前提：冷却中的 a 仍是生效账号')
    const servedBy = await dispatch(s, { sessionId: 'session-1' })
    assert.equal(servedBy, 'uid-b', '冷却中的账号必须在分发前被跳过')
  } finally {
    await s.teardown()
  }
}

/** 撞限算到发请求的账号头上；别处已经换过号时，不再多换一个。 */
async function assertAttributesToServingAccount(mod) {
  const s = scenario({ RotationEngine: mod.RotationEngine, accounts: { cn: ['uid-a', 'uid-b', 'uid-c'], ai: [] } })
  try {
    await s.engine.start()
    assert.equal(await dispatch(s, { sessionId: 'session-1' }), 'uid-a')
    // 请求还在路上时，别的会话已经把生效账号换成了 b。
    s.pool.setActiveRaw('cn', 'uid-b')
    await feed(s, retryEvent(), { id: 'session-1' })
    assert.ok(typeof s.pool.get('cn', 'uid-a').cooldownUntil === 'number', '发请求的 a 必须冷却')
    assert.equal(s.pool.get('cn', 'uid-b').cooldownUntil, undefined, 'b 没有失败过，不能被冤枉冷却')
    assert.equal(s.pool.activeUid('cn'), 'uid-b', '已经换到可用的 b，不能再多换到 c')
  } finally {
    await s.teardown()
  }
}

test('撞限后：冷却中的生效账号在下一次分发前就被跳过', () => assertSkipsCoolingBeforeDispatch({ RotationEngine }))

test('撞限后：冷却记到发请求的账号头上，且不会连换两个号', () => assertAttributesToServingAccount({ RotationEngine }))

test('round-robin 只剩一个可用账号、而生效的是冷却中的那个：必须换过去', async () => {
  const s = scenario({ accounts: { cn: ['uid-a', 'uid-b'], ai: [] }, policy: 'round-robin' })
  try {
    await s.engine.start()
    await s.pool.setCooldown('cn', 'uid-a', { until: T0 + 30 * MIN, reason: 'RATE_LIMIT' })
    await s.flush()
    assert.equal(await dispatch(s, { sessionId: 's' }), 'uid-b')
  } finally {
    await s.teardown()
  }
})

test('manual 策略：冷却中也不自动换号（只用你选的）', async () => {
  const s = scenario({ accounts: { cn: ['uid-a', 'uid-b'], ai: [] }, policy: 'manual' })
  try {
    await s.engine.start()
    await s.pool.setCooldown('cn', 'uid-a', { until: T0 + 30 * MIN, reason: 'RATE_LIMIT' })
    await s.flush()
    assert.equal(await dispatch(s, { sessionId: 's' }), 'uid-a')
  } finally {
    await s.teardown()
  }
})

test('反向: 去掉分发前跳过冷却账号后，跳过断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'no-skip-cooling',
    anchor: '/* [anchor:skip-cooling]',
    from: "const skip = !rotate && policy !== 'manual'",
    to: "const skip = false && !rotate && policy !== 'manual'",
  })
  await assert.rejects(assertSkipsCoolingBeforeDispatch(mod), /冷却中的账号必须在分发前被跳过/)
})

test('反向: 去掉「别处已换号就不再换」后，连换两号的断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'double-advance',
    anchor: '/* [anchor:no-double-advance]',
    from: "if (typeof current === 'string' && current !== failed && this.#isSelectable(variantKey, current)) {",
    to: 'if (false) {',
  })
  await assert.rejects(assertAttributesToServingAccount(mod), /不能再多换到 c/)
})

test('反向: 失败改回记到「当前生效账号」后，冤枉冷却的断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'blame-current',
    anchor: '/* [anchor:cooldown]',
    from: "const failed = typeof plan.servedBy === 'string' ? plan.servedBy : current",
    to: 'const failed = current',
  })
  await assert.rejects(assertAttributesToServingAccount(mod), /发请求的 a 必须冷却|不能被冤枉冷却/)
})
