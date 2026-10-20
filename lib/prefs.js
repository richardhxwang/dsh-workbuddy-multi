/**
 * dsh-workbuddy-multi — 设置页开关的落盘存储
 *
 * 设置页上的开关（模型分组、推理档位共享、输入框积分、上下文选档）要「立即生效」，
 * 所以它们是运行时覆盖，不走 Config（Config 只在加载时读一次）。但只放内存的话，
 * DSH 一重启就悄悄回到 Config 的默认值 —— 用户关掉的东西重启后又冒出来。
 *
 * 这里把用户在设置页上的选择写进 `<poolRoot>/settings.json`（无凭据、无秘密）。
 * 读取顺序：这里存过的值 > Config。没存过的键返回 undefined，调用方回落到 Config。
 */

import { existsSync, readFileSync } from 'node:fs'

import { writeFileAtomic } from './context-tiers.js'

/** 允许落盘的键与类型；其余一律拒绝，免得文件变成杂物堆。 */
export const PREF_KEYS = Object.freeze(['pinned', 'reasoningCache', 'creditsChip', 'contextTiers'])

export class Prefs {
  /**
   * @param options.file 存储文件；undefined = 只在内存里（测试用）
   * @param options.logger 可选
   */
  constructor({ file, logger } = {}) {
    this.file = file
    this.logger = logger
    /** @type {Map<string, boolean>} */
    this.values = new Map()
    this.load()
  }

  load() {
    this.values = new Map()
    if (this.file === undefined || !existsSync(this.file)) return
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      this.logger?.warn?.(`设置文件读不出来，按默认值处理：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const values = parsed?.values
    if (typeof values !== 'object' || values === null || Array.isArray(values)) return
    for (const key of PREF_KEYS) {
      if (typeof values[key] === 'boolean') this.values.set(key, values[key])
    }
  }

  /** 存过的值；没存过返回 undefined。 */
  get(key) {
    return this.values.get(key)
  }

  /** 写一个开关并落盘。写盘失败抛出 —— 调用方据此告诉用户「这次没保存」。 */
  set(key, value) {
    if (!PREF_KEYS.includes(key)) throw new Error(`未知设置项：${key}`)
    if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`)
    this.values.set(key, value)
    if (this.file === undefined) return value
    const payload = JSON.stringify({ version: 1, values: Object.fromEntries(this.values) }, null, 2)
    writeFileAtomic(this.file, payload)
    return value
  }
}
