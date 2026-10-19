/**
 * 跨模块集成测试用的假宿主（cordis ctx）。
 *
 * 目的：让 `apply(ctx, config)` 能在 `node --test` 里真跑起来，并**可验证地**
 * 断言两件容易漏水的事：
 *   1) `ctx.llm.registerAdapter` 注册了哪些 route id（是否撞上上游基准 route）；
 *   2) 卸载后 loopback / 定时器 / 路由 / adapter 注册是否全部回收（PLAN R5）。
 *
 * 只实现被测代码真正用到的 cordis 面：`effect` / `inject` / `logger` / `llm` / `webServer`。
 */

class FakeLogger {
  constructor() {
    this.lines = []
  }

  _push(level, args) {
    this.lines.push({ level, text: args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') })
  }

  debug(...args) {
    this._push('debug', args)
  }

  info(...args) {
    this._push('info', args)
  }

  warn(...args) {
    this._push('warn', args)
  }

  error(...args) {
    this._push('error', args)
  }

  /** 断言用：把全部日志拍平成一段文本。 */
  text() {
    return this.lines.map((l) => `${l.level}: ${l.text}`).join('\n')
  }

  has(level, needle) {
    return this.lines.some((l) => l.level === level && l.text.includes(needle))
  }
}

export class FakeHost {
  /**
   * @param {object} [options]
   * @param {string[]} [options.services] 提供的服务名；缺省提供 llm 与 webServer。
   *   `apply` 用到但没提供时，cordis 的 `inject` 不会调用回调 —— 用来验证「服务缺席也能跑」。
   */
  constructor({ services = ['llm', 'webServer'] } = {}) {
    this.services = new Set(services)
    this.logger = new FakeLogger()

    /** @type {Array<{label:string, fn:Function, disposed:boolean}>} */
    this._effects = []
    this._disposers = []
    this._injections = []
    this._handlers = new Map() // eventName -> Set<fn>

    this.adapters = new Map() // routeId -> adapter
    this.routes = new Map() // path -> handler
    this.disposed = false

    this.llm = {
      /* 真宿主的 LlmRuntime 把注册表放在公开字段 `adapters` 上（reasoning 共享要读） */
      adapters: this.adapters,
      registerAdapter: (routeIds, adapter) => {
        const ids = Array.isArray(routeIds) ? routeIds : [routeIds]
        for (const id of ids) {
          if (this.adapters.has(id)) {
            throw new Error(`route id "${id}" is owned by another provider; refusing to register it`)
          }
        }
        for (const id of ids) this.adapters.set(id, adapter)
        return () => {
          for (const id of ids) this.adapters.delete(id)
        }
      },
      listProviders: () => [...this.adapters.keys()],
      register: () => {
        throw new Error('not implemented in FakeHost')
      },
    }

    this.webServer = {
      register: ({ kind, path, handler }) => {
        if (this.routes.has(path)) throw new Error(`route already registered: ${path}`)
        this.routes.set(path, { kind, handler })
        return () => this.routes.delete(path)
      },
    }

    // cordis 的 ctx.effect(fn, label) 语义：立刻执行 fn，把返回值当 disposer。
    this.effect = (fn, label) => {
      const entry = { label: label ?? 'anonymous', fn, disposed: false }
      this._effects.push(entry)
      const disposer = fn()
      if (typeof disposer === 'function') {
        this._disposers.push({ label: entry.label, disposer, done: false })
      }
      return () => {
        entry.disposed = true
      }
    }

    // ctx.inject([names], cb)：所需服务齐全才调用 cb。
    this.inject = (names, cb) => {
      const list = Array.isArray(names) ? names : [names]
      const missing = list.filter((n) => !this.services.has(n))
      this._injections.push({ names: list, called: missing.length === 0, missing })
      if (missing.length === 0) cb(this)
      return () => {}
    }

    // cordis 的 ctx.on(name, fn) → disposer。最小实现，够 rotation 装钩子。
    this.on = (event, fn) => {
      if (!this._handlers.has(event)) this._handlers.set(event, new Set())
      this._handlers.get(event).add(fn)
      return () => this.off(event, fn)
    }

    this.off = (event, fn) => {
      const set = this._handlers.get(event)
      if (!set) return
      set.delete(fn)
      if (set.size === 0) this._handlers.delete(event)
    }

    /** 测试用：模拟一个 cordis 事件（按注册顺序 await 每个监听器）。 */
    this.emit = async (event, ...args) => {
      for (const fn of [...(this._handlers.get(event) ?? [])]) await fn(...args)
    }

    /** 某个事件当前挂了几个监听器。 */
    this.handlersOf = (event) => [...(this._handlers.get(event) ?? [])]

  }

  /** 造一个只做记录、不做真事的假 adapter，供 pinned 这类模块注册。 */
  makeAdapter(routeId) {
    return {
      routeId,
      listModels: async () => [],
    }
  }

  /** 提供一项服务（用于验证「后到服务」路径）。 */
  provide(name) {
    this.services.add(name)
  }

  /** 已注册的 route id，排序后返回，便于断言。 */
  registeredRoutes() {
    return [...this.adapters.keys()].sort()
  }

  /** 已注册的 HTTP 路径，排序后返回。 */
  registeredPaths() {
    return [...this.routes.keys()].sort()
  }

  /** 按注册逆序执行全部 disposer（cordis 卸载语义）。 */
  async disposeAll() {
    const failures = []
    for (const item of [...this._disposers].reverse()) {
      if (item.done) continue
      item.done = true
      try {
        await item.disposer()
      } catch (error) {
        failures.push({ label: item.label, error })
      }
    }
    this.disposed = true
    return failures
  }

  /** 卸载后仍然活着的资源。空数组 = 没有泄漏。 */
  leaks() {
    const out = []
    if (this.adapters.size > 0) out.push({ kind: 'adapter', ids: this.registeredRoutes() })
    if (this.routes.size > 0) out.push({ kind: 'route', paths: this.registeredPaths() })
    if (this._handlers.size > 0) out.push({ kind: 'event-listener', events: [...this._handlers.keys()].sort() })
    return out
  }

  /** 直接问某个路径的 handler（绕过 HTTP 层）。 */
  async call(path, { method = 'GET', body, headers } = {}) {
    const entry = this.routes.get(path)
    if (!entry) throw new Error(`no route registered at ${path}`)
    const req = {
      method,
      headers: { host: '127.0.0.1:59999', ...(headers ?? {}) },
      on: () => {},
    }
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]

    return await new Promise((resolve, reject) => {
      const res = {
        statusCode: undefined,
        headers: undefined,
        body: undefined,
        writeHead(status, hdrs) {
          this.statusCode = status
          this.headers = hdrs
        },
        end(payload) {
          try {
            this.body = payload === undefined || payload === '' ? undefined : JSON.parse(payload)
          } catch {
            this.body = payload
          }
          resolve(this)
        },
      }
      req.on = (event, fn) => {
        if (event === 'data') {
          for (const c of chunks) queueMicrotask(() => fn(c))
        } else if (event === 'end') {
          queueMicrotask(fn)
        } else if (event === 'error') {
          /* 测试里不触发 */
        }
        return req
      }
      req.destroy = () => reject(new Error('request destroyed'))
      try {
        entry.handler(req, res)
      } catch (error) {
        reject(error)
      }
    })
  }
}

export { FakeLogger }
