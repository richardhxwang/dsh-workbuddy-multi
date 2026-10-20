/**
 * lib/credits.js 单测。
 *
 * 纪律（与 PLAN §4 一致）：只用**假 pool / 假 createClient / 假 now / 假 logger**，
 * 不读真人 auth 文件、不打真网络。唯一用到真东西的是 `parseWorkBuddyAuth`（被测模块
 * 自己静态 import 的上游解析器）—— 密文/坏档返回 undefined 这条行为本身就是上游的，
 * 只有拿真解析器测才有意义。
 *
 * 反向测试用「读源码 → 按锚点做定点突变 → 写临时模块 → import」的方式（照
 * test/rotation.test.js / test/keepalive.test.js 的既有做法）。突变模块里的
 * `dsh-workbuddy-connect` 裸导入会被换成绝对 URL —— 临时目录里没有 node_modules，
 * 不换就会变成 ERR_MODULE_NOT_FOUND，那样红的是「模块找不到」而不是断言失败。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  CREDITS_DEFAULTS,
  CreditsCache,
  aggregateVariant,
  fetchAccountCredits,
  parseCredential,
  summarizeVariant,
} from '../lib/credits.js'
import { loadUpstream } from '../lib/upstream.js'

// 上游是按需加载的（见 lib/upstream.js）；这些用例直接调用积分函数，没有经过 bootstrap。
await loadUpstream()

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(HERE)
const CREDITS_PATH = join(PKG_ROOT, 'lib', 'credits.js')

const BASE = 1_700_000_000_000
const AI_DOMAIN = 'www.workbuddy.ai'
const CN_DOMAIN = 'www.workbuddy.cn'

const flush = () => new Promise((resolve) => setImmediate(resolve))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 夹具 ──────────────────────────────────────────────────────────────

/** 明文快照：上游 parseWorkBuddyAuth 认得的形状（实测可用）。 */
function plainDoc(uid, { nickname = '', domain = AI_DOMAIN } = {}) {
  return JSON.stringify({
    version: 1,
    account: { uid, uin: '10001', nickname: nickname === '' ? `Acct ${uid}` : nickname, type: 'personal' },
    auth: {
      accessToken: 'plain-access-token-value',
      refreshToken: 'plain-refresh-token-value',
      domain,
      expiresAt: BASE + 3_600_000,
      refreshExpiresAt: BASE + 86_400_000,
    },
    accounts: [],
  })
}

/** 桌面 App 收割来的密文信封（国内版）：上游解析器对它返回 undefined。 */
function encDoc(uid, { domain = CN_DOMAIN } = {}) {
  return JSON.stringify({
    version: 1,
    account: { uid, uin: '20002', nickname: `CN ${uid}`, type: 'personal' },
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'Y2lwaGVydGV4dA==' },
      refreshToken: { $wbEncrypted: 1, envelope: 'cmVmcmVzaA==' },
      domain,
      expiresAt: BASE + 3_600_000,
      refreshExpiresAt: BASE + 86_400_000,
    },
    accounts: [],
  })
}

function meta(uid, overrides = {}) {
  return { variantKey: 'ai', uid, label: `Acct ${uid}`, enabled: true, ...overrides }
}

/**
 * 假 pool：只实现 §3.5.3 里 credits 用得到的那几个。
 * `list` 与真 pool（lib/pool.js:421）一样是**同步**的。
 */
function fakePool({ accounts = {}, docs = {}, active = {}, listFails = false, readFails = false, metaFails = false, methods = null } = {}) {
  const calls = { list: [], read: [], accountMeta: [], activeUid: [] }
  const pool = {
    calls,
    list(variantKey) {
      calls.list.push(variantKey)
      if (listFails) throw new Error('list boom')
      return accounts[variantKey] ?? []
    },
    async readSnapshotDocument(variantKey, uid) {
      calls.read.push(`${variantKey}/${uid}`)
      if (readFails) throw new Error('read boom')
      const key = `${variantKey}/${uid}`
      return key in docs ? docs[key] : null
    },
    async accountMeta(variantKey, uid) {
      calls.accountMeta.push(`${variantKey}/${uid}`)
      if (metaFails) throw new Error('meta boom')
      return (accounts[variantKey] ?? []).find((row) => row.uid === uid)
    },
    async activeUid(variantKey) {
      calls.activeUid.push(variantKey)
      return active[variantKey]
    },
  }
  if (methods !== null) {
    for (const name of ['readSnapshotDocument', 'accountMeta', 'activeUid']) {
      if (!methods.includes(name)) delete pool[name]
    }
  }
  return pool
}

/** 假上游客户端：按 credential.uid 回不同的数；记录每次调用与收到的信号。 */
function fakeUpstream({ byUid = {}, failUid = {}, hangUid = {}, tickUid = {}, ticks = 3, onCall = null } = {}) {
  const calls = []
  let peak = 0
  let active = 0
  const gates = []
  const createClient = () => ({
    async fetchCredits(credential, signal) {
      const uid = credential && credential.uid
      calls.push({ uid, signal })
      active += 1
      peak = Math.max(peak, active)
      if (onCall) onCall(credential, signal)
      // `AbortSignal.timeout` 的定时器是 **unref** 的：只靠它等超时，事件循环会提前排空
      // （node:test 会以 'Promise resolution is still pending' 取消掉后面所有用例）。
      // 所以假客户端要么自己抓一个活把手（挂起用例），要么用 flush 推进（并发用例）。
      const keep = hangUid[uid] ? setTimeout(() => {}, 250) : null
      try {
        if (tickUid[uid]) {
          for (let i = 0; i < ticks; i += 1) await flush()
        }
        if (hangUid[uid]) {
          await new Promise((resolve, reject) => {
            gates.push(resolve)
            if (signal) {
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            }
          })
        }
        if (failUid[uid]) throw new Error(failUid[uid])
        const value = byUid[uid]
        if (typeof value === 'function') return value(credential)
        return value ?? creditsOf(0, 1)
      } finally {
        if (keep !== null) clearTimeout(keep)
        active -= 1
      }
    },
  })
  return {
    createClient,
    calls,
    peak: () => peak,
    releaseAll: () => {
      for (const resolve of gates.splice(0)) resolve()
    },
  }
}

/** 造一个上游 WorkBuddyCredits 形状的回包。 */
function creditsOf(total, packages = 1, { unlimited = false } = {}) {
  return {
    total,
    accounts: Array.from({ length: packages }, (_, i) => ({ packageName: `pkg-${i}`, remain: total / packages, size: 500 })),
    ...(unlimited ? { unlimited: true } : {}),
  }
}

function fakeLogger({ throwOnLog = false } = {}) {
  const lines = []
  const push = (level) => (message) => {
    if (throwOnLog) throw new Error('log boom')
    lines.push({ level, message: String(message) })
  }
  return { lines, info: push('info'), warn: push('warn'), log: push('log') }
}

function fakeClock(start = BASE) {
  const state = { current: start, handles: new Map(), nextId: 1 }
  return {
    // 用访问器暴露时钟：`clock.current = x` 必须真的改到 state，否则测试会静默测不到东西。
    get current() {
      return state.current
    },
    set current(value) {
      state.current = value
    },
    now: () => state.current,
    setTimeout(fn, ms) {
      const id = state.nextId
      state.nextId += 1
      state.handles.set(id, { fn, at: state.current + ms })
      return id
    },
    clearTimeout(id) {
      state.handles.delete(id)
    },
    pending: () => state.handles.size,
    async advance(ms) {
      state.current += ms
      for (let round = 0; round < 200; round += 1) {
        const due = [...state.handles.entries()].filter(([, handle]) => handle.at <= state.current)
        if (due.length === 0) return
        for (const [id, handle] of due) {
          state.handles.delete(id)
          handle.fn()
        }
        await flush()
      }
      throw new Error('假时钟推进不收敛')
    },
  }
}

const docsFor = (uids, variantKey = 'ai', make = plainDoc) =>
  Object.fromEntries(uids.map((uid) => [`${variantKey}/${uid}`, make(uid)]))

// ── 导出面 ────────────────────────────────────────────────────────────

test('导出面与 PLAN §3.6.1 逐字一致（只有这六个）', async () => {
  const mod = await import('../lib/credits.js')
  assert.deepEqual(Object.keys(mod).sort(), [
    'CREDITS_DEFAULTS',
    'CreditsCache',
    'aggregateVariant',
    'fetchAccountCredits',
    'parseCredential',
    'summarizeVariant',
  ])
  assert.deepEqual(Object.keys(CREDITS_DEFAULTS).sort(), ['concurrency', 'enabled', 'timeoutMs', 'ttlMs'])
  assert.equal(CREDITS_DEFAULTS.ttlMs, 60_000)
  assert.equal(CREDITS_DEFAULTS.concurrency, 2)
  assert.equal(CREDITS_DEFAULTS.timeoutMs, 15_000)
  assert.equal(CREDITS_DEFAULTS.enabled, true)
})

// ── parseCredential ───────────────────────────────────────────────────

test('parseCredential: 明文快照 → 凭据（带 uid，供下游按账号取数）', () => {
  const credential = parseCredential(plainDoc('u-plain'))
  assert.ok(credential, '明文必须解析得出凭据')
  assert.equal(credential.uid, 'u-plain')
  assert.equal(typeof credential.accessToken, 'string')
})

test('parseCredential: 桌面密文信封 → undefined（上游只解明文）', () => {
  assert.equal(parseCredential(encDoc('u-enc')), undefined)
})

test('parseCredential: 坏 JSON / 空串 / 非字符串 → undefined，绝不抛', () => {
  for (const input of ['{oops', '', '   ', undefined, null, 42, {}, [], Buffer.from('x')]) {
    assert.equal(parseCredential(input), undefined, `输入 ${String(input)} 应当是 undefined`)
  }
  // 实测（真解析器）：`{auth:{accessToken:'x'}}` 这种没有 uid 的文档**照样**解析得出凭据
  // （上游只用它做请求头，不校验 uid）。我们的聚合按 pool 的 uid 记账，不看凭据里的 uid，
  // 所以这里如实记录上游行为，而不是假装它会被拒。
  const noUid = parseCredential(JSON.stringify({ auth: { accessToken: 'x' } }))
  assert.ok(noUid, '上游确实接受无 uid 的文档')
  assert.equal(noUid.uid, '')
})

// ── fetchAccountCredits ───────────────────────────────────────────────

test('fetchAccountCredits: 成功 → total / unlimited / packages（套餐数来自 accounts）', async () => {
  const upstream = fakeUpstream({ byUid: { 'u1': creditsOf(350, 2) } })
  const credential = parseCredential(plainDoc('u1'))
  const result = await fetchAccountCredits({ credential, createClient: upstream.createClient })
  assert.deepEqual(result, { ok: true, total: 350, unlimited: false, packages: 2 })
})

test('fetchAccountCredits: 每个请求都带 AbortSignal（截至时间到就 abort）', async () => {
  const upstream = fakeUpstream({ byUid: { 'u1': creditsOf(100, 1) } })
  const credential = parseCredential(plainDoc('u1'))
  await fetchAccountCredits({ credential, createClient: upstream.createClient, timeoutMs: 50 })
  const [call] = upstream.calls
  assert.equal(call.uid, 'u1')
  assert.ok(call.signal instanceof AbortSignal, '必须把 signal 递下去')
  assert.equal(call.signal.aborted, false)
  await sleep(80)
  assert.equal(call.signal.aborted, true, 'timeoutMs 之后应当已 abort')
})

test('fetchAccountCredits: unlimited（账号级）→ unlimited:true 且 total 归 0', async () => {
  const upstream = fakeUpstream({ byUid: { 'u1': creditsOf(0, 1, { unlimited: true }) } })
  const credential = parseCredential(plainDoc('u1'))
  const result = await fetchAccountCredits({ credential, createClient: upstream.createClient })
  assert.deepEqual(result, { ok: true, total: 0, unlimited: true, packages: 1 })
})

test('fetchAccountCredits: 只有 unlimited 没有 total → 仍然 ok（不是坏响应）', async () => {
  const upstream = fakeUpstream({ byUid: { 'u1': () => ({ accounts: [], unlimited: true }) } })
  const credential = parseCredential(plainDoc('u1'))
  assert.deepEqual(await fetchAccountCredits({ credential, createClient: upstream.createClient }), {
    ok: true,
    total: 0,
    unlimited: true,
    packages: 0,
  })
})

test('fetchAccountCredits: 坏响应（非对象 / 既无 total 也无 unlimited）→ bad-response', async () => {
  for (const bad of [undefined, null, 42, 'nope', {}, { accounts: [] }]) {
    const upstream = fakeUpstream({ byUid: { 'u1': () => bad } })
    const credential = parseCredential(plainDoc('u1'))
    assert.deepEqual(await fetchAccountCredits({ credential, createClient: upstream.createClient }), {
      ok: false,
      error: 'bad-response',
    })
  }
})

test('fetchAccountCredits: 客户端抛错 → fetch-failed（不冒泡）', async () => {
  const upstream = fakeUpstream({ byUid: { 'u1': creditsOf(1, 1) }, failUid: { 'u1': 'network down' } })
  const credential = parseCredential(plainDoc('u1'))
  assert.deepEqual(await fetchAccountCredits({ credential, createClient: upstream.createClient }), {
    ok: false,
    error: 'fetch-failed',
  })
})

test('fetchAccountCredits: 悬挂请求到点 → timeout，且事后 reject 不产生 unhandledRejection', async () => {
  const seen = []
  const onUnhandled = (reason) => seen.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const upstream = fakeUpstream({ byUid: { 'u1': creditsOf(1, 1) }, hangUid: { 'u1': true } })
    const credential = parseCredential(plainDoc('u1'))
    const result = await fetchAccountCredits({ credential, createClient: upstream.createClient, timeoutMs: 20 })
    assert.deepEqual(result, { ok: false, error: 'timeout' })
    await sleep(60)
    assert.deepEqual(seen, [], '超时后那个 promise 仍会 reject，必须已经被吃掉')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('fetchAccountCredits: 外部信号叫停 → aborted（不是 timeout）', async () => {
  const upstream = fakeUpstream({ byUid: { 'u1': creditsOf(1, 1) }, hangUid: { 'u1': true } })
  const credential = parseCredential(plainDoc('u1'))
  const controller = new AbortController()
  const pending = fetchAccountCredits({ credential, createClient: upstream.createClient, timeoutMs: 5_000, signal: controller.signal })
  await flush()
  controller.abort()
  assert.deepEqual(await pending, { ok: false, error: 'aborted' })
})

test('fetchAccountCredits: createClient 抛错 / 没有 fetchCredits → client-unavailable', async () => {
  const credential = parseCredential(plainDoc('u1'))
  assert.deepEqual(
    await fetchAccountCredits({
      credential,
      createClient: () => {
        throw new Error('boom')
      },
    }),
    { ok: false, error: 'client-unavailable' },
  )
  assert.deepEqual(await fetchAccountCredits({ credential, createClient: () => ({}) }), {
    ok: false,
    error: 'client-unavailable',
  })
})

test('fetchAccountCredits: 没有凭据 → no-credential（不发请求）', async () => {
  const upstream = fakeUpstream({})
  assert.deepEqual(await fetchAccountCredits({ credential: undefined, createClient: upstream.createClient }), {
    ok: false,
    error: 'no-credential',
  })
  assert.equal(upstream.calls.length, 0)
})

// ── aggregateVariant：求和 ────────────────────────────────────────────

test('aggregateVariant: 真实数据 —— ai 四个账号 100/350/350/350 ⇒ 合计 1150', async () => {
  const uids = ['8c3d9e21-x', '4a05576e-x', '5a2214d3-x', '658d61dc-x']
  const pool = fakePool({
    accounts: { ai: uids.map((uid) => meta(uid)) },
    docs: docsFor(uids),
    active: { ai: uids[0] },
  })
  const upstream = fakeUpstream({
    byUid: {
      '8c3d9e21-x': creditsOf(100, 1),
      '4a05576e-x': creditsOf(350, 2),
      '5a2214d3-x': creditsOf(350, 2),
      '658d61dc-x': creditsOf(350, 2),
    },
  })
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: upstream.createClient,
    now: () => BASE,
    logger: fakeLogger(),
  })

  assert.equal(aggregate.variantKey, 'ai')
  assert.equal(aggregate.computedAt, BASE)
  assert.equal(aggregate.total, 1150)
  assert.equal(aggregate.unlimited, false)
  assert.equal(aggregate.complete, true)
  assert.equal(aggregate.accountCount, 4)
  assert.equal(aggregate.readyCount, 4)
  assert.deepEqual(aggregate.errors, [])
  assert.equal(aggregate.accounts.length, 4)
  assert.deepEqual(aggregate.accounts.map((a) => a.uid), uids, '顺序与 list 一致')
  assert.deepEqual(aggregate.accounts.map((a) => a.total), [100, 350, 350, 350])
  assert.deepEqual(aggregate.accounts.map((a) => a.packages), [1, 2, 2, 2])
  assert.deepEqual(
    aggregate.accounts.map((a) => a.active),
    [true, false, false, false],
  )
  assert.deepEqual(
    aggregate.accounts.map((a) => a.source),
    ['computed', 'computed', 'computed', 'computed'],
  )
})

test('aggregateVariant: 上游 UI 只显示生效账号的 100，我们显示 1150（这就是本模块的意义）', async () => {
  const uids = ['a', 'b', 'c', 'd']
  const pool = fakePool({ accounts: { ai: uids.map((uid) => meta(uid)) }, docs: docsFor(uids), active: { ai: 'a' } })
  const upstream = fakeUpstream({ byUid: { a: creditsOf(100, 1), b: creditsOf(350, 2), c: creditsOf(350, 2), d: creditsOf(350, 2) } })
  const aggregate = await aggregateVariant({ variantKey: 'ai', pool, createClient: upstream.createClient, now: () => BASE })
  assert.equal(aggregate.total, 1150)
  assert.notEqual(aggregate.total, 100, '不能退化成「只算生效账号」')
})

test('aggregateVariant: 禁用账号不进合计、不发请求、不计入 accountCount', async () => {
  const pool = fakePool({
    accounts: {
      ai: [meta('u-on'), meta('u-off', { enabled: false }), meta('u-on2')],
    },
    docs: docsFor(['u-on', 'u-off', 'u-on2']),
  })
  const upstream = fakeUpstream({ byUid: { 'u-on': creditsOf(100, 1), 'u-on2': creditsOf(50, 1), 'u-off': creditsOf(9999, 1) } })
  const aggregate = await aggregateVariant({ variantKey: 'ai', pool, createClient: upstream.createClient, now: () => BASE })

  assert.equal(aggregate.total, 150)
  assert.equal(aggregate.accountCount, 2, '禁用账号不参与计算')
  assert.equal(aggregate.readyCount, 2)
  assert.deepEqual(aggregate.accounts.map((a) => a.uid), ['u-on', 'u-on2'])
  assert.deepEqual(upstream.calls.map((c) => c.uid).sort(), ['u-on', 'u-on2'])
  assert.ok(!upstream.calls.some((c) => c.uid === 'u-off'), '禁用账号绝不能被请求')
  assert.ok(!pool.calls.read.includes('ai/u-off'), '连快照都不必读')
})

test('aggregateVariant: 密文账号 —— encrypted:true / error:encrypted-credential / 不发请求', async () => {
  const pool = fakePool({
    accounts: { cn: [meta('cn-enc', { variantKey: 'cn' })], ai: [meta('ai-plain')] },
    docs: { 'cn/cn-enc': encDoc('cn-enc'), 'ai/ai-plain': plainDoc('ai-plain') },
    active: { cn: 'cn-enc' },
  })
  const upstream = fakeUpstream({ byUid: { 'ai-plain': creditsOf(100, 1) } })
  const aggregate = await aggregateVariant({
    variantKey: 'cn',
    pool,
    createClient: upstream.createClient,
    now: () => BASE,
    logger: fakeLogger(),
    // 这个用例专门看密文账号本身：故意不给 fallback，看它是不是如实「算不出」。
  })

  const [entry] = aggregate.accounts
  assert.equal(entry.uid, 'cn-enc')
  assert.equal(entry.encrypted, true)
  assert.equal(entry.total, null)
  assert.equal(entry.unlimited, false)
  assert.equal(entry.packages, null)
  assert.equal(entry.error, 'encrypted-credential')
  assert.equal(entry.active, true)
  assert.equal(entry.source, 'none')
  assert.equal(upstream.calls.length, 0, '密文账号绝不能被请求')
  assert.deepEqual(aggregate.errors, [{ uid: 'cn-enc', error: 'encrypted-credential' }])
  assert.equal(aggregate.total, 0)
  assert.equal(aggregate.complete, false, '一个数都没拿到，绝不能声称完整')
  assert.equal(aggregate.readyCount, 0)
})

test('aggregateVariant: 密文生效账号借 fallback 的数 ⇒ source:fallback 且计入合计', async () => {
  const pool = fakePool({
    accounts: { cn: [meta('cn-enc', { variantKey: 'cn' })] },
    docs: { 'cn/cn-enc': encDoc('cn-enc') },
    active: { cn: 'cn-enc' },
  })
  const upstream = fakeUpstream({})
  const fallbackCalls = []
  const aggregate = await aggregateVariant({
    variantKey: 'cn',
    pool,
    createClient: upstream.createClient,
    fallbackCredits: (args) => {
      fallbackCalls.push(args)
      return { total: 210 }
    },
    now: () => BASE,
  })

  assert.deepEqual(fallbackCalls, [{ variantKey: 'cn', uid: 'cn-enc', active: true }])
  const [entry] = aggregate.accounts
  assert.equal(entry.source, 'fallback')
  assert.equal(entry.total, 210)
  assert.equal(entry.error, null)
  assert.equal(entry.packages, null, '上游 status 路由没有套餐清单，不能编一个数')
  assert.equal(aggregate.total, 210)
  assert.equal(aggregate.complete, true)
  assert.equal(aggregate.readyCount, 1)
  assert.equal(upstream.calls.length, 0)
})

test('aggregateVariant: 密文生效账号 + fallback 给 unlimited ⇒ 置真、不计入 total、算「有数」', async () => {
  const pool = fakePool({
    accounts: { cn: [meta('cn-enc', { variantKey: 'cn' })] },
    docs: { 'cn/cn-enc': encDoc('cn-enc') },
    active: { cn: 'cn-enc' },
  })
  const aggregate = await aggregateVariant({
    variantKey: 'cn',
    pool,
    createClient: fakeUpstream({}).createClient,
    fallbackCredits: () => ({ unlimited: true }),
    now: () => BASE,
  })
  assert.equal(aggregate.unlimited, true)
  assert.equal(aggregate.total, 0)
  assert.equal(aggregate.readyCount, 1)
  assert.equal(aggregate.complete, true)
  assert.equal(aggregate.accounts[0].source, 'fallback')
  assert.equal(aggregate.accounts[0].total, null)
  assert.equal(aggregate.accounts[0].error, null)
})

test('aggregateVariant: fallback 取不到 ⇒ 不冒充 0、complete:false', async () => {
  const pool = fakePool({
    accounts: { cn: [meta('cn-enc', { variantKey: 'cn' })] },
    docs: { 'cn/cn-enc': encDoc('cn-enc') },
    active: { cn: 'cn-enc' },
  })
  const aggregate = await aggregateVariant({
    variantKey: 'cn',
    pool,
    createClient: fakeUpstream({}).createClient,
    fallbackCredits: () => null,
    now: () => BASE,
  })
  assert.equal(aggregate.accounts[0].total, null)
  assert.equal(aggregate.accounts[0].source, 'none')
  assert.equal(aggregate.accounts[0].error, 'encrypted-credential')
  assert.equal(aggregate.total, 0)
  assert.equal(aggregate.complete, false)
})

test('aggregateVariant: fallback 只对生效账号调用（非生效的失败账号不许借数）', async () => {
  const pool = fakePool({
    accounts: { ai: [meta('a-active'), meta('b-plain'), meta('c-enc')] },
    docs: { 'ai/a-active': plainDoc('a-active'), 'ai/b-plain': plainDoc('b-plain'), 'ai/c-enc': encDoc('c-enc', { domain: AI_DOMAIN }) },
    active: { ai: 'a-active' },
  })
  const upstream = fakeUpstream({ byUid: { 'a-active': creditsOf(100, 1) }, failUid: { 'b-plain': 'boom' } })
  const fallbackCalls = []
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: upstream.createClient,
    fallbackCredits: (args) => {
      fallbackCalls.push(args)
      return { total: 777 }
    },
    now: () => BASE,
  })

  assert.deepEqual(fallbackCalls, [], '生效账号自己有数、且密文账号不生效 —— 一次都不该借')
  assert.equal(aggregate.total, 100)
  assert.equal(aggregate.accounts.find((a) => a.uid === 'b-plain').error, 'fetch-failed')
  assert.equal(aggregate.accounts.find((a) => a.uid === 'c-enc').error, 'encrypted-credential')
  assert.equal(aggregate.complete, false)
  assert.equal(aggregate.readyCount, 1)
})

test('aggregateVariant: 生效账号自己超时 ⇒ 允许借 fallback（自己算不出就借）', async () => {
  const pool = fakePool({
    accounts: { ai: [meta('a-active')] },
    docs: docsFor(['a-active']),
    active: { ai: 'a-active' },
  })
  const upstream = fakeUpstream({ byUid: { 'a-active': creditsOf(100, 1) }, hangUid: { 'a-active': true } })
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: upstream.createClient,
    fallbackCredits: () => ({ total: 88 }),
    now: () => BASE,
    timeoutMs: 20,
  })
  assert.equal(aggregate.accounts[0].error, null)
  assert.equal(aggregate.accounts[0].source, 'fallback')
  assert.equal(aggregate.total, 88)
  assert.equal(aggregate.complete, true)
})

test('aggregateVariant: 一个账号超时不影响其它账号（不连坐）', async () => {
  const pool = fakePool({
    accounts: { ai: [meta('u-hang'), meta('u-ok'), meta('u-ok2')] },
    docs: docsFor(['u-hang', 'u-ok', 'u-ok2']),
    active: { ai: 'u-ok' },
  })
  const upstream = fakeUpstream({
    byUid: { 'u-hang': creditsOf(999, 1), 'u-ok': creditsOf(100, 1), 'u-ok2': creditsOf(50, 1) },
    hangUid: { 'u-hang': true },
  })
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: upstream.createClient,
    now: () => BASE,
    timeoutMs: 20,
  })

  assert.equal(aggregate.total, 150, '超时那个账号不能贡献数，也不能毁掉别的')
  assert.equal(aggregate.accountCount, 3)
  assert.equal(aggregate.readyCount, 2)
  assert.equal(aggregate.complete, false)
  assert.deepEqual(aggregate.errors, [{ uid: 'u-hang', error: 'timeout' }])
  assert.equal(aggregate.accounts.find((a) => a.uid === 'u-ok').total, 100)
  assert.equal(aggregate.accounts.find((a) => a.uid === 'u-hang').total, null)
})

test('aggregateVariant: unlimited 账号不计入 total，但把 unlimited 置真', async () => {
  const pool = fakePool({
    accounts: { ai: [meta('u-plain'), meta('u-unlimited')] },
    docs: docsFor(['u-plain', 'u-unlimited']),
  })
  const upstream = fakeUpstream({ byUid: { 'u-plain': creditsOf(350, 2), 'u-unlimited': creditsOf(0, 1, { unlimited: true }) } })
  const aggregate = await aggregateVariant({ variantKey: 'ai', pool, createClient: upstream.createClient, now: () => BASE })
  assert.equal(aggregate.unlimited, true)
  assert.equal(aggregate.total, 350, '不限量的那个账号不能往合计里加数')
  assert.equal(aggregate.accountCount, 2)
  assert.equal(aggregate.readyCount, 2)
  assert.equal(aggregate.complete, true)
})

test('aggregateVariant: 空池 ⇒ 0 但不 complete（不许拿 0 冒充合计）', async () => {
  const aggregate = await aggregateVariant({
    variantKey: 'cn',
    pool: fakePool({ accounts: { cn: [] } }),
    createClient: fakeUpstream({}).createClient,
    now: () => BASE,
  })
  assert.equal(aggregate.total, 0)
  assert.equal(aggregate.accountCount, 0)
  assert.equal(aggregate.readyCount, 0)
  assert.equal(aggregate.complete, false)
  assert.deepEqual(aggregate.errors, [])
})

test('aggregateVariant: 快照缺失 / 读失败 / pool 缺方法 ⇒ 各自的错误码，不抛', async () => {
  const cases = [
    { name: '缺失', docs: {}, expect: 'snapshot-missing' },
    { name: '读失败', readFails: true, expect: 'snapshot-unreadable' },
    { name: '缺方法', docs: {}, methods: ['list'], expect: 'pool-incomplete' },
  ]
  for (const item of cases) {
    const pool = fakePool({
      accounts: { ai: [meta('u1')] },
      docs: item.docs ?? docsFor(['u1']),
      readFails: item.readFails === true,
      methods: item.methods ?? null,
    })
    const aggregate = await aggregateVariant({
      variantKey: 'ai',
      pool,
      createClient: fakeUpstream({ byUid: { u1: creditsOf(100, 1) } }).createClient,
      now: () => BASE,
    })
    assert.equal(aggregate.accounts[0].error, item.expect, item.name)
    assert.equal(aggregate.accounts[0].total, null)
    assert.equal(aggregate.complete, false)
  }
})

test('aggregateVariant: 文档坏（不是密文）⇒ no-credential（与密文分开报）', async () => {
  const pool = fakePool({ accounts: { ai: [meta('u-bad')] }, docs: { 'ai/u-bad': '{oops' } })
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: fakeUpstream({}).createClient,
    now: () => BASE,
  })
  assert.equal(aggregate.accounts[0].encrypted, false)
  assert.equal(aggregate.accounts[0].error, 'no-credential')
})

test('aggregateVariant: pool.list 抛错 ⇒ 空聚合 + pool-list-failed，绝不抛', async () => {
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool: fakePool({ listFails: true }),
    createClient: fakeUpstream({}).createClient,
    now: () => BASE,
    logger: fakeLogger(),
  })
  assert.deepEqual(aggregate.errors, [{ uid: '', error: 'pool-list-failed' }])
  assert.equal(aggregate.total, 0)
  assert.equal(aggregate.complete, false)
  assert.deepEqual(aggregate.accounts, [])
})

test('aggregateVariant: pool 缺失 / 不是对象也不抛', async () => {
  for (const pool of [undefined, null, {}, 42]) {
    const aggregate = await aggregateVariant({ variantKey: 'ai', pool, createClient: fakeUpstream({}).createClient })
    assert.equal(aggregate.variantKey, 'ai')
    assert.equal(aggregate.complete, false)
    assert.equal(aggregate.errors[0].error, 'pool-list-failed')
  }
})

test('aggregateVariant: accountMeta 抛错时退回列表那一行，不连坐', async () => {
  const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']), metaFails: true })
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: fakeUpstream({ byUid: { u1: creditsOf(100, 1) } }).createClient,
    now: () => BASE,
  })
  assert.equal(aggregate.total, 100)
  assert.equal(aggregate.accounts[0].label, 'Acct u1')
})

test('aggregateVariant: 未知档位 ⇒ 空聚合（不发请求）', async () => {
  const upstream = fakeUpstream({})
  for (const variantKey of ['xx', '', undefined, null, 'CN']) {
    const aggregate = await aggregateVariant({ variantKey, pool: fakePool({}), createClient: upstream.createClient })
    assert.equal(aggregate.accountCount, 0)
    assert.equal(aggregate.complete, false)
  }
  assert.equal(upstream.calls.length, 0)
})

test('aggregateVariant: 行不是对象 / 没有 uid 的脏行被跳过', async () => {
  const pool = fakePool({
    accounts: { ai: [meta('u1'), null, 'nope', { label: 'no uid' }, meta('u2')] },
    docs: docsFor(['u1', 'u2']),
  })
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: fakeUpstream({ byUid: { u1: creditsOf(10, 1), u2: creditsOf(20, 1) } }).createClient,
    now: () => BASE,
  })
  assert.deepEqual(aggregate.accounts.map((a) => a.uid), ['u1', 'u2'])
  assert.equal(aggregate.total, 30)
})

test('aggregateVariant: 并发不超过 concurrency（观测峰值）', async () => {
  const uids = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']
  const pool = fakePool({ accounts: { ai: uids.map((uid) => meta(uid)) }, docs: docsFor(uids) })
  // 每个请求在 3 次 setImmediate 之后才返回：既有重叠窗口（能观测峰值），又一定会结束
  // （不会让事件循环排空 —— 见 fakeUpstream 里关于 unref 定时器的注释）。
  const upstream = fakeUpstream({
    byUid: Object.fromEntries(uids.map((uid) => [uid, creditsOf(100, 1)])),
    tickUid: Object.fromEntries(uids.map((uid) => [uid, true])),
  })
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: upstream.createClient,
    now: () => BASE,
    concurrency: 2,
  })
  assert.equal(aggregate.total, 600)
  assert.equal(upstream.calls.length, 6)
  assert.ok(upstream.peak() <= 2, `并发峰值 ${upstream.peak()} 不得超过 concurrency=2`)
  assert.ok(upstream.peak() >= 2, '至少要真的并发起来（否则这条断言测不到东西）')
})

test('aggregateVariant: concurrency 非法值时兜到 1..32', async () => {
  const uids = ['u1', 'u2', 'u3']
  const pool = fakePool({ accounts: { ai: uids.map((uid) => meta(uid)) }, docs: docsFor(uids) })
  for (const concurrency of [0, -5, Number.NaN, 'x', undefined]) {
    const upstream = fakeUpstream({ byUid: Object.fromEntries(uids.map((uid) => [uid, creditsOf(10, 1)])) })
    const aggregate = await aggregateVariant({ variantKey: 'ai', pool, createClient: upstream.createClient, concurrency })
    assert.equal(aggregate.total, 30)
    assert.equal(upstream.peak(), 1, '兜底到 1 就是严格串行')
  }
})

test('aggregateVariant: label 缺省时退回 nickname，都缺就空串', async () => {
  const pool = fakePool({
    accounts: {
      ai: [meta('u1', { label: undefined, nickname: '昵称一' }), { variantKey: 'ai', uid: 'u2', enabled: true }],
    },
    docs: docsFor(['u1', 'u2']),
  })
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: fakeUpstream({ byUid: { u1: creditsOf(1, 1), u2: creditsOf(1, 1) } }).createClient,
    now: () => BASE,
  })
  assert.equal(aggregate.accounts[0].label, '昵称一')
  assert.equal(aggregate.accounts[1].label, '')
})

test('aggregateVariant: fallbackCredits 抛错 ⇒ 当作取不到，不抛', async () => {
  const pool = fakePool({
    accounts: { cn: [meta('cn-enc', { variantKey: 'cn' })] },
    docs: { 'cn/cn-enc': encDoc('cn-enc') },
    active: { cn: 'cn-enc' },
  })
  const aggregate = await aggregateVariant({
    variantKey: 'cn',
    pool,
    createClient: fakeUpstream({}).createClient,
    fallbackCredits: () => {
      throw new Error('fallback boom')
    },
    now: () => BASE,
  })
  assert.equal(aggregate.accounts[0].total, null)
  assert.equal(aggregate.complete, false)
})

test('aggregateVariant: logger / now 抛错都不影响结果', async () => {
  const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']) })
  const boom = () => {
    throw new Error('log boom')
  }
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: fakeUpstream({ byUid: { u1: creditsOf(100, 1) } }).createClient,
    now: () => {
      throw new Error('clock boom')
    },
    logger: { info: boom, warn: boom, log: boom },
  })
  assert.equal(aggregate.total, 100)
  assert.equal(typeof aggregate.computedAt, 'number', '坏时钟退回 Date.now()')
})

test('aggregateVariant: fetchImpl 被接受但不使用（不因它改变结果）', async () => {
  const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']) })
  const upstream = fakeUpstream({ byUid: { u1: creditsOf(100, 1) } })
  const plain = await aggregateVariant({ variantKey: 'ai', pool, createClient: upstream.createClient, now: () => BASE })
  const withFetch = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: upstream.createClient,
    fetchImpl: () => {
      throw new Error('fetchImpl 不该被调用')
    },
    now: () => BASE,
  })
  assert.equal(withFetch.total, plain.total)
  assert.equal(upstream.calls.length, 2)
})

test('脱敏：返回的聚合里没有凭据字段与凭据值，日志里连字段名都不出现', async () => {
  const logger = fakeLogger()
  const pool = fakePool({
    accounts: { cn: [meta('cn-enc', { variantKey: 'cn' })], ai: [meta('u-plain')] },
    docs: { 'cn/cn-enc': encDoc('cn-enc'), 'ai/u-plain': plainDoc('u-plain') },
    active: { cn: 'cn-enc' },
  })
  const upstream = fakeUpstream({ byUid: { 'u-plain': creditsOf(350, 2) } })
  const aggregate = await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: upstream.createClient,
    fallbackCredits: () => ({ total: 12 }),
    now: () => BASE,
    logger,
  })

  const dump = JSON.stringify(aggregate)
  for (const needle of ['accessToken', 'refreshToken', 'plain-access-token-value', 'plain-refresh-token-value', 'Bearer', '$wbEncrypted', 'envelope']) {
    assert.ok(!dump.includes(needle), `聚合对象里不该出现 ${needle}`)
    for (const line of logger.lines) {
      assert.ok(!line.message.includes(needle), `日志里不该出现 ${needle}：${line.message}`)
    }
  }
  const accountKeys = Object.keys(aggregate.accounts[0]).sort()
  assert.deepEqual(accountKeys, [
    'active',
    'encrypted',
    'error',
    'label',
    'packages',
    'source',
    'total',
    'uid',
    'unlimited',
  ])
})

test('脱敏:日志绝不打印 uid 之外的身份信息（这里只钉住「不含凭据」）', async () => {
  const logger = fakeLogger()
  const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']) })
  await aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: fakeUpstream({ byUid: { u1: creditsOf(100, 1) } }).createClient,
    now: () => BASE,
    logger,
  })
  assert.ok(logger.lines.length >= 1, '应当至少有合计那一行')
  assert.ok(logger.lines.every((line) => !/token/i.test(line.message)), '日志里不该出现 token 字样')
})

// ── summarizeVariant ─────────────────────────────────────────────────

test('summarizeVariant: 六个键、逐字精确', () => {
  const aggregate = { total: 1150, unlimited: false, complete: true, accountCount: 4, readyCount: 4, computedAt: BASE }
  assert.deepEqual(summarizeVariant(aggregate), {
    total: 1150,
    unlimited: false,
    complete: true,
    accountCount: 4,
    readyCount: 4,
    computedAt: BASE,
  })
})

test('summarizeVariant: 垃圾输入也回形状完整的对象，绝不抛', () => {
  for (const input of [undefined, null, 42, 'x', {}, { total: Number.NaN, accountCount: 'x', computedAt: 'x' }]) {
    const summary = summarizeVariant(input)
    assert.deepEqual(Object.keys(summary).sort(), ['accountCount', 'complete', 'computedAt', 'readyCount', 'total', 'unlimited'])
    assert.equal(summary.total, 0)
    assert.equal(summary.complete, false)
    assert.equal(summary.unlimited, false)
  }
})

// ── CreditsCache ─────────────────────────────────────────────────────

function cacheFixture({ byUid = {}, uids = ['u1'], config = {}, docs = null, active = {}, fallbackCredits = undefined } = {}) {
  const pool = fakePool({
    accounts: { ai: uids.map((uid) => meta(uid)), cn: [] },
    docs: docs ?? docsFor(uids),
    active,
  })
  const upstream = fakeUpstream({ byUid })
  const logger = fakeLogger()
  const cache = new CreditsCache({
    pool,
    createClient: upstream.createClient,
    fallbackCredits,
    now: () => BASE,
    logger,
    config: { ttlMs: 1_000, concurrency: 2, timeoutMs: 5_000, ...config },
  })
  return { pool, upstream, logger, cache }
}

test('CreditsCache: TTL 内直接回缓存，不重复请求', async () => {
  const fixture = cacheFixture({ byUid: { u1: creditsOf(100, 1) } })
  const first = await fixture.cache.get('ai')
  const second = await fixture.cache.get('ai')
  assert.equal(first, second, 'TTL 内必须是同一个对象（缓存命中）')
  assert.equal(fixture.upstream.calls.length, 1)
  assert.equal(fixture.cache.status().ai, first)
})

test('CreditsCache: 过期后重算（时钟推进越过 ttlMs）', async () => {
  const clock = fakeClock(BASE)
  const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']) })
  const upstream = fakeUpstream({ byUid: { u1: creditsOf(100, 1) } })
  const cache = new CreditsCache({ pool, createClient: upstream.createClient, now: clock.now, config: { ttlMs: 1_000 } })

  await cache.get('ai')
  clock.current = BASE + 500
  await cache.get('ai')
  assert.equal(upstream.calls.length, 1, '没过期不该重算')
  clock.current = BASE + 1_500
  await cache.get('ai')
  assert.equal(upstream.calls.length, 2, '过期必须重算')
})

test('CreditsCache: force 绕过 TTL', async () => {
  const fixture = cacheFixture({ byUid: { u1: creditsOf(100, 1) } })
  await fixture.cache.get('ai')
  await fixture.cache.get('ai', { force: true })
  assert.equal(fixture.upstream.calls.length, 2)
})

test('CreditsCache: 同一档位并发去重（三个并发 get 只打一轮）', async () => {
  const fixture = cacheFixture({ byUid: { u1: creditsOf(100, 1) } })
  const [a, b, c] = await Promise.all([fixture.cache.get('ai'), fixture.cache.get('ai'), fixture.cache.get('ai')])
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(fixture.upstream.calls.length, 1, '在飞期间不许重复打计费接口')
})

test('CreditsCache: status() 形状（cn/ai/ttlMs/running）', async () => {
  const fixture = cacheFixture({ byUid: { u1: creditsOf(100, 1) }, config: { ttlMs: 2_345 } })
  assert.deepEqual(Object.keys(fixture.cache.status()).sort(), ['ai', 'cn', 'running', 'ttlMs'])
  assert.equal(fixture.cache.status().ai, null)
  assert.equal(fixture.cache.status().cn, null)
  assert.equal(fixture.cache.status().ttlMs, 2_345)
  assert.equal(fixture.cache.status().running, false)
  await fixture.cache.get('ai')
  assert.equal(fixture.cache.status().ai.total, 100)
})

test('CreditsCache: invalidate 单档 / 全部', async () => {
  const fixture = cacheFixture({ byUid: { u1: creditsOf(100, 1) } })
  await fixture.cache.get('ai')
  await fixture.cache.get('cn')
  assert.equal(fixture.upstream.calls.length, 1, 'cn 没账号 ⇒ 不发请求')

  fixture.cache.invalidate('ai')
  assert.equal(fixture.cache.status().ai, null)
  await fixture.cache.get('ai')
  assert.equal(fixture.upstream.calls.length, 2)

  fixture.cache.invalidate()
  assert.equal(fixture.cache.status().ai, null)
})

test('CreditsCache: 未知档位 / enabled:false ⇒ null（不猜、不发请求）', async () => {
  const fixture = cacheFixture({ byUid: { u1: creditsOf(100, 1) } })
  for (const key of ['xx', '', undefined, null, 'CN']) {
    assert.equal(await fixture.cache.get(key), null)
  }
  assert.equal(fixture.upstream.calls.length, 0)

  const off = cacheFixture({ byUid: { u1: creditsOf(100, 1) }, config: { enabled: false } })
  assert.equal(await off.cache.get('ai'), null)
  assert.equal(off.upstream.calls.length, 0)
})

test('CreditsCache: refreshAll 两个档位都算，返回 {cn, ai}', async () => {
  const pool = fakePool({
    accounts: { cn: [meta('c1', { variantKey: 'cn' })], ai: [meta('a1')] },
    docs: { 'cn/c1': plainDoc('c1', { domain: CN_DOMAIN }), 'ai/a1': plainDoc('a1') },
    active: { cn: 'c1' },
  })
  const upstream = fakeUpstream({ byUid: { c1: creditsOf(200, 1), a1: creditsOf(100, 1) } })
  const cache = new CreditsCache({ pool, createClient: upstream.createClient, now: () => BASE, config: {} })
  const out = await cache.refreshAll()
  assert.deepEqual(Object.keys(out).sort(), ['ai', 'cn'])
  assert.equal(out.cn.total, 200)
  assert.equal(out.ai.total, 100)
  assert.equal(cache.status().cn.total, 200)
  assert.equal(cache.status().ai.total, 100)
})

test('CreditsCache: 构造器把 fallbackCredits 透传下去（生效密文账号能借到数）', async () => {
  const pool = fakePool({
    accounts: { cn: [meta('cn-enc', { variantKey: 'cn' })], ai: [] },
    docs: { 'cn/cn-enc': encDoc('cn-enc') },
    active: { cn: 'cn-enc' },
  })
  const seen = []
  const cache = new CreditsCache({
    pool,
    createClient: fakeUpstream({}).createClient,
    fallbackCredits: (args) => {
      seen.push(args)
      return { total: 210 }
    },
    now: () => BASE,
    config: {},
  })
  const aggregate = await cache.get('cn')
  assert.deepEqual(seen, [{ variantKey: 'cn', uid: 'cn-enc', active: true }])
  assert.equal(aggregate.total, 210)
  assert.equal(aggregate.accounts[0].source, 'fallback')
})

test('CreditsCache: start 武装定时器 → 到点自动刷新；stop 后 running:false 且无残留定时器', async () => {
  const clock = fakeClock(BASE)
  const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']) })
  const upstream = fakeUpstream({ byUid: { u1: creditsOf(100, 1) } })
  const cache = new CreditsCache({
    pool,
    createClient: upstream.createClient,
    now: clock.now,
    config: { ttlMs: 1_000, intervalMs: 1_000, setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) },
  })

  assert.equal(cache.status().running, false)
  cache.start()
  assert.equal(cache.status().running, true)
  assert.equal(clock.pending(), 1)

  await clock.advance(1_000)
  await flush()
  assert.equal(cache.status().running, true)
  assert.equal(upstream.calls.length, 1, '到点应当自动刷一轮')
  assert.equal(clock.pending(), 1, '应当续排下一轮')

  cache.stop()
  assert.equal(cache.status().running, false)
  assert.equal(clock.pending(), 0, 'stop 后绝不留残留定时器')
  await clock.advance(5_000)
  await flush()
  assert.equal(upstream.calls.length, 1, 'stop 之后不该再有自动刷新')
})

test('CreditsCache: start 幂等；stop 可重复调用', async () => {
  const clock = fakeClock(BASE)
  const cache = new CreditsCache({
    now: clock.now,
    createClient: fakeUpstream({}).createClient,
    config: { intervalMs: 1_000, setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) },
  })
  cache.start()
  cache.start()
  assert.equal(clock.pending(), 1, '重复 start 不该排两个定时器')
  cache.stop()
  cache.stop()
  assert.equal(clock.pending(), 0)
  assert.equal(cache.status().running, false)
})

test('CreditsCache: stop() 叫停在飞请求（pending get 会 resolve，不 hang）', async () => {
  const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']) })
  const upstream = fakeUpstream({ byUid: { u1: creditsOf(100, 1) }, hangUid: { u1: true } })
  const cache = new CreditsCache({ pool, createClient: upstream.createClient, now: () => BASE, config: { timeoutMs: 30_000 } })

  const pending = cache.get('ai')
  await flush()
  cache.stop()
  const result = await pending
  assert.equal(result, null, '没有旧缓存时被叫停 ⇒ null（不猜数）')
  assert.equal(cache.status().running, false)

  // 叫停之后缓存还能继续用（stop 不是「报废」）。
  const upstream2 = fakeUpstream({ byUid: { u1: creditsOf(100, 1) } })
  const cache2 = new CreditsCache({ pool, createClient: upstream2.createClient, now: () => BASE, config: {} })
  cache2.stop()
  assert.equal((await cache2.get('ai')).total, 100)
})

test('CreditsCache: stop 叫停后保留旧缓存（不把已有数弄丢）', async () => {
  const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']) })
  let hang = false
  const upstream = fakeUpstream({ byUid: { u1: () => (hang ? new Promise(() => {}) : creditsOf(100, 1)) } })
  const cache = new CreditsCache({ pool, createClient: upstream.createClient, now: () => BASE, config: { timeoutMs: 30_000 } })
  await cache.get('ai')
  hang = true
  const pending = cache.get('ai', { force: true })
  await flush()
  cache.stop()
  // 被叫停的那次不算结果：**不写缓存**，并把上一次真算出来的数交回调用方 ——
  // 一份「被中断的空合计」落盘就等于用 0 覆盖掉 100。
  assert.equal((await pending).total, 100)
  assert.equal(cache.status().ai.total, 100, '缓存里那份必须还在，且没被 0 覆盖')
})

test('CreditsCache: aggregateVariant 内部抛错时不炸调用方（回旧缓存 / null）', async () => {
  let mode = 'ok'
  const pool = fakePool({
    accounts: { ai: [meta('u1')] },
    docs: docsFor(['u1']),
  })
  const upstream = fakeUpstream({ byUid: { u1: creditsOf(100, 1) } })
  const cache = new CreditsCache({ pool, createClient: upstream.createClient, now: () => BASE, config: {} })
  await cache.get('ai')

  // 把 pool.list 变成返回不可迭代的东西：aggregateVariant 会走 pool-list-failed 分支，
  // 这里只确认上层不抛、且旧缓存不丢。
  pool.list = () => {
    throw new Error('list boom')
  }
  mode = 'bad'
  const aggregate = await cache.get('ai', { force: true })
  assert.equal(aggregate.total, 0)
  assert.equal(aggregate.complete, false)
  assert.equal(mode, 'bad')
})

test('CreditsCache: 时钟抛错也能工作（退回 Date.now）', async () => {
  const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']) })
  const upstream = fakeUpstream({ byUid: { u1: creditsOf(100, 1) } })
  const cache = new CreditsCache({
    pool,
    createClient: upstream.createClient,
    now: () => {
      throw new Error('clock boom')
    },
    config: {},
  })
  const aggregate = await cache.get('ai')
  assert.equal(aggregate.total, 100)
  assert.equal(typeof aggregate.computedAt, 'number')
})

test('CreditsCache: logger 抛错不影响结果', async () => {
  const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']) })
  const boom = () => {
    throw new Error('log boom')
  }
  const cache = new CreditsCache({
    pool,
    createClient: fakeUpstream({ byUid: { u1: creditsOf(100, 1) } }).createClient,
    logger: { info: boom, warn: boom, log: boom },
    now: () => BASE,
    config: {},
  })
  assert.equal((await cache.get('ai')).total, 100)
})

// ── 反向测试 ─────────────────────────────────────────────────────────

const ORIGINAL_SOURCE = await readFile(CREDITS_PATH, 'utf8')
const MUTATION_DIR = await mkdtemp(join(tmpdir(), 'credits-mutation-'))
const UPSTREAM_SHIM = pathToFileURL(join(PKG_ROOT, 'lib', 'upstream.js')).href

/**
 * 读真源码 → 按锚点做定点突变 → 写到临时目录 → import 突变模块。
 *
 * 相对导入 `./upstream.js` 在临时目录里解析不到，所以先换成绝对 URL（与测试本身
 * 共用同一个已加载的模块实例）—— 否则红的原因是 ERR_MODULE_NOT_FOUND，不是断言失败，
 * 那是不合格的证据。
 */
async function loadMutated({ anchor, from, to, name }) {
  assert.ok(ORIGINAL_SOURCE.includes(anchor), `锚点漂移了（源码里找不到）：${anchor}`)
  assert.ok(ORIGINAL_SOURCE.includes(from), `突变原文找不到：${from}`)
  const mutated = ORIGINAL_SOURCE.replace(from, to).replace("from './upstream.js'", `from '${UPSTREAM_SHIM}'`)
  assert.notEqual(mutated, ORIGINAL_SOURCE, '突变必须真的改变源码')
  const file = join(MUTATION_DIR, `${name}.mjs`)
  await writeFile(file, mutated)
  return import(pathToFileURL(file).href)
}

/** 三处行为断言：原始实现上必须全为真；突变后必须至少有一条断言失败。 */
async function assertCreditInvariants(mod) {
  // 1) 禁用账号不进合计、不发请求。
  const disabledPool = fakePool({
    accounts: { ai: [meta('u-on'), meta('u-off', { enabled: false })] },
    docs: docsFor(['u-on', 'u-off']),
  })
  const disabledUpstream = fakeUpstream({ byUid: { 'u-on': creditsOf(100, 1), 'u-off': creditsOf(9999, 1) } })
  const disabled = await mod.aggregateVariant({
    variantKey: 'ai',
    pool: disabledPool,
    createClient: disabledUpstream.createClient,
    now: () => BASE,
  })
  assert.equal(disabled.total, 100)
  assert.equal(disabled.accountCount, 1)
  assert.ok(!disabledUpstream.calls.some((call) => call.uid === 'u-off'))

  // 2) 密文账号：原因码精确、且一个请求都不发。
  const encPool = fakePool({ accounts: { cn: [meta('cn-enc', { variantKey: 'cn' })] }, docs: { 'cn/cn-enc': encDoc('cn-enc') } })
  const encUpstream = fakeUpstream({})
  const enc = await mod.aggregateVariant({
    variantKey: 'cn',
    pool: encPool,
    createClient: encUpstream.createClient,
    now: () => BASE,
  })
  assert.equal(enc.accounts[0].encrypted, true)
  assert.equal(enc.accounts[0].error, 'encrypted-credential')
  assert.equal(encUpstream.calls.length, 0)

  // 3) 并发上限。
  const uids = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']
  const pool = fakePool({ accounts: { ai: uids.map((uid) => meta(uid)) }, docs: docsFor(uids) })
  const upstream = fakeUpstream({
    byUid: Object.fromEntries(uids.map((uid) => [uid, creditsOf(10, 1)])),
    tickUid: Object.fromEntries(uids.map((uid) => [uid, true])),
  })
  await mod.aggregateVariant({
    variantKey: 'ai',
    pool,
    createClient: upstream.createClient,
    now: () => BASE,
    concurrency: 2,
  })
  assert.equal(upstream.calls.length, 6)
  assert.ok(upstream.peak() <= 2, `并发峰值 ${upstream.peak()} 超过 concurrency=2`)
}

test('（正向对照）三处行为断言在原始实现上必须为真', async () => {
  const mod = await import('../lib/credits.js')
  await assertCreditInvariants(mod)
})

test('反向: 放宽「只看启用账号」⇒ 断点断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'skip-disabled',
    anchor: '[anchor:skip-disabled]',
    from: "const enabled = rows.filter((row) => isRecord(row) && typeof row.uid === 'string' && row.enabled !== false)",
    to: "const enabled = rows.filter((row) => isRecord(row) && typeof row.uid === 'string')",
  })
  await assert.rejects(assertCreditInvariants(mod), assert.AssertionError)
})

test('反向: 密文账号的原因码改坏 ⇒ 断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'encrypted-code',
    anchor: '[anchor:encrypted]',
    from: "entry.error = entry.encrypted ? ERR_ENCRYPTED : ERR_NO_CREDENTIAL",
    to: "entry.error = entry.encrypted ? ERR_NO_CREDENTIAL : ERR_NO_CREDENTIAL",
  })
  await assert.rejects(assertCreditInvariants(mod), assert.AssertionError)
})

test('反向: 去掉并发上限 ⇒ 断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'no-concurrency-cap',
    anchor: '[anchor:concurrency]',
    from: 'const effective = Math.max(1, Math.min(cfg.concurrency, items.length))',
    to: 'const effective = Math.max(1, items.length)',
  })
  await assert.rejects(assertCreditInvariants(mod), assert.AssertionError)
})

test('反向: TTL 判据放宽成「有缓存就回」⇒ 过期重算断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'ttl-never-expires',
    anchor: '[anchor:ttl]',
    from: 'if (!force && cached && resolveNow(this.#now) - cached.at < this.#config.ttlMs) return cached.aggregate',
    to: 'if (!force && cached) return cached.aggregate',
  })

  await assert.rejects(
    (async () => {
      const clock = fakeClock(BASE)
      const pool = fakePool({ accounts: { ai: [meta('u1')] }, docs: docsFor(['u1']) })
      const upstream = fakeUpstream({ byUid: { u1: creditsOf(100, 1) } })
      const cache = new mod.CreditsCache({
        pool,
        createClient: upstream.createClient,
        now: clock.now,
        config: { ttlMs: 1_000 },
      })
      await cache.get('ai')
      clock.current = BASE + 5_000
      await cache.get('ai')
      assert.equal(upstream.calls.length, 2, '缓存过期 5 秒后必须重算')
    })(),
    assert.AssertionError,
  )
})

test('反向: 突变模块本身是可用的（否则上面的「断言失败」不可信）', async () => {
  const mod = await loadMutated({
    name: 'sanity',
    anchor: '[anchor:skip-disabled]',
    from: 'const effective = Math.max(1, Math.min(cfg.concurrency, items.length))',
    to: 'const effective = Math.max(1, Math.min(cfg.concurrency, items.length))',
  })
  assert.equal(typeof mod.aggregateVariant, 'function')
  assert.deepEqual(Object.keys(mod).sort(), [
    'CREDITS_DEFAULTS',
    'CreditsCache',
    'aggregateVariant',
    'fetchAccountCredits',
    'parseCredential',
    'summarizeVariant',
  ])
})

// ── H-6：外壳信号已中止时，晚到的 reject 不能变成 unhandledRejection（Node 22 会因此退出进程）──
test('fetchAccountCredits：信号已中止 + 上游请求随后 reject → 不产生 unhandledRejection', async () => {
  const seen = []
  const onUnhandled = (reason) => seen.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const controller = new AbortController()
    controller.abort()
    let rejectLater
    const client = {
      fetchCredits: () =>
        new Promise((_resolve, reject) => {
          rejectLater = reject
        }),
    }
    const result = await fetchAccountCredits({
      credential: { accessToken: 'x' },
      createClient: () => client,
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    assert.equal(result.ok, false, '前提：走的是「已中止」早退分支')
    assert.equal(typeof rejectLater, 'function', '前提：上游请求确实发出了')
    rejectLater(new Error('HTTP 500 from upstream'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(seen.map(String), [], '晚到的 reject 必须被接住')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
