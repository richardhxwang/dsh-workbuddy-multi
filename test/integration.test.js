/**
 * 跨模块集成测试：真的把 `apply()` 跑起来（假 ctx，真 pool / rotation / pinned）。
 *
 * 覆盖的是单测覆盖不到的那一层：
 *   - 组装顺序（池 → 环境变量接管 → pinned 注册 → Web 动作面）
 *   - 动作面 HTTP 契约（方法 / 回环校验 / 未知 action）
 *   - 429 → 制冷当前账号 → 换号的完整链路
 *   - 卸载后 route / adapter / 事件监听 一个都不剩（PLAN R5）
 *
 * 全部隔离：临时 DSH_HOME / 临时桌面 auth 目录 / 临时池目录，绝不读写真账号。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ACTIONS_BASE, apply } from '../lib/index.js'
import { FakeHost } from './helpers/fake-host.js'

/**
 * 用「相对现在」的时间戳。
 *
 * 这里踩过一次：最初写死 `1_700_000_000_000`（2023-11-14），于是所有账号在墙钟上
 * 都是**已过期**的 —— `isAccountDead()` 全为真 → `advance()` 找不到可用账号 →
 * 429 换号静默不生效，测试表现为 waitFor 超时，完全看不出真因。
 */
const BASE = Date.now()

/**
 * FakeHost 的默认 Host 头（`127.0.0.1:59999`）。宿主侧唯一允许学的 origin 就是它，
 * 愈合器（lib/heal.js）与积分回落都只能借这个回环地址去打上游自己的路由。
 */
const LOOPBACK_ORIGIN = 'http://127.0.0.1:59999'

function cnDoc(uid, { expiresAt = BASE + 3_600_000, refreshExpiresAt = BASE + 86_400_000 } = {}) {
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
      expiresAt,
      refreshExpiresAt,
    },
    accounts: [],
    allAccounts: [],
  }
}

function aiDoc(uid, { nickname = 'user@example.com', expiresAt = BASE + 3_600_000 } = {}) {
  return {
    account: { uid, nickname, uin: '100000000002', type: 'personal' },
    auth: {
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.fake.payload',
      refreshToken: 'eyJhbGciOiJIUzI1NiJ9.fake.refresh',
      tokenType: 'Bearer',
      domain: 'www.workbuddy.ai',
      expiresAt,
      refreshExpiresAt: expiresAt,
    },
    accounts: [],
    allAccounts: [],
  }
}

async function makeIsolatedEnv(t) {
  const root = await mkdtemp(join(tmpdir(), 'wbm-int-'))
  const desktop = join(root, 'desktop')
  const dshHome = join(root, 'dshhome')
  await mkdir(desktop, { recursive: true })
  await mkdir(dshHome, { recursive: true })

  const names = [
    'DSH_HOME',
    'WORKBUDDY_DESKTOP_AUTH_DIR',
    'WORKBUDDY_POOL_ROOT',
    'WORKBUDDY_AUTH_FILE',
    'WORKBUDDY_AI_AUTH_FILE',
  ]
  const saved = new Map(names.map((n) => [n, process.env[n]]))
  process.env.DSH_HOME = dshHome
  process.env.WORKBUDDY_DESKTOP_AUTH_DIR = desktop
  delete process.env.WORKBUDDY_AUTH_FILE
  delete process.env.WORKBUDDY_AI_AUTH_FILE

  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  return {
    root,
    desktop,
    dshHome,
    poolRoot: join(root, 'pool'),
    async put(variantKey, doc) {
      const file = variantKey === 'cn' ? 'workbuddy-desktop.info' : 'workbuddy-desktop-ai.info'
      await writeFile(join(desktop, file), JSON.stringify(doc), 'utf8')
    },
  }
}

async function waitFor(predicate, { timeout = 8000, interval = 20, what = '条件' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}`)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

const STATUS = `${ACTIONS_BASE}/status`
const ACTION = `${ACTIONS_BASE}/action`

async function readStatus(host) {
  const res = await host.call(STATUS)
  // 启动是异步的：未就绪时冻结契约给 503 + 一份 status 空壳，轮询要能穿过这个窗口。
  assert.ok(
    res.statusCode === 200 || res.statusCode === 503,
    `status 状态码只应是 200（就绪）或 503（未就绪），实际 ${res.statusCode}: ${JSON.stringify(res.body)}`,
  )
  if (res.statusCode === 200) return res.body
  assert.equal(res.body?.ok, false)
  return res.body?.status ?? { ready: false }
}

/**
 * 兜底卸载：用例**失败时**也必须把插件拆掉。
 *
 * 踩过一次：反向测试故意把代码改坏后，用例在 `disposeAll()` 之前就断言失败，
 * 插件的 `scanMs` 定时器留在那儿 → `node --test` 打印完输出后**进程不退出**，
 * 整条命令看起来像卡住，反倒把「红」这个证据吞掉了（实测 >180s 未退出，
 * 只能 kill）。`FakeHost.disposeAll()` 是幂等的（每个 disposer 带 done 标记），
 * 所以这里重复调用是安全的。
 */
function teardown(t, host) {
  t.after(async () => {
    try {
      await host.disposeAll()
    } catch {
      /* 卸载失败由用例自己的断言负责，这里只保证不留句柄 */
    }
  })
}

async function act(host, body) {
  const res = await host.call(ACTION, { method: 'POST', body })
  assert.equal(res.statusCode, 200, `action ${body.action} 应返回 200，实际 ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert.equal(res.body?.ok, true)
  return res.body.result
}

test('apply()：捕获→动作→429 换号→卸载无泄漏（pinned 关闭）', async (t) => {
  const env = await makeIsolatedEnv(t)
  await env.put('cn', cnDoc('uid-a'))

  const host = new FakeHost()
  teardown(t, host)
  apply(host, { poolRoot: env.poolRoot, pinned: false, scanMs: 60_000, envTakeover: true })

  // ── 启动与 Web 动作面 ────────────────────────────────────────────────
  const status = await waitFor(
    async () => {
      const s = await readStatus(host)
      return s.ready ? s : undefined
    },
    { what: '插件就绪' },
  )
  assert.deepEqual(host.registeredPaths(), [`${ACTIONS_BASE}/action`, STATUS].sort())
  assert.equal(status.variants.find((v) => v.key === 'cn').accounts.length, 1)
  assert.equal(status.variants.find((v) => v.key === 'ai').accounts.length, 0)

  // 环境变量接管：上游每次请求都读 env，所以这里必须已经指向池里的生效文件
  const activePath = join(env.poolRoot, 'active', 'cn.info')
  assert.equal(process.env.WORKBUDDY_AUTH_FILE, activePath)

  // ── 加第二个账号（改桌面文件 → refreshFromDesktop）──────────────────
  await env.put('cn', cnDoc('uid-b'))
  await act(host, { action: 'refreshFromDesktop', variantKey: 'cn' })
  let after = await readStatus(host)
  assert.equal(after.variants.find((v) => v.key === 'cn').accounts.length, 2)

  // ── 手动选号 ────────────────────────────────────────────────────────
  await act(host, { action: 'select', variantKey: 'cn', uid: 'uid-b' })
  after = await readStatus(host)
  assert.equal(after.variants.find((v) => v.key === 'cn').activeUid, 'uid-b')

  // ── 429：冷却当前账号并换到下一个 ───────────────────────────────────
  await host.emit('session/event', {}, {
    type: 'llm/retry',
    data: {
      provider: 'workbuddy',
      turn: 1,
      step: 1,
      retry: 1,
      failure: {
        code: 'RATE_LIMIT',
        message: '您的使用量已超出频率限制，将在 2033-05-18 11:33:20 UTC+8 重置',
      },
    },
  })

  const swapped = await waitFor(
    async () => {
      const s = await readStatus(host)
      const cn = s.variants.find((v) => v.key === 'cn')
      return cn.activeUid !== 'uid-b' ? cn : undefined
    },
    { what: '429 后换号' },
  )
  assert.equal(swapped.activeUid, 'uid-a', '应换到另一个可用账号')
  assert.ok(
    swapped.cooling.some((c) => c.uid === 'uid-b'),
    '被限流的账号必须进入冷却，否则下一个请求又会撞上去',
  )

  // ── 过期账号必须被标记，且绝不能被选中 ───────────────────────────────
  await env.put(
    'cn',
    cnDoc('uid-c', { expiresAt: BASE - 60_000, refreshExpiresAt: BASE - 60_000 }),
  )
  await act(host, { action: 'refreshFromDesktop', variantKey: 'cn' })
  const withDead = (await readStatus(host)).variants.find((v) => v.key === 'cn')
  assert.equal(withDead.accounts.length, 3)
  assert.equal(withDead.accounts.find((a) => a.uid === 'uid-c').dead, true, '过期账号必须标 dead')
  // uid-b 冷却中、uid-c 已过期 → 唯一可用的还是 uid-a，advance 不能落到别人身上
  await act(host, { action: 'advance', variantKey: 'cn' })
  const afterAdvance = (await readStatus(host)).variants.find((v) => v.key === 'cn')
  assert.notEqual(afterAdvance.activeUid, 'uid-c', '过期账号绝不能被 advance 选中')
  assert.equal(afterAdvance.activeUid, 'uid-a')

  // ── 信任边界与方法校验 ──────────────────────────────────────────────
  const evil = await host.call(STATUS, { headers: { host: 'evil.example.com' } })
  assert.equal(evil.statusCode, 403)
  assert.equal(evil.body.error, 'request-not-trusted')

  const badMethod = await host.call(STATUS, { method: 'POST', body: {} })
  assert.equal(badMethod.statusCode, 405)

  const unknown = await host.call(ACTION, { method: 'POST', body: { action: 'nope' } })
  assert.equal(unknown.statusCode, 400)

  const badVariant = await host.call(ACTION, { method: 'POST', body: { action: 'advance', variantKey: 'zz' } })
  assert.equal(badVariant.statusCode, 400)

  // ── 卸载：route / 监听器 / 定时器全部回收 ───────────────────────────
  const failures = await host.disposeAll()
  assert.deepEqual(failures, [])
  assert.deepEqual(host.leaks(), [], `卸载后仍有资源存活：${JSON.stringify(host.leaks())}`)
})

test('apply()：ctx.log 是「需 inject 的服务」时（读取即抛）插件仍必须起来', async (t) => {
  // 真 profile 启动时踩到的坑：cordis 对未 inject 声明的服务属性做了门禁，
  // `ctx.log` 一读就抛 `cannot get property "log" without inject`，
  // 而它发生在 apply() 的最开头 → 整棵插件树启动失败、DSH 直接起不来。
  // 这条测试就是那个失败的回归钉。
  const env = await makeIsolatedEnv(t)
  await env.put('cn', cnDoc('uid-a'))

  const host = new FakeHost()
  teardown(t, host)
  Object.defineProperty(host, 'log', {
    configurable: true,
    get() {
      throw new Error('cannot get property "log" without inject')
    },
  })

  apply(host, { poolRoot: env.poolRoot, pinned: false, scanMs: 60_000, envTakeover: true })

  const status = await waitFor(
    async () => {
      const s = await readStatus(host)
      return s.ready ? s : undefined
    },
    { what: 'ctx.log 抛错时插件仍应就绪' },
  )
  assert.equal(status.ready, true)
  assert.equal(status.variants.find((v) => v.key === 'cn').accounts.length, 1)

  const failures = await host.disposeAll()
  assert.deepEqual(failures, [])
  assert.deepEqual(host.leaks(), [])
})

test('apply()：pinned 开启时注册独立模型组，且绝不占用上游基准 route', async (t) => {
  const env = await makeIsolatedEnv(t)
  await env.put('ai', aiDoc('uid-ai-1'))

  const host = new FakeHost()
  teardown(t, host)
  apply(host, { poolRoot: env.poolRoot, pinned: true, scanMs: 60_000 })

  const routes = await waitFor(
    () => (host.registeredRoutes().length > 0 ? host.registeredRoutes() : undefined),
    { what: 'pinned 注册至少一个模型组' },
  )
  assert.ok(routes.length >= 1)
  for (const id of routes) {
    assert.ok(id.startsWith('workbuddy-m-'), `pinned route 必须以前缀开头，实际 ${id}`)
    assert.ok(!['workbuddy', 'workbuddy-ai'].includes(id), '绝不能占用上游基准 route id')
  }

  const status = await readStatus(host)
  assert.equal(status.pinned.length, routes.length)
  const ai = status.variants.find((v) => v.key === 'ai')
  assert.equal(ai.accounts.length, 1)
  assert.ok(routes.includes(status.pinned[0].providerId))

  const failures = await host.disposeAll()
  assert.deepEqual(failures, [])
  assert.deepEqual(host.leaks(), [], `卸载后仍有资源存活：${JSON.stringify(host.leaks())}`)
})

// ── 主动登录 / 自动续期 / 脱敏（PLAN §3.5）─────────────────────────────────

const CN_ENDPOINT = 'https://www.codebuddy.cn'
const AI_ENDPOINT = 'https://www.workbuddy.ai'
const REFRESHED_AT = BASE + 7_200_000
const REFRESHED_RT = REFRESHED_AT + 86_400_000
const AI_REFRESHED_AT = BASE + 10_800_000

/** 最小 fetch 响应：login.js 走 text()、keepalive.js 优先 json()，两个都给。 */
function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text
    },
    async json() {
      return body
    },
  }
}

/**
 * 假 OAuth 服务端：只实现「取 state → 轮询换 token → 取账号 → 刷新」四步。
 * 收到预期外的 URL 直接抛，避免测试悄悄打到别处还显示绿的。
 */
function makeOauthFetch({ pendingPolls = 1 } = {}) {
  const calls = []
  let polls = 0
  async function fetchImpl(url, init) {
    const target = String(url)
    calls.push({ url: target, method: init?.method ?? 'GET', headers: init?.headers ?? {} })
    if (target.startsWith(`${CN_ENDPOINT}/v2/plugin/auth/state`)) {
      return jsonResponse({
        code: 0,
        data: { state: 'st-1', authUrl: `${CN_ENDPOINT}/login?platform=workbuddy&state=st-1` },
      })
    }
    if (target.startsWith(`${CN_ENDPOINT}/v2/plugin/auth/token/refresh`)) {
      return jsonResponse({
        code: 0,
        data: {
          accessToken: 'at-refreshed',
          refreshToken: 'rt-refreshed',
          domain: 'www.codebuddy.cn',
          expiresAt: REFRESHED_AT,
          refreshExpiresAt: REFRESHED_RT,
          tokenType: 'Bearer',
        },
      })
    }
    if (target.startsWith(`${CN_ENDPOINT}/v2/plugin/auth/token`)) {
      polls += 1
      if (polls <= pendingPolls) return jsonResponse({ code: 11217, msg: '11217:login ing...' })
      return jsonResponse({
        code: 0,
        data: {
          accessToken: 'at-oauth',
          refreshToken: 'rt-oauth',
          domain: 'www.codebuddy.cn',
          expiresAt: BASE + 3_600_000,
          refreshExpiresAt: BASE + 86_400_000,
          tokenType: 'Bearer',
        },
      })
    }
    if (target.startsWith(`${CN_ENDPOINT}/v2/plugin/login/account`)) {
      return jsonResponse({
        code: 0,
        data: { uid: 'uid-oauth', nickname: '扫码账号', domain: 'www.codebuddy.cn' },
      })
    }
    throw new Error(`假 OAuth 服务端收到预期外请求：${target}`)
  }
  return { fetchImpl, calls }
}

/** 假的上游刷新端点（国际版档位）。 */
function makeAiRefreshFetch() {
  const calls = []
  async function fetchImpl(url, init) {
    const target = String(url)
    calls.push({ url: target, method: init?.method ?? 'GET', headers: init?.headers ?? {} })
    if (target.startsWith(`${AI_ENDPOINT}/v2/plugin/auth/token/refresh`)) {
      return jsonResponse({
        code: 0,
        data: {
          accessToken: 'at-ai-refreshed',
          refreshToken: 'rt-ai-refreshed',
          domain: 'www.workbuddy.ai',
          expiresAt: AI_REFRESHED_AT,
          refreshExpiresAt: AI_REFRESHED_AT + 86_400_000,
          tokenType: 'Bearer',
        },
      })
    }
    throw new Error(`假的国际版服务端收到预期外请求：${target}`)
  }
  return { fetchImpl, calls }
}

/**
 * HTTP 响应里永不得出现这些东西。
 *
 * `accessToken` / `refreshToken` 连**字段名**都不许出现 —— 出现字段名就说明
 * 某个动作把整个凭据文档回传了（哪怕值是脱敏的，这也是不该泄露的结构）。
 */
const SECRET_NEEDLES = ['accessToken', 'refreshToken', '$wbEncrypted', 'at-oauth', 'rt-oauth', 'at-refreshed']

function assertNoSecrets(label, value) {
  const text = JSON.stringify(value)
  for (const needle of SECRET_NEEDLES) {
    assert.ok(!text.includes(needle), `${label} 泄露了 ${needle}：${text.slice(0, 300)}`)
  }
}

test('apply()：扫码登录→入库→手动刷新；加密账号如实拒绝；全程脱敏', async (t) => {
  const env = await makeIsolatedEnv(t)
  // 桌面收割来的国内版账号：token 是 $wbEncrypted 信封
  await env.put('cn', cnDoc('uid-desktop'))

  const oauth = makeOauthFetch()
  const host = new FakeHost()
  teardown(t, host)
  const seen = []
  apply(
    host,
    { poolRoot: env.poolRoot, pinned: false, scanMs: 60_000, envTakeover: true, keepalive: false },
    { fetchImpl: oauth.fetchImpl },
  )

  async function post(body) {
    const res = await host.call(ACTION, { method: 'POST', body })
    seen.push({ [body.action]: res.body })
    assert.equal(res.statusCode, 200, `action ${body.action} 应 200，实际 ${res.statusCode}: ${JSON.stringify(res.body)}`)
    return res.body
  }
  async function statusOf() {
    const s = await readStatus(host)
    seen.push({ status: s })
    return s
  }

  const ready = await waitFor(async () => {
    const s = await readStatus(host)
    return s.ready ? s : undefined
  }, { what: '插件就绪' })
  assert.equal(ready.variants.find((v) => v.key === 'cn').accounts.length, 1)
  // 新契约：status 必须带上这两个键，卡片靠它们渲染登录面板与续期状态
  assert.ok(Array.isArray(ready.logins), 'status.logins 必须是数组')
  assert.equal(typeof ready.keepalive, 'object', 'status.keepalive 必须是对象')

  // ── 第 1 步：开一个扫码会话 ──────────────────────────────────────────
  const startBody = await post({ action: 'loginStart', variantKey: 'cn' })
  const session = startBody.result
  assert.match(session.loginId, /^wbm_/, 'loginId 必须是 wbm_ 前缀')
  assert.ok(session.verificationUri.startsWith(`${CN_ENDPOINT}/login`), session.verificationUri)
  assert.equal(session.variantKey, 'cn')
  assert.ok(session.expiresIn > 0)
  // `state` 是换 token 的凭据，不许作为字段回传（它只出现在用户要打开的那个 URL 里）
  assert.equal(
    Object.prototype.hasOwnProperty.call(session, 'state'),
    false,
    'loginStart 不得把 state 作为独立字段回传',
  )

  // 会话出现在 status.logins 里（卡片要显示倒计时）
  const during = await statusOf()
  assert.ok(
    during.logins.some((l) => l.loginId === session.loginId),
    'status.logins 必须包含进行中的会话',
  )

  // ── 第 2 步：轮询（第一次是 pending）────────────────────────────────
  const first = await post({ action: 'loginPoll', loginId: session.loginId })
  assert.equal(first.result.done, false, '未扫码时必须如实报 pending')
  assert.match(String(first.result.status), /11217/)

  // ── 第 3 步：轮询（第二次成功，凭据入库）────────────────────────────
  const second = await post({ action: 'loginPoll', loginId: session.loginId })
  assert.equal(second.result.done, true)
  assert.equal(second.result.ok, true)
  assert.equal(second.result.uid, 'uid-oauth')
  assert.equal(second.result.source, 'oauth')

  const afterLogin = await statusOf()
  const cnAccounts = afterLogin.variants.find((v) => v.key === 'cn').accounts
  const scanned = cnAccounts.find((a) => a.uid === 'uid-oauth')
  assert.ok(scanned, '扫码拿到的账号必须进池')
  assert.equal(scanned.source, 'oauth')
  assert.equal(scanned.label, '扫码账号')
  assert.equal(scanned.needsRelogin, false)
  // 会话结束后必须从 logins 里消失
  assert.ok(
    !afterLogin.logins.some((l) => l.loginId === session.loginId),
    '已结束的会话不该继续留在 status.logins',
  )

  // ── 第 4 步：手动刷新明文账号 ───────────────────────────────────────
  const before = oauth.calls.filter((c) => c.url.includes('/auth/token/refresh')).length
  const refreshed = await post({ action: 'refreshAccount', variantKey: 'cn', uid: 'uid-oauth' })
  assert.equal(refreshed.result.ok, true, JSON.stringify(refreshed.result))
  assert.equal(refreshed.result.expiresAt, REFRESHED_AT, '刷新后必须采纳上游给的新到期时间')
  const refreshCall = oauth.calls.filter((c) => c.url.includes('/auth/token/refresh')).at(-1)
  assert.equal(oauth.calls.filter((c) => c.url.includes('/auth/token/refresh')).length, before + 1)
  assert.equal(refreshCall.method, 'POST')
  assert.equal(refreshCall.headers['X-Auth-Refresh-Source'], 'plugin', '缺这个头国际版会 12153')
  assert.equal(refreshCall.headers['X-Refresh-Token'], 'rt-oauth')
  assert.equal(refreshCall.headers['X-Domain'], 'www.codebuddy.cn')

  // ── 第 5 步：加密账号如实拒绝，且**不发请求** ───────────────────────
  const networkBefore = oauth.calls.length
  const refused = await post({ action: 'refreshAccount', variantKey: 'cn', uid: 'uid-desktop' })
  assert.equal(refused.result.ok, false)
  assert.equal(refused.result.reason, 'encrypted-credential')
  assert.match(String(refused.result.message), /加密凭据/)
  assert.equal(oauth.calls.length, networkBefore, '加密凭据不该产生任何网络请求')

  // ── 脱敏：所有 HTTP 响应体都不得含 token 或信封 ──────────────────────
  for (const body of seen) assertNoSecrets('HTTP 响应', body)

  const failures = await host.disposeAll()
  assert.deepEqual(failures, [])
  assert.deepEqual(host.leaks(), [], `卸载后仍有资源存活：${JSON.stringify(host.leaks())}`)
})

test('apply()：自动续期只刷新闲置账号，绝不碰当前活跃账号（refresh token 一次性轮换，不能和上游抢）', async (t) => {
  const env = await makeIsolatedEnv(t)
  const NOW = Date.now()
  /*
   * 两个明文账号，**都**落在 300s 余量之内 → 两个都「该刷」，但只有一个该被我们刷：
   * 活跃账号由上游 dsh-workbuddy-connect 在每次请求的发送路径上按需刷新，我们碰它就是抢。
   *
   * 哪个会成为活跃账号由 ensureActive() 在启动时决定，测试不去猜：先读出 activeUid，
   * 另一个就是「闲置」的那个。这样断言与实现细节解耦，也不依赖账号在列表里的顺序。
   */
  await env.put('ai', aiDoc('uid-ai-live', { expiresAt: NOW + 60_000 }))
  const importDir = join(env.poolRoot, 'import', 'ai')
  await mkdir(importDir, { recursive: true })
  await writeFile(
    join(importDir, 'uid-ai-idle.info'),
    JSON.stringify(aiDoc('uid-ai-idle', { expiresAt: NOW + 60_000 })),
    'utf8',
  )

  const upstream = makeAiRefreshFetch()
  const host = new FakeHost()
  teardown(t, host)
  apply(
    host,
    {
      poolRoot: env.poolRoot,
      pinned: false,
      scanMs: 60_000,
      keepaliveSweepMs: 60_000,
      keepaliveMarginMs: 300_000,
    },
    { fetchImpl: upstream.fetchImpl, now: () => NOW },
  )

  // 两个账号都要在自动续期第一轮巡检之前就位（import 目录由 bootstrap 吸收，早于 keepalive.start）。
  const booted = await waitFor(
    async () => {
      const s = await readStatus(host)
      if (!s.ready) return undefined
      const ai = s.variants.find((v) => v.key === 'ai')
      return ai.accounts.length === 2 ? ai : undefined
    },
    { what: '两个账号都被捕获' },
  )
  const activeUid = booted.activeUid
  assert.ok(
    activeUid === 'uid-ai-live' || activeUid === 'uid-ai-idle',
    `activeUid 应是这两个之一，实际 ${String(activeUid)}`,
  )
  const idleUid = activeUid === 'uid-ai-live' ? 'uid-ai-idle' : 'uid-ai-live'

  const refreshed = await waitFor(
    async () => {
      const s = await readStatus(host)
      const account = s.variants.find((v) => v.key === 'ai').accounts.find((a) => a.uid === idleUid)
      return account && account.expiresAt === AI_REFRESHED_AT ? account : undefined
    },
    { what: '自动续期把闲置账号刷新到新的到期时间' },
  )
  assert.equal(typeof refreshed.lastRefreshAt, 'number')
  assert.equal(refreshed.lastRefreshError, undefined)

  // 活跃账号必须**一个字节没动** —— 这是本测试的核心断言。
  //
  // 注意：快照是在巡检循环内部写的，而 #stats 是循环**跑完**才累加的（lib/keepalive.js:851-856）。
  // 所以这里必须再等一次「统计已结算」，否则在全量并行跑时会读到 ok:0（数据已落盘但计数未提交）。
  const status = await waitFor(
    async () => {
      const s = await readStatus(host)
      return s.keepalive && s.keepalive.stats.ok >= 1 ? s : undefined
    },
    { what: '自动续期这一轮结算完成（stats.ok 已累加）' },
  )
  const activeRow = status.variants.find((v) => v.key === 'ai').accounts.find((a) => a.uid === activeUid)
  assert.equal(activeRow.expiresAt, NOW + 60_000, '活跃账号的到期时间必须保持原样（它归上游管）')

  // 落盘核对：闲置账号的快照写了新 token，活跃账号的快照原封不动。
  const idleSnapshot = await readFile(join(env.poolRoot, 'accounts', 'ai', `${idleUid}.info`), 'utf8')
  assert.ok(idleSnapshot.includes('at-ai-refreshed'), '闲置账号的快照必须已写入刷新后的 token')
  assert.ok(!idleSnapshot.includes('eyJhbGciOiJIUzI1NiJ9.fake.payload'), '旧 token 必须被替换掉')
  const activeSnapshot = await readFile(join(env.poolRoot, 'accounts', 'ai', `${activeUid}.info`), 'utf8')
  assert.ok(!activeSnapshot.includes('at-ai-refreshed'), '活跃账号的快照绝不能被我们改写')
  assert.ok(
    activeSnapshot.includes('eyJhbGciOiJIUzI1NiJ9.fake.payload'),
    '活跃账号的快照必须还是原来那份 token',
  )

  // 协议契约 + 只打真实域。只该有一次刷新 —— 也就是只有闲置账号那一次。
  const refreshCalls = upstream.calls.filter((c) => c.url.includes('/auth/token/refresh'))
  assert.equal(refreshCalls.length, 1, '活跃账号绝不能被我们刷新（否则会和上游抢一次性 refresh token）')
  assert.equal(refreshCalls[0].method, 'POST')
  assert.equal(refreshCalls[0].headers['X-Auth-Refresh-Source'], 'plugin')
  for (const call of upstream.calls) {
    // 唯一的例外是愈合器（lib/heal.js）：它借宿主回环 origin 去打上游自己的 status /
    // probe 路由。那必须是**回环**地址，永远不能是真实域名，所以这里放行的是回环前缀，
    // 而不是「任何非刷新请求」。
    if (call.url.startsWith(`${LOOPBACK_ORIGIN}/plugins/dsh-workbuddy-connect/`)) continue
    assert.ok(call.url.startsWith(`${AI_ENDPOINT}/`), `只该打国际版端点，实际 ${call.url}`)
  }

  // 自动续期状态要能从 status 里读到（卡片用它显示成功/失败/跳过）
  assert.equal(status.keepalive.running, true)
  assert.equal(status.keepalive.unavailable, undefined)
  assert.ok(status.keepalive.stats.ok >= 1)
  assert.ok(status.keepalive.stats.skipped >= 1, '被跳过的活跃账号应计进 skipped')

  const failures = await host.disposeAll()
  assert.deepEqual(failures, [])
  assert.deepEqual(host.leaks(), [], `卸载后仍有资源存活：${JSON.stringify(host.leaks())}`)
})

const BASELINE_PROVIDERS = new Set(['workbuddy', 'workbuddy-ai'])

test('apply()：分组方式可运行时刻切换（合并 ⇄ 按账号），不用重启；返回值契约完整', async (t) => {
  const env = await makeIsolatedEnv(t)
  await env.put('cn', cnDoc('uid-cn'))
  await env.put('ai', aiDoc('uid-ai'))

  const host = new FakeHost()
  teardown(t, host)
  apply(host, {
    poolRoot: env.poolRoot,
    pinned: false,
    scanMs: 60_000,
    keepalive: false,
    credits: false,
  })

  const ready = await waitFor(
    async () => {
      const s = await readStatus(host)
      return s.ready ? s : undefined
    },
    { what: '插件就绪' },
  )

  // ── 默认合并：不注册任何账号组，但必须说清楚「合并后归上游哪一组」─────
  assert.equal(ready.groups.mode, 'merged')
  assert.equal(ready.groups.defaultMode, 'merged')
  assert.equal(ready.pinned.length, 0)
  assert.equal(host.registeredRoutes().length, 0, '合并模式绝不该注册自己的 provider')
  assert.equal(ready.groups.merged.length, 2, '两个档位各一条（国内/国际永远分开）')
  assert.deepEqual(
    ready.groups.merged.map((g) => g.routeId).sort(),
    ['workbuddy', 'workbuddy-ai'],
    '合并模式必须报告上游那两个 route id，否则卡片没法解释「这些账号现在归哪一组」',
  )
  for (const group of ready.groups.merged) {
    assert.ok(group.accountCount >= 1, `${group.variantKey} 应有账号`)
    assert.ok(typeof group.activeUid === 'string' && group.activeUid !== '')
  }

  // ── 切到「按账号」：动作一返回就必须已经注册好（不需要重启）───────────
  const on = await act(host, { action: 'setPinned', on: true })
  assert.equal(on.mode, 'per-account')
  assert.equal(on.removed.length, 0)
  assert.equal(on.added.length, 2, `两个账号都该新增，实际：${JSON.stringify(on.added)}`)
  assert.equal(on.pinned.length, 2)
  for (const entry of on.pinned) {
    assert.match(entry.providerId, /^workbuddy-m-/, entry.providerId)
    assert.ok(!BASELINE_PROVIDERS.has(entry.providerId), `绝不能占用上游 provider id：${entry.providerId}`)
  }
  assert.deepEqual(host.registeredRoutes().sort(), on.pinned.map((e) => e.providerId).sort())
  assert.equal((await readStatus(host)).groups.mode, 'per-account')

  // ── 切回「合并」：已注册的必须被摘掉（这条最容易漏）───────────────────
  const off = await act(host, { action: 'setPinned', on: false })
  assert.equal(off.mode, 'merged')
  assert.equal(off.added.length, 0)
  assert.equal(off.removed.length, 2, '切回合并必须把账号组摘干净')
  assert.equal(off.pinned.length, 0)
  assert.equal(host.registeredRoutes().length, 0)
  assert.equal((await readStatus(host)).groups.mode, 'merged')

  // ── 非法形参：必须是 400（由动作面统一兜成 client error，不是 500）────
  const bad = await host.call(ACTION, { method: 'POST', body: { action: 'setPinned', on: 'yes' } })
  assert.equal(bad.statusCode, 400, JSON.stringify(bad.body))
  assert.equal(bad.body.ok, false)

  const failures = await host.disposeAll()
  assert.deepEqual(failures, [])
  assert.deepEqual(host.leaks(), [], `卸载后仍有资源存活：${JSON.stringify(host.leaks())}`)
})

/**
 * 逐账号问积分的假客户端。
 *
 * 契约来自上游公开类型：`WorkBuddyUpstreamClient.fetchCredits(credential)` —— **一个参数**，
 * 返回 `{ total, accounts?, unlimited?, expiry? }`。密文凭据连调用都不该发起。
 */
function makeCreditsClient(totals) {
  const asked = []
  return {
    asked,
    createClient() {
      return {
        async fetchCredits(credential) {
          asked.push(credential.uid)
          if (!Object.prototype.hasOwnProperty.call(totals, credential.uid)) {
            throw new Error(`unexpected-uid:${credential.uid}`)
          }
          return { total: totals[credential.uid] }
        },
      }
    },
  }
}

test('apply()：合并组积分 = 池内合计；密文生效账号回落到上游 status 路由；只在内存里算', async (t) => {
  const env = await makeIsolatedEnv(t)
  const NOW = Date.now()

  // 国内版：唯一的账号是桌面收割来的 `$wbEncrypted` 密文凭据 —— 我们算不出它的积分
  await env.put('cn', cnDoc('uid-cn-enc'))
  // 国际版：两个明文账号（一个会被 ensureActive 选成活跃，另一个走 import 目录）
  await env.put('ai', aiDoc('uid-ai-live', { expiresAt: NOW + 3_600_000 }))
  const importDir = join(env.poolRoot, 'import', 'ai')
  await mkdir(importDir, { recursive: true })
  await writeFile(
    join(importDir, 'uid-ai-idle.info'),
    JSON.stringify(aiDoc('uid-ai-idle', { expiresAt: NOW + 3_600_000 })),
    'utf8',
  )

  /*
   * 假 fetch 只服务一件事：**上游自己的** status 路由 —— 密文生效账号的积分只有它知道。
   * 这也顺带验证「宿主 origin 是学来的，不是猜的」：插件必须先收到一次回环请求，
   * 才知道该往哪个地址打（FakeHost 的 Host 是 127.0.0.1:59999）。
   */
  const UPSTREAM_CN_STATUS = `${LOOPBACK_ORIGIN}/plugins/dsh-workbuddy-connect/status`
  const fetched = []
  const fetchImpl = async (url) => {
    fetched.push(String(url))
    if (String(url) === UPSTREAM_CN_STATUS) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'signed-in', credits: { total: 500 } }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }

  const credits = makeCreditsClient({ 'uid-ai-live': 350, 'uid-ai-idle': 800 })
  const host = new FakeHost()
  teardown(t, host)
  const seen = []
  apply(
    host,
    {
      poolRoot: env.poolRoot,
      pinned: false,
      scanMs: 60_000,
      keepalive: false,
      credits: true,
      creditsTtlMs: 5_000,
    },
    { fetchImpl, createClient: credits.createClient, now: () => NOW },
  )

  await waitFor(
    async () => {
      const s = await readStatus(host)
      return s.ready ? s : undefined
    },
    { what: '插件就绪' },
  )

  const indexPath = join(env.poolRoot, 'index.json')
  const before = await readFile(indexPath, 'utf8')

  const result = await act(host, { action: 'refreshCredits', force: true })
  seen.push({ refreshCredits: result })

  // ── 国际版：两个明文账号直接问，合计 350 + 800 ──────────────────────────
  assert.equal(result.ai.total, 1150, 'AI 合计必须是两个账号之和')
  assert.equal(result.ai.complete, true)
  assert.equal(result.ai.accountCount, 2)
  assert.equal(result.ai.unlimited, false)
  assert.equal(result.ai.accounts.length, 2)
  for (const row of result.ai.accounts) {
    assert.equal(row.encrypted, false)
    assert.ok(row.total === 350 || row.total === 800, `意外的单账号数：${JSON.stringify(row)}`)
  }
  assert.equal(result.ai.accounts.filter((r) => r.active === true).length, 1, '只有一个账号该被标成生效')

  // ── 国内版：密文凭据不发起问询，改问上游 status 路由（且只有 active 才允许回落）──
  assert.equal(result.cn.total, 500, '密文生效账号的积分应回落到上游 status 路由')
  assert.equal(result.cn.accounts.length, 1)
  assert.equal(result.cn.accounts[0].encrypted, true)
  assert.equal(result.cn.accounts[0].total, 500)
  assert.deepEqual(
    credits.asked.filter((uid) => uid === 'uid-cn-enc'),
    [],
    '密文账号绝不能被直接问积分（拿不到明文 accessToken 去拼请求头）',
  )
  assert.ok(
    fetched.includes(UPSTREAM_CN_STATUS),
    `应回落到上游 status 路由，实际打过：${fetched.join(', ')}`,
  )

  // ── 只读：不写盘（index.json 逐字节不变）────────────────────────────────
  assert.equal(await readFile(indexPath, 'utf8'), before, 'refreshCredits 不得写盘')

  // ── status 里要能读到同一份合计（卡片靠它渲染）──────────────────────────
  const status = await readStatus(host)
  seen.push({ status })
  assert.equal(status.credits.cn.total, 500)
  assert.equal(status.credits.ai.total, 1150)
  assert.equal(status.credits.ttlMs, 5_000)

  // ── 脱敏：响应与 status 里都不许出现凭据字段名 ─────────────────────────
  for (const body of seen) assertNoSecrets('积分响应', body)

  const failures = await host.disposeAll()
  assert.deepEqual(failures, [])
  assert.deepEqual(host.leaks(), [], `卸载后仍有资源存活：${JSON.stringify(host.leaks())}`)
})

/**
 * R8 的接线测试：愈合器（`lib/heal.js`）只有在「借宿主回环 origin 问过上游 status、
 * 且确属『已登录但目录空』」时才该动作。
 *
 * 这两条用例覆盖的都是**接线**（origin 学得对不对、开关关得掉、一次就够），
 * 判据本身在 `test/heal.test.js` 里逐条钉死。
 */
test('apply()：已登录但上游目录为空 → 借宿主 origin 打一次上游探测路由，然后复读确认', async (t) => {
  const env = await makeIsolatedEnv(t)
  await env.put('cn', cnDoc('uid-cn'))

  const KEY = '2715418b060e8086c121e77eaa9b64c916474dee6568e34f'
  const STATUS_URL = `${LOOPBACK_ORIGIN}/plugins/dsh-workbuddy-connect/status`
  const PROBE_URL = `${LOOPBACK_ORIGIN}/plugins/dsh-workbuddy-connect/probe`
  const calls = []
  let statusReads = 0

  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })
    if (href === PROBE_URL) return { ok: true, status: 200, json: async () => ({ state: 'refreshed' }) }
    if (href === STATUS_URL) {
      statusReads += 1
      // 第一次：已登录、一个模型都没有（就是那个坏状态）；第二次：修好了。
      return statusReads === 1
        ? { ok: true, status: 200, json: async () => ({ status: 'signed-in', probeKey: KEY }) }
        : {
            ok: true,
            status: 200,
            json: async () => ({ status: 'signed-in', probeKey: KEY, models: [{ id: 'a' }, { id: 'b' }] }),
          }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }

  const host = new FakeHost()
  teardown(t, host)
  apply(
    host,
    { poolRoot: env.poolRoot, pinned: false, scanMs: 60_000, keepalive: false, credits: false },
    { fetchImpl, now: () => Date.now() },
  )

  // 第一个回环请求到达时才知道宿主 origin；在那之前愈合器什么都不该知道。
  await waitFor(async () => ((await readStatus(host)).ready ? true : undefined), { what: '插件就绪' })

  const status = await waitFor(
    async () => {
      const s = await readStatus(host)
      return s.heal?.attempted?.cn?.healed === true ? s : undefined
    },
    { what: '国内版自愈结算完成' },
  )

  assert.equal(status.heal.enabled, true)
  assert.equal(status.heal.attempted.cn.healed, true, '复读后目录非空才算自愈成功')
  assert.equal(status.heal.attempted.cn.models, 2)

  const posts = calls.filter((c) => c.method === 'POST')
  assert.equal(posts.length, 1, '恰好一次探测，不许重试')
  assert.equal(posts[0].url, PROBE_URL)
  assert.equal(posts[0].headers['x-workbuddy-probe-key'], KEY, '缺这个头上游会 403')
  assert.deepEqual(JSON.parse(posts[0].body), { action: 'refresh' })

  // 国际版那条 status 是 404 ⇒ 读不到 ⇒ 不许探测。
  assert.equal(status.heal.attempted.ai?.attempted ?? false, false, '读不到上游状态时绝不许探测')

  // 自愈只允许打回环地址 —— 绝不许出现真实域名。
  for (const call of calls) {
    assert.ok(call.url.startsWith(LOOPBACK_ORIGIN), `自愈只准打回环 origin，实际 ${call.url}`)
  }

  assertNoSecrets('自愈后的 status', status)

  const failures = await host.disposeAll()
  assert.deepEqual(failures, [])
  assert.deepEqual(host.leaks(), [], `卸载后仍有资源存活：${JSON.stringify(host.leaks())}`)
})

test('apply()：上游目录正常时，愈合器一次探测都不发（好状态必须零动作）', async (t) => {
  const env = await makeIsolatedEnv(t)
  await env.put('cn', cnDoc('uid-cn'))

  const STATUS_URL = `${LOOPBACK_ORIGIN}/plugins/dsh-workbuddy-connect/status`
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, method: init.method ?? 'GET' })
    if (href === STATUS_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'signed-in', probeKey: 'k', models: [{ id: 'a' }] }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }

  const host = new FakeHost()
  teardown(t, host)
  apply(
    host,
    { poolRoot: env.poolRoot, pinned: false, scanMs: 60_000, keepalive: false, credits: false },
    { fetchImpl, now: () => Date.now() },
  )

  const status = await waitFor(
    async () => {
      const s = await readStatus(host)
      // 注意判据是**结算后**的形状：刚触发时 `attempted.cn` 是 `{pending:true}`，
      // 只判 `!== undefined` 会在 pending 那一刻就通过，于是读不到 attempted/reason。
      return s.heal?.attempted?.cn?.attempted === false ? s : undefined
    },
    { what: '愈合器结算完成（即使什么都不做）' },
  )

  assert.equal(status.heal.attempted.cn.attempted, false)
  assert.equal(status.heal.attempted.cn.reason, 'catalog-not-empty')
  assert.deepEqual(
    calls.filter((c) => c.method === 'POST'),
    [],
    '目录非空时绝不许碰探测路由',
  )

  const failures = await host.disposeAll()
  assert.deepEqual(failures, [])
  assert.deepEqual(host.leaks(), [], `卸载后仍有资源存活：${JSON.stringify(host.leaks())}`)
})

test('apply()：把 healBaseline 关掉 → 愈合器完全不工作，status 如实说明', async (t) => {
  const env = await makeIsolatedEnv(t)
  await env.put('cn', cnDoc('uid-cn'))

  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return { ok: false, status: 404, json: async () => ({}) }
  }

  const host = new FakeHost()
  teardown(t, host)
  apply(
    host,
    { poolRoot: env.poolRoot, pinned: false, scanMs: 60_000, keepalive: false, credits: false, healBaseline: false },
    { fetchImpl, now: () => Date.now() },
  )

  const status = await waitFor(
    async () => {
      const s = await readStatus(host)
      return s.ready ? s : undefined
    },
    { what: '插件就绪' },
  )

  assert.equal(status.heal.enabled, false)
  assert.deepEqual(status.heal.attempted, {}, '关掉之后一次都不该尝试')
  assert.deepEqual(calls, [], '关掉之后不该有任何请求')

  const failures = await host.disposeAll()
  assert.deepEqual(failures, [])
  assert.deepEqual(host.leaks(), [], `卸载后仍有资源存活：${JSON.stringify(host.leaks())}`)
})
