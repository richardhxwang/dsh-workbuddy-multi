/**
 * test/client-fixes.test.js — 2026-10-20 review 里 A3–A9 的客户端回归测试。
 *
 * 每条都对着一个用户能看到的坏行为写：修之前这些断言是红的（反向测试见 VERIFY.md §26）。
 * 沙箱与 client-credits.test.js 共用（test/helpers/client-sandbox.js）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSandbox } from './helpers/client-sandbox.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
const realSetTimeout = globalThis.setTimeout

/** 渲染树里所有满足条件的节点。 */
function findAll(node, pred, out = []) {
  if (node === null || node === void 0 || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out)
    return out
  }
  if (pred(node)) out.push(node)
  findAll(node.props?.children, pred, out)
  return out
}

/** 一个节点子树里的全部文字。 */
function textOf(node) {
  if (node === null || node === void 0) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/** Connect 区默认收起（§29 B2）：要看里面的面板先把它展开。 */
async function openConnect(s) {
  const view = await s.settle()
  const head = view.buttons.find((b) => textOf(b).includes('connectHeading'))
  assert.ok(head !== void 0, '前提：Connect 区的折叠头渲染出来了')
  if (head.props['aria-expanded'] !== true) head.props.onClick()
  return s.settle()
}

/**
 * 给沙箱的假 fetch 套一层路由：上游 dsh-workbuddy-connect 的 AI status、指定动作的失败/副作用。
 * 其余请求交还沙箱原来的 fetch。
 */
function routeFetch({ upstreamAi, onAction } = {}) {
  const inner = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (url === '/plugins/dsh-workbuddy-connect/ai/status' && upstreamAi !== void 0) {
      return { ok: true, status: 200, json: async () => structuredClone(upstreamAi) }
    }
    if (url === '/plugins/dsh-workbuddy-connect/status' && upstreamAi !== void 0) {
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    }
    const method = init.method ?? (init.body !== void 0 ? 'POST' : 'GET')
    if (method === 'POST' && onAction !== void 0) {
      const body = JSON.parse(init.body)
      const override = await onAction(body, url)
      if (override !== void 0) {
        return { ok: override.status < 300, status: override.status, json: async () => override.body }
      }
    }
    return inner(url, init)
  }
}

/* ── A3：选档下拉里「目录默认（300K）」和「300K」不再同时出现 ───────────── */

test('A3 选档下拉：与目录默认同值的档不再重复列出', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus({
    upstream: { installed: true },
    contextTiers: {
      enabled: true,
      overridden: 0,
      tiers: { cn: {}, ai: { 'kimi-k3': { options: [300000, 1000000], default: 300000, current: null } } }
    }
  })
  routeFetch({
    upstreamAi: {
      status: 'signed-in',
      nickname: 'a@example.com',
      probeKey: 'k',
      models: [{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 300000, maxContextWindow: 1000000 }]
    }
  })
  let view = await openConnect(s)
  const toggle = view.buttons.find((b) => textOf(b).includes('connectModelsHeadingCount'))
  assert.ok(toggle !== void 0, '前提：国际版模型列表的折叠头渲染出来了')
  toggle.props.onClick()
  view = await s.settle()
  const selects = findAll(view.tree, (n) => n.type === 'select')
  assert.equal(selects.length, 1, '前提：kimi-k3 那一行有选档下拉')
  const values = findAll(selects[0], (n) => n.type === 'option').map((o) => o.props.value)
  assert.deepEqual(values, ['', '1000000'], `下拉选项：${JSON.stringify(values)}`)
})

/* ── A4：chip 隐藏后在设置页改回「显示」，chip 要能回来 ─────────────────── */

test('A4 输入框积分：隐藏时仍慢速读状态；设置页改回显示后立刻重新出现（不等轮询）', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  let chipOn = false
  s.state.statusDoc = () => ({
    ok: true,
    status: 200,
    json: async () => structuredClone({ ...s.mkStatus({ groups: { mode: 'merged' } }), composerChip: chipOn })
  })
  routeFetch({
    onAction: (body) => {
      if (body.action === 'setCreditsChip') chipOn = body.on
      return void 0
    }
  })
  const { CreditsChip } = s.mod.creditsInternals
  const directory = {
    subscribe: () => () => void 0,
    getSnapshot: () => ({ current: { provider: 'workbuddy-ai' } })
  }
  const chipView = () => s.settle(12, CreditsChip, { directory, t: s.t })
  const hasChip = (view) => view.buttons.some((b) => b.props?.['aria-label'] === 'creditsRefreshPooled')

  let chip = await chipView()
  assert.equal(hasChip(chip), false, '前提：composerChip=false 时 chip 不渲染')
  assert.equal(s.liveIntervals(60000).length, 1, '隐藏时也要保留 60s 的慢速轮询，否则永远看不到它变回 true')

  // 在设置页点「显示」
  let page = await s.settle()
  const show = page.buttons.find((b) => b.props?.role === 'switch' && b.props?.['aria-label'] === 'chipHeading')
  assert.ok(show !== void 0, '前提：设置页有「输入框积分」开关')
  assert.equal(show.props['aria-checked'], false, '前提：开关此刻是关')
  show.props.onClick()
  page = await s.settle()
  assert.equal(chipOn, true, '前提：动作确实发到了宿主')

  chip = await chipView()
  assert.equal(hasChip(chip), true, '设置页写成功后广播，chip 不等下一轮轮询就出现')
})

/* ── A5：设置页自己按 TTL 要一次积分（chip 隐藏时那一组不再永远空白）──────── */

test('A5 积分：设置页挂载时对有账号、没统计过的版本按 TTL 要一次（force:false），且每次挂载只要一次', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus({ credits: { cn: null, ai: null, ttlMs: 60000 } })
  await s.settle()
  const asks = () => s.state.actions.filter((a) => a.action === 'refreshCredits')
  assert.deepEqual(asks(), [{ action: 'refreshCredits', variantKey: 'cn', force: false }])
  s.fireTick(15000)
  await s.settle()
  assert.equal(asks().length, 1, '轮询不应再触发第二次（ai 版本没有账号，不要）')
})

test('A5 积分：已有未过期的合计时不再要', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus({
    credits: {
      ttlMs: 60000,
      cn: { total: 10, accountCount: 3, readyCount: 3, complete: true, computedAt: Date.now(), accounts: [] },
      ai: null
    }
  })
  await s.settle()
  assert.equal(s.state.actions.filter((a) => a.action === 'refreshCredits').length, 0)
})

/* ── A6：写失败报「操作失败」，不冒充读失败，也不被下一轮轮询悄悄清掉 ──────── */

test('A6 写失败：显示「操作失败」+原因，轮询后仍在，可手动关闭', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus()
  routeFetch({
    onAction: (body) => (body.action === 'setPolicy' ? { status: 400, body: { ok: false, error: '策略写入失败' } } : void 0)
  })
  let view = await s.settle()
  view.buttons.find((b) => b.props?.children === 'policyRoundRobin').props.onClick()
  view = await s.settle()
  assert.ok(view.has('actionFailed'), '标题是「操作失败」')
  assert.ok(view.has('策略写入失败'), '带宿主给的原因')
  assert.ok(!view.has('readFailed'), '不能显示成「读取状态失败」')

  s.fireTick(15000)
  view = await s.settle()
  assert.ok(view.has('策略写入失败'), '下一轮轮询成功后仍要留着，不能悄悄消失')

  view.buttons.find((b) => b.props?.['aria-label'] === 'loginClose').props.onClick()
  view = await s.settle()
  assert.ok(!view.has('策略写入失败'), '手动关闭后消失')
})


const sleepReal = (ms) => new Promise((r) => realSetTimeout(r, ms))

/* ── A7：「全部检测」可以停止 ────────────────────────────────────────────── */

test('A7 全部检测：进行中有「停止」，按下后不再测下一个模型，并报「已停止」', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus({ upstream: { installed: true } })
  const probed = []
  routeFetch({
    upstreamAi: {
      status: 'signed-in',
      nickname: 'a@example.com',
      probeKey: 'k',
      models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }, { id: 'm3', name: 'M3' }],
      probe: { candidates: ['m1', 'm2', 'm3'], results: [] }
    },
    onAction: (body, url) => {
      if (url !== '/plugins/dsh-workbuddy-connect/ai/probe') return void 0
      probed.push(body.model)
      return { status: 200, body: { state: 'ok' } }
    }
  })
  let view = await openConnect(s)
  view.buttons.find((b) => b.props?.children === 'connectProbeAll').props.onClick()
  view = await s.settle()
  view.buttons.find((b) => b.props?.children === 'connectProbeConfirmAction').props.onClick()
  // 第一个模型测完后进入 2s 间隔
  for (let i = 0; i < 20 && probed.length < 1; i += 1) await sleepReal(20)
  view = await s.settle()
  assert.deepEqual(probed, ['m1'], '前提：第一个模型已测、正停在间隔里')
  const stop = view.buttons.find((b) => b.props?.children === 'connectProbeStop')
  assert.ok(stop !== void 0, '进行中必须有「停止」按钮')
  stop.props.onClick()
  await sleepReal(600)
  view = await s.settle()
  assert.deepEqual(probed, ['m1'], '停止后不能再测 m2/m3')
  assert.ok(view.has('connectProbeAllStopped'), '结果报「已停止」，不是「全部检测完成」')
})

/* ── A8：登录面板 ─────────────────────────────────────────────────────────── */

test('A8 登录成功：给「完成」（关面板）和「再添加一个」，不再是「重新生成」', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus()
  s.state.loginStart = { loginId: 'L1', verificationUri: 'https://example.com/login', expiresIn: 600 }
  s.state.pollResults = [{ done: true, ok: true, meta: { uid: 'new-uid' } }]
  await s.ensureWaiting()
  s.fireTick(1000)
  s.fireTick(1000)
  let view = await s.settle()
  assert.ok(view.has('loginSucceeded'), '前提：登录成功')
  const labels = view.buttons.map((b) => String(b.props?.children))
  assert.ok(labels.includes('loginDone') && labels.includes('loginAddAnother'), JSON.stringify(labels))
  assert.ok(!labels.includes('loginRetry'), '成功后不该出现「重新生成」')
  view.buttons.find((b) => b.props?.children === 'loginDone').props.onClick()
  view = await s.settle()
  assert.ok(!view.has('loginSucceeded'), '「完成」关掉面板')
})

test('A8 链接过期：只说「链接已失效」，不加「登录失败：」前缀', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus()
  s.state.loginStart = { loginId: 'L2', verificationUri: 'https://example.com/login', expiresIn: 0.001 }
  s.state.pollResults = [{ done: false, status: 'pending' }]
  await s.ensureWaiting()
  await sleepReal(5)
  s.fireTick(1000)
  const view = await s.settle()
  assert.ok(view.texts.includes('loginExpired'), JSON.stringify(view.texts.filter((x) => x.includes('login'))))
  assert.ok(!view.texts.some((x) => x.includes('loginFailed')), '不能出现「登录失败：链接已失效」')
})

test('A8 轮询：上一次没回来不发下一次；取消后晚到的结果被丢弃', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus()
  s.state.loginStart = { loginId: 'L3', verificationUri: 'https://example.com/login', expiresIn: 600 }
  let release
  let polls = 0
  routeFetch({
    onAction: (body) => {
      if (body.action !== 'loginPoll') return void 0
      polls += 1
      return new Promise((resolve) => {
        release = () => resolve({ status: 200, body: { ok: true, result: { done: true, ok: true, meta: { uid: 'late' } } } })
      })
    }
  })
  await s.ensureWaiting()
  for (let i = 0; i < 6; i += 1) s.fireTick(1000)
  await s.settle()
  assert.equal(polls, 1, `一次轮询挂着时不该再发：发了 ${polls} 次`)
  let view = await s.settle()
  view.buttons.find((b) => b.props?.children === 'loginCancel').props.onClick()
  await s.settle()
  release()
  view = await s.settle()
  assert.ok(!view.has('loginSucceeded'), '取消之后晚到的「成功」不能把面板翻成成功')
})

/* ── A9：页面级 toast 点 × 后真的关掉 ──────────────────────────────────── */

function fakeDocument() {
  const mk = (tag) => {
    const el = {
      tag,
      children: [],
      attrs: {},
      listeners: {},
      dataset: {},
      className: '',
      textContent: '',
      parent: void 0,
      setAttribute(k, v) {
        this.attrs[k] = v
      },
      append(...c) {
        for (const x of c) x.parent = this
        this.children.push(...c)
      },
      appendChild(x) {
        this.append(x)
        return x
      },
      replaceChildren() {
        this.children = []
      },
      addEventListener(type, fn) {
        ;(this.listeners[type] ??= []).push(fn)
      },
      remove() {
        if (this.parent === void 0) return
        const i = this.parent.children.indexOf(this)
        if (i >= 0) this.parent.children.splice(i, 1)
        this.parent = void 0
      }
    }
    return el
  }
  return { body: mk('body'), head: mk('head'), documentElement: mk('html'), createElement: mk, querySelector: () => null }
}

test('A9 依赖缺失的 toast：点 × 后同一阶段不再弹回来', async (t) => {
  const doc = fakeDocument()
  const s = createSandbox(SOURCE, { document: doc })
  t.after(() => {
    s.unmount()
    delete globalThis.document
  })
  s.state.upstreamProbe = 404
  const inner = globalThis.fetch
  globalThis.fetch = async (url, init) =>
    url === '/dsh-market/api/v1/capabilities' ? { ok: false, status: 404, json: async () => ({}) } : inner(url, init)
  const gate = s.mod.uiInternals.upstreamGate
  const toasts = () => doc.body.children.filter((el) => el.className === 'wbm-toast')

  await gate.ensure()
  assert.equal(gate.getSnapshot().phase, 'no-market', '前提：进入「没有插件市场」阶段')
  assert.equal(toasts().length, 1, '前提：toast 出现了')
  const close = toasts()[0].children[0].children[1]
  close.listeners.click[0]()
  assert.equal(toasts().length, 0)

  await gate.ensure()
  assert.equal(gate.getSnapshot().phase, 'no-market', '前提：检查重跑后仍是同一阶段')
  assert.equal(toasts().length, 0, '同一阶段重跑检查不能把它画回来')
})

/* ── M-9 / M-13：设置区的两条提示 ───────────────────────────────────────── */

test('M-9 设置区：宿主给出 tieredModels 时提示里带上可选模型数', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus({ contextTiers: { enabled: true, overridden: 0, tieredModels: 11, tiers: { cn: {}, ai: {} } } })
  const view = await s.settle()
  assert.ok(view.has('tiersHintCount'), '提示要带数量')
})

test('M-13 按账号分组：不再提示「新添加的账号需重启 DSH」（实际运行时即注册）', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus({
    groups: { mode: 'per-account' },
    pinned: [{ providerId: 'workbuddy-m-5f1e0c3a', displayName: 'WorkBuddy · 工作号' }]
  })
  const view = await s.settle()
  assert.ok(view.has('workbuddy-m-5f1e0c3a'), '前提：按账号分组的列表渲染出来了')
  assert.ok(!view.has('pinnedPendingRestart'), '不能再出现「需重启」提示')
})
