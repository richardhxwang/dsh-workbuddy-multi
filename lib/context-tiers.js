/**
 * dsh-workbuddy-multi — 按模型选上下文窗口（拆分选择器条目）
 *
 * DSH（0.2.1-rc.2）没有「按模型选窗口」的能力：模型元数据只有一个标量
 * contextWindow，选择键是 (provider, model id)。所以选档只能走「拆分条目」：
 * 目录里声明了多档窗口的模型（supportedContextWindows），在选择器里展开成
 * 多个条目 —— `Kimi-K3`（默认档）加 `Kimi-K3 · 600K` / `Kimi-K3 · 1M`。
 *
 * 拆出来的条目 id 是合成的（`<真实id>--ctx<窗口>`），DSH 链路能原样解析
 * （pi-ai 的 getModel 走我们包过的 getModels，能找到它），但请求不能带着
 * 合成 id 出门 —— 上游 shim 会把它当未知模型。所以合成条目的 baseUrl 指向
 * 本模块的小回环代理：它只做一件事，把请求体里的 model 换回真实 id，再原样
 * 转发给上游 shim（含 Authorization 与 SSE 流，逐字节透传）。
 *
 * 纪律：
 *   - 代理只绑回环地址（与上游 shim 同一边界 doctrine）；
 *   - 只处理 POST /v1/chat/completions，其余一律 404；
 *   - 目录里没有多档窗口、或上游 shim 地址还没学到时，augment 原样返回。
 */

import http from 'node:http'

/** 合成 id 的后缀形状。 */
export const CTX_SUFFIX_RE = /--ctx(\d+)$/

/** 窗口的紧凑标记（300000 → 300K，1000000 → 1M）。 */
export function tierLabel(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return String(tokens)
  if (tokens >= 1e6 && tokens % 1e6 === 0) return `${tokens / 1e6}M`
  if (tokens >= 1e3 && tokens % 1e3 === 0) return `${tokens / 1e3}K`
  return String(tokens)
}

export class ContextTiers {
  /**
   * @param options.rowsForVariant (variantKey) => 目录行数组（至少带 id/name/contextWindow/supportedContextWindows）
   * @param options.enabled 总开关
   */
  constructor({ logger, enabled = true, rowsForVariant } = {}) {
    this.logger = logger
    this.enabled = enabled !== false
    this.rowsForVariant = typeof rowsForVariant === 'function' ? rowsForVariant : () => []
    /** 合成 id → { baseId, contextWindow, variantKey } */
    this.tiers = new Map()
    /** variantKey → 上游 shim 的 baseUrl（在 getModels 包装读取时现学） */
    this.upstreamBases = new Map()
    this.server = undefined
    this.port = 0
  }

  /** 重算派生表；目录内容变化时由调用方（共享模块的定时器）触发。 */
  rebuild(variantKeys) {
    this.tiers.clear()
    if (!this.enabled) return
    for (const variantKey of variantKeys) {
      let rows = []
      try {
        rows = this.rowsForVariant(variantKey) ?? []
      } catch {
        rows = []
      }
      for (const row of rows) {
        const supported = Array.isArray(row?.supportedContextWindows) ? row.supportedContextWindows : []
        const current = typeof row?.contextWindow === 'number' ? row.contextWindow : 0
        const others = [...new Set(supported.filter((w) => Number.isFinite(w) && w > 0 && w !== current))]
        for (const w of others) {
          this.tiers.set(`${row.id}--ctx${w}`, {
            baseId: row.id,
            contextWindow: w,
            variantKey,
          })
        }
      }
    }
  }

  /**
   * getModels 追加：给有派生档的模型补上合成条目（窗口改写、baseUrl 指向本代理）。
   * 代理还没起监听时原样返回 —— 下一轮读取自然会带上。
   */
  augment(variantKey, models) {
    if (!this.enabled || this.port === 0 || !Array.isArray(models)) return models
    const out = [...models]
    for (const model of models) {
      if (typeof model?.id !== 'string') continue
      const upstreamBase = model.baseUrl
      for (const [synId, tier] of this.tiers) {
        if (tier.variantKey !== variantKey || tier.baseId !== model.id) continue
        if (typeof upstreamBase === 'string' && upstreamBase !== '') {
          this.upstreamBases.set(variantKey, upstreamBase)
        }
        out.push({
          ...model,
          id: synId,
          name: `${model.name ?? model.id} · ${tierLabel(tier.contextWindow)}`,
          contextWindow: tier.contextWindow,
          baseUrl: `http://127.0.0.1:${this.port}/v1`,
        })
      }
    }
    return out
  }

  /** 启动代理（幂等）；返回是否已就绪。 */
  async start() {
    if (this.server !== undefined) return true
    const server = http.createServer((req, res) => this.handle(req, res))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    this.server = server
    this.port = server.address().port
    this.logger?.info?.(`上下文选档代理已监听 127.0.0.1:${this.port}（${this.tiers.size} 个派生条目）`)
    return true
  }

  /** 只接 POST /v1/chat/completions；其余 404。 */
  async handle(req, res) {
    const fail = (status, message) => {
      const payload = JSON.stringify({ error: message })
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(payload)
    }
    try {
      if (req.method !== 'POST' || typeof req.url !== 'string' || !req.url.startsWith('/v1/')) {
        fail(404, 'not found')
        return
      }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 8 << 20) {
          fail(413, 'body too large')
          req.destroy()
          return
        }
        chunks.push(chunk)
      }
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        fail(400, 'invalid json')
        return
      }
      const synId = body?.model
      const tier = typeof synId === 'string' ? this.tiers.get(synId) : undefined
      if (tier === undefined) {
        fail(400, `unknown tiered model: ${String(synId)}`)
        return
      }
      const upstreamBase = this.upstreamBases.get(tier.variantKey)
      if (upstreamBase === undefined) {
        fail(502, 'upstream shim origin not learned yet')
        return
      }
      body.model = tier.baseId
      const headers = { ...req.headers }
      delete headers['content-length']
      delete headers['host']
      const upstream = await fetch(`${upstreamBase}${req.url.slice(3)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      })
      if (upstream.body === null) {
        res.end()
        return
      }
      // SSE / 逐块透传，不做整缓冲
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
      res.end()
    } catch (error) {
      if (!res.headersSent) fail(502, String(error instanceof Error ? error.message : error))
      else res.end()
    }
  }

  /** 状态摘要（进 status 路由）。 */
  status() {
    return {
      enabled: this.enabled,
      port: this.port,
      tieredModels: [...new Set([...this.tiers.values()].map((t) => t.baseId))].length,
      tiers: this.tiers.size,
    }
  }

  async stop() {
    if (this.server === undefined) return
    const server = this.server
    this.server = undefined
    this.port = 0
    await new Promise((resolve) => server.close(resolve))
  }
}
