/**
 * dsh-workbuddy-multi · lib/rotation.js
 *
 * 账号轮换引擎（PLAN.md §3.2 冻结接口；写入范围：本文件只归 rotation-engine 所有）。
 *
 * 为什么是这个形状（全部来自实测，见 PLAN §2.1/§2.4）：
 *  1. 上游 dsh-workbuddy-connect 一行都不改，它解析凭据文件的优先级是
 *     「插件显式 authFile/authFileAI → 环境变量 → 平台默认路径」（host-heartbeat 内
 *     `const fromEnv = process.env[this.variant?.env ?? "WORKBUDDY_AUTH_FILE"]`）。
 *     因此我们唯一能用的旋钮就是 `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE`，
 *     且必须先检测用户是否在插件设置里填了显式路径（否则我们的 env 会被忽略 → R1）。
 *  2. 上游 `readDesktop()` 无缓存，每次请求都重新 readFile，所以「切号」= 原子替换
 *     `active/<variant>.info` 的内容，即时生效、无需重启、无需 reload。
 *  3. 频控（429 / 6004）可观测：`@deepseek-ai/dsh-llm-retry` 把 `llm/retry` 追加进
 *     **session 事件流**（`agent.session.append("llm/retry", …)`），不是 cordis 事件；
 *     所以这里用 `ctx.on('session/event', (session, event) => …)` 观察它。
 *     payload = `{ retryId, turn, step, provider, mode, policyKey, retry, delayMs, failure }`，
 *     failure = `{ message, code, status?, providerRetryAfterMs?, … }`，code 是稳定枚举
 *     （workbuddy 的 429 会被 pi-ai 归类成 `RATE_LIMIT`，message 里带中文 6004 文案）。
 *  4. round-robin 要挂在 `llm/stream` waterfall 上，且 cordis 的 waterfall 是**同步组合**
 *     （`waterfall()` 立即 `return next()`），监听器不能 `await` 之后再调 next()。唯一正确
 *     写法是返回 async generator、在 generator 体内 `await` 之后 `yield* next()`
 *     （ds-bot 的 `images.js` 就是这个模式）。
 *
 * 依赖纪律：本文件零第三方依赖、零相对静态 import，只使用注入的
 * `pool` / `ctx` / `logger` / `config` —— 因此可以独立单测，也不会因为兄弟模块
 * （pool.js / index.js / pinned.js / client.js）还没落盘而炸。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** 上游的凭据路径环境变量名（PLAN §2.1，实测 `variant.env`）。 */
export const FALLBACK_ENV = Object.freeze({
  cn: 'WORKBUDDY_AUTH_FILE',
  ai: 'WORKBUDDY_AI_AUTH_FILE',
})

/**
 * 内置 variant 兜底表。
 *
 * pool.js 会导出同形的 `POOL_VARIANTS`（key/routeId/env/region/…），构造时会优先采纳它；
 * 这张表只是「pool 没给 / 给了残缺」时的兜底，保证本模块永远能独立工作。
 */
export const ROTATION_VARIANTS = Object.freeze([
  Object.freeze({
    key: 'cn',
    routeId: 'workbuddy',
    env: 'WORKBUDDY_AUTH_FILE',
    desktopEnv: 'WORKBUDDY_AUTH_FILE',
    region: 'cn',
    displayName: 'WorkBuddy',
  }),
  Object.freeze({
    key: 'ai',
    routeId: 'workbuddy-ai',
    env: 'WORKBUDDY_AI_AUTH_FILE',
    desktopEnv: 'WORKBUDDY_AI_AUTH_FILE',
    region: 'global',
    displayName: 'WorkBuddy AI',
  }),
])

/**
 * 触发「换号」的稳定 failure code 集合。
 *
 * `RATE_LIMIT` = 上游 429/soft_rate（workbuddy 的 6004 文案走这条）；
 * `QUOTA` / `ACCOUNT_QUOTA` = 额度用尽（同样只对当前账号成立，换号有意义）。
 * 其余 code（`MISSING_CREDENTIAL`、`INVALID_REQUEST`、`TIMEOUT`…）换号无用，不动。
 */
/* [anchor:codes] 反向测试锚点：把这里清空后，QUOTA/ACCOUNT_QUOTA 不再触发换号 */
export const RATE_LIMIT_CODES = Object.freeze(['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA'])

export const ROTATION_POLICIES = Object.freeze(['on-rate-limit', 'round-robin', 'manual'])

export const DEFAULT_ROTATION_CONFIG = Object.freeze({
  /** 默认策略：平时粘住当前账号，只在频控/额度错误时换。 */
  policy: 'on-rate-limit',
  /** 频控时是否把当前账号冷却起来（false = 只换号不冷却）。 */
  respectCooldown: true,
  /** 拿不到重置时刻时的兜底冷却时长。 */
  cooldownMs: 5 * 60 * 1000,
  /** 冷却时长下限：解析出的重置时刻若已过去，至少冷却这么久，避免立刻换回来。 */
  minCooldownMs: 30 * 1000,
  /** 是否接管 `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE`。 */
  envOverride: true,
  /** 检测到上游显式 authFile 时，是否连环境变量也不设（设了也会被忽略）。 */
  suppressEnvOnConflict: true,
  /** 检测到冲突是否告警（内容同时进 `status().warnings`）。 */
  warnOnAuthFileConflict: true,
  /** round-robin 是否为内部请求（带 purpose 的，如标题生成）也转动。默认否，避免烧号。 */
  rotateInternalRequests: false,
  /** 宿主/测试可注入的替代实现。 */
  patchFiles: undefined,
  readFile: undefined,
  detectConflicts: undefined,
})

/** `RotationEngine` 构造函数要求的 pool 方法（PLAN §3.2 冻结面，缺一个就 fail fast）。 */
export const REQUIRED_POOL_METHODS = Object.freeze([
  'list',
  'activeUid',
  'policy',
  'selectable',
  'setCooldown',
  'advance',
  'ensureActive',
  'activeFilePath',
  'on',
  'off',
])

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数（可单测；反向测试的锚点都在这一层或紧邻处）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从上游频控文案里解析「额度重置时刻」，返回 epoch 毫秒；解析不出返回 `undefined`。
 *
 * 典型输入（实测原文）：
 *   `您的使用量已超出频率限制，将在 2026-10-19 05:11:08 UTC+8 重置，您也可以切换其他模型继续使用。`
 *
 * 支持的写法（宽松，但会校验日历合法性）：
 *   - 日期分隔 `-` 或 `/`；日期与时间之间空格或 `T`
 *   - 秒可省略；可带小数秒
 *   - 时区：`UTC+8` / `UTC+08:00` / `GMT-5` / `+0800` / `-05:00` / `Z` / `UTC` / `GMT`
 *   - 完全不带时区时，按**本机本地时间**解释（与上游 parseCycleEndTime 的朴素约定一致）
 *
 * 故意不做：不猜相对时间（"30 分钟后"）、不做年份补全。解析不出就返回 undefined，
 * 由调用方用 `config.cooldownMs` 兜底 —— 绝不编一个假时刻出来。
 *
 * @param {unknown} text
 * @returns {number|undefined}
 */
export function parseRateLimitReset(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  // 每次新建正则实例：避免 g 标志的 lastIndex 在调用之间泄漏。
  const re =
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|GMT|UT)?\s*(?:([+-])\s?(\d{1,2})(?::?(\d{2}))?)?/gi
  for (const m of text.matchAll(re)) {
    const year = Number(m[1])
    const month = Number(m[2])
    const day = Number(m[3])
    const hour = Number(m[4])
    const minute = Number(m[5])
    const second = m[6] === undefined ? 0 : Number(m[6])
    const zone = m[7] === undefined ? undefined : m[7].toUpperCase()
    const sign = m[8]
    const offHours = m[9] === undefined ? 0 : Number(m[9])
    const offMinutes = m[10] === undefined ? 0 : Number(m[10])

    if (month < 1 || month > 12 || day < 1 || day > 31) continue
    if (hour > 23 || minute > 59 || second > 59) continue

    let offsetMinutes = null // null = 未给时区 → 按本机本地时间解释
    if (zone !== undefined) {
      offsetMinutes = 0
      if (sign !== undefined) {
        if (offHours > 14 || offMinutes > 59) continue
        if (offHours === 14 && offMinutes > 0) continue
        offsetMinutes = (sign === '-' ? -1 : 1) * (offHours * 60 + offMinutes)
      }
    } else if (sign !== undefined) {
      // 只写了 `+08:00` / `+0800`，没有 UTC/GMT 前缀。
      if (offHours > 14 || offMinutes > 59) continue
      if (offHours === 14 && offMinutes > 0) continue
      offsetMinutes = (sign === '-' ? -1 : 1) * (offHours * 60 + offMinutes)
    }

    // 日历往返校验：挡住 2026-02-30（Date 会悄悄滚到 3 月）之类。
    const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
    const probe = new Date(asUtc)
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
      continue
    }

    const epoch =
      offsetMinutes === null
        ? asUtc + new Date(asUtc).getTimezoneOffset() * 60_000
        : asUtc - offsetMinutes * 60_000
    if (!Number.isFinite(epoch) || epoch <= 0) continue
    return epoch
  }
  return undefined
}

/**
 * 扫描一份 YAML/JSON 文本里显式的 `authFile` / `authFileAI` 赋值。
 *
 * 这是 R1 的检测手段：上游优先用插件里显式配置的路径，那样我们设的环境变量会被忽略。
 * 纯函数、宽松解析（不做完整 YAML/Cordis 求值）：只要同名字段被赋了非空值就算命中，
 * 空串 / `null` / `~` 视为「没配」。
 *
 * @param {unknown} text
 * @returns {{field: 'authFile'|'authFileAI', value: string, scoped: boolean, line: number}[]}
 *   `scoped` = 同一份文件里前面 40 行内出现过 `workbuddy` 字样（该段配置大概率属于本插件）。
 */
export function scanAuthFileOverrides(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.split(/\r?\n/)
  const out = []
  const seen = new Set()
  const lineIndexOf = (index) => {
    let n = 0
    for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1
    return n
  }
  const scopedAt = (lineIndex) => {
    for (let i = Math.max(0, lineIndex - 40); i <= lineIndex; i += 1) {
      if (/workbuddy/i.test(lines[i] ?? '')) return true
    }
    return false
  }
  const add = (field, rawValue, lineIndex) => {
    const value = normalizeScalar(rawValue)
    /* [anchor:scan-empty] 反向测试锚点：空值必须被当成「没配置」 */
    if (value === '') return
    const key = `${field}\u0000${value}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ field, value, scoped: scopedAt(lineIndex), line: lineIndex + 1 })
  }
  // 第一遍：YAML 行形态（也覆盖 pretty-print 的 JSON）
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^[ \t]*(?:-[ \t]*)?["']?(authFileAI|authFile)["']?[ \t]*:[ \t]*(.*)$/.exec(lines[i])
    if (m !== null) add(m[1], m[2], i)
  }
  // 第二遍：单行 JSON 里的内联键值（`{"ns":{"authFile":"/x"}}`）
  const inline = /["'](authFileAI|authFile)["'][ \t]*:[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}\]\s]+)/g
  for (const m of text.matchAll(inline)) add(m[1], m[2], lineIndexOf(m.index ?? 0))
  return out
}

/** 去掉 YAML/JSON 标量的引号与行尾注释；空值统一成 `''`。 */
function normalizeScalar(rest) {
  let s = String(rest ?? '')
  s = s.replace(/\s+#.*$/, '') // YAML 行尾注释（`#` 前有空白才按注释处理）
  s = s.trim()
  const quoted = /^(['"])([\s\S]*)\1$/.exec(s)
  if (quoted !== null) s = quoted[2].trim()
  if (s === '' || s === '~' || s.toLowerCase() === 'null') return ''
  return s
}

/**
 * provider id → variant key；不是我们托管的基础 route 时返回 `undefined`。
 *
 * **只做精确匹配**，刻意不做前缀匹配：pinned 路由 id 形如 `workbuddy-m-<slug>`
 * （pinned.js 的 `DEFAULT_PROVIDER_PREFIX = 'workbuddy-m-'`），那是用户给单个账号显式
 * 钉住的 route，本来就绕过池子的 active 文件。若把 `workbuddy-m-*` 也算成 cn/ai，
 * 轮换会被我们自己钉住的路由反复触发 —— 那是错的。
 *
 * @param {unknown} provider
 * @param {ReadonlyArray<{key: string, routeId?: string, variantId?: string}>} [variants]
 * @returns {'cn'|'ai'|undefined}
 */
/* [anchor:provider] 反向测试锚点：改成前缀匹配后，pinned 路由会被误判成 cn */
export function variantKeyForProvider(provider, variants = ROTATION_VARIANTS) {
  if (typeof provider !== 'string') return undefined
  const norm = provider.trim().toLowerCase()
  if (norm === '') return undefined
  for (const v of variants) {
    for (const id of [v.routeId, v.variantId, v.key]) {
      if (typeof id !== 'string' || id === '') continue
      if (id.toLowerCase() === norm) return v.key
    }
  }
  return undefined
}

/** 同一个失败的去重键：同一 step 的多次重试共用 retryId、`retry` 递增，四元组唯一。 */
function retrySignature(data) {
  const retryId = typeof data.retryId === 'string' && data.retryId !== '' ? data.retryId : ''
  const turn = data.turn === undefined ? '' : String(data.turn)
  const step = data.step === undefined ? '' : String(data.step)
  const retry = data.retry === undefined ? '' : String(data.retry)
  if (retryId === '' && `${turn}${step}${retry}` === '') return undefined
  return `${retryId}|${turn}|${step}|${retry}`
}

/**
 * 把一个 `llm/retry` session 事件判定成「是否要换号」。
 *
 * 返回 `undefined` 表示不关我们的事（不是 llm/retry、不是我们的 provider、code 不该换号）。
 * 纯函数：注入 `variants` / `codes` / `now` 即可完全单测。
 *
 * @param {unknown} event cordis `session/event` 的第二个参数
 * @param {{variants?: unknown[], codes?: readonly string[], now?: number, fallbackCooldownMs?: number}} [options]
 * @returns {undefined | {variantKey: string, provider: string, code: string, message: string,
 *   resetAt: number|undefined, retryAt: number|undefined, signature: string|undefined}}
 */
export function classifyRetryEvent(event, options = {}) {
  const {
    variants = ROTATION_VARIANTS,
    codes = RATE_LIMIT_CODES,
    now = Date.now(),
    fallbackCooldownMs,
  } = options
  if (!event || typeof event !== 'object') return undefined
  if (event.type !== 'llm/retry') return undefined
  const data = event.data
  if (!data || typeof data !== 'object') return undefined
  const variantKey = variantKeyForProvider(data.provider, variants)
  if (variantKey === undefined) return undefined
  const failure = data.failure && typeof data.failure === 'object' ? data.failure : {}
  const code = typeof failure.code === 'string' ? failure.code : ''
  if (!codes.includes(code)) return undefined
  const message = typeof failure.message === 'string' ? failure.message : ''
  const providerRetryAfterMs =
    typeof failure.providerRetryAfterMs === 'number' &&
    Number.isFinite(failure.providerRetryAfterMs) &&
    failure.providerRetryAfterMs > 0
      ? failure.providerRetryAfterMs
      : undefined
  const resetAt = parseRateLimitReset(message)
  const retryAt =
    resetAt ??
    (providerRetryAfterMs !== undefined
      ? now + providerRetryAfterMs
      : typeof fallbackCooldownMs === 'number' && Number.isFinite(fallbackCooldownMs)
        ? now + fallbackCooldownMs
        : undefined)
  return {
    variantKey,
    provider: typeof data.provider === 'string' ? data.provider : '',
    code,
    message,
    resetAt,
    retryAt,
    signature: retrySignature(data),
  }
}

/**
 * 冷却计划：优先用上游给的重置时刻，其次调用方的兜底时长；再抬到 `minCooldownMs` 下限。
 *
 * @param {{resetAt?: number, now?: number, cooldownMs?: number, minCooldownMs?: number}} input
 * @returns {number} epoch 毫秒
 */
/* [anchor:reset] 反向测试锚点：忽略 resetAt 后，冷却时刻会退化成 now+cooldownMs */
export function planCooldown({ resetAt, now = Date.now(), cooldownMs = 0, minCooldownMs = 0 } = {}) {
  // 只有「未来」的重置时刻才可用；已经过去说明文案是旧的（或本机时钟偏了），
  // 这时退回配置的 cooldownMs，否则冷却瞬间结束 → 立刻被选回来 → 抖动。
  const usable = typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt > now
  const base = usable ? resetAt : now + cooldownMs
  return Math.max(base, now + minCooldownMs)
}

/**
 * 默认要扫描「用户有没有显式配 authFile」的文件清单。
 *
 * 全部**只读**：`~/.dsh/cordis.patch.yml`、`~/.dsh/settings.yaml`、以及 profile 的
 * `cordis.patch.yml`（从 `DSH_PROFILE_DIR` / `DSH_PROFILE` 推断，绝不硬编码 desktop）。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
export function defaultPatchFiles(env = process.env) {
  const read = (name) => {
    const raw = env?.[name]
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
  }
  const home = read('DSH_HOME') ?? join(homedir(), '.dsh')
  const files = [join(home, 'cordis.patch.yml'), join(home, 'settings.yaml')]
  const profileDir = read('DSH_PROFILE_DIR')
  if (profileDir !== undefined) files.push(join(profileDir, 'cordis.patch.yml'))
  const profile = read('DSH_PROFILE')
  if (profile !== undefined) {
    files.push(
      profile.startsWith('/')
        ? join(profile, 'cordis.patch.yml')
        : join(home, 'profiles', profile, 'cordis.patch.yml'),
    )
  }
  return [...new Set(files)]
}

/**
 * 尽力而为地读一次宿主 settings 服务里的 workbuddy 配置节。
 *
 * dsh-settings 的读 API 是 generation-dependent 的（上游自己都只鸭子类型判
 * `installSection`/`update` 是否存在），所以这里只做防御性尝试：形状不认识就返回 []，
 * 绝不因为探测失败而中断 start()。真正可靠的那条路是文件扫描。
 */
function probeSettingsSection(ctx, variants) {
  try {
    if (!ctx || typeof ctx !== 'object') return []
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : ctx.settings
    if (!settings || typeof settings !== 'object') return []
    const out = []
    for (const v of variants) {
      const ns = v.key === 'cn' ? 'workbuddy' : 'workbuddy-ai'
      const field = v.key === 'cn' ? 'authFile' : 'authFileAI'
      let section
      for (const method of ['get', 'section', 'value', 'read']) {
        if (typeof settings[method] !== 'function') continue
        try {
          section = settings[method](ns)
        } catch {
          section = undefined
        }
        if (section !== undefined) break
      }
      if (!section || typeof section !== 'object') continue
      const value = typeof section[field] === 'string' ? section[field].trim() : ''
      if (value !== '') out.push({ variantKey: v.key, field, value, source: `settings:${ns}`, scoped: true })
    }
    return out
  } catch {
    return []
  }
}

/** 把注入的 variant 表归一成 { key, routeId, env, displayName, region }，永远含 cn+ai。 */
function resolveVariants(config, pool) {
  const injected = Array.isArray(config?.variants)
    ? config.variants
    : Array.isArray(pool?.POOL_VARIANTS)
      ? pool.POOL_VARIANTS
      : Array.isArray(pool?.variants)
        ? pool.variants
        : []
  return ROTATION_VARIANTS.map((base) => {
    const hit = injected.find(
      (v) =>
        v &&
        typeof v === 'object' &&
        (v.key === base.key || v.routeId === base.routeId || v.variantId === base.routeId),
    )
    return Object.freeze({
      key: base.key,
      routeId: (hit && (hit.routeId ?? hit.variantId)) || base.routeId,
      env: (hit && (hit.env ?? hit.desktopEnv)) || base.env,
      displayName: (hit && hit.displayName) || base.displayName,
      region: (hit && hit.region) || base.region,
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 引擎
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 账号轮换引擎。
 *
 * 生命周期：`new RotationEngine({ pool, ctx, logger, config })` → `await pool.load()`
 * （宿主做）→ `await engine.start()` → 之后池子每次变更（`pool.on('changed')`）调
 * `await engine.sync()`；卸载时 `await engine.stop()`。
 *
 * `stop()` 故意**不回滚** `process.env`：回滚会让上游退回「平台默认路径」（用户真实的
 * 桌面 auth 文件），那比「指向池子里的 active 文件」更糟 —— 见 PLAN §3.2。
 */
export class RotationEngine {
  #pool
  #ctx
  #logger
  #config
  #variants
  #warnings = []
  #warnedOnce = new Set()
  #disposers = []
  #started = false
  #seenRetries = new Set()
  #advanceLog = new Map()
  /**
   * 每个会话、每个档位最近一次请求是哪个账号发出去的（`sessionId|variantKey` → uid）。
   *
   * 撞限事件（llm/retry）到达时，「当前生效账号」不一定就是刚失败的那个 —— 别的会话
   * 或者分发前的跳过逻辑可能已经换过号。按「当前生效」去冷却会冤枉一个好账号，
   * 再换一次号又把请求送回下一个可能也不行的账号。所以失败要记到**发请求的那个账号**头上。
   */
  #lastDispatch = new Map()
  #envApplied = new Map()
  #conflicts = []
  #unavailable = []
  #explicitPolicy = false
  #now

  constructor({ pool, ctx, logger, config } = {}) {
    if (!pool || typeof pool !== 'object') {
      throw new TypeError('RotationEngine: `pool` is required')
    }
    const missing = REQUIRED_POOL_METHODS.filter((m) => typeof pool[m] !== 'function')
    if (missing.length > 0) {
      // 按 PLAN §3.2 的冻结面 fail fast，而不是给 pool 打补丁 —— 缺方法要报给 lead。
      throw new TypeError(`RotationEngine: pool is missing frozen methods: ${missing.join(', ')}`)
    }
    const raw = config && typeof config === 'object' ? config : {}
    this.#pool = pool
    this.#ctx = ctx ?? null
    this.#logger = logger ?? null
    this.#config = { ...DEFAULT_ROTATION_CONFIG, ...raw }
    // 「显式给了 policy」必须以调用方原始 config 为准，不能看合并后的默认值。
    this.#explicitPolicy = raw.policy !== undefined
    this.#variants = resolveVariants(this.#config, pool)
    this.#now = typeof raw.now === 'function' ? raw.now : () => Date.now()
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  /**
   * 启动：① 检测显式 authFile 冲突并告警 ② 接管环境变量 ③ ensureActive
   * ④ 装 `llm/retry`（换号）与 `llm/stream`（round-robin）监听。
   */
  async start() {
    if (this.#started) return
    this.#started = true

    // ① 冲突检测（R1）：上游会优先用插件设置里的 authFile，我们的 env 对它无效。
    this.#conflicts = await this.#detectConflicts()
    const conflicted = new Set(this.#conflicts.map((c) => c.variantKey))
    if (this.#config.warnOnAuthFileConflict !== false) {
      for (const c of this.#conflicts) {
        this.#warn(
          `dsh-workbuddy-connect 的设置中填写了 ${c.field}（${JSON.stringify(c.value)}` +
            `${c.source ? `，位于 ${c.source}${c.line ? `:${c.line}` : ''}` : ''}），其优先级高于本插件，` +
            `${editionName(c.variantKey)}的自动轮换不会生效。请清空该设置。`,
        )
      }
    }

    // ② 环境变量接管（只在没有显式配置、且未被 config.envOverride=false 关掉时）。
    for (const variant of this.#variants) {
      if (this.#config.envOverride === false) break
      if (conflicted.has(variant.key) && this.#config.suppressEnvOnConflict !== false) continue
      const target = this.#pool.activeFilePath(variant.key)
      if (typeof target !== 'string' || target === '') {
        this.#warn(`${editionName(variant.key)}未能接管凭据路径（activeFilePath 无返回值）`)
        continue
      }
      /* [anchor:env] 反向测试锚点：不设环境变量，上游就永远读不到池子里的账号 */
      process.env[variant.env] = target
      this.#envApplied.set(variant.key, target)
    }

    // ③ 喂好 active/<v>.info（幂等；池子空则只告警）。
    for (const variant of this.#variants) {
      const uid = await this.#call(() => this.#pool.ensureActive(variant.key), undefined)
      const active = typeof uid === 'string' ? uid : this.#readActive(variant.key)
      this.#advanceLog.set(variant.key, { uid: active, at: this.#now(), reason: 'ensure-active' })
      if (active === undefined) {
        this.#warn(`${editionName(variant.key)}暂无可用账号`)
      }
    }

    // ④ 监听。
    this.#installHooks()
  }

  /** 卸掉钩子。故意不回滚 process.env（见类注释）。 */
  async stop() {
    for (const dispose of this.#disposers.splice(0)) {
      try {
        dispose()
      } catch (err) {
        this.#loggerWarn(`卸载监听失败：${messageOf(err)}`)
      }
    }
    this.#started = false
  }

  /** 池子 'changed' 之后调用：重铺 active 文件、必要时重建，并保持 env 指向。 */
  async sync() {
    if (!this.#started) return this.status()
    for (const variant of this.#variants) {
      const uid = await this.#call(() => this.#pool.ensureActive(variant.key), undefined)
      const active = typeof uid === 'string' ? uid : this.#readActive(variant.key)
      const prev = this.#advanceLog.get(variant.key)
      if (prev === undefined || prev.uid !== active) {
        this.#advanceLog.set(variant.key, { uid: active, at: this.#now(), reason: 'sync' })
      }
      if (this.#config.envOverride === false) continue
      if (!this.#envApplied.has(variant.key)) continue
      const target = this.#pool.activeFilePath(variant.key)
      if (typeof target === 'string' && target !== '' && process.env[variant.env] !== target) {
        process.env[variant.env] = target
        this.#envApplied.set(variant.key, target)
      }
    }
    return this.status()
  }

  /** 只读状态快照（PLAN §3.2 冻结形状 + `warnings`）。 */
  status() {
    const at = this.#now()
    const variants = {}
    for (const variant of this.#variants) {
      const accounts = this.#trySync(() => this.#pool.list(variant.key), [])
      const list = Array.isArray(accounts) ? accounts : []
      const selectable = this.#trySync(() => this.#pool.selectable(variant.key, { at }), [])
      const log = this.#advanceLog.get(variant.key)
      variants[variant.key] = {
        routeId: variant.routeId,
        env: variant.env,
        activeUid: this.#readActive(variant.key),
        lastAdvanceAt: log?.at,
        lastAdvanceReason: log?.reason,
        cooling: list
          .filter((m) => m && typeof m.cooldownUntil === 'number' && m.cooldownUntil > at)
          .map((m) => ({ uid: m.uid, until: m.cooldownUntil, reason: m.cooldownReason ?? 'rate-limit' })),
        accounts: list.length,
        selectable: Array.isArray(selectable) ? selectable.length : 0,
      }
    }
    const policy = this.#trySync(() => this.#pool.policy(), this.#config.policy)
    return {
      policy: typeof policy === 'string' ? policy : this.#config.policy,
      variants,
      warnings: [...this.#warnings],
      conflicts: this.#conflicts.map((c) => ({ ...c })),
      unavailable: [...this.#unavailable],
      envOverride: this.#config.envOverride !== false,
      envApplied: Object.fromEntries(this.#envApplied),
      started: this.#started,
    }
  }

  // ── 监听 ────────────────────────────────────────────────────────────────
  #installHooks() {
    const on = this.#ctx?.on
    /* [anchor:degradation] 反向测试锚点：这里必须「降级 + 告警」，绝不能抛 */
    if (typeof on !== 'function') {
      this.#unavailable.push('ctx.on')
      this.#warn('宿主未提供 ctx.on，自动轮换不可用，仅支持手动指定账号')
      return
    }

    // 频控：llm/retry 是 session append（不是 cordis 事件）→ 从 session/event 里筛。
    this.#addDisposer(this.#safeOn('session/event', (session, event) => this.#onSessionEvent(session, event)))

    // 策略应用：只有显式给了 config.policy 才去改池子里的持久策略。
    void this.#applyPolicy()

    // round-robin：llm/stream waterfall，分发前 advance（async generator 内 await 后 yield* next()）。
    this.#addDisposer(this.#safeOn('llm/stream', (options, next) => this.#onStream(options, next)))
  }

  async #applyPolicy() {
    if (this.#explicitPolicy !== true) return
    const wanted = this.#config.policy
    if (!ROTATION_POLICIES.includes(wanted)) return
    const current = this.#trySync(() => this.#pool.policy(), undefined)
    if (current === wanted) return
    await this.#call(() => this.#pool.setPolicy?.(wanted), undefined)
  }

  /** `ctx.on` 的防御性包装：返回一个可调用的 disposer，永远不抛。 */
  #safeOn(name, fn) {
    try {
      const disposer = this.#ctx.on(name, fn)
      if (typeof disposer === 'function') return disposer
      return () => {
        try {
          this.#ctx?.off?.(name, fn)
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      this.#unavailable.push(name)
      this.#warn(`无法注册 ${name} 监听（ctx.on：${messageOf(err)}），自动轮换功能受限`)
      return () => {}
    }
  }

  #onSessionEvent(session, event) {
    let plan
    try {
      plan = classifyRetryEvent(event, {
        variants: this.#variants,
        codes: RATE_LIMIT_CODES,
        now: this.#now(),
        fallbackCooldownMs: this.#config.cooldownMs,
      })
    } catch (err) {
      this.#loggerWarn(`解析 llm/retry 事件失败：${messageOf(err)}`)
      return
    }
    if (plan === undefined) return
    // 去重键要带上 session 身份：两个会话在同一 turn/step/retry 上各撞一次 429 是两次
    // **真实**失败（尤其上游事件里没有 retryId 时），不能因为四元组相同就吞掉一次。
    if (plan.signature !== undefined) {
      plan = { ...plan, signature: `${sessionIdOf(session)}|${plan.signature}` }
    }
    const servedBy = this.#lastDispatch.get(dispatchKey(sessionIdOf(session), plan.variantKey))
    if (servedBy !== undefined) plan = { ...plan, servedBy }
    // session 事件是同步 emit 的：绝不把 rejection 丢回宿主。
    void this.#handleRateLimit(plan).catch((err) => {
      this.#loggerWarn(`频控换号失败（${plan.variantKey}/${plan.code}）：${messageOf(err)}`)
    })
  }

  /**
   * 频控处理：冷却当前账号 + 换到下一个可用账号（`manual` 策略只冷却不换）。
   *
   * @param {{variantKey: string, code: string, message?: string, resetAt?: number,
   *   retryAt?: number, signature?: string}} plan
   */
  async #handleRateLimit(plan) {
    const { variantKey } = plan
    /* [anchor:dedupe] 反向测试锚点：去掉去重后，同一失败的重复事件会连换几号 */
    if (plan.signature !== undefined && this.#seenRetries.has(plan.signature)) {
      return { advanced: false, deduped: true }
    }
    if (plan.signature !== undefined) {
      if (this.#seenRetries.size > 512) this.#seenRetries.clear()
      this.#seenRetries.add(plan.signature)
    }

    const now = this.#now()
    const until = planCooldown({
      resetAt: plan.resetAt ?? plan.retryAt,
      now,
      cooldownMs: this.#config.cooldownMs,
      minCooldownMs: this.#config.minCooldownMs,
    })
    const current = this.#readActive(variantKey)
    // 失败记到发请求的那个账号头上；不知道是谁发的（没有会话 id）才退回当前生效账号。
    const failed = typeof plan.servedBy === 'string' ? plan.servedBy : current

    if (this.#config.respectCooldown !== false && typeof failed === 'string') {
      const cooldown = { until, reason: plan.code }
      /* [anchor:cooldown] 反向测试锚点：不冷却当前账号，下一次还会选中它 */
      await this.#pool.setCooldown(variantKey, failed, cooldown)
    }

    const policy = await this.#call(() => this.#pool.policy(), this.#config.policy)
    if (policy === 'manual') {
      this.#loggerInfo(`${variantKey} 频控（${plan.code}）但在 manual 策略下不自动换号`)
      return { advanced: false, until, from: failed, to: current }
    }

    // 已经有人换过号了（别的会话撞限、或分发前跳过了冷却账号），且新的生效账号可用：
    // 不再往前换 —— 否则一个失败会连换两个号，好账号被白白跳过。
    /* [anchor:no-double-advance] 反向测试锚点：去掉后，一次失败会多换一个号 */
    if (typeof current === 'string' && current !== failed && this.#isSelectable(variantKey, current)) {
      return { advanced: false, until, from: failed, to: current }
    }

    const next = await this.#call(() => this.#pool.advance(variantKey, { reason: 'rate-limit' }), undefined)
    if (typeof next !== 'string') {
      this.#warn(`${editionName(variantKey)}触发限流（${plan.code}），且没有其他可用账号，继续使用 ${String(current).slice(0, 8)}`)
      return { advanced: false, until, from: failed, to: current }
    }
    this.#advanceLog.set(variantKey, { uid: next, at: now, reason: `rate-limit:${plan.code}` })
    this.#loggerInfo(
      `${variantKey} 频控（${plan.code}）→ 切到 ${next.slice(0, 8)}，${String(failed).slice(0, 8)} 冷却到 ${new Date(until).toISOString()}`,
    )
    return { advanced: next !== current, until, from: failed, to: next }
  }

  /**
   * `llm/stream` waterfall 监听：round-robin 时在**分发前**换号。
   *
   * cordis waterfall 是同步组合，所以这里必须同步 return；`await` 只能发生在返回的
   * async generator 内部（`yield* next()` 之前）。
   */
  #onStream(options, next) {
    if (typeof next !== 'function') return next
    const variantKey = variantKeyForProvider(options?.provider, this.#variants)
    if (variantKey === undefined) return next()
    const key = dispatchKey(options?.sessionId, variantKey)
    const policy = this.#trySync(() => this.#pool.policy(), this.#config.policy)
    const internal = this.#config.rotateInternalRequests !== true && options?.purpose !== undefined
    const rotate = policy === 'round-robin' && !internal
    // 冷却中的账号在冷却结束前一律跳过：每次分发前都看一眼，而不是等它再撞一次限才换。
    // 内部请求（压缩、标题）也一样 —— 发到冷却账号上同样会失败。
    /* [anchor:skip-cooling] 反向测试锚点：去掉后，冷却中的生效账号会再被请求一次 */
    const skip = !rotate && policy !== 'manual' && this.#config.respectCooldown !== false && this.#activeIsCooling(variantKey)
    if (!rotate && !skip) {
      this.#rememberDispatch(key, variantKey)
      return next()
    }
    const engine = this
    return (async function* rotated() {
      try {
        if (rotate) await engine.#advanceForRoundRobin(variantKey)
        else await engine.#skipCoolingActive(variantKey)
      } catch (err) {
        engine.#loggerWarn(`分发前换号失败：${messageOf(err)}`)
      }
      engine.#rememberDispatch(key, variantKey)
      yield* next()
    })()
  }

  #rememberDispatch(key, variantKey) {
    if (key === undefined) return
    const uid = this.#readActive(variantKey)
    if (uid === undefined) return
    if (this.#lastDispatch.size > 512) this.#lastDispatch.clear()
    this.#lastDispatch.set(key, uid)
  }

  #isSelectable(variantKey, uid) {
    const list = this.#trySync(() => this.#pool.selectable(variantKey, { at: this.#now() }), [])
    return Array.isArray(list) && list.some((meta) => meta?.uid === uid)
  }

  /** 生效账号不可用（冷却/停用/失效），而池里还有别的可用账号。 */
  #activeIsCooling(variantKey) {
    const active = this.#readActive(variantKey)
    if (active === undefined) return false
    const list = this.#trySync(() => this.#pool.selectable(variantKey, { at: this.#now() }), [])
    if (!Array.isArray(list) || list.length === 0) return false
    return !list.some((meta) => meta?.uid === active)
  }

  async #skipCoolingActive(variantKey) {
    if (!this.#activeIsCooling(variantKey)) return undefined
    const from = this.#readActive(variantKey)
    const next = await this.#call(() => this.#pool.advance(variantKey, { reason: 'skip-cooling' }), undefined)
    if (typeof next === 'string') {
      this.#advanceLog.set(variantKey, { uid: next, at: this.#now(), reason: 'skip-cooling' })
      this.#loggerInfo(`${variantKey} ${String(from).slice(0, 8)} 还在冷却，分发前直接换到 ${next.slice(0, 8)}`)
    }
    return next
  }

  async #advanceForRoundRobin(variantKey) {
    const at = this.#now()
    const candidates = this.#trySync(() => this.#pool.selectable(variantKey, { at }), [])
    if (!Array.isArray(candidates) || candidates.length === 0) return undefined
    // 只剩一个可用账号且它已经在用：不必每请求重写 active 文件（省掉无意义的磁盘写）。
    // 但如果在用的是冷却中的那个，就必须换过去，否则两个账号里冷却的那个会一直被打。
    if (candidates.length === 1 && candidates[0]?.uid === this.#readActive(variantKey)) return undefined
    const next = await this.#call(() => this.#pool.advance(variantKey, { reason: 'round-robin' }), undefined)
    if (typeof next === 'string') {
      this.#advanceLog.set(variantKey, { uid: next, at, reason: 'round-robin' })
    }
    return next
  }

  // ── 冲突检测 ────────────────────────────────────────────────────────────
  async #detectConflicts() {
    if (typeof this.#config.detectConflicts === 'function') {
      const injected = await this.#call(
        () => this.#config.detectConflicts({ variants: this.#variants, ctx: this.#ctx }),
        [],
      )
      return Array.isArray(injected) ? injected.filter((c) => c && c.variantKey && c.value) : []
    }
    const files = Array.isArray(this.#config.patchFiles) ? this.#config.patchFiles : defaultPatchFiles()
    const readFile =
      typeof this.#config.readFile === 'function'
        ? this.#config.readFile
        : (path) => {
            try {
              return readFileSync(path, 'utf8')
            } catch {
              return undefined
            }
          }
    const out = []
    for (const file of files) {
      const text = await this.#call(() => readFile(file), undefined)
      if (typeof text !== 'string' || text === '') continue
      for (const hit of scanAuthFileOverrides(text)) {
        out.push({
          variantKey: hit.field === 'authFileAI' ? 'ai' : 'cn',
          field: hit.field,
          value: hit.value,
          source: String(file),
          scoped: hit.scoped,
          line: hit.line,
        })
      }
    }
    for (const hit of probeSettingsSection(this.#ctx, this.#variants)) out.push(hit)
    return out
  }

  // ── 小工具 ──────────────────────────────────────────────────────────────
  #readActive(variantKey) {
    const uid = this.#trySync(() => this.#pool.activeUid(variantKey), undefined)
    return typeof uid === 'string' ? uid : undefined
  }

  /** 同步上下文用的安全调用（status()、策略判断、候选计数）。 */
  #trySync(fn, fallback) {
    try {
      return fn()
    } catch (err) {
      this.#warnOnce(`账号池操作失败：${messageOf(err)}`)
      return fallback
    }
  }

  /** 异步上下文用的安全调用（start/sync/换号）。池子未 load 时 `_assertLoaded()` 会抛。 */
  async #call(fn, fallback) {
    try {
      return await fn()
    } catch (err) {
      this.#warnOnce(`账号池操作失败：${messageOf(err)}`)
      return fallback
    }
  }

  #warn(message) {
    this.#warnings.push(message)
    this.#loggerWarn(message)
  }

  #warnOnce(message) {
    if (this.#warnedOnce.has(message)) return
    this.#warnedOnce.add(message)
    this.#warn(message)
  }

  #loggerWarn(message) {
    const logger = this.#logger
    if (logger && typeof logger.warn === 'function') logger.warn(`workbuddy-multi/rotation: ${message}`)
  }

  #loggerInfo(message) {
    const logger = this.#logger
    if (logger && typeof logger.info === 'function') logger.info(`workbuddy-multi/rotation: ${message}`)
  }

  #addDisposer(disposer) {
    if (typeof disposer === 'function') this.#disposers.push(disposer)
  }
}

/** cordis session 的身份（不同 generation 的字段名不一样，挨个试）。 */
/** 界面上显示的版本名。 */
function editionName(variantKey) {
  return variantKey === 'cn' ? '国内版' : variantKey === 'ai' ? '国际版' : String(variantKey)
}

/** `#lastDispatch` 的键；没有会话 id 时返回 undefined（不记录，退回按当前生效账号处理）。 */
function dispatchKey(sessionId, variantKey) {
  return typeof sessionId === 'string' && sessionId !== '' ? `${sessionId}|${variantKey}` : undefined
}

function sessionIdOf(session) {
  if (session === null || typeof session !== 'object') return ''
  for (const field of ['id', 'sessionId', 'key']) {
    const value = session[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}

export default RotationEngine
