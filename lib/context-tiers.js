/**
 * dsh-workbuddy-multi — 按模型选上下文窗口（设置项，不是拆分条目）
 *
 * DSH（0.2.1-rc.2）没有「按模型选窗口」的能力：模型元数据只有一个标量
 * contextWindow，选择键是 (provider, model id)。所以选档 = 按用户设置改写
 * 描述符里的那个标量：选择器里每个模型仍然只有一个条目、一个名字，
 * 窗口档在设置页里选（逐个模型选，或「全部最高 / 全部最低 / 恢复默认」一把切）。
 *
 * 选择在 `workbuddy-pool/context-windows.json` 落盘（无凭据、无秘密）；
 * 注入走推理共享那条 getModels 包装（augment 钩子），不改上游任何文件。
 * 某模型当前的窗口档若从目录里消失（supportedContextWindows 变了），它的覆盖
 * 自动失效回到目录档 —— 宁可用目录的，也不拿过期选择硬顶。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 临时文件 + rename 的原子写（崩在中途也不会留下半截 JSON）。 */
export function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
}

/** 窗口的紧凑标记（300000 → 300K，1000000 → 1M）。 */
export function tierLabel(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return String(tokens)
  if (tokens >= 1e6 && tokens % 1e6 === 0) return `${tokens / 1e6}M`
  if (tokens >= 1e3 && tokens % 1e3 === 0) return `${tokens / 1e3}K`
  return String(tokens)
}

export class ContextTiers {
  /**
   * @param options.rowsForVariant (variantKey) => 目录行数组（id/name/contextWindow/supportedContextWindows）
   * @param options.file 覆盖存储文件（默认 <poolRoot>/context-windows.json）
   * @param options.enabled 总开关
   */
  constructor({ logger, enabled = true, rowsForVariant, file } = {}) {
    this.logger = logger
    this.enabled = enabled !== false
    this.rowsForVariant = typeof rowsForVariant === 'function' ? rowsForVariant : () => []
    this.file = file
    /** variantKey → Map<modelId, tokens> */
    this.overrides = new Map()
    this.load()
  }

  load() {
    this.overrides = new Map()
    if (this.file === undefined || !existsSync(this.file)) return
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    const tiers = parsed?.tiers
    if (typeof tiers !== 'object' || tiers === null || Array.isArray(tiers)) return
    for (const [variantKey, perModel] of Object.entries(tiers)) {
      if (typeof perModel !== 'object' || perModel === null || Array.isArray(perModel)) continue
      const map = new Map()
      for (const [modelId, tokens] of Object.entries(perModel)) {
        if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) map.set(modelId, tokens)
      }
      this.overrides.set(variantKey, map)
    }
  }

  persist() {
    if (this.file === undefined) return
    const tiers = {}
    for (const [variantKey, map] of this.overrides) tiers[variantKey] = Object.fromEntries(map)
    const payload = JSON.stringify({ version: 1, tiers }, null, 2)
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileAtomic(this.file, payload)
  }

  /** 一个模型声明的窗口档（升序、去重）；没有声明多档的返回 undefined。 */
  optionsFor(variantKey, modelId) {
    const rows = this.rowsForVariant(variantKey) ?? []
    const row = rows.find((r) => r?.id === modelId)
    const supported = Array.isArray(row?.supportedContextWindows) ? row.supportedContextWindows : []
    const list = [...new Set(supported.filter((w) => Number.isFinite(w) && w > 0))].sort((a, b) => a - b)
    return list.length > 1 ? list : undefined
  }

  /**
   * 一个模型的目录默认档（不覆盖时生效的那个窗口）。
   * 目录行里 `defaultContextWindow` 优先，没有就是 `contextWindow`。
   */
  defaultFor(variantKey, modelId) {
    const rows = this.rowsForVariant(variantKey) ?? []
    const row = rows.find((r) => r?.id === modelId)
    const value = row?.defaultContextWindow ?? row?.contextWindow
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  }

  /** 一个模型的生效覆盖：覆盖了、且该档仍在目录声明里才认。 */
  overrideFor(variantKey, modelId) {
    if (!this.enabled) return undefined
    const tokens = this.overrides.get(variantKey)?.get(modelId)
    if (tokens === undefined) return undefined
    const options = this.optionsFor(variantKey, modelId)
    if (options === undefined || !options.includes(tokens)) return undefined
    return tokens
  }

  /**
   * getModels 包装用：把有覆盖的模型的 contextWindow 改成所选档。
   * 不新增条目、不改名字、不动 baseUrl —— 选择器里仍然一个模型一个名字。
   */
  augment(variantKey, models) {
    if (!this.enabled || !Array.isArray(models)) return models
    return models.map((model) => {
      if (typeof model?.id !== 'string') return model
      const tokens = this.overrideFor(variantKey, model.id)
      if (tokens === undefined || model.contextWindow === tokens) return model
      return { ...model, contextWindow: tokens }
    })
  }

  /** 逐模型设置；tokens 传 null/undefined = 恢复目录默认。 */
  setTier(variantKey, modelId, tokens) {
    if (tokens === null || tokens === undefined) {
      const map = this.overrides.get(variantKey)
      if (map !== undefined) {
        map.delete(modelId)
        if (map.size === 0) this.overrides.delete(variantKey)
      }
      this.persist()
      return { model: modelId, cleared: true }
    }
    const options = this.optionsFor(variantKey, modelId)
    if (options === undefined || !options.includes(tokens)) {
      throw new Error(`模型 ${modelId} 没有声明 ${tokens} 这一档（可选：${(options ?? []).join('/')}）`)
    }
    // 选的正好是目录默认档 = 不覆盖。存成覆盖的话，下拉里「目录默认」和同值的那一档
    // 就成了两个不同状态，而且目录默认以后变了，这一条还会钉在旧值上。
    if (tokens === this.defaultFor(variantKey, modelId)) return this.setTier(variantKey, modelId, null)
    if (!this.overrides.has(variantKey)) this.overrides.set(variantKey, new Map())
    this.overrides.get(variantKey).set(modelId, tokens)
    this.persist()
    return { model: modelId, tokens }
  }

  /** 一把切：max=全部最高档，min=全部最低档，default=清掉所有覆盖。 */
  setAll(variantKey, mode) {
    if (mode !== 'max' && mode !== 'min' && mode !== 'default') throw new Error(`mode 必须是 max/min/default，收到 ${mode}`)
    if (mode === 'default') {
      this.overrides.delete(variantKey)
      this.persist()
      return { mode, cleared: true }
    }
    const rows = this.rowsForVariant(variantKey) ?? []
    const map = new Map()
    let count = 0
    for (const row of rows) {
      const supported = Array.isArray(row?.supportedContextWindows) ? row.supportedContextWindows : []
      const list = [...new Set(supported.filter((w) => Number.isFinite(w) && w > 0))]
      if (list.length <= 1) continue
      const target = mode === 'max' ? Math.max(...list) : Math.min(...list)
      // 目标档就是目录默认档时不存覆盖（理由见 setTier）。
      if (target !== (row.defaultContextWindow ?? row.contextWindow)) map.set(row.id, target)
      count += 1
    }
    if (map.size > 0) this.overrides.set(variantKey, map)
    else this.overrides.delete(variantKey)
    this.persist()
    return { mode, count }
  }

  /** 状态摘要（进 status 路由；clients 靠它画每行的选择器）。 */
  status() {
    const tiers = {}
    for (const variantKey of ['cn', 'ai']) {
      const perModel = {}
      const rows = this.rowsForVariant(variantKey) ?? []
      for (const row of rows) {
        const options = this.optionsFor(variantKey, row.id)
        if (options === undefined) continue
        perModel[row.id] = {
          options,
          default: this.defaultFor(variantKey, row.id) ?? null,
          current: this.overrideFor(variantKey, row.id) ?? null,
        }
      }
      tiers[variantKey] = perModel
    }
    const overridden = [...this.overrides.values()].reduce((n, m) => n + m.size, 0)
    /** 有可选窗口档的模型数（两个版本合计）—— 设置页「N 个模型有可选窗口档」读这个。 */
    const tieredModels = Object.values(tiers).reduce((n, perModel) => n + Object.keys(perModel).length, 0)
    return { enabled: this.enabled, overridden, tieredModels, tiers }
  }

  async stop() {}
}
