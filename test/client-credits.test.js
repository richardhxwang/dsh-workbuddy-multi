/**
 * test/client-credits.test.js — lib/client.js 的渲染行为测试（node --test）。
 *
 * lib/client.js 是一个浏览器侧的 JSX bundle，不是一个可 import 的模块：它自己调用
 * `window.__ModuleLoader__.load({ id, factory })`，并在 factory 里 `require('react')`。
 * 所以这个文件的做法是——把源码当数据读进来，塞进一个最小沙箱里**求值**：
 *   · 一个会真正调用函数组件的迷你 React（挂载 / hooks / effect 清理）
 *   · 假定时器（能数出「当前有几个存活的 interval」，这对「卸载后不许留定时器」是硬证据）
 *   · 假 fetch（按 action 分发，记录每一次 GET/POST）
 *   · 假 cordis ctx（捕获 slots.register 注册进来的组件）
 * 然后像真渲染器一样把它渲染出来，对渲染结果和网络调用做断言。
 *
 * ── 两个踩过的坑，别重犯 ────────────────────────────────────────────────────
 *
 * 1. **fetch stub 每次必须返回新对象**（用 `structuredClone`），不能把同一个引用
 *    反复返回。真实的 `response.json()` 每次都新建对象；如果你复用同一个引用，
 *    所有基于身份（identity）的 effect 依赖都被冻住，effect 不再重跑，
 *    于是「漏了 once-per-mount 的 ref」这类真实缺陷会被静默掩盖 —— 变异测试抓不到。
 *
 * 2. **chip 被门控两次**：轮询门控（`variantKeyForProvider` 决定要不要读 status）
 *    + 渲染门控（`isMergedMode` 决定要不要画）。所以只变异**渲染门控**会被**轮询门控**
 *    遮掉、看起来「没红」；要证明门控吃劲，必须变异 `variantKeyForProvider`（它同时
 *    决定读不读和画不画）。反向测试里的 M3/M4 就是这两个方向。
 *
 * 运行：`cd dsh-workbuddy-multi && node --test test/client-credits.test.js`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

const realSetTimeout = globalThis.setTimeout

/* ────────────────────────────── 沙箱 ────────────────────────────── */

/**
 * 把一段 client.js 源码装进最小沙箱并渲染。
 *
 * 之所以做成工厂而不是模块级单例：反向测试要把源码**定向文本突变**后的副本
 * 装进一个**全新的世界**再跑同一套断言（照 test/rotation.test.js 的做法）。
 * 每个世界有自己的实例表、定时器和 fetch 记录，互不污染。
 */
function createSandbox(src, { keepPage = false } = {}) {
  /* 迷你 React：instance 由组件名 + 出现次序定位，hooks 按调用次序编号。 */
  let instances = new Map()
  let counters = new Map()
  let currentInstance = null
  let dirty = false

  const sameDeps = (a, b) => {
    if (a === void 0 || b === void 0) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
    return true
  }

  const instanceFor = (type) => {
    const name = type.name || 'anon'
    const n = (counters.get(name) ?? 0) + 1
    counters.set(name, n)
    const key = `${name}#${n}`
    let inst = instances.get(key)
    if (inst === void 0) {
      inst = { key, hooks: [], hookIndex: 0 }
      instances.set(key, inst)
    }
    return inst
  }

  const React = {
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const inst = currentInstance
      const i = inst.hookIndex++
      let slot = inst.hooks[i]
      if (slot === void 0) {
        slot = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
        inst.hooks[i] = slot
      }
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (!Object.is(value, slot.value)) {
          slot.value = value
          dirty = true
        }
      }
      return [slot.value, set]
    },
    useRef(initial) {
      const inst = currentInstance
      const i = inst.hookIndex++
      let slot = inst.hooks[i]
      if (slot === void 0) {
        slot = { kind: 'ref', value: { current: initial } }
        inst.hooks[i] = slot
      }
      return slot.value
    },
    useCallback(fn, deps) {
      const inst = currentInstance
      const i = inst.hookIndex++
      let slot = inst.hooks[i]
      if (slot === void 0 || !sameDeps(slot.deps, deps)) {
        const ran = slot?.ran
        slot = { kind: 'callback', deps, fn, ran }
        inst.hooks[i] = slot
      }
      return slot.fn
    },
    useEffect(fn, deps) {
      const inst = currentInstance
      const i = inst.hookIndex++
      const prev = inst.hooks[i]
      inst.hooks[i] = { kind: 'effect', fn, deps, ran: prev?.ran }
    },
    useMemo(fn) {
      return fn()
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      /* 订阅即可，往下取快照。测试里 store 是自己的，不触发通知。 */
      try {
        subscribe(() => void 0)
      } catch {
        /* 订阅失败不该让测试炸掉 */
      }
      return getSnapshot()
    }
  }

  /* 关键：函数组件要被**真的调用**，否则树遍历会停在外层元素上。 */
  const jsx = (type, props, key) => {
    if (typeof type === 'function') {
      const inst = instanceFor(type)
      const prev = currentInstance
      currentInstance = inst
      try {
        return type(props ?? {})
      } finally {
        currentInstance = prev
      }
    }
    return { type, props: props ?? {}, key }
  }

  const flushEffects = () => {
    for (const inst of instances.values()) {
      for (const slot of inst.hooks) {
        if (slot === void 0 || slot.kind !== 'effect') continue
        if (slot.ran !== void 0 && sameDeps(slot.ran.deps, slot.deps)) continue
        if (slot.ran !== void 0 && typeof slot.ran.cleanup === 'function') slot.ran.cleanup()
        const cleanup = slot.fn()
        slot.ran = { deps: slot.deps, cleanup: typeof cleanup === 'function' ? cleanup : void 0 }
      }
    }
  }

  /* ── 假定时器：能回答「现在有几个活着的 interval」 ── */
  let timers = []
  let timerSeq = 0
  const fakeSetInterval = (fn, delay) => {
    const id = ++timerSeq
    timers.push({ id, fn, delay, live: true })
    return id
  }
  const fakeClearInterval = (id) => {
    const t = timers.find((x) => x.id === id)
    if (t !== void 0) t.live = false
  }
  const liveIntervals = (delay) =>
    timers.filter((t) => t.live && (delay === void 0 || t.delay === delay))
  const fireTick = (delay) => {
    const t = liveIntervals(delay)
    if (t.length === 0) throw new Error(`no live interval with delay ${delay}`)
    t[0].fn()
  }

  /* ── 假 fetch：POST 记 action，GET 返回 status ── */
  const state = {
    statusDoc: null,
    loginStart: null,
    pollResults: [],
    actions: [],
    calls: [],
    pollCount: 0,
    statusGets: 0,
    /** 上游 dsh-workbuddy-connect 自己的 status 路由：200 = 上游在跑；404 = 没装/没启用。 */
    upstreamProbe: 200,
    upstreamProbes: 0
  }

  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  })

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? (init.body !== void 0 ? 'POST' : 'GET')
    state.calls.push({ url, method, body: init.body === void 0 ? void 0 : JSON.parse(init.body) })
    if (method === 'POST') {
      const body = JSON.parse(init.body)
      state.actions.push(body)
      if (body.action === 'loginStart') return reply(200, { ok: true, result: state.loginStart })
      if (body.action === 'loginPoll') {
        const next = state.pollResults[Math.min(state.pollCount, state.pollResults.length - 1)]
        state.pollCount += 1
        return reply(200, { ok: true, result: next })
      }
      if (body.action === 'loginCancel') return reply(200, { ok: true, result: { cancelled: true } })
      return reply(200, { ok: true, result: {} })
    }
    if (url === '/plugins/dsh-workbuddy-connect/status') {
      state.upstreamProbes += 1
      return reply(state.upstreamProbe, {})
    }
    state.statusGets += 1
    if (typeof state.statusDoc === 'function') return state.statusDoc()
    /* 每次新对象，见文件头「坑 1」。 */
    return reply(200, structuredClone(state.statusDoc))
  }

  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => void 0 } },
    configurable: true
  })
  globalThis.setInterval = fakeSetInterval
  globalThis.clearInterval = fakeClearInterval

  const gl = {}
  globalThis.window = gl
  gl.setInterval = fakeSetInterval
  gl.clearInterval = fakeClearInterval

  const modules = {
    react: React,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: React.Fragment }
  }
  let spec = null
  gl.__ModuleLoader__ = {
    load: (s) => {
      spec = s
    }
  }
  const requireStub = (name) => {
    if (name in modules) return modules[name]
    throw new Error(`unexpected require: ${name}`)
  }

  // 每个沙盒模拟一张新页面：页面级共享的依赖安装控制器不跨沙盒保留
  if (!keepPage) delete globalThis[Symbol.for('dsh-workbuddy-multi:upstream-gate')]
  new Function('window', 'require', src)(gl, requireStub)
  const mod = spec.factory(requireStub)

  /* ── 假 cordis ctx：把注册进来的槽位组件收下来 ── */
  const slots = new Map()
  const ctx = {
    effect(fn) {
      return fn()
    },
    locale: {
      register() {
        return () => void 0
      },
      bind: () => (key) => key
    },
    slots: {
      inject(_names, fn) {
        return fn()
      },
      register(options, component) {
        slots.set(`${options.name}#${options.id ?? ''}`, { options, component })
        return () => void 0
      }
    },
    inject(_deps, fn) {
      return fn({ slots: ctx.slots })
    }
  }
  mod.apply(ctx)

  const page = slots.get('plugins.bundle.config#').component
  const t = (key, params) => {
    if (params === void 0) return key
    return String(key).replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m))
  }

  /* ── 渲染 ── */
  const collect = (node, texts, buttons, links, types) => {
    if (node === null || node === void 0 || typeof node !== 'object') {
      if (typeof node === 'string' || typeof node === 'number') texts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) collect(child, texts, buttons, links, types)
      return
    }
    if (node.type === 'button') buttons.push(node)
    if (node.type === 'a') links.push(node)
    if (node.type !== void 0 && typeof node.type !== 'function') types.push(node.type)
    collect(node.props?.children, texts, buttons, links, types)
  }

  /** 纯文字按钮读文字；图标按钮（children 是 svg）读 aria-label —— 与读屏器看到的一致。 */
  const buttonText = (b) =>
    typeof b.props?.children === 'string' || typeof b.props?.children === 'number'
      ? String(b.props.children)
      : String(b.props?.['aria-label'] ?? '')

  const render = () => {
    counters = new Map()
    for (const inst of instances.values()) inst.hookIndex = 0
    dirty = false
    const tree = jsx(page, { t })
    flushEffects()
    const texts = []
    const buttons = []
    const links = []
    const types = []
    collect(tree, texts, buttons, links, types)
    return {
      tree,
      texts,
      buttons,
      links,
      types,
      has: (needle) => texts.some((x) => x.includes(needle))
    }
  }

  /** 渲染到没有状态再变为止（异步 fetch 在两次 pass 之间 resolve）。 */
  const settle = async (max = 12) => {
    let view = render()
    for (let i = 0; i < max; i += 1) {
      await new Promise((r) => realSetTimeout(r, 0))
      if (!dirty) return view
      view = render()
    }
    return view
  }

  const clickLabel = (view, label) => {
    const button = view.buttons.find((b) => buttonText(b).includes(label))
    if (button === void 0) {
      throw new Error(
        `没有匹配 ${label} 的按钮；现有：${JSON.stringify(view.buttons.map(buttonText))}`
      )
    }
    button.props.onClick?.()
  }

  const unmount = () => {
    for (const inst of instances.values()) {
      for (const slot of inst.hooks) {
        if (
          slot !== void 0 &&
          slot.kind === 'effect' &&
          slot.ran !== void 0 &&
          typeof slot.ran.cleanup === 'function'
        ) {
          slot.ran.cleanup()
        }
      }
    }
    instances.clear()
  }

  const sleep = () => new Promise((r) => realSetTimeout(r, 0))

  /* ── 素材 ── */
  const NOW = Date.now()
  const HOUR = 3600000

  const mkAccount = (over) => ({
    uid: '5f1e0c3a-7b2d-4e9f-8a61-0c4d2b7e9f13',
    uin: '100000000001',
    label: '工作号',
    enabled: true,
    source: 'desktop',
    expiresAt: NOW + 2 * HOUR,
    ...over
  })

  const mkStatus = (extra = {}) => ({
    policy: 'on-rate-limit',
    warnings: [],
    pinned: [],
    keepalive: { running: true, lastSweepAt: NOW - 60000, stats: { ok: 2, failed: 0, skipped: 1 } },
    variants: [
      {
        key: 'cn',
        routeId: 'workbuddy',
        displayName: 'WorkBuddy',
        activeUid: '5f1e0c3a-7b2d-4e9f-8a61-0c4d2b7e9f13',
        cooling: [],
        accounts: [
          mkAccount(),
          mkAccount({
            uid: 'bbbbbbbb-1111-2222-3333-444444444444',
            uin: '100000000002',
            label: '备用号',
            enabled: false,
            source: 'import',
            expiresAt: NOW - 1000
          }),
          mkAccount({
            uid: 'cccccccc-1111-2222-3333-444444444444',
            uin: '999',
            label: '要重登',
            source: 'oauth',
            needsRelogin: true,
            needsReloginReason: 'invalid_grant',
            lastRefreshError: 'invalid_grant: Invalid refresh token'
          })
        ]
      },
      {
        key: 'ai',
        routeId: 'workbuddy-ai',
        displayName: 'WorkBuddy AI',
        activeUid: void 0,
        cooling: [],
        accounts: []
      }
    ],
    ...extra
  })

  /**
   * 把登录面板推进「等待扫码」态，不管它现在是什么态。
   *
   * 面板对「开始」和「重新开始」复用同一个按钮标签，所以这里按**可观察到的标签**循环，
   * 而不是假设固定顺序。
   */
  const ensureWaiting = async () => {
    let v = await settle()
    for (let i = 0; i < 10; i += 1) {
      const labels = v.buttons.map(buttonText)
      if (labels.includes('loginCopy')) return v
      if (labels.includes('loginStart')) {
        clickLabel(v, 'loginStart')
        v = await settle()
        continue
      }
      if (labels.includes('loginRetry')) {
        clickLabel(v, 'loginRetry')
        v = await settle()
        continue
      }
      if (labels.some((l) => l.includes('loginHeading'))) {
        clickLabel(v, 'loginHeading')
        v = await settle()
        continue
      }
      throw new Error('无法进入等待态登录面板：' + JSON.stringify(labels))
    }
    throw new Error('ensureWaiting 循环耗尽')
  }

  return {
    mod,
    page,
    t,
    state,
    timers: () => timers,
    resetTimers: () => {
      timers = []
    },
    liveIntervals,
    fireTick,
    render,
    settle,
    clickLabel,
    unmount,
    sleep,
    mkAccount,
    mkStatus,
    ensureWaiting,
    instances: () => instances,
    clearInstances: () => instances.clear()
  }
}

/* ────────────────────────────── 断言 ────────────────────────────── */

/** 在渲染树里找一个 props[name] === value 的节点（看 title / aria-* 这类不进正文的属性）。 */
function findProp(node, name, value) {
  if (node === null || node === void 0 || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((child) => findProp(child, name, value))
  if (node.props?.[name] === value) return true
  return findProp(node.props?.children, name, value)
}

/** 一条断言 = 一个具名子用例，名字用中文说清行为。 */
const step = (t, name, fn) => t.test(name, fn)

/* ────────────────────────────── A 组：静态面 ────────────────────────────── */

test('设置卡片（静态面）：自动续期、账号状态与安全边界', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())

  s.state.statusDoc = s.mkStatus()
  const view = await s.settle()

  await step(t, '挂载后会向宿主 GET 一次 status', () =>
    assert.ok(s.state.statusGets >= 1, `statusGets=${s.state.statusGets}`)
  )
  await step(t, '自动续期状态区渲染出标题', () => assert.ok(view.has('keepaliveHeading')))
  await step(t, '自动续期运行中时显示「运行中」徽标', () => assert.ok(view.has('keepaliveRunning')))
  await step(t, '自动续期统计放在悬停提示里，不占正文', () =>
    assert.ok(findProp(view.tree, 'title', 'keepaliveStats'), '状态栏的 title 应当是 keepaliveStats')
  )
  await step(t, '续期全部成功时不显示失败文案', () => assert.ok(!view.has('keepaliveFailed')))
  await step(t, '需要重新登录的账号显示 needsRelogin 徽标', () =>
    assert.ok(view.has('accountNeedsRelogin'))
  )
  await step(t, '需要重新登录的账号显示原因行', () =>
    assert.ok(view.has('accountNeedsReloginReason'))
  )
  await step(t, '显示最近一次刷新失败的原因', () => assert.ok(view.has('accountLastRefreshError')))
  await step(t, '扫码来源的账号显示 oauth 来源徽标', () =>
    assert.ok(view.has('accountSourceOauth'))
  )
  await step(t, '剩余有效期用粗略单位（小时）显示', () => assert.ok(view.has('expiresInHours')))
  await step(t, '已过期账号显示「已过期」而不是负数剩余', () =>
    assert.ok(view.has('expiresExpired'))
  )
  await step(t, '每个账号行都有一个「更多操作」菜单', () =>
    assert.equal(view.buttons.filter((b) => b.props?.['aria-label'] === 'more').length, 3 + 2)
  )
  await step(t, '菜单展开后有「续期令牌」', async () => {
    const rowMenu = view.buttons.filter((b) => b.props?.['aria-label'] === 'more')[1]
    rowMenu.props.onClick()
    const opened = await s.settle()
    assert.ok(opened.buttons.some((b) => String(b.props?.children) === 'actionRefreshAccount'))
  })
  await step(t, '卡片里有「登录新账号」入口按钮', () =>
    assert.ok(view.buttons.some((b) => String(b.props?.children).includes('loginHeading')))
  )
  await step(t, '渲染结果里不出现任何 token 字段名或密文标记', () => {
    const all = view.texts.join(' ')
    assert.ok(
      !/accessToken|refreshToken|\$wbEncrypted/.test(all),
      '卡片绝不能渲染凭据材料'
    )
  })
})

/* ────────────────────────────── B 组：登录流程 ────────────────────────────── */

test('登录面板：开链、倒计时、轮询到终态与成功高亮', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())

  s.state.statusDoc = s.mkStatus()
  let view = await s.settle()

  s.state.loginStart = {
    loginId: 'wbm_abc',
    verificationUri: 'https://www.codebuddy.cn/login?platform=workbuddy&state=xyz',
    expiresIn: 600
  }
  s.state.pollResults = [
    { done: false, status: '11217:login ing...' },
    { done: false, status: '11217:login ing...' },
    {
      done: true,
      ok: true,
      meta: { uid: 'dddddddd-9999-8888-7777-666666666666', nickname: '新号' }
    }
  ]

  s.clickLabel(view, 'loginHeading')
  view = await s.settle()
  await step(t, '点登录入口后面板打开并显示档位选择', () => assert.ok(view.has('loginChoose')))
  await step(t, '档位选择里有国内版', () =>
    assert.ok(view.texts.some((x) => x === 'loginVariantCn'))
  )
  await step(t, '档位选择里有国际版', () =>
    assert.ok(view.texts.some((x) => x === 'loginVariantAi'))
  )

  s.clickLabel(view, 'loginStart')
  view = await s.settle()
  await step(t, '点开始后 POST loginStart 且 variantKey=cn', () =>
    assert.ok(s.state.actions.some((a) => a.action === 'loginStart' && a.variantKey === 'cn'))
  )
  await step(t, '登录链接渲染成真实的 href', () =>
    assert.ok(view.links.some((l) => l.props.href === s.state.loginStart.verificationUri))
  )
  await step(t, '登录链接新开标签且带 rel=noreferrer', () =>
    assert.ok(view.links.every((l) => l.props.rel === 'noreferrer' && l.props.target === '_blank'))
  )
  await step(t, '有「复制链接」按钮', () =>
    assert.ok(view.buttons.some((b) => String(b.props?.children) === 'loginCopy'))
  )
  await step(t, '有「取消」按钮', () =>
    assert.ok(view.buttons.some((b) => String(b.props?.children) === 'loginCancel'))
  )
  await step(t, '等待扫码时只持有一个 1 秒定时器', () =>
    assert.equal(s.liveIntervals(1000).length, 1)
  )
  await step(t, '等待时显示倒计时行', () => assert.ok(view.has('loginCountdown')))

  /* 第一个 tick：只走倒计时，不发轮询 */
  s.fireTick(1000)
  await s.sleep()
  view = await s.settle()
  await step(t, '第一个 tick 只走倒计时，不发轮询', () => assert.equal(s.state.pollCount, 0))
  await step(t, '只走倒计时的 tick 之后定时器仍然存活', () =>
    assert.equal(s.liveIntervals(1000).length, 1)
  )

  /* 第二个 tick：发轮询，宿主的 pending 文案原样显示 */
  s.fireTick(1000)
  await s.sleep()
  view = await s.settle()
  await step(t, '第二个 tick 发起一次轮询', () => assert.equal(s.state.pollCount, 1))
  await step(t, '宿主返回的 pending 状态串原样显示、不被翻译', () =>
    assert.ok(view.texts.some((x) => x === '11217:login ing...'))
  )
  await step(t, '轮询未决期间定时器仍然存活', () =>
    assert.equal(s.liveIntervals(1000).length, 1)
  )

  /* 一路轮询到宿主报终态 */
  let guard = 0
  while (s.state.pollCount < 3 && guard < 10) {
    s.fireTick(1000)
    await s.sleep()
    guard += 1
  }
  view = await s.settle()
  await step(t, '持续轮询直到宿主报终态', () => assert.equal(s.state.pollCount, 3))
  await step(t, '成功后显示成功文案', () => assert.ok(view.has('loginSucceeded')))
  await step(t, '离开等待态后定时器被释放', () =>
    assert.equal(s.liveIntervals(1000).length, 0)
  )

  /* 高亮：落地账号要在刷新后的文档里被标出来 */
  s.state.statusDoc = s.mkStatus()
  s.state.statusDoc.variants[0].accounts.push(
    s.mkAccount({
      uid: 'dddddddd-9999-8888-7777-666666666666',
      uin: '777',
      label: '新号',
      source: 'oauth'
    })
  )
  s.clickLabel(view, 'refresh')
  view = await s.settle()
  await step(t, '登录成功的账号被标记为「刚加入」', () => assert.ok(view.has('accountJustAdded')))
  await step(t, '登录成功的账号出现在刷新后的列表里', () =>
    assert.ok(view.texts.some((x) => x === '新号'))
  )
})

/* ──────────────────── C 组：取消必须释放定时器 ──────────────────── */

test('取消登录会释放定时器', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())

  s.state.loginStart = {
    loginId: 'wbm_abc',
    verificationUri: 'https://www.codebuddy.cn/login?state=xyz',
    expiresIn: 600
  }
  s.state.statusDoc = s.mkStatus()

  let view = await s.ensureWaiting()
  await step(t, '再次进入等待态仍然只拥有一个定时器', () =>
    assert.equal(s.liveIntervals(1000).length, 1)
  )

  s.clickLabel(view, 'loginCancel')
  view = await s.settle()
  await step(t, '点取消会 POST loginCancel', () =>
    assert.ok(s.state.actions.some((a) => a.action === 'loginCancel'))
  )
  await step(t, '取消后 1 秒定时器被释放', () => assert.equal(s.liveIntervals(1000).length, 0))
})

/* ───────────── D 组：卸载停轮询（硬性要求，绝不留定时器） ───────────── */

test('面板卸载后不再轮询，也不留定时器', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())

  s.state.loginStart = {
    loginId: 'wbm_abc',
    verificationUri: 'https://www.codebuddy.cn/login?state=xyz',
    expiresIn: 600
  }
  s.state.statusDoc = s.mkStatus()

  await s.ensureWaiting()
  await step(t, '卸载前等待面板持有一个 1 秒定时器', () =>
    assert.equal(s.liveIntervals(1000).length, 1)
  )

  s.unmount()
  await step(t, '卸载后 1 秒定时器被释放', () => assert.equal(s.liveIntervals(1000).length, 0))

  const pollsAfter = s.state.pollCount
  for (const timer of s.liveIntervals(1000)) timer.fn()
  await step(t, '卸载后不可能再发出轮询', () => assert.equal(s.state.pollCount, pollsAfter))
})

/* ───────────── E 组：未就绪时的 503 空壳 ───────────── */

test('宿主未就绪（503 空壳）时卡片仍然可用', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())

  const shell = {
    policy: 'on-rate-limit',
    warnings: ['上游设置了显式 authFile，本插件被覆盖'],
    pinned: [],
    variants: [
      {
        key: 'cn',
        routeId: 'workbuddy',
        displayName: 'WorkBuddy',
        activeUid: void 0,
        cooling: [],
        accounts: []
      },
      {
        key: 'ai',
        routeId: 'workbuddy-ai',
        displayName: 'WorkBuddy AI',
        activeUid: void 0,
        cooling: [],
        accounts: []
      }
    ]
  }
  s.state.statusDoc = () => ({
    ok: false,
    status: 503,
    json: async () => ({ ok: false, error: '插件尚未就绪', status: structuredClone(shell) })
  })

  const view = await s.settle()
  await step(t, '未就绪时只发一次 status GET', () => assert.equal(s.state.statusGets, 1))
  await step(t, '就绪失败被显示出来', () => assert.ok(view.has('readFailed')))
  await step(t, '显示宿主返回的错误原文', () => assert.ok(view.has('插件尚未就绪')))
  await step(t, '503 空壳里的 warnings 被采纳并渲染', () => assert.ok(view.has('显式 authFile')))
  await step(t, '空壳也能显示 warnings 标题', () => assert.ok(view.has('warningsHeading')))
  await step(t, '空壳也能显示策略选项', () => assert.ok(view.has('policyRoundRobin')))
  await step(t, '加载占位被空壳替换', () => assert.ok(!view.has('loading')))
})

/* ────────────────────────────── D 组：上游依赖自动安装 ────────────────────────────── */

/**
 * 用一个只认识这几条路由的假 fetch 驱动 `createUpstreamGate`。
 * `market` 为 null 表示没装插件市场（capabilities 404）。
 */
function gateWorld({ upstream = 404, market = { installed: {} }, install = { ok: true, hot: true }, afterInstall = 200 } = {}) {
  const calls = []
  let installed = false
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ url, method, body })
    const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
    if (url === '/plugins/dsh-workbuddy-connect/status') return reply(installed ? afterInstall : upstream, {})
    if (url === '/dsh-market/api/v1/capabilities') return market === null ? reply(404, {}) : reply(200, { schema: 'dsh-market/update-api/v1' })
    if (url === '/dsh-market/installed') return reply(200, market)
    if (url === '/dsh-market/install' || url === '/dsh-market/toggle') {
      installed = install.ok !== false
      return reply(install.ok === false ? 502 : 200, install)
    }
    return reply(404, {})
  }
  return { calls }
}

test('上游依赖：检测到缺失时经插件市场自动安装', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  const { createUpstreamGate, UPSTREAM_REPO_URL } = s.mod.uiInternals

  await step(t, '上游在跑：只探测一次，不碰插件市场', async () => {
    const w = gateWorld({ upstream: 200 })
    const gate = createUpstreamGate()
    await gate.ensure()
    assert.equal(gate.getSnapshot().phase, 'present')
    assert.deepEqual(w.calls.map((c) => c.url), ['/plugins/dsh-workbuddy-connect/status'])
  })

  await step(t, '没装：POST /dsh-market/install，url 是精选目录里的上游地址', async () => {
    const w = gateWorld()
    const gate = createUpstreamGate()
    await gate.ensure()
    const install = w.calls.find((c) => c.url === '/dsh-market/install')
    assert.ok(install, JSON.stringify(w.calls))
    assert.deepEqual(install.body, { url: UPSTREAM_REPO_URL })
    assert.equal(UPSTREAM_REPO_URL, 'https://github.com/corrinehu/dsh-workbuddy-connect')
    assert.equal(gate.getSnapshot().phase, 'installed', '装完上游路由能答，提示刷新页面')
  })

  await step(t, '装了但被停用：走 toggle 启用，而不是重复安装', async () => {
    const w = gateWorld({ market: { installed: { 'dsh-workbuddy-connect': '0.7.8' } } })
    const gate = createUpstreamGate()
    await gate.ensure()
    assert.ok(!w.calls.some((c) => c.url === '/dsh-market/install'))
    const toggle = w.calls.find((c) => c.url === '/dsh-market/toggle')
    assert.deepEqual(toggle.body, { name: 'dsh-workbuddy-connect', enabled: true })
  })

  await step(t, '装好但宿主不能热加载：提示重启而不是刷新', async () => {
    gateWorld({ afterInstall: 404 })
    const gate = createUpstreamGate({ settleMs: 0 })
    await gate.ensure()
    assert.equal(gate.getSnapshot().phase, 'needs-restart')
  })

  await step(t, '市场拒绝：如实报错，带市场给的原因', async () => {
    gateWorld({ install: { ok: false, error: 'plugin is not in the curated registry' } })
    const gate = createUpstreamGate()
    await gate.ensure()
    assert.equal(gate.getSnapshot().phase, 'failed')
    assert.match(gate.getSnapshot().error, /curated registry/)
  })

  await step(t, '没有插件市场：不发任何写请求，给出手动命令', async () => {
    const w = gateWorld({ market: null })
    const gate = createUpstreamGate()
    await gate.ensure()
    assert.equal(gate.getSnapshot().phase, 'no-market')
    assert.ok(!w.calls.some((c) => c.method === 'POST'))
  })

  await step(t, '网络抖动（非 404）不算缺失，不会触发安装', async () => {
    const w = gateWorld({ upstream: 502 })
    const gate = createUpstreamGate()
    await gate.ensure()
    assert.ok(!w.calls.some((c) => c.method === 'POST'))
  })

  await step(t, '自动模式每页只跑一次', async () => {
    const w = gateWorld({ upstream: 200 })
    const gate = createUpstreamGate()
    await gate.ensure({ auto: true })
    await gate.ensure({ auto: true })
    assert.equal(w.calls.length, 1)
  })
})

test('上游依赖：没有插件市场不算失败，不写退避', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  const store = new Map()
  globalThis.window.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  t.after(() => { delete globalThis.window.localStorage })
  gateWorld({ market: null })
  await s.mod.uiInternals.createUpstreamGate().ensure({ auto: true })
  assert.equal(store.size, 0, '没尝试安装就不该退避')
  gateWorld({ install: { ok: false, error: 'boom' } })
  await s.mod.uiInternals.createUpstreamGate().ensure({ auto: true })
  assert.equal(store.size, 1, '真的安装失败才退避')
})

test('上游依赖：安装成功后依赖晚几秒才加载，不会再装第二次', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  const { createUpstreamGate } = s.mod.uiInternals
  /** 装完后前两次探测仍是 404（热加载还没完成），第三次才 200。 */
  const laggingWorld = () => {
    const w = gateWorld()
    const realFetch = globalThis.fetch
    let probesAfterInstall = 0
    let installedOnce = false
    globalThis.fetch = async (url, init) => {
      if (url === '/plugins/dsh-workbuddy-connect/status' && installedOnce) {
        probesAfterInstall += 1
        if (probesAfterInstall < 3) return { ok: false, status: 404, json: async () => ({}) }
      }
      const r = await realFetch(url, init)
      if (url === '/dsh-market/install') installedOnce = true
      return r
    }
    return w
  }
  const w = laggingWorld()
  const gate = createUpstreamGate({ settleMs: 1000, pollMs: 5 })
  await gate.ensure()
  await step(t, '最终显示已安装', () => assert.equal(gate.getSnapshot().phase, 'installed'))
  await step(t, '只发了一次安装', () => assert.equal(w.calls.filter((c) => c.url === '/dsh-market/install').length, 1))
  await step(t, '反向：不等待（settleMs=0）时同样的世界会误判为需重启', async () => {
    laggingWorld()
    const g2 = createUpstreamGate({ settleMs: 0 })
    await g2.ensure()
    assert.equal(g2.getSnapshot().phase, 'needs-restart')
  })
})

test('上游依赖：市场回 409（已有安装在进行）按安装中处理，不算失败、不写退避', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  const store = new Map()
  globalThis.window.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  t.after(() => { delete globalThis.window.localStorage })
  let polls = 0
  globalThis.fetch = async (url, init = {}) => {
    const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
    if (url === '/plugins/dsh-workbuddy-connect/status') { polls += 1; return reply(polls >= 3 ? 200 : 404, {}) }
    if (url === '/dsh-market/api/v1/capabilities') return reply(200, {})
    if (url === '/dsh-market/installed') return reply(200, { installed: {} })
    if (url === '/dsh-market/install') return reply(409, { error: 'another install is already running' })
    return reply(404, {})
  }
  const gate = s.mod.uiInternals.createUpstreamGate({ settleMs: 1000, pollMs: 5 })
  await gate.ensure({ auto: true })
  await step(t, '等到依赖出现后显示已安装', () => assert.equal(gate.getSnapshot().phase, 'installed'))
  await step(t, '没有写 6 小时退避', () => assert.equal(store.size, 0))
})

test('上游依赖：插件热重载后沿用同一个安装控制器，不会重复自动安装', async (t) => {
  const s1 = createSandbox(SOURCE)
  t.after(() => s1.unmount())
  const s2 = createSandbox(SOURCE, { keepPage: true })
  t.after(() => s2.unmount())
  await step(t, '同一页面里重新执行模块拿到的是同一个实例', () => {
    assert.equal(s2.mod.uiInternals.upstreamGate, s1.mod.uiInternals.upstreamGate)
  })
  await step(t, '第一份模块自动检查过后，第二份的自动检查不再发请求', async () => {
    const w = gateWorld({ upstream: 200 })
    await s1.mod.uiInternals.upstreamGate.ensure({ auto: true })
    await s2.mod.uiInternals.upstreamGate.ensure({ auto: true })
    assert.equal(w.calls.length, 1)
  })
  await step(t, '反向：换一张新页面（不保留）就是新实例', () => {
    const s3 = createSandbox(SOURCE)
    t.after(() => s3.unmount())
    assert.notEqual(s3.mod.uiInternals.upstreamGate, s1.mod.uiInternals.upstreamGate)
  })
})
