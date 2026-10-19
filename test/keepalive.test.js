/**
 * test/keepalive.test.js — lib/keepalive.js 的单测 + 反向（变异）测试。
 *
 * 约定（PLAN §3.5.2 / §5）：
 *  - 依赖全注入：假 fetchImpl、假 now（假时钟）、假 pool、假 logger。
 *    **绝不打真网络、绝不读真人 auth 文件、绝不用真 pool。**
 *  - 假 pool 只实现 PLAN §3.5.3 里 keepalive 用得着的那几个方法；`list()` 的语义照
 *    lib/pool.js 实测行为建模（`list(variantKey)` 对空桶返回 `[]`，未 load 才抛）。
 *  - 反向测试：把 lib/keepalive.js 源码做**定向文本突变**写成临时模块再 import，然后用
 *    **同一套行为断言**跑一遍，断言它现在必须因**断言失败**而红（不是 ImportError）。
 *    突变锚点漂移会显式报错，绝不静默通过。
 *    三处必修突变：删掉 `X-Auth-Refresh-Source` 头 / 把 encrypted 分支改成标 needsRelogin /
 *    去掉并发上限。
 *  运行：`cd dsh-workbuddy-multi && node --test test/keepalive.test.js`
 *  （注意：`node --test test/` 传目录在 Node 22 会 MODULE_NOT_FOUND，必须点名文件。）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEEPALIVE_PATH = join(HERE, '..', 'lib', 'keepalive.js')
const keepalive = await import(pathToFileURL(KEEPALIVE_PATH).href)

const {
  KEEPALIVE_DEFAULTS,
  KEEPALIVE_VARIANTS,
  REQUIRED_POOL_METHODS,
  OPTIONAL_POOL_METHODS,
  refreshUrl,
  refreshHeaders,
  applyRefreshResult,
  accessTokenOf,
  refreshDocument,
  computeBackoffMs,
  KeepAliveScheduler,
} = keepalive

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 1_700_000_000_000
const CN = 'https://www.codebuddy.cn'
const AI = 'https://www.workbuddy.ai'
const REFRESH_PATH = '/v2/plugin/auth/token/refresh'
const CN_REFRESH_URL = CN + REFRESH_PATH
const AI_REFRESH_URL = AI + REFRESH_PATH

/** 明文账号文档（OAuth 登录来的形态）。 */
function plainDoc(uid, { domain = 'www.workbuddy.cn', expiresAt = BASE + 3_600_000, refreshExpiresAt = BASE + 86_400_000, account = {} } = {}) {
  return {
    auth: {
      accessToken: `at-${uid}`,
      refreshToken: `rt-${uid}`,
      tokenType: 'Bearer',
      domain,
      expiresAt,
      refreshExpiresAt,
    },
    account: { uid, nickname: `nick-${uid}`, uin: '100000000001', type: 'personal', ...account },
    accounts: [],
    allAccounts: [],
    source: 'oauth',
    version: 1,
  }
}

/** 加密信封账号文档（从桌面 App 收割来的国内版）：token / 昵称都是信封对象。 */
function encDoc(uid) {
  return {
    account: {
      uid,
      nickname: { $wbEncrypted: 1, envelope: 'ZmFrZS1uaWNr' },
      uin: '100000000001',
      type: 'personal',
    },
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'ZmFrZS1hdA==' },
      refreshToken: { $wbEncrypted: 1, envelope: 'ZmFrZS1ydA==' },
      tokenType: 'Bearer',
      domain: 'www.workbuddy.cn',
      expiresAt: BASE + 3_600_000,
      refreshExpiresAt: BASE + 86_400_000,
    },
    accounts: [],
    allAccounts: [],
    source: 'desktop',
    version: 1,
  }
}

/** 刷新成功响应体。 */
function successPayload(uid, overrides = {}) {
  return {
    code: 0,
    data: {
      accessToken: `new-at-${uid}`,
      refreshToken: `new-rt-${uid}`,
      domain: 'www.workbuddy.cn',
      expiresAt: BASE + 7_200_000,
      refreshExpiresAt: BASE + 172_800_000,
      ...overrides,
    },
  }
}

/** 假 Response：`ok` 可显式覆盖（测 status>=400 但 ok 缺失的宽松路径）。 */
function jsonResponse(body, { status = 200, ok } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: ok === undefined ? status >= 200 && status < 300 : ok,
    status,
    async text() {
      return text
    },
    async json() {
      return JSON.parse(text)
    },
  }
}

/** 只提供 text() 的响应，验证退化路径。 */
function textResponse(body, { status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { ok: status >= 200 && status < 300, status, async text() { return text } }
}

/** 记录调用的 fetch。 */
function recordingFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return await handler(url, init)
  }
  return { fetchImpl, calls }
}

/**
 * 闸门 fetch：所有请求都卡在 `release()` 上，用来精确观测「同时在飞几个」。
 * 不给结果之前绝不放行 —— 并发上限测试靠这个才能确定性成立。
 */
function gatedFetch(handler) {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const state = { inFlight: 0, max: 0, calls: [] }
  const fetchImpl = async (url, init) => {
    state.calls.push({ url, init })
    state.inFlight += 1
    state.max = Math.max(state.max, state.inFlight)
    try {
      await gate
    } finally {
      state.inFlight -= 1
    }
    return handler ? await handler(url, init) : jsonResponse(successPayload('x'))
  }
  return { fetchImpl, state, release: () => release() }
}

/** 假 logger：记录消息，可配置成自己抛错。 */
function fakeLogger({ throwOnLog = false } = {}) {
  const lines = []
  const emit = (level) => (message) => {
    if (throwOnLog) throw new Error('logger boom')
    lines.push(`${level}:${message}`)
  }
  return { lines, debug: emit('debug'), info: emit('info'), warn: emit('warn'), log: emit('log') }
}

/** 假时钟：注入 `now`，同时提供假 setTimeout/clearTimeout 证明「不留定时器」。 */
function fakeClock(start = BASE) {
  let current = start
  let seq = 0
  const timers = new Map()
  const clock = {
    now: () => current,
    get current() {
      return current
    },
    set current(v) {
      current = v
    },
    get pending() {
      return timers.size
    },
    setTimeout(fn, ms) {
      seq += 1
      const id = seq
      timers.set(id, { fn, at: current + Math.max(0, Number(ms) || 0) })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    fireDue() {
      for (const [id, timer] of [...timers]) {
        if (timer.at <= current) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    async advance(ms) {
      current += Math.max(0, Number(ms) || 0)
      clock.fireDue()
      await flush()
    },
  }
  return clock
}

/** 让所有已排队的微任务/宏任务跑完。 */
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** 账号元信息行（形状照 lib/pool.js `_buildMeta`）。 */
function meta(uid, { variantKey = 'cn', expiresAt = BASE + 60_000, ...rest } = {}) {
  return {
    variantKey,
    uid,
    uin: '100000000001',
    domain: 'www.workbuddy.cn',
    label: `nick-${uid}`,
    type: 'personal',
    expiresAt,
    refreshExpiresAt: BASE + 86_400_000,
    capturedAt: BASE - 1_000_000,
    source: 'oauth',
    enabled: true,
    needsRelogin: false,
    ...rest,
  }
}

/**
 * 假 pool：只实现 §3.5.3 里 keepalive 用得着的方法。
 * `accounts`：{ [variantKey]: meta[] }；`docs`：{ 'cn/uid': 原始文本 }。
 * `list(variantKey)` 对未知 bucket 返回 `[]`（照真实 pool.js 行为），`listFails` 时才抛。
 */
function fakePool({
  accounts = {},
  docs = {},
  variants,
  accountMeta,
  activeUids,
  listFails = false,
  readFails = false,
  writeFails = false,
} = {}) {
  const calls = { list: [], read: [], write: [], needsRelogin: [], refreshError: [] }
  const store = { ...docs }
  const pool = {
    calls,
    store,
    // 照真实 lib/pool.js:421：list() 是**同步**的，未 load 时同步抛。
    list(variantKey) {
      calls.list.push(variantKey)
      if (listFails) throw new Error('pool not loaded')
      return accounts[variantKey] ?? []
    },
    async readSnapshotDocument(variantKey, uid) {
      calls.read.push([variantKey, uid])
      if (readFails) throw new Error('read boom')
      return store[`${variantKey}/${uid}`] ?? null
    },
    async writeSnapshotDocument(variantKey, uid, text) {
      calls.write.push([variantKey, uid, text])
      if (writeFails) throw new Error('write boom')
      store[`${variantKey}/${uid}`] = text
    },
    async setLastRefreshError(variantKey, uid, text) {
      calls.refreshError.push([variantKey, uid, text])
    },
    async markNeedsRelogin(variantKey, uid, reason) {
      calls.needsRelogin.push([variantKey, uid, reason])
    },
  }
  if (variants !== undefined) pool.variants = variants
  if (accountMeta !== undefined) pool.accountMeta = accountMeta
  // 照真实 lib/pool.js:440：给定才会存在。不给就代表「这个 pool 不认识活跃账号」，
  // 于是 skip-active 闸门自动失效（对既有用例保持零影响）。
  if (activeUids !== undefined) pool.activeUid = (variantKey) => activeUids[variantKey]
  return pool
}

function docsFor(uids, variantKey = 'cn', docFactory = plainDoc) {
  const out = {}
  for (const uid of uids) out[`${variantKey}/${uid}`] = JSON.stringify(docFactory(uid))
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// refreshUrl
// ─────────────────────────────────────────────────────────────────────────────

test('refreshUrl: 两个档位的端点逐字照 PLAN §3.5.0', () => {
  assert.equal(refreshUrl('cn'), CN_REFRESH_URL)
  assert.equal(refreshUrl('ai'), AI_REFRESH_URL)
  assert.equal(refreshUrl('cn'), 'https://www.codebuddy.cn/v2/plugin/auth/token/refresh')
  assert.equal(refreshUrl('ai'), 'https://www.workbuddy.ai/v2/plugin/auth/token/refresh')
})

test('refreshUrl: 也认 {key,endpoint,apiPrefix} 形状（可直接吃 login.js 的 LOGIN_VARIANTS）', () => {
  assert.equal(
    refreshUrl({ key: 'cn', endpoint: 'https://www.codebuddy.cn', platform: 'workbuddy', apiPrefix: '/v2/plugin' }),
    CN_REFRESH_URL,
  )
  assert.equal(refreshUrl({ key: 'cn' }), CN_REFRESH_URL, '只给 key 也要能落到内置表')
  assert.equal(
    refreshUrl({ key: 'cn', endpoint: 'https://stub.test', apiPrefix: '/v9/plugin' }),
    'https://stub.test/v9/plugin/auth/token/refresh',
  )
  assert.equal(refreshUrl({ key: 'cn', endpoint: 'https://stub.test/' }), 'https://stub.test/v2/plugin/auth/token/refresh')
})

test('refreshUrl: 认不出的档位返回 undefined（绝不猜一个档位去打）', () => {
  for (const bad of ['zz', '', '  ', undefined, null, 42, {}, [], { key: 'zz' }]) {
    assert.equal(refreshUrl(bad), undefined, `refreshUrl(${JSON.stringify(bad)}) 应为 undefined`)
  }
})

test('KEEPALIVE_VARIANTS: 逐字照 §3.5.0 表', () => {
  assert.deepEqual(
    KEEPALIVE_VARIANTS.map((v) => [v.key, v.endpoint, v.platform]),
    [
      ['cn', CN, 'workbuddy'],
      ['ai', AI, 'workbuddy-ai'],
    ],
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// refreshHeaders
// ─────────────────────────────────────────────────────────────────────────────

test('refreshHeaders: 齐备时逐字包含全部要求的头（含 X-Auth-Refresh-Source: plugin）', () => {
  const headers = refreshHeaders({
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    uid: 'u-1',
    enterpriseId: 'ent-9',
    domain: 'www.workbuddy.cn',
  })
  assert.deepEqual(headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer at-1',
    'X-User-Id': 'u-1',
    'X-Enterprise-Id': 'ent-9',
    'X-Tenant-Id': 'ent-9',
    'X-Domain': 'www.workbuddy.cn',
    'X-Refresh-Token': 'rt-1',
    'X-Auth-Refresh-Source': 'plugin',
  })
  assert.equal(headers['X-Auth-Refresh-Source'], 'plugin', 'X-Auth-Refresh-Source 必须逐字是 plugin')
})

test('refreshHeaders: 缺 uid/enterpriseId/domain 时不写空头', () => {
  const headers = refreshHeaders({ accessToken: 'at-1', refreshToken: 'rt-1' })
  for (const key of ['X-User-Id', 'X-Enterprise-Id', 'X-Tenant-Id', 'X-Domain']) {
    assert.equal(key in headers, false, `${key} 不该出现（写空串会被网关当成「提供了但无效」）`)
  }
  assert.equal(headers.Authorization, 'Bearer at-1')
  assert.equal(headers['X-Refresh-Token'], 'rt-1')
  assert.equal(headers['X-Auth-Refresh-Source'], 'plugin')
})

test('refreshHeaders: 空串 / 纯空白 一律当缺失；没有任何 undefined/null/[object Object] 值', () => {
  const headers = refreshHeaders({
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    uid: '',
    enterpriseId: '   ',
    domain: '\t\n',
  })
  for (const key of ['X-User-Id', 'X-Enterprise-Id', 'X-Tenant-Id', 'X-Domain']) {
    assert.equal(key in headers, false, `${key} 不该出现`)
  }
  for (const [key, value] of Object.entries(headers)) {
    assert.equal(typeof value, 'string', `${key} 必须是字符串`)
    assert.notEqual(value.trim(), '', `${key} 不能是空串`)
    assert.ok(!/undefined|null|\[object /.test(value), `${key} 不得含 undefined/null/[object ...]：${value}`)
  }
})

test('refreshHeaders: 非字符串（信封对象/数字）不写进头，且不做字符串化', () => {
  const headers = refreshHeaders({
    accessToken: { $wbEncrypted: 1, envelope: 'e' },
    refreshToken: 12345,
    uid: { $wbEncrypted: 1, envelope: 'e' },
    enterpriseId: null,
    domain: undefined,
  })
  for (const key of ['Authorization', 'X-Refresh-Token', 'X-User-Id', 'X-Enterprise-Id', 'X-Tenant-Id', 'X-Domain']) {
    assert.equal(key in headers, false, `${key} 不该出现`)
  }
  assert.equal(headers['X-Auth-Refresh-Source'], 'plugin', '强制头必须在')
})

test('refreshHeaders: 头值里的 CR/LF 被消掉（防头注入）', () => {
  const headers = refreshHeaders({ accessToken: 'at-1', refreshToken: 'rt-1', domain: 'www.workbuddy.cn\r\nX-Evil: 1' })
  assert.equal(headers['X-Domain'], 'www.workbuddy.cn X-Evil: 1')
  for (const value of Object.values(headers)) assert.ok(!/[\r\n]/.test(value), '头值不得含换行')
})

// ─────────────────────────────────────────────────────────────────────────────
// accessTokenOf
// ─────────────────────────────────────────────────────────────────────────────

test('accessTokenOf: 明文串 → plaintext（逐字保留，不 trim）', () => {
  assert.deepEqual(accessTokenOf({ auth: { accessToken: 'at-1' } }), { kind: 'plaintext', token: 'at-1' })
  assert.deepEqual(accessTokenOf({ auth: { accessToken: ' a b ' } }), { kind: 'plaintext', token: ' a b ' })
})

test('accessTokenOf: {$wbEncrypted:1,envelope:…} → encrypted', () => {
  assert.deepEqual(accessTokenOf(encDoc('u1')), { kind: 'encrypted' })
  assert.deepEqual(accessTokenOf({ auth: { accessToken: { $wbEncrypted: 1, envelope: 'x' } } }), { kind: 'encrypted' })
  assert.deepEqual(accessTokenOf({ auth: { accessToken: { $wbEncrypted: true } } }), { kind: 'encrypted' })
})

test('accessTokenOf: 其余一切 → absent', () => {
  const cases = [
    undefined,
    null,
    {},
    { auth: {} },
    { auth: { accessToken: '' } },
    { auth: { accessToken: 0 } },
    { auth: { accessToken: 42 } },
    { auth: { accessToken: null } },
    { auth: { accessToken: {} } },
    { auth: { accessToken: { $wbEncrypted: 0 } } },
    { auth: { accessToken: { $wbEncrypted: 1 } } }.auth.accessToken,
    { accessToken: 'at-top-level' },
  ]
  for (const value of cases) {
    assert.deepEqual(accessTokenOf(value), { kind: 'absent' }, `${JSON.stringify(value)} 应为 absent`)
  }
  // 只有 `auth.accessToken` 是判据位置；顶层同名键不算。
  assert.equal(accessTokenOf({ accessToken: 'at-top-level' }).kind, 'absent')
})

// ─────────────────────────────────────────────────────────────────────────────
// applyRefreshResult
// ─────────────────────────────────────────────────────────────────────────────

test('applyRefreshResult: 只动 auth 的四个 token 字段，其余键逐字保留', () => {
  const doc = plainDoc('u1')
  const data = {
    accessToken: 'new-at',
    refreshToken: 'new-rt',
    expiresAt: BASE + 7_200_000,
    refreshExpiresAt: BASE + 172_800_000,
    domain: 'www.workbuddy.cn',
    tokenType: 'Bearer',
  }
  const next = applyRefreshResult(doc, data, BASE)

  assert.deepEqual(
    next,
    {
      ...doc,
      auth: {
        ...doc.auth,
        accessToken: 'new-at',
        refreshToken: 'new-rt',
        expiresAt: BASE + 7_200_000,
        refreshExpiresAt: BASE + 172_800_000,
      },
    },
    '除了四个 token 字段，其它（domain/tokenType/account/accounts/source/version）必须逐字不动',
  )
  assert.notEqual(next, doc, '必须返回新对象')
  assert.notEqual(next.auth, doc.auth, 'auth 必须是新对象')
  assert.deepEqual(doc, plainDoc('u1'), '入参不得被修改')
})

test('applyRefreshResult: refreshToken 没回就沿用旧值', () => {
  const doc = plainDoc('u1')
  const next = applyRefreshResult(doc, { accessToken: 'new-at', expiresAt: BASE + 7_200_000 }, BASE)
  assert.equal(next.auth.refreshToken, 'rt-u1')
  assert.equal(next.auth.refreshExpiresAt, doc.auth.refreshExpiresAt)
})

test('applyRefreshResult: 响应没给到期时刻时不编造（沿用旧值）', () => {
  const doc = plainDoc('u1')
  const next = applyRefreshResult(doc, { accessToken: 'new-at' }, BASE)
  assert.equal(next.auth.expiresAt, doc.auth.expiresAt)
  assert.equal(next.auth.refreshExpiresAt, doc.auth.refreshExpiresAt)
})

test('applyRefreshResult: 兼容 snake_case 与 expiresIn 秒数（用注入的 now 换算）', () => {
  const doc = plainDoc('u1')
  const next = applyRefreshResult(
    doc,
    { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600, refresh_expires_in: 7200 },
    BASE,
  )
  assert.equal(next.auth.accessToken, 'new-at')
  assert.equal(next.auth.refreshToken, 'new-rt')
  assert.equal(next.auth.expiresAt, BASE + 3_600_000)
  assert.equal(next.auth.refreshExpiresAt, BASE + 7_200_000)
})

test('applyRefreshResult: 到期时刻兼容 epoch 秒 / ISO 串', () => {
  const doc = plainDoc('u1')
  const seconds = applyRefreshResult(doc, { accessToken: 'a', expiresAt: Math.floor((BASE + 5_000) / 1000) }, BASE)
  assert.equal(seconds.auth.expiresAt, Math.round(Math.floor((BASE + 5_000) / 1000) * 1000))
  const iso = applyRefreshResult(doc, { accessToken: 'a', expiresAt: '2026-10-19T05:11:08.000Z' }, BASE)
  assert.equal(iso.auth.expiresAt, Date.parse('2026-10-19T05:11:08.000Z'))
})

test('applyRefreshResult: now 可传数字也可传函数；data 非法时不炸', () => {
  const doc = plainDoc('u1')
  const asFn = applyRefreshResult(doc, { accessToken: 'a', expiresIn: 60 }, () => BASE)
  assert.equal(asFn.auth.expiresAt, BASE + 60_000)
  for (const bad of [undefined, null, 42, 'nope', [], { accessToken: 123 }]) {
    const next = applyRefreshResult(doc, bad, BASE)
    assert.deepEqual(next, doc, `${JSON.stringify(bad)} 不该改动凭据`)
  }
})

test('applyRefreshResult: 冻结的入参也不抛（证明真的没在改入参）', () => {
  const frozen = Object.freeze({
    auth: Object.freeze({ accessToken: 'at-1', refreshToken: 'rt-1', domain: 'www.workbuddy.cn' }),
    account: Object.freeze({ uid: 'u1' }),
    version: 1,
  })
  const next = applyRefreshResult(frozen, { accessToken: 'new-at' }, BASE)
  assert.equal(next.auth.accessToken, 'new-at')
  assert.equal(next.account.uid, 'u1')
  assert.equal(frozen.auth.accessToken, 'at-1')
})

// ─────────────────────────────────────────────────────────────────────────────
// refreshDocument
// ─────────────────────────────────────────────────────────────────────────────

test('refreshDocument: 成功路径 —— POST + 头齐备 + body {} + 返回新文档与 expiresAtMs', async () => {
  const doc = plainDoc('u1', { account: { enterpriseId: 'ent-9' } })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('u1')))
  const result = await refreshDocument({ variantKey: 'cn', document: doc, fetchImpl, now: BASE, logger: fakeLogger() })

  assert.equal(result.ok, true)
  assert.equal(result.expiresAtMs, BASE + 7_200_000)
  assert.equal(result.document.auth.accessToken, 'new-at-u1')
  assert.equal(result.document.auth.refreshToken, 'new-rt-u1')
  assert.equal(result.document.account.uid, 'u1')
  assert.deepEqual(doc.auth.accessToken, 'at-u1', '入参文档不得被改')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, CN_REFRESH_URL)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.body, '{}')
  assert.deepEqual(calls[0].init.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer at-u1',
    'X-User-Id': 'u1',
    'X-Enterprise-Id': 'ent-9',
    'X-Tenant-Id': 'ent-9',
    'X-Domain': 'www.workbuddy.cn',
    'X-Refresh-Token': 'rt-u1',
    'X-Auth-Refresh-Source': 'plugin',
  })
})

test('refreshDocument: ai 档位打到国际版端点', async () => {
  const doc = plainDoc('u1', { domain: 'www.workbuddy.ai' })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('u1', { domain: 'www.workbuddy.ai' })))
  const result = await refreshDocument({ variantKey: 'ai', document: doc, fetchImpl, now: BASE })
  assert.equal(result.ok, true)
  assert.equal(calls[0].url, AI_REFRESH_URL)
})

test('refreshDocument: 加密信封账号 → 精确结果、不标 needsRelogin、绝不打网络', async () => {
  let calls = 0
  const result = await refreshDocument({
    variantKey: 'cn',
    document: encDoc('u1'),
    now: BASE,
    logger: fakeLogger(),
    fetchImpl: async () => {
      calls += 1
      return jsonResponse(successPayload('u1'))
    },
  })
  assert.deepEqual(result, { ok: false, terminal: false, needsRelogin: false, error: 'encrypted-credential' })
  assert.equal(result.needsRelogin, false, '加密信封账号绝不能被标 needsRelogin')
  assert.equal(result.terminal, false, '也不许当成终态硬失败')
  assert.equal(calls, 0, '加密信封账号绝不打真网络')
})

test('refreshDocument: refreshToken 本身是信封 → 也只当缺 refreshToken，不炸', async () => {
  let calls = 0
  const doc = { auth: { accessToken: 'at-1', refreshToken: { $wbEncrypted: 1, envelope: 'x' } }, account: { uid: 'u1' } }
  const result = await refreshDocument({
    variantKey: 'cn',
    document: doc,
    now: BASE,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse(successPayload('u1'))
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.needsRelogin, true)
  assert.equal(result.terminal, true)
  assert.equal(result.error, 'missing-refresh-token')
  assert.equal(calls, 0)
})

test('refreshDocument: 缺 refreshToken → needsRelogin:true，且不打网络', async () => {
  let calls = 0
  const doc = { auth: { accessToken: 'at-1', domain: 'www.workbuddy.cn' }, account: { uid: 'u1' } }
  const result = await refreshDocument({
    variantKey: 'cn',
    document: doc,
    now: BASE,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse(successPayload('u1'))
    },
  })
  assert.deepEqual(result, { ok: false, terminal: true, needsRelogin: true, error: 'missing-refresh-token' })
  assert.equal(calls, 0)
})

test('refreshDocument: 缺 accessToken（absent）→ needsRelogin:true，不打网络', async () => {
  let calls = 0
  const doc = { auth: { refreshToken: 'rt-1' }, account: { uid: 'u1' } }
  const result = await refreshDocument({
    variantKey: 'cn',
    document: doc,
    now: BASE,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse(successPayload('u1'))
    },
  })
  assert.deepEqual(result, { ok: false, terminal: true, needsRelogin: true, error: 'missing-access-token' })
  assert.equal(calls, 0)
  // 整个 document 都没有也要安全
  const empty = await refreshDocument({ variantKey: 'cn', document: undefined, now: BASE })
  assert.equal(empty.ok, false)
  assert.equal(empty.needsRelogin, true)
})

test('refreshDocument: code 12153（invalid_grant）→ terminal + needsRelogin，error 带 code 与 msg', async () => {
  const fetchImpl = async () =>
    jsonResponse({ code: 12153, msg: 'invalid_grant: Invalid refresh token', requestId: 'r-1' })
  const result = await refreshDocument({ variantKey: 'ai', document: plainDoc('u1', { domain: 'www.workbuddy.ai' }), fetchImpl, now: BASE })
  assert.equal(result.ok, false)
  assert.equal(result.terminal, true, 'code 12153 是终态')
  assert.equal(result.needsRelogin, true, 'code 12153 必须标 needsRelogin')
  assert.match(result.error, /code-12153/)
  assert.match(result.error, /invalid_grant/)
})

test('refreshDocument: 非终态 code（500）→ terminal:false / needsRelogin:false，可重试', async () => {
  const fetchImpl = async () => jsonResponse({ code: 500, msg: 'server busy' })
  const result = await refreshDocument({ variantKey: 'cn', document: plainDoc('u1'), fetchImpl, now: BASE })
  assert.equal(result.ok, false)
  assert.equal(result.terminal, false)
  assert.equal(result.needsRelogin, false)
  assert.match(result.error, /code-500/)
  assert.match(result.error, /server busy/)
})

test('refreshDocument: code 200 与字符串 "0" 都算成功；权限类 code 1 算可重试', async () => {
  const ok200 = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => jsonResponse(successPayload('u1', { code: 200 })),
  })
  assert.equal(ok200.ok, true)

  const okStr = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => jsonResponse({ code: '0', data: { accessToken: 'new-at', expiresIn: 60 } }),
  })
  assert.equal(okStr.ok, true)
  assert.equal(okStr.expiresAtMs, BASE + 60_000)

  const code1 = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => jsonResponse({ code: 1, msg: 'failed' }),
  })
  assert.equal(code1.terminal, false)
  assert.equal(code1.needsRelogin, false)
})

test('refreshDocument: HTTP 非 2xx —— 5xx 可重试，401/403 属终态', async () => {
  const s500 = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => jsonResponse({ code: 500 }, { status: 500 }),
  })
  assert.deepEqual(s500, { ok: false, terminal: false, needsRelogin: false, error: 'http-500' })

  const s401 = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => jsonResponse({ code: 401 }, { status: 401 }),
  })
  assert.deepEqual(s401, { ok: false, terminal: true, needsRelogin: true, error: 'http-401' })

  const s403 = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => jsonResponse({}, { status: 403 }),
  })
  assert.equal(s403.terminal, true)
})

test('refreshDocument: 网络抛错绝不冒泡，判成可重试', async () => {
  const result = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => {
      throw new Error('socket hang up')
    },
  })
  assert.deepEqual(result, { ok: false, terminal: false, needsRelogin: false, error: 'socket hang up' })
})

test('refreshDocument: 非 JSON / 没有 body reader / fetch 返回 undefined 都不炸', async () => {
  const badJson = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new SyntaxError('Unexpected token <') } }),
  })
  assert.deepEqual(badJson, { ok: false, terminal: false, needsRelogin: false, error: 'invalid-json' })

  const noReader = await refreshDocument({ variantKey: 'cn', document: plainDoc('u1'), now: BASE, fetchImpl: async () => ({ ok: true, status: 200 }) })
  assert.equal(noReader.error, 'invalid-json')

  const undef = await refreshDocument({ variantKey: 'cn', document: plainDoc('u1'), now: BASE, fetchImpl: async () => undefined })
  assert.equal(undef.ok, false)
  assert.equal(undef.error, 'invalid-json')

  const viaText = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => textResponse(successPayload('u1')),
  })
  assert.equal(viaText.ok, true, '只有 text() 的响应也要能解析')
})

test('refreshDocument: code 成功但缺 data / 缺 accessToken → needsRelogin:true，不写坏文档', async () => {
  const noData = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => jsonResponse({ code: 0, msg: 'ok' }),
  })
  assert.deepEqual(noData, { ok: false, terminal: false, needsRelogin: false, error: 'invalid-response' })

  const noToken = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => jsonResponse({ code: 0, data: { refreshToken: 'new-rt' } }),
  })
  assert.deepEqual(noToken, { ok: false, terminal: true, needsRelogin: true, error: 'missing-access-token-in-response' })

  const arrayData = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => jsonResponse({ code: 0, data: [] }),
  })
  assert.equal(arrayData.ok, false)
  assert.equal(arrayData.error, 'invalid-response')
})

test('refreshDocument: 认不出的档位 → unknown-variant，且绝不打网络', async () => {
  let calls = 0
  const result = await refreshDocument({
    variantKey: 'zz',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse(successPayload('u1'))
    },
  })
  assert.deepEqual(result, { ok: false, terminal: true, needsRelogin: false, error: 'unknown-variant' })
  assert.equal(calls, 0)
})

test('refreshDocument: 档位一致性守卫 —— cn 拿到 workbuddy.ai 的 domain 一律拒绝', async () => {
  const result = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    fetchImpl: async () => jsonResponse(successPayload('u1', { domain: 'www.workbuddy.ai' })),
  })
  assert.deepEqual(result, { ok: false, terminal: true, needsRelogin: true, error: 'domain-mismatch' })
})

test('refreshDocument: 响应不带 domain 时不阻断（空 domain 无法判定）', async () => {
  const doc = plainDoc('u1')
  const result = await refreshDocument({
    variantKey: 'cn',
    document: doc,
    now: BASE,
    fetchImpl: async () => jsonResponse({ code: 0, data: { accessToken: 'new-at' } }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.document.auth.domain, 'www.workbuddy.cn', 'domain 逐字保留旧值')
})

test('refreshDocument: 没有可用 fetch 时优雅失败（不打真网络）', async () => {
  const saved = globalThis.fetch
  globalThis.fetch = undefined
  try {
    const result = await refreshDocument({ variantKey: 'cn', document: plainDoc('u1'), now: BASE })
    assert.deepEqual(result, { ok: false, terminal: false, needsRelogin: false, error: 'fetch-unavailable' })
  } finally {
    globalThis.fetch = saved
  }
})

test('refreshDocument: logger 自己抛错也不影响主流程', async () => {
  const logger = fakeLogger({ throwOnLog: true })
  const ok = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    logger,
    fetchImpl: async () => jsonResponse(successPayload('u1')),
  })
  assert.equal(ok.ok, true)
  const bad = await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    logger,
    fetchImpl: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(bad.ok, false)
})

test('refreshDocument: 日志里绝不出现 token / 请求头', async () => {
  const logger = fakeLogger()
  await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    logger,
    fetchImpl: async () => jsonResponse(successPayload('u1')),
  })
  await refreshDocument({
    variantKey: 'cn',
    document: plainDoc('u1'),
    now: BASE,
    logger,
    fetchImpl: async () => jsonResponse({ code: 12153, msg: 'invalid_grant' }),
  })
  const all = logger.lines.join('\n')
  assert.ok(logger.lines.length > 0, '应该有日志')
  for (const secret of ['at-u1', 'rt-u1', 'new-at-u1', 'new-rt-u1', 'X-Refresh-Token', 'Authorization']) {
    assert.ok(!all.includes(secret), `日志不得出现 ${secret}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：退避
// ─────────────────────────────────────────────────────────────────────────────

test('computeBackoffMs: 指数增长、jitter=0 时可精确断言', () => {
  const config = { minRetryMs: 1_000, maxRetryMs: 100_000, jitterRatio: 0 }
  assert.equal(computeBackoffMs(1, config, () => 0.5), 1_000)
  assert.equal(computeBackoffMs(2, config, () => 0.5), 2_000)
  assert.equal(computeBackoffMs(3, config, () => 0.5), 4_000)
  assert.equal(computeBackoffMs(5, config, () => 0.5), 16_000)
})

test('computeBackoffMs: 抖动 ±jitterRatio', () => {
  const config = { minRetryMs: 1_000, maxRetryMs: 100_000, jitterRatio: 0.25 }
  assert.equal(computeBackoffMs(3, config, () => 0), 3_000, 'base 4000 - 25%')
  assert.equal(computeBackoffMs(3, config, () => 0.5), 4_000, 'base 4000')
  assert.equal(computeBackoffMs(3, config, () => 1), 5_000, 'base 4000 + 25%')
})

test('computeBackoffMs: 封顶 maxRetryMs（抖动后也不许超过）', () => {
  const config = { minRetryMs: 60_000, maxRetryMs: 3_600_000, jitterRatio: 0.1 }
  assert.equal(computeBackoffMs(20, config, () => 0.5), 3_600_000)
  assert.ok(computeBackoffMs(20, config, () => 1) <= 3_600_000, '抖动后仍必须封顶')
  assert.ok(computeBackoffMs(50, config, () => 1) <= 3_600_000)
  assert.ok(computeBackoffMs(20, config, () => 0) <= 3_600_000)
  assert.ok(computeBackoffMs(3, config, () => 1) <= 3_600_000)
  for (let n = 1; n <= 40; n += 1) {
    const ms = computeBackoffMs(n, config, () => 1)
    assert.ok(ms >= 1 && ms <= 3_600_000, `failures=${n} → ${ms} 越界`)
  }
})

test('computeBackoffMs: 退化输入不炸（默认配置 / 坏 random / 坏 failures）', () => {
  const defaulted = computeBackoffMs(1)
  assert.ok(
    defaulted >= KEEPALIVE_DEFAULTS.minRetryMs * 0.9 && defaulted <= KEEPALIVE_DEFAULTS.minRetryMs * 1.1,
    `默认配置也只在 jitterRatio 范围内：${defaulted}`,
  )
  assert.equal(computeBackoffMs(1, undefined, () => 0.5), KEEPALIVE_DEFAULTS.minRetryMs)
  assert.ok(computeBackoffMs(0, {}, () => 0.5) >= 1)
  assert.ok(computeBackoffMs(-5, {}, () => 0.5) >= 1)
  assert.ok(computeBackoffMs(NaN, {}, () => 0.5) >= 1)
  assert.ok(computeBackoffMs(2, { minRetryMs: 1, maxRetryMs: 1, jitterRatio: 0 }, () => 0.5) >= 1)
  const throwingRandom = () => {
    throw new Error('random boom')
  }
  assert.ok(computeBackoffMs(2, { minRetryMs: 1_000, maxRetryMs: 10_000 }, throwingRandom) >= 1)
  const nanRandom = () => NaN
  assert.equal(computeBackoffMs(2, { minRetryMs: 1_000, maxRetryMs: 10_000, jitterRatio: 0.1 }, nanRandom), 2_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// 调度器：基本形状
// ─────────────────────────────────────────────────────────────────────────────

test('KeepAliveScheduler: KEEPALIVE_DEFAULTS 逐字照 PLAN §3.5.2，且 config 可覆盖', () => {
  assert.deepEqual(KEEPALIVE_DEFAULTS, {
    marginMs: 300_000,
    sweepMs: 900_000,
    minRetryMs: 60_000,
    maxRetryMs: 3_600_000,
    jitterRatio: 0.1,
    concurrency: 2,
    skipActive: true,
  })
  const scheduler = new KeepAliveScheduler({ config: { concurrency: 5, jitterRatio: 2 } })
  assert.equal(scheduler.config.concurrency, 5)
  assert.equal(scheduler.config.jitterRatio, 1, 'jitterRatio 收敛到 [0,1]')
  const fallback = new KeepAliveScheduler({ config: { concurrency: 0, sweepMs: -5, minRetryMs: NaN } })
  assert.equal(fallback.config.concurrency, 1)
  assert.equal(fallback.config.sweepMs, KEEPALIVE_DEFAULTS.sweepMs)
  assert.equal(fallback.config.minRetryMs, KEEPALIVE_DEFAULTS.minRetryMs)
  const cap = new KeepAliveScheduler({ config: { minRetryMs: 10_000, maxRetryMs: 1_000 } })
  assert.equal(cap.config.maxRetryMs, 10_000, 'maxRetryMs 不得低于 minRetryMs')
})

test('KeepAliveScheduler: 初始 status 精确形状（running=false、无 unavailable）', () => {
  const scheduler = new KeepAliveScheduler({ pool: fakePool(), fetchImpl: async () => jsonResponse({}) })
  assert.deepEqual(scheduler.status(), {
    running: false,
    lastSweepAt: null,
    nextSweepAt: null,
    inFlight: [],
    stats: { ok: 0, failed: 0, skipped: 0 },
  })
  assert.deepEqual(REQUIRED_POOL_METHODS, ['list', 'readSnapshotDocument', 'writeSnapshotDocument'])
  assert.ok(OPTIONAL_POOL_METHODS.includes('accountMeta'))
})

test('KeepAliveScheduler: 只挑「即将过期 + 可用」的账号', async () => {
  const pool = fakePool({
    accounts: {
      cn: [
        meta('u-due'),
        meta('u-far', { expiresAt: BASE + 3_600_000 }),
        meta('u-off', { enabled: false }),
        meta('u-relogin', { needsRelogin: true }),
        meta('u-cooling', { cooldownUntil: BASE + 60_000 }),
      ],
    },
    docs: docsFor(['u-due']),
  })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('u-due')))
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE, logger: fakeLogger() })

  const summary = await scheduler.sync()
  assert.equal(summary.considered, 1)
  assert.equal(summary.refreshed, 1)
  assert.deepEqual(scheduler.status().stats, { ok: 1, failed: 0, skipped: 4 })
  assert.deepEqual(calls.map((c) => c.url), [CN_REFRESH_URL])
  assert.deepEqual(pool.calls.read, [['cn', 'u-due']])
  assert.equal(pool.calls.write.length, 1)
  assert.equal(pool.calls.write[0][0], 'cn')
  assert.equal(pool.calls.write[0][1], 'u-due')
  const written = JSON.parse(pool.calls.write[0][2])
  assert.equal(written.auth.accessToken, 'new-at-u-due')
  assert.equal(written.account.uid, 'u-due')
  assert.deepEqual(pool.calls.refreshError.at(-1), ['cn', 'u-due', null], '成功后清掉 lastRefreshError')
  assert.deepEqual(pool.calls.needsRelogin.at(-1), ['cn', 'u-due', null], '成功后清掉 needsRelogin')
  assert.equal(scheduler.status().unavailable, undefined)
})

test('KeepAliveScheduler: 当前活跃账号必须被跳过（refresh token 一次性轮换，不能和上游抢）', async () => {
  /*
   * 活跃账号由上游 dsh-workbuddy-connect 在每次请求的发送路径上按需刷新。
   * 我们若也拿一份 refresh token 去刷同一个账号，两边谁后刷谁就让对方那份作废 ——
   * 轻则我们误标 needsRelogin，重则把用户的上游会话踢成「需要重新登录」。
   */
  const pool = fakePool({
    accounts: { cn: [meta('u-active'), meta('u-idle')] },
    docs: docsFor(['u-active', 'u-idle']),
    activeUids: { cn: 'u-active' },
  })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('u-idle')))
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE, logger: fakeLogger() })

  const summary = await scheduler.sync()
  assert.equal(summary.considered, 1, '两个账号都该刷，但只有闲置的那个该被我们刷')
  assert.equal(summary.refreshed, 1)
  assert.equal(summary.skipped, 1, '被跳过的活跃账号要计进 skipped')
  assert.deepEqual(calls.map((c) => c.url), [CN_REFRESH_URL])
  assert.deepEqual(
    pool.calls.write.map((w) => w[1]),
    ['u-idle'],
    '绝不允许写活跃账号的快照',
  )
  // 活跃账号连读都不该读（读了也白读，还可能顺手把它的 token 消耗掉）。
  assert.ok(!pool.calls.read.some(([, uid]) => uid === 'u-active'), '活跃账号不该被读快照')

  // 反向对照：同一份 pool 关掉 skipActive → 活跃账号会被刷（这就是要防住的行为）。
  const pool2 = fakePool({
    accounts: { cn: [meta('u-active'), meta('u-idle')] },
    docs: docsFor(['u-active', 'u-idle']),
    activeUids: { cn: 'u-active' },
  })
  const rec2 = recordingFetch(async () => jsonResponse(successPayload('x')))
  const scheduler2 = new KeepAliveScheduler({
    pool: pool2,
    fetchImpl: rec2.fetchImpl,
    now: () => BASE,
    logger: fakeLogger(),
    config: { skipActive: false },
  })
  const summary2 = await scheduler2.sync()
  assert.equal(summary2.considered, 2, 'skipActive:false 时必须两个都刷（证明闸门真的在起作用）')
  assert.equal(rec2.calls.length, 2)
})

test('KeepAliveScheduler: 已过期 / 无 expiresAt / refreshToken 已死 的判定', async () => {  const pool = fakePool({
    accounts: {
      cn: [
        meta('u-expired', { expiresAt: BASE - 1_000 }),
        { ...meta('u-unknown'), expiresAt: undefined }, // 注意：meta() 的默认值会把显式 undefined 兜住，这里必须显式抹掉
        meta('u-dead', { refreshExpiresAt: BASE - 1 }),
      ],
    },
    docs: docsFor(['u-expired', 'u-unknown', 'u-dead']),
  })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('x')))
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE })
  await scheduler.sync()
  assert.deepEqual(calls.map((c) => c.init.headers['X-User-Id']), ['u-expired'], '只有「已过期但 refreshToken 还活着」的该刷')
  assert.deepEqual(scheduler.status().stats, { ok: 1, failed: 0, skipped: 2 })
})

test('KeepAliveScheduler: 多档位各刷一遍，endpoint 不串档', async () => {
  const pool = fakePool({
    accounts: { cn: [meta('c1')], ai: [meta('a1', { variantKey: 'ai' })] },
    docs: { 'cn/c1': JSON.stringify(plainDoc('c1')), 'ai/a1': JSON.stringify(plainDoc('a1', { domain: 'www.workbuddy.ai' })) },
  })
  const { fetchImpl, calls } = recordingFetch(async (url) =>
    jsonResponse(successPayload('x', { domain: url.startsWith(AI) ? 'www.workbuddy.ai' : 'www.workbuddy.cn' })),
  )
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE })
  await scheduler.sync()
  assert.deepEqual(pool.calls.list, ['cn', 'ai'])
  assert.deepEqual(calls.map((c) => c.url).sort(), [CN_REFRESH_URL, AI_REFRESH_URL].sort())
  assert.deepEqual(scheduler.status().stats, { ok: 2, failed: 0, skipped: 0 })
})

test('KeepAliveScheduler: pool.list 若变成 async 也必须照样能扫（不把 Promise 当空池）', async () => {
  const pool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']) })
  const syncList = pool.list
  pool.list = async (variantKey) => syncList(variantKey)
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('u1')))
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE })
  await scheduler.sync()
  assert.equal(calls.length, 1, 'async list 也必须被认成有账号')
  assert.deepEqual(scheduler.status().stats, { ok: 1, failed: 0, skipped: 0 })
  assert.equal(scheduler.status().unavailable, undefined)
})

test('KeepAliveScheduler: config.variants 可换自定义端点（也可直接吃 login.js 的表）', async () => {
  const pool = fakePool({ accounts: { cn: [meta('c1')] }, docs: docsFor(['c1']) })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('c1')))
  const scheduler = new KeepAliveScheduler({
    pool,
    fetchImpl,
    now: () => BASE,
    config: { variants: [{ key: 'cn', endpoint: 'https://stub.test', apiPrefix: '/v9/plugin' }] },
  })
  await scheduler.sync()
  assert.deepEqual(calls.map((c) => c.url), ['https://stub.test/v9/plugin/auth/token/refresh'])
})

test('KeepAliveScheduler: pool.variants 也会被采纳', async () => {
  const pool = fakePool({
    accounts: { cn: [meta('c1')] },
    docs: docsFor(['c1']),
    variants: [{ key: 'cn', endpoint: 'https://pool-variant.test' }],
  })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('c1')))
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE })
  await scheduler.sync()
  assert.deepEqual(calls.map((c) => c.url), ['https://pool-variant.test/v2/plugin/auth/token/refresh'])
})

// ─────────────────────────────────────────────────────────────────────────────
// 调度器：并发上限
// ─────────────────────────────────────────────────────────────────────────────

test('KeepAliveScheduler: 同一轮并发绝不超过 concurrency', async () => {
  const uids = ['u1', 'u2', 'u3', 'u4', 'u5']
  const pool = fakePool({ accounts: { cn: uids.map((uid) => meta(uid)) }, docs: docsFor(uids) })
  const gated = gatedFetch()
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl: gated.fetchImpl, now: () => BASE, config: { concurrency: 2 } })

  const running = scheduler.sync()
  await flush()
  assert.equal(gated.state.max, 2, '同一轮并发不得超过 concurrency')
  gated.release()
  await running

  assert.equal(gated.state.calls.length, 5)
  assert.deepEqual(scheduler.status().stats, { ok: 5, failed: 0, skipped: 0 })
  assert.equal(gated.state.max, 2)
})

test('KeepAliveScheduler: concurrency=1 时严格串行', async () => {
  const uids = ['u1', 'u2', 'u3']
  const pool = fakePool({ accounts: { cn: uids.map((uid) => meta(uid)) }, docs: docsFor(uids) })
  const gated = gatedFetch()
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl: gated.fetchImpl, now: () => BASE, config: { concurrency: 1 } })

  const running = scheduler.sync()
  await flush()
  assert.equal(gated.state.max, 1)
  assert.deepEqual(scheduler.status().inFlight, ['u1'])
  gated.release()
  await running
  assert.deepEqual(scheduler.status().inFlight, [])
  assert.equal(gated.state.calls.length, 3)
})

test('KeepAliveScheduler: concurrency 大于账号数时全并行（上限取 min）', async () => {
  const uids = ['u1', 'u2', 'u3', 'u4', 'u5']
  const pool = fakePool({ accounts: { cn: uids.map((uid) => meta(uid)) }, docs: docsFor(uids) })
  const gated = gatedFetch()
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl: gated.fetchImpl, now: () => BASE, config: { concurrency: 8 } })

  const running = scheduler.sync()
  await flush()
  assert.equal(gated.state.max, 5)
  gated.release()
  await running
})

test('KeepAliveScheduler: 两个 sync() 并发只扫一轮（同一个 promise）', async () => {
  const pool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']) })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('u1')))
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE })
  const first = scheduler.sync()
  const second = scheduler.sync()
  assert.equal(first, second, '同一个 promise')
  await Promise.all([first, second])
  assert.equal(calls.length, 1)
  assert.deepEqual(scheduler.status().stats, { ok: 1, failed: 0, skipped: 0 })
})

// ─────────────────────────────────────────────────────────────────────────────
// 调度器：退避
// ─────────────────────────────────────────────────────────────────────────────

test('KeepAliveScheduler: 失败退避带抖动、封顶 maxRetryMs，退避期内不再打网络', async () => {
  const clock = fakeClock(BASE)
  const pool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']) })
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    throw new Error('boom')
  }
  const scheduler = new KeepAliveScheduler({
    pool,
    fetchImpl,
    now: clock.now,
    config: { minRetryMs: 1_000, maxRetryMs: 8_000, jitterRatio: 0, concurrency: 2 },
  })

  await scheduler.sync()
  assert.equal(calls, 1, '第一次就失败')
  assert.deepEqual(scheduler.status().stats, { ok: 0, failed: 1, skipped: 0 })

  await scheduler.sync()
  assert.equal(calls, 1, '退避期内不得再打网络')
  assert.equal(scheduler.status().stats.skipped, 1)

  clock.current = BASE + 999
  await scheduler.sync()
  assert.equal(calls, 1, '差 1ms 也不行')

  clock.current = BASE + 1_000
  await scheduler.sync()
  assert.equal(calls, 2, '退避结束（minRetryMs）后重试一次')

  clock.current = BASE + 1_000 + 1_999
  await scheduler.sync()
  assert.equal(calls, 2, '第二次失败后退避翻倍到 2000ms')

  clock.current = BASE + 1_000 + 2_000
  await scheduler.sync()
  assert.equal(calls, 3, '2000ms 后重试')

  // 一路失败到封顶：无论怎么推进，都不会超过 maxRetryMs 才有下一跳
  for (let i = 0; i < 10; i += 1) {
    clock.current += 8_000
    await scheduler.sync()
  }
  const before = calls
  clock.current += 8_000 - 1
  await scheduler.sync()
  assert.equal(calls, before, '封顶后 8000ms 内不得再打网络')
  clock.current += 1
  await scheduler.sync()
  assert.equal(calls, before + 1, '封顶就是 maxRetryMs')
})

test('KeepAliveScheduler: 退避用注入的随机源抖动（边界差 1ms 都不行）', async () => {
  // 每个探针都用一个全新实例：同一实例上推进时钟会改变 failures 计数、把退避翻倍，
  // 「二分找阈值」的前提会被自己破坏。
  async function firesAt(randomValue, delay) {
    const clock = fakeClock(BASE)
    const pool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']) })
    let calls = 0
    const scheduler = new KeepAliveScheduler({
      pool,
      fetchImpl: async () => {
        calls += 1
        throw new Error('boom')
      },
      now: clock.now,
      config: { minRetryMs: 1_000, maxRetryMs: 60_000, jitterRatio: 0.5, random: () => randomValue },
    })
    await scheduler.sync() // 第一次失败 → 退避 = 1000 × (1 + 0.5×(2r-1))
    clock.current = BASE + delay
    await scheduler.sync()
    return calls === 2
  }

  // r=0 → 1000 × 0.5 = 500；r=1 → 1500；r=0.5 → 1000（无抖动）
  assert.equal(await firesAt(0, 499), false, 'r=0 时 499ms 还不到点')
  assert.equal(await firesAt(0, 500), true, 'r=0 时 500ms 到点')
  assert.equal(await firesAt(1, 1_499), false, 'r=1 时 1499ms 还不到点')
  assert.equal(await firesAt(1, 1_500), true, 'r=1 时 1500ms 到点')
  assert.equal(await firesAt(0.5, 999), false, 'r=0.5 时无抖动')
  assert.equal(await firesAt(0.5, 1_000), true, 'r=0.5 时正好 minRetryMs')
})

test('KeepAliveScheduler: 成功后清掉退避（下次立刻可刷）', async () => {
  const clock = fakeClock(BASE)
  const pool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']) })
  let mode = 'fail'
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (mode === 'fail') throw new Error('boom')
    return jsonResponse(successPayload('u1'))
  }
  const scheduler = new KeepAliveScheduler({
    pool,
    fetchImpl,
    now: clock.now,
    config: { minRetryMs: 600_000, maxRetryMs: 600_000, jitterRatio: 0 },
  })

  await scheduler.sync()
  assert.equal(calls, 1)
  mode = 'ok'
  clock.current = BASE + 600_000
  await scheduler.sync()
  assert.equal(calls, 2)
  assert.equal(scheduler.status().stats.ok, 1)

  // 成功后再失败一次：退避从 minRetryMs 重新开始
  mode = 'fail'
  clock.current = BASE + 600_000
  await scheduler.sync()
  assert.equal(calls, 3)
  clock.current += 599_999
  await scheduler.sync()
  assert.equal(calls, 3, '退避重新从 minRetryMs 起算')
})

// ─────────────────────────────────────────────────────────────────────────────
// 调度器：账号状态与池交互
// ─────────────────────────────────────────────────────────────────────────────

test('KeepAliveScheduler: 加密信封账号 → 记 lastRefreshError、不标 needsRelogin、不打网络、不进失败重试', async () => {
  const pool = fakePool({ accounts: { cn: [meta('u-enc')] }, docs: { 'cn/u-enc': JSON.stringify(encDoc('u-enc')) } })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('u-enc')))
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE })

  await scheduler.sync()
  assert.equal(calls.length, 0, '加密信封账号绝不打网络')
  assert.deepEqual(scheduler.status().stats, { ok: 0, failed: 0, skipped: 1 })
  assert.deepEqual(pool.calls.refreshError.at(-1), ['cn', 'u-enc', 'encrypted-credential'])
  assert.deepEqual(pool.calls.needsRelogin, [], '绝不标 needsRelogin')
  assert.equal(pool.calls.write.length, 0)

  // 再来一轮也一样（既没有重试轰炸，也不会被误标）
  await scheduler.sync()
  assert.equal(calls.length, 0)
  assert.deepEqual(pool.calls.needsRelogin, [])
  assert.equal(scheduler.status().stats.failed, 0)
})

test('KeepAliveScheduler: 终态失败（12153）→ markNeedsRelogin + lastRefreshError', async () => {
  const pool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']) })
  const fetchImpl = async () => jsonResponse({ code: 12153, msg: 'invalid_grant: Invalid refresh token' })
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE })
  await scheduler.sync()

  assert.deepEqual(scheduler.status().stats, { ok: 0, failed: 1, skipped: 0 })
  assert.equal(pool.calls.needsRelogin.length, 1)
  assert.equal(pool.calls.needsRelogin[0][0], 'cn')
  assert.equal(pool.calls.needsRelogin[0][1], 'u1')
  assert.match(pool.calls.needsRelogin[0][2], /code-12153/)
  assert.match(pool.calls.refreshError.at(-1)[2], /code-12153/)
})

test('KeepAliveScheduler: 可重试失败 → 只记 lastRefreshError，不标 needsRelogin', async () => {
  const pool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']) })
  const scheduler = new KeepAliveScheduler({
    pool,
    fetchImpl: async () => {
      throw new Error('socket hang up')
    },
    now: () => BASE,
  })
  await scheduler.sync()
  assert.deepEqual(pool.calls.needsRelogin, [])
  assert.deepEqual(pool.calls.refreshError.at(-1), ['cn', 'u1', 'socket hang up'])
})

test('KeepAliveScheduler: 快照读不到 / 不是 JSON → 可重试失败，不炸', async () => {
  const pool = fakePool({ accounts: { cn: [meta('missing'), meta('broken')] }, docs: { 'cn/broken': '{not json' } })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('x')))
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE })
  await scheduler.sync()

  assert.equal(calls.length, 0, '文档都读不出来就不该打网络')
  assert.deepEqual(scheduler.status().stats, { ok: 0, failed: 2, skipped: 0 })
  const errors = pool.calls.refreshError.map(([, uid, text]) => [uid, text])
  assert.deepEqual(errors, [
    ['missing', 'missing-document'],
    ['broken', 'invalid-json'],
  ])
})

test('KeepAliveScheduler: pool 读/写抛错 —— 读算可重试失败、写算持久化失败', async () => {
  const readPool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']), readFails: true })
  const readScheduler = new KeepAliveScheduler({ pool: readPool, fetchImpl: async () => jsonResponse(successPayload('u1')), now: () => BASE })
  await readScheduler.sync()
  assert.deepEqual(readScheduler.status().stats, { ok: 0, failed: 1, skipped: 0 })
  assert.deepEqual(readPool.calls.refreshError.at(-1), ['cn', 'u1', 'missing-document'])

  const writePool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']), writeFails: true })
  const writeScheduler = new KeepAliveScheduler({ pool: writePool, fetchImpl: async () => jsonResponse(successPayload('u1')), now: () => BASE })
  await writeScheduler.sync()
  assert.deepEqual(writeScheduler.status().stats, { ok: 0, failed: 1, skipped: 0 })
  assert.deepEqual(writePool.calls.refreshError.at(-1), ['cn', 'u1', 'persist-failed'])
})

test('KeepAliveScheduler: accountMeta 复核（扫描期间被停用 → 本轮跳过）', async () => {
  const listed = meta('u1')
  const pool = fakePool({
    accounts: { cn: [listed] },
    docs: docsFor(['u1']),
    accountMeta: async () => ({ ...listed, enabled: false }),
  })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('u1')))
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl, now: () => BASE })
  await scheduler.sync()
  assert.equal(calls.length, 0, '复核发现已停用就不该刷')
  assert.deepEqual(scheduler.status().stats, { ok: 0, failed: 0, skipped: 1 })
})

test('KeepAliveScheduler: accountMeta 抛错时退回列表里的那份，照样能刷', async () => {
  const pool = fakePool({
    accounts: { cn: [meta('u1')] },
    docs: docsFor(['u1']),
    accountMeta: async () => {
      throw new Error('meta boom')
    },
  })
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl: async () => jsonResponse(successPayload('u1')), now: () => BASE })
  await scheduler.sync()
  assert.deepEqual(scheduler.status().stats, { ok: 1, failed: 0, skipped: 0 })
})

// ─────────────────────────────────────────────────────────────────────────────
// 调度器：优雅降级
// ─────────────────────────────────────────────────────────────────────────────

test('KeepAliveScheduler: 没有 pool → unavailable=pool-missing，且不抛', async () => {
  const scheduler = new KeepAliveScheduler({ fetchImpl: async () => jsonResponse({}), now: () => BASE })
  const summary = await scheduler.sync()
  assert.equal(summary.considered, 0)
  assert.equal(scheduler.status().unavailable, 'pool-missing')
  assert.deepEqual(scheduler.status().stats, { ok: 0, failed: 0, skipped: 0 })
})

test('KeepAliveScheduler: pool 缺方法 → unavailable 指出缺什么，绝不打网络、绝不抛', async () => {
  const incomplete = {
    async list() {
      return [meta('u1')]
    },
    async readSnapshotDocument() {
      return JSON.stringify(plainDoc('u1'))
    },
  }
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('u1')))
  const scheduler = new KeepAliveScheduler({ pool: incomplete, fetchImpl, now: () => BASE })
  await scheduler.sync()
  assert.equal(calls.length, 0)
  assert.match(scheduler.status().unavailable, /^pool-incomplete:/)
  assert.match(scheduler.status().unavailable, /writeSnapshotDocument/)

  const noList = new KeepAliveScheduler({
    pool: { async readSnapshotDocument() {}, async writeSnapshotDocument() {} },
    fetchImpl,
    now: () => BASE,
  })
  await noList.sync()
  assert.equal(noList.status().unavailable, 'pool-missing-list')
})

test('KeepAliveScheduler: 没注入 fetchImpl → unavailable=fetch-missing（绝不碰真网络）', async () => {
  const pool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']) })
  const scheduler = new KeepAliveScheduler({ pool, now: () => BASE })
  await scheduler.sync()
  assert.equal(scheduler.status().unavailable, 'fetch-missing')
  assert.deepEqual(pool.calls.read, [], '连快照都不该读')
})

test('KeepAliveScheduler: pool.list 抛错 → unavailable=pool-error，不抛', async () => {
  const pool = fakePool({ listFails: true })
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl: async () => jsonResponse({}), now: () => BASE })
  const summary = await scheduler.sync()
  assert.equal(summary.considered, 0)
  assert.equal(scheduler.status().unavailable, 'pool-error')
})

test('KeepAliveScheduler: 全链路都在抛（pool + fetch + logger）也绝不抛', async () => {
  const pool = {
    async list() {
      throw new Error('list boom')
    },
    async readSnapshotDocument() {
      throw new Error('read boom')
    },
    async writeSnapshotDocument() {
      throw new Error('write boom')
    },
    async setLastRefreshError() {
      throw new Error('meta boom')
    },
    async markNeedsRelogin() {
      throw new Error('relogin boom')
    },
  }
  const scheduler = new KeepAliveScheduler({
    pool,
    fetchImpl: async () => {
      throw new Error('fetch boom')
    },
    now: () => BASE,
    logger: fakeLogger({ throwOnLog: true }),
  })
  const summary = await scheduler.sync()
  assert.equal(typeof summary.considered, 'number')
  assert.equal(scheduler.status().unavailable, 'pool-error')
})

test('KeepAliveScheduler: 只有 list 能用的残缺 pool 也不抛，只是全跳过', async () => {
  const pool = {
    async list() {
      return [meta('u1')]
    },
  }
  const scheduler = new KeepAliveScheduler({ pool, fetchImpl: async () => jsonResponse({}), now: () => BASE })
  await assert.doesNotReject(() => scheduler.sync())
  assert.match(scheduler.status().unavailable, /^pool-incomplete:/)
})

// ─────────────────────────────────────────────────────────────────────────────
// 调度器：start / stop 与定时器
// ─────────────────────────────────────────────────────────────────────────────

function timerScheduler({ uids = ['u1'], config = {}, sweepMs = 60_000 } = {}) {
  const clock = fakeClock(BASE)
  const pool = fakePool({ accounts: { cn: uids.map((uid) => meta(uid)) }, docs: docsFor(uids) })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('x')))
  const scheduler = new KeepAliveScheduler({
    pool,
    fetchImpl,
    now: clock.now,
    logger: fakeLogger(),
    config: { sweepMs, ...config, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  })
  return { clock, pool, scheduler, calls }
}

test('KeepAliveScheduler.start/stop: 不留定时器残留，stop 后 running=false', async () => {
  const { clock, scheduler } = timerScheduler()
  assert.equal(clock.pending, 0)

  scheduler.start()
  assert.equal(scheduler.status().running, true)
  assert.equal(clock.pending, 1, 'start 后恰好一个定时器')
  assert.equal(scheduler.status().nextSweepAt, BASE + 60_000)
  await flush()

  scheduler.start()
  assert.equal(clock.pending, 1, '重复 start 不得叠加定时器')

  scheduler.stop()
  assert.equal(scheduler.status().running, false)
  assert.equal(scheduler.status().nextSweepAt, null)
  assert.equal(clock.pending, 0, 'stop 后不得残留定时器')

  scheduler.stop()
  assert.equal(scheduler.status().running, false)
  assert.equal(clock.pending, 0)
})

test('KeepAliveScheduler.start: 立即扫一轮，然后每 sweepMs 一轮', async () => {
  const { clock, scheduler, calls } = timerScheduler({ sweepMs: 60_000 })
  scheduler.start()
  await flush()
  assert.equal(calls.length, 1, 'start 后立刻扫一轮')
  assert.equal(scheduler.status().lastSweepAt, BASE)
  assert.equal(clock.pending, 1)

  await clock.advance(60_000)
  assert.equal(calls.length, 2, '一个周期后再扫一轮')
  assert.equal(scheduler.status().nextSweepAt, BASE + 120_000)

  await clock.advance(60_000)
  assert.equal(calls.length, 3)
  scheduler.stop()
})

test('KeepAliveScheduler.stop: 停下后时钟再怎么走也不再扫（无残留定时器）', async () => {
  const { clock, scheduler, calls } = timerScheduler()
  scheduler.start()
  await flush()
  const settled = calls.length
  scheduler.stop()
  await clock.advance(600_000)
  assert.equal(calls.length, settled, 'stop 后不得再有自动续期请求')
  assert.equal(clock.pending, 0)
  assert.equal(scheduler.status().running, false)
})

test('KeepAliveScheduler.stop: 扫描进行中调用 stop 也不留残留（不会自己复活）', async () => {
  const clock = fakeClock(BASE)
  const pool = fakePool({ accounts: { cn: [meta('u1')] }, docs: docsFor(['u1']) })
  const gated = gatedFetch()
  const scheduler = new KeepAliveScheduler({
    pool,
    fetchImpl: gated.fetchImpl,
    now: clock.now,
    config: { sweepMs: 60_000, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  })
  scheduler.start()
  await flush()
  scheduler.stop()
  assert.equal(clock.pending, 0)
  gated.release()
  await flush()
  assert.equal(clock.pending, 0, 'stop 后正在飞的那一轮结束了也不能再排下一轮')
  assert.equal(scheduler.status().running, false)
  await clock.advance(600_000)
  assert.equal(clock.pending, 0)
})

test('KeepAliveScheduler: start 未调用时 sync() 也能手动跑（且不排定时器）', async () => {
  const { clock, scheduler, calls } = timerScheduler()
  await scheduler.sync()
  assert.equal(calls.length, 1)
  assert.equal(clock.pending, 0)
  assert.equal(scheduler.status().running, false)
  assert.equal(scheduler.status().nextSweepAt, null)
})

test('KeepAliveScheduler: start/stop/status 全流程绝不抛（坏时钟 + 坏 pool）', async () => {
  const scheduler = new KeepAliveScheduler({
    pool: fakePool({ listFails: true }),
    fetchImpl: async () => {
      throw new Error('boom')
    },
    now: () => {
      throw new Error('clock boom')
    },
    config: {
      setTimeout: () => {
        throw new Error('timer boom')
      },
      clearTimeout: () => {
        throw new Error('clear boom')
      },
    },
  })
  assert.doesNotThrow(() => scheduler.start())
  await flush()
  assert.doesNotThrow(() => scheduler.stop())
  assert.equal(scheduler.status().running, false)
  assert.equal(typeof scheduler.status().lastSweepAt, 'number')
})

// ─────────────────────────────────────────────────────────────────────────────
// 正/反向共用的行为断言（反向测试靠它们「吃劲」）
// ─────────────────────────────────────────────────────────────────────────────

/** 断言 1：刷新头必须逐字带 X-Auth-Refresh-Source: plugin。 */
async function assertRefreshSourceHeader(mod) {
  const headers = mod.refreshHeaders({
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    uid: 'u-1',
    enterpriseId: 'ent-1',
    domain: 'www.workbuddy.cn',
  })
  assert.equal(headers['X-Auth-Refresh-Source'], 'plugin', '必须逐字带 X-Auth-Refresh-Source: plugin')
  assert.equal(headers['X-Refresh-Token'], 'rt-1')
  assert.equal(headers.Authorization, 'Bearer at-1')
  assert.equal(headers['X-User-Id'], 'u-1')
  assert.equal(headers['X-Enterprise-Id'], 'ent-1')
  assert.equal(headers['X-Tenant-Id'], 'ent-1')
  assert.equal(headers['X-Domain'], 'www.workbuddy.cn')
}

/** 断言 2：加密信封账号既不标 needsRelogin、也不打网络。 */
async function assertEncryptedIsQuiet(mod) {
  let calls = 0
  const result = await mod.refreshDocument({
    variantKey: 'cn',
    document: encDoc('u1'),
    now: BASE,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse(successPayload('u1'))
    },
  })
  assert.deepEqual(
    result,
    { ok: false, terminal: false, needsRelogin: false, error: 'encrypted-credential' },
    '加密信封账号的结果形状必须逐字固定',
  )
  assert.equal(result.needsRelogin, false, '加密信封账号绝不能被标 needsRelogin')
  assert.equal(calls, 0, '加密信封账号绝不打网络')
}

/** 断言 3：同一轮并发不得超过 concurrency。 */
async function assertConcurrencyCapped(mod) {
  const uids = ['u1', 'u2', 'u3', 'u4', 'u5']
  const pool = fakePool({ accounts: { cn: uids.map((uid) => meta(uid)) }, docs: docsFor(uids) })
  const gated = gatedFetch()
  const scheduler = new mod.KeepAliveScheduler({
    pool,
    fetchImpl: gated.fetchImpl,
    now: () => BASE,
    config: { concurrency: 2 },
  })
  const running = scheduler.sync()
  await flush()
  const observed = gated.state.max
  gated.release()
  await running
  assert.equal(observed, 2, '同一轮并发不得超过 concurrency（concurrency=2）')
  assert.ok(observed <= 2, `观测到的并发 ${observed} 超过上限 2`)
}

test('（正向对照）三处行为断言在原始实现上必须为真', async () => {
  await assertRefreshSourceHeader(keepalive)
  await assertEncryptedIsQuiet(keepalive)
  await assertConcurrencyCapped(keepalive)
})

// ─────────────────────────────────────────────────────────────────────────────
// 反向（变异）测试
//
// 做法：把源码做**定向文本突变**写成临时模块，import 后用上面**同一套断言**跑，
// 断言它现在必须因断言失败而红。突变没生效（锚点漂移）时测试直接红，不允许静默通过。
// ─────────────────────────────────────────────────────────────────────────────

const MUTATION_DIR = await mkdtemp(join(tmpdir(), 'keepalive-mutation-'))

async function loadMutated({ anchor, from, to, subs, name }) {
  const source = await readFile(KEEPALIVE_PATH, 'utf8')
  const edits = Array.isArray(subs) ? subs : [{ anchor, from, to }]
  let mutated = source
  for (const [index, edit] of edits.entries()) {
    if (edit.anchor) {
      assert.ok(mutated.includes(edit.anchor), `突变锚点已漂移：${edit.anchor} —— lib/keepalive.js 改了逻辑就必须同步更新本测试`)
    }
    assert.ok(mutated.includes(edit.from), `突变的原文找不到（第 ${index + 1} 处）：${JSON.stringify(edit.from)}`)
    const before = mutated
    mutated = mutated.replace(edit.from, edit.to)
    assert.notEqual(mutated, before, `突变没有生效（第 ${index + 1} 处）`)
  }
  const file = join(MUTATION_DIR, `keepalive.${name}.mjs`)
  await writeFile(file, mutated)
  return import(pathToFileURL(file).href)
}

test('反向: 删掉 X-Auth-Refresh-Source 头 → 刷新头断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'no-refresh-source',
    anchor: '/* [anchor:refresh-source]',
    from: "  headers['X-Auth-Refresh-Source'] = 'plugin'\n",
    to: '',
  })
  assert.equal(mod.refreshHeaders({ accessToken: 'a', refreshToken: 'r' })['X-Auth-Refresh-Source'], undefined, '突变版确实没有这个头了')
  await assert.rejects(assertRefreshSourceHeader(mod), /X-Auth-Refresh-Source/)
})

test('反向: 把 encrypted 分支改成标 needsRelogin → 加密账号断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'encrypted-relogin',
    anchor: '/* [anchor:encrypted]',
    from: "    return { ok: false, terminal: false, needsRelogin: false, error: 'encrypted-credential' }",
    to: "    return { ok: false, terminal: false, needsRelogin: true, error: 'encrypted-credential' }",
  })
  const probe = await mod.refreshDocument({ variantKey: 'cn', document: encDoc('u1'), now: BASE })
  assert.equal(probe.needsRelogin, true, '突变版确实会误标 needsRelogin')
  await assert.rejects(assertEncryptedIsQuiet(mod), /needsRelogin|deep-equal/)
})

test('反向: 去掉并发上限 → 并发断言必须失败', async () => {
  const mod = await loadMutated({
    name: 'no-concurrency-limit',
    anchor: '/* [anchor:concurrency]',
    from: 'const limit = Math.max(1, Math.min(cfg.concurrency, items.length))',
    to: 'const limit = Math.max(1, items.length)',
  })
  await assert.rejects(assertConcurrencyCapped(mod), /并发不得超过|超过上限/)
})

test('反向: 删掉 X-Auth-Refresh-Source 头后，端到端刷新的请求头断言也必须失败', async () => {
  const mod = await loadMutated({
    name: 'no-refresh-source-e2e',
    anchor: '/* [anchor:refresh-source]',
    from: "  headers['X-Auth-Refresh-Source'] = 'plugin'\n",
    to: '',
  })
  const { fetchImpl, calls } = recordingFetch(async () => jsonResponse(successPayload('u1')))
  await mod.refreshDocument({ variantKey: 'cn', document: plainDoc('u1'), fetchImpl, now: BASE })
  assert.equal(calls[0].init.headers['X-Auth-Refresh-Source'], undefined)
  assert.throws(
    () => assert.equal(calls[0].init.headers['X-Auth-Refresh-Source'], 'plugin', '缺 X-Auth-Refresh-Source 会让国际版返回 code 12153'),
    /X-Auth-Refresh-Source/,
  )
})

test('反向: 把 encrypted 分支改成标 needsRelogin 后，调度器层面也必须断言失败', async () => {
  // 两处一起突变：只改 refreshDocument 的返回值会被调度器里的 encrypted 豁免吞掉，
  // 那样这条反向测试就观测不到任何「错误行为」，也就证明不了断言真的在守着它。
  const mod = await loadMutated({
    name: 'encrypted-relogin-scheduler',
    subs: [
      {
        anchor: '/* [anchor:encrypted]',
        from: "    return { ok: false, terminal: false, needsRelogin: false, error: 'encrypted-credential' }",
        to: "    return { ok: false, terminal: false, needsRelogin: true, error: 'encrypted-credential' }",
      },
      {
        from: `      if (result.error === 'encrypted-credential') {
        // 加密信封账号：记一笔给 UI 看，但**不标 needsRelogin、不进退避**（重试无意义）。
        await this.#setLastRefreshError(variant.key, uid, 'encrypted-credential')
        return 'skipped'
      }
`,
        to: `      // （突变：去掉调度器里对加密信封账号的豁免）
`,
      },
    ],
  })

  const pool = fakePool({ accounts: { cn: [meta('u-enc')] }, docs: { 'cn/u-enc': JSON.stringify(encDoc('u-enc')) } })
  const scheduler = new mod.KeepAliveScheduler({
    pool,
    fetchImpl: async () => jsonResponse(successPayload('u-enc')),
    now: () => BASE,
  })
  await scheduler.sync()

  // 突变后的错误行为：既标了 needsRelogin，又把它算进了失败/退避（重试轰炸）。
  const needRelogin = pool.calls.needsRelogin.length
  const failed = scheduler.status().stats.failed
  assert.equal(needRelogin, 1, '突变版会给加密账号打上「需重新登录」（错误行为）')
  assert.equal(failed, 1, '突变版会把加密账号算成失败并进重试退避（错误行为）')

  // 两条不变式都必须因断言失败而红。
  assert.throws(
    () => assert.deepEqual(pool.calls.needsRelogin, [], '加密信封账号绝不能被标 needsRelogin'),
    /needsRelogin/,
  )
  assert.throws(
    () => assert.equal(scheduler.status().stats.failed, 0, '加密信封账号绝不进退避、绝不重试轰炸'),
    /needsRelogin|重试轰炸/,
  )
})

test('反向: 去掉并发上限后，并发峰值观测值必须超过 2（证明断言真的在测并发）', async () => {
  const mod = await loadMutated({
    name: 'no-concurrency-limit-peek',
    anchor: '/* [anchor:concurrency]',
    from: 'const limit = Math.max(1, Math.min(cfg.concurrency, items.length))',
    to: 'const limit = Math.max(1, items.length)',
  })
  const uids = ['u1', 'u2', 'u3', 'u4', 'u5']
  const pool = fakePool({ accounts: { cn: uids.map((uid) => meta(uid)) }, docs: docsFor(uids) })
  const gated = gatedFetch()
  const scheduler = new mod.KeepAliveScheduler({ pool, fetchImpl: gated.fetchImpl, now: () => BASE, config: { concurrency: 2 } })
  const running = scheduler.sync()
  await flush()
  const observed = gated.state.max
  gated.release()
  await running
  assert.equal(observed, 5, '突变版会把 5 个账号一次性全发出去')
})
