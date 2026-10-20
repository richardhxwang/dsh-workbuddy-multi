/**
 * test/helpers/client-sandbox.js — 把 lib/client.js 装进最小沙箱渲染（迷你 React + 假定时器 + 假 fetch）。
 * 从 test/client-credits.test.js 抽出来，供多个客户端测试文件共用；两处坑的说明见那个文件的文件头。
 */

const realSetTimeout = globalThis.setTimeout

export /**
 * 把一段 client.js 源码装进最小沙箱并渲染。
 *
 * 之所以做成工厂而不是模块级单例：反向测试要把源码**定向文本突变**后的副本
 * 装进一个**全新的世界**再跑同一套断言（照 test/rotation.test.js 的做法）。
 * 每个世界有自己的实例表、定时器和 fetch 记录，互不污染。
 */
function createSandbox(src, { keepPage = false, document } = {}) {
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

  /* 需要 DOM 的用例（页面级 toast）自带一个假 document；apply() 里的 toast 还要求 window.setTimeout 存在。 */
  if (document !== void 0) {
    globalThis.document = document
    gl.setTimeout = () => 0
    gl.clearTimeout = () => void 0
  }

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

  const render = (comp = page, props = { t }) => {
    counters = new Map()
    for (const inst of instances.values()) inst.hookIndex = 0
    dirty = false
    const tree = jsx(comp, props)
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
  const settle = async (max = 12, comp, props) => {
    let view = render(comp, props)
    for (let i = 0; i < max; i += 1) {
      await new Promise((r) => realSetTimeout(r, 0))
      if (!dirty) return view
      view = render(comp, props)
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
      if (labels.includes('loginAddAnother')) {
        clickLabel(v, 'loginAddAnother')
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

