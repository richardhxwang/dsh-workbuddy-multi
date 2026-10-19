/**
 * lib/login.js 单测 —— **纯单测：绝不打真网络、绝不读真人 auth 文件**。
 *
 * fetchImpl 与 now 全部注入：假 fetch 按「脚本」或「路径路由」应答，且记录每次调用，
 * 因此「有没有多发一次请求」「header 里到底写了什么」都是可断言的。
 *
 * 运行：node --test test/login.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LOGIN_VARIANTS,
  LOGIN_TIMEOUT_MS,
  PENDING_HINT_CODE,
  isAiDomain,
  domainMatchesVariant,
  normalizeTokenPayload,
  buildAccountDocument,
  WorkBuddyLoginManager,
} from '../lib/login.js'

// ── 夹具 ────────────────────────────────────────────────────────────────

const BASE = 1_700_000_000_000

/** 可控时钟：默认冻结在 BASE，绝不使用真实时间。 */
function clock(start = BASE) {
  let t = start
  const now = () => t
  now.set = (v) => {
    t = v
  }
  now.advance = (ms) => {
    t += ms
  }
  return now
}

/** 收集日志，避免测试往 stdout 打 warn；同时断言「日志里不能出现 token」。 */
function recorder() {
  const entries = []
  const push = (level) => (message, detail) => entries.push({ level, message, detail })
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

function response(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { ok: status >= 200 && status < 300, status, async text() { return text } }
}

/**
 * 假 fetch。`plan` 可以是：
 *  - 数组：按调用序号取脚本项（`undefined` 表示「不该有这次请求」→ 抛错）
 *  - 函数：`(url, opts, index) => 脚本项`
 * 脚本项 = `{body, status?}` 或一个 Error（模拟网络失败）。
 */
function makeFetch(plan) {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    const index = calls.length
    calls.push({ url, method: opts.method, headers: opts.headers ?? {}, body: opts.body, signal: opts.signal })
    const step = typeof plan === 'function' ? plan(url, opts, index) : plan[index]
    if (step === undefined) throw new Error(`unexpected fetch #${index + 1}: ${url}`)
    if (step instanceof Error) throw step
    return response(step.body, step.status ?? 200)
  }
  return { fetchImpl, calls }
}

/**
 * 按路径分发的假 fetch；未命中的请求会抛错（于是断言 calls.length 就能抓到多发请求）。
 * `routes[].body` 可以是响应体，也可以是 `(url, opts) => 响应体`。
 */
function routeFetch(routes) {
  return makeFetch((url, opts) => {
    for (const r of routes) {
      if (url.includes(r.path)) {
        return { body: typeof r.body === 'function' ? r.body(url, opts) : r.body, status: r.status ?? 200 }
      }
    }
    return undefined
  })
}

const STATE_AI = {
  code: 0,
  requestId: 'req-state-ai',
  data: { state: 'state-ai-1', authUrl: 'https://www.workbuddy.ai/login?platform=workbuddy-ai&state=state-ai-1' },
}
const STATE_CN = {
  code: 0,
  requestId: 'req-state-cn',
  data: { state: 'state-cn-1', authUrl: 'https://www.codebuddy.cn/login?platform=workbuddy&state=state-cn-1' },
}

function pendingBody(code = PENDING_HINT_CODE, msg = '11217:login ing...') {
  const body = { code, requestId: 'req-pending' }
  if (msg !== undefined) body.msg = msg
  return body
}

function tokenBody(data = {}) {
  return {
    code: 0,
    requestId: 'req-token',
    data: {
      accessToken: 'at-secret',
      refreshToken: 'rt-secret',
      domain: 'www.workbuddy.ai',
      expiresIn: 3600,
      refreshExpiresIn: 86400,
      tokenType: 'Bearer',
      ...data,
    },
  }
}

function accountBody(data = {}) {
  return {
    code: 0,
    requestId: 'req-account',
    data: {
      uid: 'uid-1',
      nickname: 'nick-1',
      email: 'nick@example.com',
      enterpriseId: 'ent-1',
      enterpriseName: 'Acme',
      domain: 'www.workbuddy.ai',
      ...data,
    },
  }
}

/** 开一个 ai 档位会话并返回 {manager, calls, loginId}。 */
async function startedAi(plan) {
  const { fetchImpl, calls } = makeFetch(plan)
  const manager = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: recorder() })
  const started = await manager.start('ai')
  return { manager, calls, loginId: started.loginId, started }
}

// ── 冻结常量 ────────────────────────────────────────────────────────────

test('LOGIN_VARIANTS: 逐字照 PLAN §3.5.0 的实测表', () => {
  assert.deepEqual(LOGIN_VARIANTS, {
    cn: { key: 'cn', endpoint: 'https://www.codebuddy.cn', platform: 'workbuddy', apiPrefix: '/v2/plugin' },
    ai: { key: 'ai', endpoint: 'https://www.workbuddy.ai', platform: 'workbuddy-ai', apiPrefix: '/v2/plugin' },
  })
})

test('冻结常量: LOGIN_TIMEOUT_MS = 600000 秒级倒计时，PENDING_HINT_CODE = 11217', () => {
  assert.equal(LOGIN_TIMEOUT_MS, 600_000)
  assert.equal(PENDING_HINT_CODE, 11217)
})

// ── isAiDomain / domainMatchesVariant ───────────────────────────────────

test('isAiDomain: 去空白 + 小写后按 .workbuddy.ai / .codebuddy.ai 后缀判定', () => {
  assert.equal(isAiDomain('  WWW.WorkBuddy.AI  '), true)
  assert.equal(isAiDomain('www.workbuddy.ai'), true)
  assert.equal(isAiDomain('www.codebuddy.ai'), true)
  assert.equal(isAiDomain(' WWW.CodeBuddy.AI '), true)
  assert.equal(isAiDomain('www.workbuddy.cn'), false)
  assert.equal(isAiDomain('www.codebuddy.cn'), false)
  assert.equal(isAiDomain(''), false)
  assert.equal(isAiDomain('   '), false)
  assert.equal(isAiDomain(undefined), false)
  assert.equal(isAiDomain(null), false)
  assert.equal(isAiDomain({ $wbEncrypted: 1 }), false)
})

test('isAiDomain: 后缀白名单挡住拼接域名（ai.evil.com 一律不算）', () => {
  assert.equal(isAiDomain('www.workbuddy.ai.evil.com'), false)
  assert.equal(isAiDomain('www.codebuddy.ai.evil.com'), false)
  assert.equal(isAiDomain('workbuddy.ai.evil.com'), false)
  assert.equal(isAiDomain('workbuddy.ai'), false) // 必须带前导点，裸后缀不算
})

test('domainMatchesVariant: 空 / 认不出 → 不阻断', () => {
  assert.equal(domainMatchesVariant('ai', ''), true)
  assert.equal(domainMatchesVariant('ai', '   '), true)
  assert.equal(domainMatchesVariant('ai', undefined), true)
  assert.equal(domainMatchesVariant('ai', null), true)
  assert.equal(domainMatchesVariant('cn', undefined), true)
  assert.equal(domainMatchesVariant('ai', { $wbEncrypted: 1, envelope: 'x' }), true)
})

test('domainMatchesVariant: ai 档位收到国内域名必须判不符', () => {
  assert.equal(domainMatchesVariant('ai', 'www.workbuddy.ai'), true)
  assert.equal(domainMatchesVariant('ai', ' WWW.WorkBuddy.AI '), true)
  assert.equal(domainMatchesVariant('ai', 'www.codebuddy.ai'), true)
  assert.equal(domainMatchesVariant('ai', 'www.codebuddy.cn'), false)
  assert.equal(domainMatchesVariant('ai', 'www.workbuddy.cn'), false)
  assert.equal(domainMatchesVariant('ai', 'www.codebuddy.ai.evil.com'), false)
  assert.equal(domainMatchesVariant('ai', 'www.workbuddy.ai.evil.com'), false)
})

test('domainMatchesVariant: cn 档位收到国际域名必须判不符', () => {
  assert.equal(domainMatchesVariant('cn', 'www.workbuddy.cn'), true)
  assert.equal(domainMatchesVariant('cn', 'www.codebuddy.cn'), true)
  assert.equal(domainMatchesVariant('cn', 'www.workbuddy.ai'), false)
  assert.equal(domainMatchesVariant('cn', 'www.codebuddy.ai'), false)
})

// ── normalizeTokenPayload ───────────────────────────────────────────────

test('normalizeTokenPayload: camel 命名 + epoch 毫秒原样保留', () => {
  const r = normalizeTokenPayload(
    {
      accessToken: 'at',
      refreshToken: 'rt',
      domain: 'www.workbuddy.ai',
      expiresAt: BASE + 1_000,
      refreshExpiresAt: BASE + 2_000,
      tokenType: 'Bearer',
    },
    BASE,
  )
  assert.deepEqual(r, {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: BASE + 1_000,
    refreshExpiresAtMs: BASE + 2_000,
    domain: 'www.workbuddy.ai',
    tokenType: 'Bearer',
  })
})

test('normalizeTokenPayload: snake_case 命名 + epoch 秒 → 毫秒', () => {
  const r = normalizeTokenPayload(
    {
      access_token: 'at',
      refresh_token: 'rt',
      domain: 'www.workbuddy.cn',
      expires_at: 1_700_000_000,
      refresh_expires_at: 1_700_100_000,
      token_type: 'Bearer',
    },
    BASE,
  )
  assert.equal(r.accessToken, 'at')
  assert.equal(r.refreshToken, 'rt')
  assert.equal(r.expiresAtMs, 1_700_000_000_000)
  assert.equal(r.refreshExpiresAtMs, 1_700_100_000_000)
  assert.equal(r.tokenType, 'Bearer')
})

test('normalizeTokenPayload: expiresIn / refreshExpiresIn 是秒 → now + n*1000', () => {
  const r = normalizeTokenPayload({ accessToken: 'at', expiresIn: 3600, refreshExpiresIn: 7200 }, BASE)
  assert.equal(r.expiresAtMs, BASE + 3_600_000)
  assert.equal(r.refreshExpiresAtMs, BASE + 7_200_000)
})

test('normalizeTokenPayload: 绝对量优先于 expiresIn', () => {
  const r = normalizeTokenPayload({ accessToken: 'at', expiresAt: BASE + 111, expiresIn: 999 }, BASE)
  assert.equal(r.expiresAtMs, BASE + 111)
})

test('normalizeTokenPayload: ISO 字符串也认', () => {
  const r = normalizeTokenPayload({ accessToken: 'at', expiresAt: '2030-01-01T00:00:00.000Z' }, BASE)
  assert.equal(r.expiresAtMs, Date.parse('2030-01-01T00:00:00.000Z'))
})

test('normalizeTokenPayload: 缺失字段是 undefined，且六键恒在', () => {
  const r = normalizeTokenPayload({}, BASE)
  assert.deepEqual(Object.keys(r), [
    'accessToken',
    'refreshToken',
    'expiresAtMs',
    'refreshExpiresAtMs',
    'domain',
    'tokenType',
  ])
  assert.deepEqual(r, {
    accessToken: undefined,
    refreshToken: undefined,
    expiresAtMs: undefined,
    refreshExpiresAtMs: undefined,
    domain: undefined,
    tokenType: undefined,
  })
})

test('normalizeTokenPayload: 空白 token 视为缺失，绝不写出空串', () => {
  const r = normalizeTokenPayload({ accessToken: '   ', refreshToken: '' }, BASE)
  assert.equal(r.accessToken, undefined)
  assert.equal(r.refreshToken, undefined)
})

test('normalizeTokenPayload: CN 加密信封对象原样保留', () => {
  const envelope = { $wbEncrypted: 1, envelope: 'ZmFrZQ==' }
  const r = normalizeTokenPayload({ accessToken: envelope, refreshToken: envelope }, BASE)
  assert.deepEqual(r.accessToken, envelope)
  assert.deepEqual(r.refreshToken, envelope)
})

test('normalizeTokenPayload: 非法 data 不炸', () => {
  assert.equal(normalizeTokenPayload(undefined, BASE).accessToken, undefined)
  assert.equal(normalizeTokenPayload(null, BASE).domain, undefined)
  assert.equal(normalizeTokenPayload('nope', BASE).accessToken, undefined)
  assert.equal(normalizeTokenPayload(42, BASE).refreshToken, undefined)
})

// ── buildAccountDocument ────────────────────────────────────────────────

test('buildAccountDocument: 完整文档形状（expiresAt 写 epoch 毫秒）', () => {
  const token = normalizeTokenPayload(tokenBody().data, BASE)
  const doc = buildAccountDocument({ variantKey: 'ai', token, profile: accountBody().data, now: BASE })
  assert.deepEqual(doc, {
    auth: {
      accessToken: 'at-secret',
      refreshToken: 'rt-secret',
      expiresAt: BASE + 3_600_000,
      refreshExpiresAt: BASE + 86_400_000,
      domain: 'www.workbuddy.ai',
      tokenType: 'Bearer',
    },
    account: {
      uid: 'uid-1',
      nickname: 'nick-1',
      email: 'nick@example.com',
      enterpriseId: 'ent-1',
      enterpriseName: 'Acme',
    },
    accounts: [],
    allAccounts: [],
    source: 'multi',
    version: 1,
  })
})

test('buildAccountDocument: 缺失字段直接不写，不写 null', () => {
  const doc = buildAccountDocument({
    variantKey: 'ai',
    token: { accessToken: 'at' },
    profile: { uid: 'uid-1', nickname: 'nick-1' },
  })
  assert.deepEqual(Object.keys(doc.auth), ['accessToken'])
  assert.deepEqual(Object.keys(doc.account), ['uid', 'nickname'])
  assert.equal('email' in doc.account, false)
  assert.equal('expiresAt' in doc.auth, false)
  assert.equal(JSON.stringify(doc).includes('null'), false)
})

test('buildAccountDocument: token.domain 缺失时回落到 profile.domain', () => {
  const doc = buildAccountDocument({ token: { accessToken: 'at' }, profile: { uid: 'u', domain: 'www.workbuddy.cn' } })
  assert.equal(doc.auth.domain, 'www.workbuddy.cn')
})

test('buildAccountDocument: 全空输入给出空 auth/account 而不是 null', () => {
  assert.deepEqual(buildAccountDocument({}), {
    auth: {},
    account: {},
    accounts: [],
    allAccounts: [],
    source: 'multi',
    version: 1,
  })
  assert.deepEqual(buildAccountDocument(), {
    auth: {},
    account: {},
    accounts: [],
    allAccounts: [],
    source: 'multi',
    version: 1,
  })
})

test('buildAccountDocument: snake_case 的 enterprise 字段也认', () => {
  const doc = buildAccountDocument({
    token: { accessToken: 'at' },
    profile: { uid: 'u', enterprise_id: 'e1', enterprise_name: 'Acme', nickname: { $wbEncrypted: 1, envelope: 'x' } },
  })
  assert.equal(doc.account.enterpriseId, 'e1')
  assert.equal(doc.account.enterpriseName, 'Acme')
  assert.deepEqual(doc.account.nickname, { $wbEncrypted: 1, envelope: 'x' })
})

// ── start ───────────────────────────────────────────────────────────────

test('start: cn 档位拿到 state 与 authUrl，并按 LOGIN_TIMEOUT_MS 定 expiresAt', async () => {
  const now = clock()
  const { fetchImpl, calls } = makeFetch([{ body: STATE_CN }])
  const m = new WorkBuddyLoginManager({ fetchImpl, now, logger: recorder() })
  const r = await m.start('cn')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://www.codebuddy.cn/v2/plugin/auth/state?platform=workbuddy')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].body, '{}')
  assert.deepEqual(calls[0].headers, { Accept: 'application/json', 'Content-Type': 'application/json' })
  assert.ok(calls[0].signal, '必须带 AbortSignal')
  assert.deepEqual(r, {
    loginId: r.loginId,
    variantKey: 'cn',
    verificationUri: 'https://www.codebuddy.cn/login?platform=workbuddy&state=state-cn-1',
    state: 'state-cn-1',
    startedAt: BASE,
    expiresAt: BASE + LOGIN_TIMEOUT_MS,
    expiresIn: 600,
  })
  assert.match(r.loginId, /^wbm_[0-9a-f]{32}$/)
})

test('start: ai 档位用国际版端点与 platform', async () => {
  const { fetchImpl, calls } = makeFetch([{ body: STATE_AI }])
  const m = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: recorder() })
  const r = await m.start('ai')
  assert.equal(calls[0].url, 'https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai')
  assert.equal(r.variantKey, 'ai')
  assert.equal(r.verificationUri, STATE_AI.data.authUrl)
  assert.equal(r.state, 'state-ai-1')
  assert.equal(r.expiresIn, 600)
})

test('start: 未开扫码时 state 立刻进 list()', async () => {
  const { fetchImpl } = makeFetch([{ body: STATE_AI }])
  const now = clock()
  const m = new WorkBuddyLoginManager({ fetchImpl, now, logger: recorder() })
  const r = await m.start('ai')
  assert.deepEqual(m.list(), [
    {
      loginId: r.loginId,
      variantKey: 'ai',
      verificationUri: STATE_AI.data.authUrl,
      startedAt: BASE,
      expiresAt: BASE + LOGIN_TIMEOUT_MS,
    },
  ])
})

test('start: timeoutMs 可注入，expiresAt / expiresIn 跟着变', async () => {
  const { fetchImpl } = makeFetch([{ body: STATE_AI }])
  const m = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: recorder(), timeoutMs: 90_000 })
  const r = await m.start('ai')
  assert.equal(r.expiresAt, BASE + 90_000)
  assert.equal(r.expiresIn, 90)
})

test('start: 未知档位抛错', async () => {
  const { fetchImpl, calls } = makeFetch([])
  const m = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: recorder() })
  await assert.rejects(() => m.start('eu'), /unknown login variant/)
  await assert.rejects(() => m.start(undefined), /unknown login variant/)
  assert.equal(calls.length, 0)
})

test('start: code 非 0 → 抛错并带上服务端 msg', async () => {
  const { fetchImpl } = makeFetch([{ body: { code: 500, msg: 'boom' } }])
  const m = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: recorder() })
  await assert.rejects(() => m.start('ai'), /code 500 boom/)
})

test('start: 缺 state / 缺 authUrl / 非 JSON 各自抛错且不建会话', async () => {
  const cases = [
    [{ body: { code: 0, data: { authUrl: 'https://x/y' } } }, /missing state/],
    [{ body: { code: 0, data: { state: 's' } } }, /missing authUrl/],
    [{ body: '<!doctype html>' }, /not a JSON object/],
    [{ body: '' }, /not a JSON object/],
  ]
  for (const [step, re] of cases) {
    const { fetchImpl } = makeFetch([step])
    const m = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: recorder() })
    await assert.rejects(() => m.start('ai'), re)
    assert.deepEqual(m.list(), [])
  }
})

test('start: 网络错误直接抛（冻结签名没有错误返回位）', async () => {
  const { fetchImpl } = makeFetch([new Error('socket hang up')])
  const m = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: recorder() })
  await assert.rejects(() => m.start('ai'), /socket hang up/)
})

// ── poll: 未完成 ────────────────────────────────────────────────────────

test('poll: 未扫码 code 11217 → {done:false, status} 用服务端 msg', async () => {
  const { manager, loginId, calls } = await startedAi([{ body: STATE_AI }, { body: pendingBody() }])
  const r = await manager.poll(loginId)
  assert.deepEqual(r, { done: false, status: '11217:login ing...' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'https://www.workbuddy.ai/v2/plugin/auth/token?state=state-ai-1')
  assert.equal(calls[1].method, 'GET')
  assert.equal(calls[1].body, undefined)
})

test('poll: 11217 但没有 msg → 用 PENDING_HINT_CODE 兜一个稳定 status', async () => {
  const { manager, loginId } = await startedAi([
    { body: STATE_AI },
    { body: { code: 11217, requestId: 'req-pending' } },
  ])
  assert.deepEqual(await manager.poll(loginId), { done: false, status: 'login-pending' })
})

test('poll: code 非 0/200 → 未完成，透出 msg', async () => {
  const { manager, loginId } = await startedAi([{ body: STATE_AI }, { body: { code: 403, msg: 'forbidden' } }])
  assert.deepEqual(await manager.poll(loginId), { done: false, status: 'forbidden' })
})

test('poll: code 非 0/200 且没有 msg → status 形如 code:<code>', async () => {
  const { manager, loginId } = await startedAi([{ body: STATE_AI }, { body: { code: 500 } }])
  assert.deepEqual(await manager.poll(loginId), { done: false, status: 'code:500' })
})

test('poll: code 是数字字符串 "200" 也算成功', async () => {
  const { manager, loginId } = await startedAi([
    { body: STATE_AI },
    { body: { code: '200', data: { accessToken: 'at', domain: 'www.workbuddy.ai' } } },
    { body: accountBody() },
  ])
  const r = await manager.poll(loginId)
  assert.equal(r.done, true)
  assert.equal(r.ok, true)
})

test('poll: 非 JSON / 空响应体 → 未完成，不炸', async () => {
  const bodies = ['<html>502</html>', '', '   ', '[1,2,3]', '{"code":']
  for (const body of bodies) {
    const { manager, loginId } = await startedAi([{ body: STATE_AI }, { body }])
    const r = await manager.poll(loginId)
    assert.deepEqual(r, { done: false, status: 'non-json-response' })
  }
})

test('poll: 网络错误 → 未完成并透出错误信息', async () => {
  const { manager, loginId } = await startedAi([{ body: STATE_AI }, new Error('socket hang up')])
  const r = await manager.poll(loginId)
  assert.equal(r.done, false)
  assert.match(r.status, /^network-error: socket hang up$/)
})

test('poll: 未完成的结果不进终态缓存（下一次仍会重新请求）', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: pendingBody() },
    { body: pendingBody() },
  ])
  assert.equal((await manager.poll(loginId)).done, false)
  assert.equal((await manager.poll(loginId)).done, false)
  assert.equal(calls.length, 3)
})

// ── poll: 成功两步 ──────────────────────────────────────────────────────

test('poll: 成功路径 = token 换凭据 + account 取信息，两端点与请求头都对', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: tokenBody() },
    { body: accountBody() },
  ])
  const r = await manager.poll(loginId)

  assert.equal(calls.length, 3)
  assert.equal(calls[1].url, 'https://www.workbuddy.ai/v2/plugin/auth/token?state=state-ai-1')
  assert.deepEqual(calls[1].headers, { Accept: 'application/json' })
  assert.equal(calls[2].url, 'https://www.workbuddy.ai/v2/plugin/login/account?state=state-ai-1')
  assert.equal(calls[2].method, 'GET')
  assert.equal(calls[2].headers.Authorization, 'Bearer at-secret')
  assert.equal(calls[2].headers['X-Domain'], 'www.workbuddy.ai')

  assert.equal(r.done, true)
  assert.equal(r.ok, true)
  assert.equal(r.variantKey, 'ai')
  assert.equal(r.terminal, undefined)
  assert.deepEqual(r.meta, { uid: 'uid-1', nickname: 'nick-1', email: 'nick@example.com' })
  assert.deepEqual(r.document, {
    auth: {
      accessToken: 'at-secret',
      refreshToken: 'rt-secret',
      expiresAt: BASE + 3_600_000,
      refreshExpiresAt: BASE + 86_400_000,
      domain: 'www.workbuddy.ai',
      tokenType: 'Bearer',
    },
    account: {
      uid: 'uid-1',
      nickname: 'nick-1',
      email: 'nick@example.com',
      enterpriseId: 'ent-1',
      enterpriseName: 'Acme',
    },
    accounts: [],
    allAccounts: [],
    source: 'multi',
    version: 1,
  })
})

test('poll 成功: meta 只含 uid/nickname/email，绝不含 token', async () => {
  const { manager, loginId } = await startedAi([{ body: STATE_AI }, { body: tokenBody() }, { body: accountBody() }])
  const r = await manager.poll(loginId)
  assert.equal(r.done, true, '先钉住终态形状：守卫若把 ai 误判成 cn，这里必须断言失败而不是 TypeError')
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(r.meta).sort(), ['email', 'nickname', 'uid'])
  const flat = JSON.stringify(r.meta)
  assert.equal(flat.includes('at-secret'), false)
  assert.equal(flat.includes('rt-secret'), false)
  assert.equal(flat.includes('$wbEncrypted'), false)
})

test('poll 成功: 日志里不能出现 token', async () => {
  const logs = recorder()
  const { fetchImpl } = makeFetch([{ body: STATE_AI }, { body: tokenBody() }, { body: accountBody() }])
  const m = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: logs })
  const s = await m.start('ai')
  await m.poll(s.loginId)
  const flat = JSON.stringify(logs.entries)
  assert.equal(flat.includes('at-secret'), false)
  assert.equal(flat.includes('rt-secret'), false)
  assert.ok(logs.entries.length > 0)
})

test('poll 成功: snake_case + epoch 秒端到端换算成毫秒', async () => {
  const { manager, loginId } = await startedAi([
    { body: STATE_AI },
    {
      body: {
        code: 200,
        data: {
          access_token: 'at-2',
          refresh_token: 'rt-2',
          domain: 'www.workbuddy.ai',
          expires_at: 1_700_000_000,
          refresh_expires_at: 1_700_200_000,
        },
      },
    },
    { body: accountBody() },
  ])
  const r = await manager.poll(loginId)
  assert.equal(r.done, true, '先钉住终态形状：守卫若把 ai 误判成 cn，这里必须断言失败而不是 TypeError')
  assert.equal(r.ok, true)
  assert.equal(r.document.auth.accessToken, 'at-2')
  assert.equal(r.document.auth.refreshToken, 'rt-2')
  assert.equal(r.document.auth.expiresAt, 1_700_000_000_000)
  assert.equal(r.document.auth.refreshExpiresAt, 1_700_200_000_000)
})

test('poll 成功: token 没有 domain 时不发 X-Domain 头（也不阻断）', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: { code: 0, data: { accessToken: 'at-3' } } },
    { body: accountBody() },
  ])
  const r = await manager.poll(loginId)
  assert.equal(r.ok, true)
  assert.equal('X-Domain' in calls[2].headers, false)
  assert.equal(r.document.auth.domain, 'www.workbuddy.ai') // 回落到 profile.domain
})

test('poll 成功: account 里的 nickname 是加密信封也照样入库', async () => {
  const envelope = { $wbEncrypted: 1, envelope: 'ZmFrZQ==' }
  const { manager, loginId } = await startedAi([
    { body: STATE_AI },
    { body: tokenBody() },
    { body: accountBody({ nickname: envelope }) },
  ])
  const r = await manager.poll(loginId)
  assert.equal(r.done, true, '先钉住终态形状：守卫若把 ai 误判成 cn，这里必须断言失败而不是 TypeError')
  assert.equal(r.ok, true)
  assert.deepEqual(r.document.account.nickname, envelope)
  assert.deepEqual(r.meta.nickname, envelope)
})

test('poll 成功: account 非 JSON / code 非 0 → 未完成（可重试），不当终态', async () => {
  const first = await startedAi([
    { body: STATE_AI },
    { body: tokenBody() },
    { body: '<html>oops</html>' },
  ])
  assert.deepEqual(await first.manager.poll(first.loginId), { done: false, status: 'non-json-response' })
  assert.equal(first.manager.list().length, 1, '未完成时必须还留在 list 里')

  const second = await startedAi([
    { body: STATE_AI },
    { body: tokenBody() },
    { body: { code: 500, msg: 'account down' } },
  ])
  assert.deepEqual(await second.manager.poll(second.loginId), { done: false, status: 'account down' })
})

// ── 档位一致性守卫 ──────────────────────────────────────────────────────

test('档位守卫①: ai 档位收到国内 domain 必须拒绝入库，且不再请求 account', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: tokenBody({ domain: 'www.codebuddy.cn' }) },
    { body: accountBody() },
  ])
  const r = await manager.poll(loginId)
  assert.deepEqual(r, { done: true, ok: false, error: 'domain-mismatch', terminal: true })
  assert.equal(calls.length, 2, '守卫命中后不得再打 account 端点')
  assert.equal('document' in r, false)
})

test('档位守卫②: token 无 domain 但 account 回国内 domain → 同样拒绝', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: { code: 0, data: { accessToken: 'at-4' } } },
    { body: accountBody({ domain: 'www.codebuddy.cn' }) },
  ])
  const r = await manager.poll(loginId)
  assert.deepEqual(r, { done: true, ok: false, error: 'domain-mismatch', terminal: true })
  assert.equal(calls.length, 3)
})

test('档位守卫: ai 档位收到 codebuddy.ai 必须放行（上游 AI 档两种后缀都算）', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: tokenBody({ domain: 'www.codebuddy.ai' }) },
    { body: accountBody({ domain: 'www.codebuddy.ai' }) },
  ])
  const r = await manager.poll(loginId)
  assert.equal(r.done, true)
  assert.equal(r.ok, true, 'codebuddy.ai 属于国际版白名单，不得 fail-closed')
  assert.equal(r.document.auth.domain, 'www.codebuddy.ai')
  assert.equal(calls[2].headers['X-Domain'], 'www.codebuddy.ai')
  assert.equal(calls.length, 3)
})

test('档位守卫: cn 档位收到国际版 domain → 拒绝（两个守卫点都拦）', async () => {
  // startedAi 固定开 ai 会话，cn 档位这里手工构造
  const { fetchImpl, calls } = makeFetch([
    { body: STATE_CN },
    { body: tokenBody({ domain: 'www.workbuddy.ai' }) },
  ])
  const m = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: recorder() })
  const s = await m.start('cn')
  assert.deepEqual(await m.poll(s.loginId), { done: true, ok: false, error: 'domain-mismatch', terminal: true })
  assert.equal(calls.length, 2)

  const { fetchImpl: f2, calls: c2 } = makeFetch([
    { body: STATE_CN },
    { body: { code: 0, data: { accessToken: 'at-5' } } },
    { body: accountBody({ domain: 'www.workbuddy.ai' }) },
  ])
  const m2 = new WorkBuddyLoginManager({ fetchImpl: f2, now: clock(), logger: recorder() })
  const s2 = await m2.start('cn')
  assert.deepEqual(await m2.poll(s2.loginId), { done: true, ok: false, error: 'domain-mismatch', terminal: true })
  assert.equal(c2.length, 3)
})

// ── 其它终态 ────────────────────────────────────────────────────────────

test('poll: code 成功但缺 accessToken → 终态 missing-access-token', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: { code: 0, data: { domain: 'www.workbuddy.ai', refreshToken: 'rt' } } },
    { body: accountBody() },
  ])
  const r = await manager.poll(loginId)
  assert.deepEqual(r, { done: true, ok: false, error: 'missing-access-token', terminal: true })
  assert.equal(calls.length, 2)
})

test('poll: code 成功但缺 uid → 终态 missing-uid，不再发后续请求', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: tokenBody() },
    { body: { code: 0, data: { nickname: 'nick-1', domain: 'www.workbuddy.ai' } } },
  ])
  const r = await manager.poll(loginId)
  assert.deepEqual(r, { done: true, ok: false, error: 'missing-uid', terminal: true })
  assert.equal('document' in r, false, '不能给出一个 upsertAccount 会拒的文档')
  assert.equal(calls.length, 3, 'account 已是最后一个请求，之后不得再打网络')
})

test('poll: uid 只有空白也算缺失 → missing-uid', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: tokenBody() },
    { body: accountBody({ uid: '   ' }) },
  ])
  const r = await manager.poll(loginId)
  assert.deepEqual(r, { done: true, ok: false, error: 'missing-uid', terminal: true })
  assert.equal(calls.length, 3)
})

test('poll: uid 与 domain 同时缺失时固定报 missing-uid（顺序确定，卡片文案才稳定）', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: { code: 0, data: { accessToken: 'at-7' } } },
    { body: { code: 0, data: { nickname: 'nick-1' } } },
  ])
  const r = await manager.poll(loginId)
  assert.deepEqual(r, { done: true, ok: false, error: 'missing-uid', terminal: true })
  assert.equal(calls.length, 3)
})

test('poll: token 与 account 都没有 domain → 终态 missing-domain', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: { code: 0, data: { accessToken: 'at-6' } } },
    { body: { code: 0, data: { uid: 'uid-1', nickname: 'nick-1' } } },
  ])
  const r = await manager.poll(loginId)
  assert.deepEqual(r, { done: true, ok: false, error: 'missing-domain', terminal: true })
  assert.equal('document' in r, false)
  assert.equal(calls.length, 3)
})

test('幂等: missing-uid / missing-domain 也是终态，重复 poll 返回同一对象', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: tokenBody() },
    { body: { code: 0, data: { domain: 'www.workbuddy.ai' } } },
  ])
  const r1 = await manager.poll(loginId)
  const n = calls.length
  const r2 = await manager.poll(loginId)
  assert.equal(r1.error, 'missing-uid')
  assert.equal(calls.length, n)
  assert.equal(r2, r1)
})

test('poll: 缺 expiresAt 不算终态（不凭空造过期时间，pool 侧对此容错）', async () => {
  const { manager, loginId } = await startedAi([
    { body: STATE_AI },
    { body: { code: 0, data: { accessToken: 'at-8', domain: 'www.workbuddy.ai' } } },
    { body: accountBody() },
  ])
  const r = await manager.poll(loginId)
  assert.equal(r.ok, true)
  assert.equal('expiresAt' in r.document.auth, false)
  assert.equal('refreshExpiresAt' in r.document.auth, false)
})

test('poll: 超时 → 终态 timeout，且一点网络都不打', async () => {
  const now = clock()
  const { fetchImpl, calls } = makeFetch([{ body: STATE_AI }])
  const m = new WorkBuddyLoginManager({ fetchImpl, now, logger: recorder() })
  const s = await m.start('ai')
  assert.equal(calls.length, 1)

  now.set(BASE + LOGIN_TIMEOUT_MS)
  const r = await m.poll(s.loginId)
  assert.deepEqual(r, { done: true, ok: false, error: 'timeout', terminal: true })
  assert.equal(calls.length, 1)
})

test('poll: 未知 loginId → 终态 unknown-login，不抛', async () => {
  const { fetchImpl } = makeFetch([])
  const m = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: recorder() })
  assert.deepEqual(await m.poll('wbm_nope'), { done: true, ok: false, error: 'unknown-login', terminal: true })
  assert.deepEqual(await m.poll(undefined), { done: true, ok: false, error: 'unknown-login', terminal: true })
})

// ── 幂等 ────────────────────────────────────────────────────────────────

test('幂等: 成功后重复 poll 返回同一结果对象且不再发请求', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: tokenBody() },
    { body: accountBody() },
  ])
  const r1 = await manager.poll(loginId)
  const n = calls.length
  const r2 = await manager.poll(loginId)
  const r3 = await manager.poll(loginId)

  assert.equal(calls.length, n, '终态后不得再发请求')
  assert.equal(r2, r1, '必须返回同一个对象')
  assert.equal(r3, r1)
  assert.deepEqual(r2, r1)
})

test('幂等: 终态失败同样幂等，不再发请求', async () => {
  const { manager, loginId, calls } = await startedAi([
    { body: STATE_AI },
    { body: tokenBody({ domain: 'www.codebuddy.cn' }) },
  ])
  const r1 = await manager.poll(loginId)
  const n = calls.length
  const r2 = await manager.poll(loginId)
  assert.equal(calls.length, n)
  assert.equal(r2, r1)
  assert.deepEqual(r2, { done: true, ok: false, error: 'domain-mismatch', terminal: true })
})

test('幂等: 超时终态同样幂等', async () => {
  const now = clock()
  const { fetchImpl, calls } = makeFetch([{ body: STATE_AI }])
  const m = new WorkBuddyLoginManager({ fetchImpl, now, logger: recorder() })
  const s = await m.start('ai')
  now.set(BASE + LOGIN_TIMEOUT_MS + 1)
  const r1 = await m.poll(s.loginId)
  const r2 = await m.poll(s.loginId)
  assert.equal(r2, r1)
  assert.equal(calls.length, 1)
})

// ── cancel / list / gc ──────────────────────────────────────────────────

test('cancel: 存在 → true，再次 → false，之后 poll 是 unknown-login', async () => {
  const { manager, loginId } = await startedAi([{ body: STATE_AI }])
  assert.equal(manager.cancel(loginId), true)
  assert.equal(manager.cancel(loginId), false)
  assert.deepEqual(manager.list(), [])
  assert.deepEqual(await manager.poll(loginId), { done: true, ok: false, error: 'unknown-login', terminal: true })
})

test('list: 只列未完成的会话；成功与会话过期后都不列', async () => {
  const now = clock()
  let seq = 0
  const { fetchImpl } = routeFetch([
    { path: '/auth/state', body: () => ({ code: 0, data: { state: `s-${++seq}`, authUrl: `https://www.workbuddy.ai/login?state=s-${seq}` } }) },
    {
      path: '/auth/token',
      body: (url) => (url.includes('state=s-1') ? pendingBody() : tokenBody({ domain: 'www.workbuddy.ai' })),
    },
    { path: '/login/account', body: () => accountBody() },
  ])
  const m = new WorkBuddyLoginManager({ fetchImpl, now, logger: recorder() })
  const a = await m.start('ai')
  const b = await m.start('ai')

  // s-1 保持 pending，s-2 走完成功
  await m.poll(a.loginId)
  await m.poll(b.loginId)

  const listed = m.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].loginId, a.loginId)
  assert.deepEqual(Object.keys(listed[0]), ['loginId', 'variantKey', 'verificationUri', 'startedAt', 'expiresAt'])

  now.set(BASE + LOGIN_TIMEOUT_MS)
  assert.deepEqual(m.list(), [], '过期后不再列出')
})

test('gc: 清掉超时会话并返回条数，幂等；未超时的会话不动', async () => {
  const now = clock()
  const { fetchImpl } = routeFetch([
    {
      path: '/auth/state',
      body: (() => {
        let n = 0
        return () => ({ code: 0, data: { state: `s-${++n}`, authUrl: 'https://www.workbuddy.ai/login' } })
      })(),
    },
  ])
  const m = new WorkBuddyLoginManager({ fetchImpl, now, logger: recorder() })
  const a = await m.start('ai')
  now.advance(1000)
  const b = await m.start('ai')

  now.set(a.startedAt + LOGIN_TIMEOUT_MS) // a 到期，b 还差 1000ms
  assert.equal(m.gc(), 1)
  assert.equal(m.gc(), 0, 'gc 必须幂等')
  assert.deepEqual(m.list().map((x) => x.loginId), [b.loginId])
  assert.deepEqual(await m.poll(a.loginId), { done: true, ok: false, error: 'unknown-login', terminal: true })
})

test('gc: 终态会话到点后也被回收', async () => {
  const now = clock()
  const { fetchImpl } = makeFetch([{ body: STATE_AI }, { body: tokenBody() }, { body: accountBody() }])
  const m = new WorkBuddyLoginManager({ fetchImpl, now, logger: recorder() })
  const s = await m.start('ai')
  assert.equal((await m.poll(s.loginId)).ok, true)
  assert.equal(m.gc(), 0)
  now.set(BASE + LOGIN_TIMEOUT_MS)
  assert.equal(m.gc(), 1)
})

// ── 构造 ────────────────────────────────────────────────────────────────

test('构造: fetchImpl / now 可注入，类型不对抛 TypeError', () => {
  assert.doesNotThrow(() => new WorkBuddyLoginManager({ logger: recorder() }))
  assert.doesNotThrow(() => new WorkBuddyLoginManager({ fetchImpl: async () => response({}), now: () => 1 }))
  assert.throws(() => new WorkBuddyLoginManager({ fetchImpl: 'nope' }), TypeError)
  assert.throws(() => new WorkBuddyLoginManager({ fetchImpl: 42 }), TypeError)
  assert.throws(() => new WorkBuddyLoginManager({ now: 123 }), TypeError)
})

test('构造: 非法 timeoutMs 回落到 LOGIN_TIMEOUT_MS', async () => {
  for (const bad of [0, -1, Number.NaN, 'x']) {
    const { fetchImpl } = makeFetch([{ body: STATE_AI }])
    const m = new WorkBuddyLoginManager({ fetchImpl, now: clock(), logger: recorder(), timeoutMs: bad })
    const r = await m.start('ai')
    assert.equal(r.expiresAt, BASE + LOGIN_TIMEOUT_MS, `timeoutMs=${String(bad)} 应回落`)
  }
})

test('构造: 日志器缺失时 warn 也不会炸（用一次性 logger 收口）', async () => {
  const { fetchImpl } = makeFetch([
    { body: STATE_AI },
    { body: tokenBody({ domain: 'www.codebuddy.cn' }) },
  ])
  // 不传 logger：warn 会走 console.warn，这里临时静音以免污染测试输出
  const original = console.warn
  const seen = []
  console.warn = (...args) => seen.push(args)
  try {
    const m = new WorkBuddyLoginManager({ fetchImpl, now: clock() })
    const s = await m.start('ai')
    const r = await m.poll(s.loginId)
    assert.equal(r.error, 'domain-mismatch')
  } finally {
    console.warn = original
  }
  assert.ok(seen.length >= 1, '档位不符必须留下一条 warn')
})
