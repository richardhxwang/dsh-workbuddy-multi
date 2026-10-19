/**
 * dsh-workbuddy-multi — 宿主入口
 *
 * 伴侣插件：**不修改 dsh-workbuddy-connect 的任何文件**，靠它的公开导出与
 * 文档化的 auth 文件优先级（`resolveDesktopCandidates()` 每次请求都读
 * `process.env[variant.env]`）来接管账号。
 *
 * 组成：
 *   pool.js      账号池（原始字节快照 + 托管生效文件）
 *   rotation.js  环境变量接管 + 轮换策略 + 429 换号
 *   pinned.js    每账号一套 store/shim/adapter → 独立模型组
 *   login.js     主动加账号：OAuth 微信扫码登录
 *   keepalive.js 全池 token 自动续期（我们自己的账号能刷，桌面收割的密文账号交给上游）
 *   本文件        装配 + 设置卡片的 HTTP 动作面
 */

import z from '@deepseek-ai/schemastery'

import { WorkBuddyPool, POOL_VARIANTS, variantFor, isAccountDead, POLICY_VALUES } from './pool.js'
import { RotationEngine } from './rotation.js'
import { PinnedRoutes } from './pinned.js'
import { WorkBuddyLoginManager, LOGIN_TIMEOUT_MS } from './login.js'
import { KeepAliveScheduler, refreshDocument, accessTokenOf, KEEPALIVE_DEFAULTS } from './keepalive.js'
import { CreditsCache } from './credits.js'
import { CatalogHealer, HEAL_VARIANT_KEYS } from './heal.js'
import { loadUpstream, upstreamModule, upstreamLoadError, UPSTREAM_PACKAGE, UPSTREAM_REPO_URL } from './upstream.js'

/** 插件身份（cordis）。 */
export const name = 'llm-workbuddy-multi'

/**
 * 需要 llm 服务：pinned 路由通过 `ctx.llm.registerAdapter` 注册模型组。
 * webServer 是可选的，用 `ctx.inject` 惰性接入，缺了也能跑。
 */
export const inject = ['llm']

/** 设置卡片的 HTTP 基址（客户端必须与此一致）。 */
export const ACTIONS_BASE = '/plugins/dsh-workbuddy-multi'

const DEFAULTS = {
  poolRoot: '',
  policy: 'on-rate-limit',
  cooldownMs: 1_800_000,
  respectCooldown: true,
  pinned: false,
  providerPrefix: 'workbuddy-m-',
  scanMs: 60_000,
  envTakeover: true,
  keepalive: true,
  keepaliveSweepMs: 900_000,
  keepaliveMarginMs: 300_000,
  credits: true,
  creditsTtlMs: 60_000,
  healBaseline: true,
}

export const Config = z.object({
  poolRoot: z
    .string()
    .default(DEFAULTS.poolRoot)
    .description('账号池目录（默认 ~/.dsh/workbuddy-pool）'),
  policy: z
    .string()
    .default(DEFAULTS.policy)
    .description('轮换策略：on-rate-limit（默认）/ round-robin / manual'),
  cooldownMs: z
    .number()
    .default(DEFAULTS.cooldownMs)
    .description('撞限流但看不出重置时刻时，该账号冷却多久（毫秒）'),
  respectCooldown: z.boolean().default(DEFAULTS.respectCooldown).description('轮换时跳过冷却中的账号'),
  pinned: z
    .boolean()
    .default(DEFAULTS.pinned)
    .description('为每个账号注册一个独立模型组（默认关闭：同一版本的多账号合并成一个模型组）'),
  providerPrefix: z
    .string()
    .default(DEFAULTS.providerPrefix)
    .description('独立模型组的 provider id 前缀（改动后需重启才出现在选择器里）'),
  scanMs: z.number().default(DEFAULTS.scanMs).description('扫描桌面 auth 文件与导入目录的间隔（毫秒）'),
  envTakeover: z
    .boolean()
    .default(DEFAULTS.envTakeover)
    .description('把 WORKBUDDY_AUTH_FILE / WORKBUDDY_AI_AUTH_FILE 指向账号池的生效文件'),
  keepalive: z
    .boolean()
    .default(DEFAULTS.keepalive)
    .description('定时为池内账号续期 token（只对插件自己扫码登录的明文凭据有效）'),
  keepaliveSweepMs: z
    .number()
    .default(DEFAULTS.keepaliveSweepMs)
    .description('续期检查间隔（毫秒）'),
  keepaliveMarginMs: z
    .number()
    .default(DEFAULTS.keepaliveMarginMs)
    .description('access token 剩余不足这个毫秒数时提前刷新'),
  credits: z
    .boolean()
    .default(DEFAULTS.credits)
    .description('统计账号池的积分合计（合并模式下的「合计」chip 用它；只发计费 GET，不写盘）'),
  creditsTtlMs: z.number().default(DEFAULTS.creditsTtlMs).description('积分合计的缓存有效期（毫秒）'),
  healBaseline: z
    .boolean()
    .default(DEFAULTS.healBaseline)
    .description(
      '上游启动时读不到凭据会把该档目录藏起来（组里 0 个模型）；开启后在最坏状态下自动点一次它的目录刷新',
    ),
})

// ── 小工具 ──────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

function hostnameOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')
  try {
    const u = new URL(`http://${text}`)
    return u.hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * 与上游 `loopbackRequest()` 同一判据：Host 必须是回环，且若带了 Origin
 * 也必须是回环（同源 fetch 不带 Origin，只靠 Host 通过）。
 */
export function loopbackRequest(req) {
  const host = hostnameOf(req?.headers?.host)
  if (host === undefined || !LOOPBACK_HOSTS.has(host)) return false
  const origin = req?.headers?.origin
  if (origin === undefined || origin === '') return true
  const originHost = hostnameOf(origin)
  return originHost !== undefined && LOOPBACK_HOSTS.has(originHost)
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(req, limit = 1 << 20) {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function safeMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .slice(0, 500)
}

function pickLogger(ctx) {
  // cordis 的服务门禁：访问**未 inject 声明**的服务属性会直接抛
  // `cannot get property "log" without inject`。实测（真 profile 启动）：
  // `ctx.logger` 是内置可读的（上游 `lib/index.js:2110` 也是直接用 `ctx.logger`），
  // 但 `ctx.log` 是要 inject 的服务 —— 先前这里裸读 `ctx.log` 直接把整个插件树
  // 拦在启动阶段。所以每个候选都单独 try，绝不让探测本身冒泡。
  const candidates = []
  for (const key of ['logger', 'log']) {
    try {
      candidates.push(ctx?.[key])
    } catch {
      // 未 inject 的服务：跳过，不是错误。
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      if (typeof candidate.warn === 'function' || typeof candidate.info === 'function') return candidate
    }
    if (typeof candidate === 'function') {
      return { debug: candidate, info: candidate, warn: candidate, error: candidate }
    }
  }
  return undefined
}

function normalizeConfig(config) {
  const src = config && typeof config === 'object' ? config : {}
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (src[key] !== undefined && src[key] !== '') out[key] = src[key]
  }
  out.poolRoot = typeof out.poolRoot === 'string' ? out.poolRoot : ''
  out.policy = POLICY_VALUES.includes(out.policy) ? out.policy : DEFAULTS.policy
  out.cooldownMs =
    Number.isFinite(out.cooldownMs) && out.cooldownMs > 0 ? out.cooldownMs : DEFAULTS.cooldownMs
  out.scanMs = Number.isFinite(out.scanMs) && out.scanMs >= 5_000 ? out.scanMs : DEFAULTS.scanMs
  out.providerPrefix =
    typeof out.providerPrefix === 'string' && out.providerPrefix.trim() !== ''
      ? out.providerPrefix.trim()
      : DEFAULTS.providerPrefix
  out.pinned = out.pinned !== false
  out.respectCooldown = out.respectCooldown !== false
  out.envTakeover = out.envTakeover !== false
  out.keepalive = out.keepalive !== false
  out.keepaliveSweepMs =
    Number.isFinite(out.keepaliveSweepMs) && out.keepaliveSweepMs >= 60_000
      ? out.keepaliveSweepMs
      : DEFAULTS.keepaliveSweepMs
  out.keepaliveMarginMs =
    Number.isFinite(out.keepaliveMarginMs) && out.keepaliveMarginMs >= 0
      ? out.keepaliveMarginMs
      : DEFAULTS.keepaliveMarginMs
  out.credits = out.credits !== false
  out.creditsTtlMs =
    Number.isFinite(out.creditsTtlMs) && out.creditsTtlMs >= 5_000
      ? out.creditsTtlMs
      : DEFAULTS.creditsTtlMs
  return out
}

// ── 插件本体 ────────────────────────────────────────────────────────────

/**
 * 装配入口。
 *
 * @param ctx cordis 上下文
 * @param rawConfig 插件配置
 * @param deps 仅测试用的注入出口（cordis 只传前两个参数）：
 *   `fetchImpl` 用来拦掉真网络，`now` 用来固定时钟。
 *   生产路径两个都不传时分别落到 `globalThis.fetch` 与 `Date.now`。
 */
export function apply(ctx, rawConfig, deps = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = pickLogger(ctx)
  const fetchFn =
    typeof deps?.fetchImpl === 'function'
      ? deps.fetchImpl
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch
        : undefined
  const nowFn = typeof deps?.now === 'function' ? deps.now : undefined
  const state = {
    ready: false,
    stopped: false,
    bootError: undefined,
    upstreamMissing: false,
    lastUpstreamRetryAt: 0,
    boot: undefined,
    notes: [],
    lastScanAt: 0,
    lastSignature: '',
    timer: undefined,
    pendingSync: undefined,
    detach: [],
  }

  const pool = new WorkBuddyPool({
    root: config.poolRoot !== '' ? config.poolRoot : undefined,
    logger,
    now: nowFn,
  })
  const rotation = new RotationEngine({
    pool,
    ctx,
    logger,
    config: {
      policy: config.policy,
      respectCooldown: config.respectCooldown,
      cooldownMs: config.cooldownMs,
      envOverride: config.envTakeover,
    },
  })
  const pinned = new PinnedRoutes({
    pool,
    ctx,
    logger,
    config: { enable: config.pinned, providerPrefix: config.providerPrefix },
  })

  /**
   * 分组方式的运行时覆盖。
   *
   * `undefined` = 跟着 Config 走（Config 只在加载时读一次）。卡片上的开关把它设成
   * 布尔值，于是「合并 / 按账号」可以随时切、**不需要重启**：`PinnedRoutes.enabled`
   * 每次 sync 现读，切回合并会把已注册的独立模型组全部摘掉，并广播
   * `llm/adapters-updated` 让选择器重新拉一遍。
   */
  let pinnedOverride

  /**
   * 当前分组方式。
   *
   * - `per-account`：每个账号一个独立模型组（`workbuddy-m-<slug>`）。
   * - `merged`：不注册任何独立模型组，只用上游按版本注册的那两个
   *   （国内版 `workbuddy` / 国际版 `workbuddy-ai`），组内由本插件自动换号。
   *
   * 两种方式下**国内版和国际版都是分开的**：不同的 route id、不同的环境变量、
   * 不同的生效文件，账号池还按 region 做了串号守卫。
   *
   * @returns {'merged'|'per-account'}
   */
  function groupMode() {
    const perAccount = pinnedOverride === undefined ? config.pinned : pinnedOverride
    return perAccount ? 'per-account' : 'merged'
  }

  /**
   * 把当前分组方式落到 pinned 路由上。
   *
   * 合并模式不是「什么都不做」：它要**摘掉**上一次按账号模式注册的那些路由，
   * 所以两条分支都得 sync，不能只在按账号时 sync。
   */
  async function applyGroupMode() {
    pinned.enabled = groupMode() === 'per-account'
    await pinned.sync()
    return pinned.list()
  }

  /**
   * 登录管理器**按需构造**：它的构造函数要求能拿到 fetch，缺了会抛。
   * 理论上前提不成立（Node 22 自带 fetch），但这条路径若在插件加载阶段抛，
   * 会把整个插件树拦在启动前 —— 不值得。所以推迟到第一次真的要用扫码时才建。
   */
  let loginManager
  function login() {
    if (loginManager === undefined) {
      loginManager = new WorkBuddyLoginManager({
        logger,
        timeoutMs: LOGIN_TIMEOUT_MS,
        fetchImpl: fetchFn,
        now: nowFn,
      })
    }
    return loginManager
  }

  /**
   * 自动续期调度器。**必须显式注入 fetch**：它拿不到 fetch 时会把自己标成
   * `unavailable: 'fetch-missing'` 并且一个请求都不发（这是它的安全设计）。
   */
  const keepalive = new KeepAliveScheduler({
    pool,
    logger,
    fetchImpl: fetchFn,
    now: nowFn,
    config: { sweepMs: config.keepaliveSweepMs, marginMs: config.keepaliveMarginMs },
  })

  /**
   * 「宿主自己的 origin」——从**已经通过回环校验的请求**里学，而不是猜端口。
   *
   * 只有上游 status 路由的 payload 里带着「生效账号的积分」，而它挂在宿主自己的 HTTP
   * 上；本插件也注册在同一个 server 上，所以浏览器打过来的 `Host` 就是可用地址。
   * 学不到就如实返回 null（界面显示「未知」），绝不去猜 50498/59277 这类端口。
   */
  let loopbackOrigin
  function rememberLoopbackOrigin(req) {
    const host = req?.headers?.host
    if (typeof host !== 'string') return
    const trimmed = host.trim()
    if (trimmed === '') return
    if (!LOOPBACK_HOSTS.has(hostnameOf(trimmed))) return
    loopbackOrigin = trimmed
    // 拿到 origin 才能拼出上游地址，所以这是自愈唯一的触发点。幂等、异步、失败静默。
    const healer = healerInstance()
    if (healer !== undefined) {
      for (const variantKey of HEAL_VARIANT_KEYS) healer.maybeHeal({ variantKey, origin: trimmed })
    }
  }

  /**
   * 目录自愈（R8，PLAN §3.6.5）。
   *
   * 上游启动时若读不到凭据，会把自己那一档的目录 `setVisible(false)`，表现为
   * 「模型组在，但一个模型都没有」。我们的环境变量接管与它的启动顺序不保证，所以重启后
   * 可能复发。这里只在**确切的坏状态**（已登录 + 目录为空）下点一次上游自己的刷新动作，
   * 好状态下零请求。按需构造（理由同 login/credits：构造期抛会拦住整个插件树）。
   */
  let catalogHealer
  function healerInstance() {
    if (catalogHealer === undefined && config.healBaseline) {
      catalogHealer = new CatalogHealer({ fetchImpl: fetchFn, now: nowFn, logger })
    }
    return catalogHealer
  }

  /** 只读摘要，进 status 用（不含凭据、不含 origin）。 */
  function healerStatus() {
    const empty = { enabled: Boolean(config.healBaseline), attempted: {} }
    if (catalogHealer === undefined) return empty
    try {
      return catalogHealer.status()
    } catch (error) {
      logger?.warn?.(`目录自愈摘要读取失败：${safeMessage(error)}`)
      return empty
    }
  }

  /** 上游自己的两个状态路由（国内版在根、国际版在 `ai/` 前缀下）。 */
  const UPSTREAM_STATUS_PATHS = {
    cn: '/plugins/dsh-workbuddy-connect/status',
    ai: '/plugins/dsh-workbuddy-connect/ai/status',
  }

  /**
   * 密文凭据的兜底数：只有**生效账号**的那份能在上游 status 路由的 payload 里拿到
   * （它按生效凭据算）。拿不到就返回 null —— 宁可显式「未知」，也不拿 0 冒充。
   */
  async function fallbackCredits({ variantKey, active }) {
    if (active !== true) return null
    const origin = loopbackOrigin
    if (typeof origin !== 'string' || origin === '') return null
    if (typeof fetchFn !== 'function') return null
    const path = UPSTREAM_STATUS_PATHS[variantKey]
    if (typeof path !== 'string') return null
    try {
      const response = await fetchFn(`http://${origin}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (response.ok !== true) return null
      const body = await response.json()
      const credits = body?.credits
      if (credits === null || typeof credits !== 'object') return null
      if (credits.unlimited === true) return { unlimited: true }
      return Number.isFinite(credits.total) ? { total: credits.total } : null
    } catch {
      return null
    }
  }

  /**
   * 积分合计（第三轮，PLAN §3.6）。
   *
   * 合并模式下一个模型组代表整个档位，可上游 UI 的积分 chip 只认**当前生效的那一个
   * 凭据**（数据来自上游自己的 status 路由，那个 payload 里没有「池」的概念）。
   * 所以合计只能由我们自己逐账号去问，再往同一个槽位加一个我们自己的 chip。
   *
   * 按需构造（理由同 login）：构造期抛异常会把整个插件树拦在启动前，不值得。
   * 采集失败只影响显示、绝不影响聊天 —— 这里所有路径都吞异常。
   */
  let creditsCache
  function creditsInstance() {
    if (creditsCache === undefined && config.credits) {
      creditsCache = new CreditsCache({
        pool,
        logger,
        now: nowFn,
        createClient:
          typeof deps?.createClient === 'function'
            ? deps.createClient
            : () => new (upstreamModule().WorkBuddyUpstreamClient)(),
        fetchImpl: fetchFn,
        fallbackCredits,
        config: { ttlMs: config.creditsTtlMs },
      })
    }
    return creditsCache
  }

  /** 只读摘要；没算过或功能关掉一律 null（界面据此显示「未知」）。 */
  function creditsStatus() {
    if (creditsCache === undefined) return { cn: null, ai: null, ttlMs: config.creditsTtlMs }
    try {
      const snapshot = creditsCache.status()
      return {
        cn: snapshot?.cn ?? null,
        ai: snapshot?.ai ?? null,
        ttlMs: config.creditsTtlMs,
      }
    } catch (error) {
      logger?.warn?.(`积分摘要读取失败：${safeMessage(error)}`)
      return { cn: null, ai: null, ttlMs: config.creditsTtlMs }
    }
  }

  function poolSignature() {
    const parts = []
    for (const v of POOL_VARIANTS) {
      for (const meta of pool.list(v.key)) {
        parts.push(`${v.key}:${meta.uid}:${meta.enabled ? 1 : 0}:${meta.label}`)
      }
    }
    return parts.sort().join('|')
  }

  async function syncNow() {
    if (state.stopped || !state.ready) return
    if (state.pendingSync !== undefined) {
      clearTimeout(state.pendingSync)
      state.pendingSync = undefined
    }
    try {
      await rotation.sync()
    } catch (error) {
      logger?.warn?.(`rotation.sync 失败：${safeMessage(error)}`)
    }
    const signature = poolSignature()
    if (signature !== state.lastSignature) {
      state.lastSignature = signature
      try {
        await pinned.sync()
      } catch (error) {
        logger?.warn?.(`pinned.sync 失败：${safeMessage(error)}`)
      }
    }
  }

  function scheduleSync() {
    if (state.stopped || state.pendingSync !== undefined) return
    state.pendingSync = setTimeout(() => {
      state.pendingSync = undefined
      void syncNow()
    }, 50)
    state.pendingSync.unref?.()
  }

  async function scan() {
    if (state.stopped || !state.ready) return
    state.lastScanAt = Date.now()
    try {
      for (const v of POOL_VARIANTS) await pool.absorbImportDir(v.key)
      await pool.captureAll()
      // 顺手回收已结束的扫码会话，卡片列表里的倒计时不会一直留着过期条目。
      if (loginManager !== undefined) {
        try {
          loginManager.gc()
        } catch {
          /* 回收失败不影响扫描 */
        }
      }
      await syncNow()
    } catch (error) {
      logger?.warn?.(`扫描失败：${safeMessage(error)}`)
    }
  }

  /**
   * 卡片顶部「需要处理」区的内容：只放真正要用户动手的事。
   *
   * 冷却、需重新登录、池子为空这些状态卡片在账号行上已经各有标记，这里不再重复成
   * 一条条文字；上游 authFile 冲突只在**真的检测到**时出现（由 rotation 判定），
   * 不再无条件常驻一条提醒。
   */
  function buildWarnings() {
    let rotationWarnings = []
    try {
      const list = rotation.status()?.warnings
      rotationWarnings = Array.isArray(list) ? list : []
    } catch {
      /* rotation 还没起来时没有警告可报 */
    }
    // rotation 的警告是累计的（同一条频控提示可能出现很多次）：去重后只留最近 5 条。
    const unique = [...new Set([...rotationWarnings.map(String), ...state.notes])]
    return unique.slice(-5)
  }

  async function bootstrap() {
    // 上游没装时不往下走：降级成只报告状态，由设置卡片去插件市场把上游装上。
    // 每次 status 被读到都会节流重试，装好上游后不重启也能接上（见 statusHandler）。
    const upstream = await loadUpstream(deps?.importUpstream)
    if (upstream === null) {
      state.upstreamMissing = true
      return
    }
    state.upstreamMissing = false
    await pool.load()
    for (const v of POOL_VARIANTS) await pool.absorbImportDir(v.key)
    await pool.captureAll()

    await rotation.start()
    state.ready = true
    // 用 applyGroupMode 而不是裸 sync：合并模式同样要走一遍（至少要把上次留下的
    // 独立模型组摘干净），而且这样「分组方式」只有一条出口，不会两处各写一半。
    await applyGroupMode()
    state.lastSignature = poolSignature()
    state.lastScanAt = Date.now()

    // 自动续期放在最后启动：它第一件事就是扫一轮，此时账号池必须是已加载的完整状态。
    // 关掉 keepalive 时**连 fetch 都不注入**，绝无隐式网络行为。
    if (config.keepalive) {
      try {
        keepalive.start()
      } catch (error) {
        state.notes.push(`自动续期启动失败：${safeMessage(error)}`)
        logger?.warn?.(`keepalive.start 失败：${safeMessage(error)}`)
      }
    } else {
      state.notes.push('自动续期已在配置中关闭（keepalive: false），账号令牌不会自动刷新。')
    }

    logger?.info?.(
      `WorkBuddy 多账号已就绪：策略 ${pool.policy()}，账号 ${POOL_VARIANTS.map(
        (v) => `${v.displayName} ${pool.list(v.key).length}`,
      ).join(' / ')}`,
    )
  }

  // ── 设置卡片的只读状态 ────────────────────────────────────────────────
  function status() {
    const now = Date.now()
    const variants = POOL_VARIANTS.map((v) => {
      // 未就绪时绝不能碰 pool：load() 还没跑，list() 会抛。卡片会先拿到一份空壳，
      // 等 ready 翻真之后再刷出真实账号。
      const accounts = state.ready
        ? pool.list(v.key).map((meta) => ({
            ...meta,
            dead: isAccountDead(meta, now),
            cooling: typeof meta.cooldownUntil === 'number' && meta.cooldownUntil > now,
          }))
        : []
      return {
        key: v.key,
        variantKey: v.key,
        routeId: v.routeId,
        env: v.env,
        region: v.region,
        displayName: v.displayName,
        accounts,
        activeUid: state.ready ? pool.activeUid(v.key) : undefined,
        cooling: accounts
          .filter((a) => a.cooling)
          .map((a) => ({ uid: a.uid, until: a.cooldownUntil, reason: a.cooldownReason })),
      }
    })

    let pinnedList = []
    if (state.ready) {
      try {
        pinnedList = pinned.list()
      } catch {
        pinnedList = []
      }
    }
    let rotationStatus
    if (state.ready) {
      try {
        rotationStatus = rotation.status()
      } catch {
        rotationStatus = undefined
      }
    }

    // 未完成的扫码会话（供卡片显示倒计时 / 取消按钮）。登录管理器可能还没被构造过。
    let logins = []
    if (loginManager !== undefined) {
      try {
        logins = loginManager.list()
      } catch {
        logins = []
      }
    }

    let keepaliveStatus
    if (state.ready) {
      try {
        keepaliveStatus = keepalive.status()
      } catch {
        keepaliveStatus = undefined
      }
    }

    /**
     * 分组方式，以及合并模式下真正在用的那两个模型组。
     *
     * 合并模式的「组」是上游按版本注册的，不是我们注册的 —— 客户端要能解释
     * 「你的 4 个国际版账号现在归 `workbuddy-ai` 这一组」，所以这里把 route id、
     * 账号数、当前生效账号一并给出。
     */
    const groups = {
      mode: groupMode(),
      defaultMode: config.pinned ? 'per-account' : 'merged',
      providerPrefix: config.providerPrefix,
      merged: variants.map((v) => ({
        variantKey: v.key,
        routeId: v.routeId,
        displayName: v.displayName,
        accountCount: v.accounts.length,
        activeUid: v.activeUid,
      })),
    }

    const warnings = state.ready ? buildWarnings() : [...state.notes]
    if (state.bootError) warnings.unshift(`启动未完成：${safeMessage(state.bootError)}`)

    return {
      ready: state.ready,
      policy: state.ready ? pool.policy() : config.policy,
      variants,
      pinned: pinnedList,
      groups,
      rotation: rotationStatus,
      logins,
      keepalive: keepaliveStatus,
      credits: creditsStatus(),
      heal: healerStatus(),
      warnings,
      upstream: {
        package: UPSTREAM_PACKAGE,
        repoUrl: UPSTREAM_REPO_URL,
        installed: upstreamModule() !== null,
        ...(state.upstreamMissing && upstreamLoadError() !== undefined
          ? { error: safeMessage(upstreamLoadError()) }
          : {}),
      },
      lastScanAt: state.lastScanAt,
    }
  }

  // ── 动作面 ────────────────────────────────────────────────────────────
  function requireVariant(value) {
    const v = variantFor(value)
    if (!v) throw new Error(`variantKey 必须是 'cn' 或 'ai'，收到 ${JSON.stringify(value)}`)
    return v.key
  }

  function requireString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${field} 必须是非空字符串`)
    }
    return value.trim()
  }

  const ACTIONS = {
    async select(body) {
      const variantKey = requireVariant(body.variantKey)
      const uid = requireString(body.uid, 'uid')
      await pool.setActive(variantKey, uid, { reason: 'manual' })
      await syncNow()
      return { uid }
    },
    async advance(body) {
      const variantKey = requireVariant(body.variantKey)
      const uid = await pool.advance(variantKey, { reason: 'manual' })
      await syncNow()
      return { uid }
    },
    async setEnabled(body) {
      const variantKey = requireVariant(body.variantKey)
      const uid = requireString(body.uid, 'uid')
      if (typeof body.on !== 'boolean') throw new Error('on 必须是布尔值')
      const meta = await pool.setEnabled(variantKey, uid, body.on)
      await syncNow()
      return { uid: meta.uid, enabled: meta.enabled }
    },
    async setLabel(body) {
      const variantKey = requireVariant(body.variantKey)
      const uid = requireString(body.uid, 'uid')
      if (typeof body.label !== 'string') throw new Error('label 必须是字符串')
      const meta = await pool.setLabel(variantKey, uid, body.label)
      await syncNow()
      return { uid: meta.uid, label: meta.label }
    },
    async remove(body) {
      const variantKey = requireVariant(body.variantKey)
      const uid = requireString(body.uid, 'uid')
      const removed = await pool.remove(variantKey, uid)
      await syncNow()
      return { uid, removed }
    },
    async refreshFromDesktop(body) {
      const variantKey = requireVariant(body.variantKey)
      const meta = await pool.captureFromDesktop(variantKey)
      await pool.ensureActive(variantKey)
      await syncNow()
      return { uid: meta === undefined || meta === null ? null : meta.uid, captured: Boolean(meta) }
    },
    async importPaths(body) {
      const variantKey = requireVariant(body.variantKey)
      if (!Array.isArray(body.paths) || body.paths.length === 0) {
        throw new Error('paths 必须是非空字符串数组')
      }
      const errors = []
      const metas = await pool.importFiles(variantKey, body.paths, {
        onError: (error) => errors.push({ path: error.path, message: safeMessage(error) }),
      })
      await pool.ensureActive(variantKey)
      await syncNow()
      return { imported: metas.map((m) => m.uid), errors }
    },
    async setPolicy(body) {
      if (!POLICY_VALUES.includes(body.policy)) {
        throw new Error(`policy 必须是 ${POLICY_VALUES.join(' / ')} 之一`)
      }
      await pool.setPolicy(body.policy)
      await syncNow()
      return { policy: body.policy }
    },

    /**
     * 切换模型分组方式：合并（每版本一组，组内自动换号）或按账号（每账号一组）。
     *
     * 不走 Config 而走这个运行时覆盖，是为了让卡片上的开关**立即生效**：
     * `applyGroupMode()` 会注册或摘掉独立模型组，并广播 `llm/adapters-updated`。
     * 注意这不改配置文件，宿主重启后回到 Config 里的默认值。
     */
    async setPinned(body) {
      if (typeof body.on !== 'boolean') throw new Error('on 必须是布尔值')
      /*
       * `pinned.sync()` 的返回值是 **undefined**（§3.2 的契约只规定它有副作用），
       * 所以增删清单只能靠前后各取一次 `list()` 自己算 —— 之前直接读 `sync()` 的返回值，
       * 结果动作每次都抛 `Cannot read properties of undefined (reading 'added')`，
       * 而模式其实已经切了（副作用先发生）。单测没覆盖这一层，是靠真机点一下才发现的。
       */
      const before = new Set(pinned.list().map((entry) => entry.providerId))
      pinnedOverride = body.on
      const after = await applyGroupMode()
      const afterIds = new Set(after.map((entry) => entry.providerId))
      return {
        mode: groupMode(),
        added: [...afterIds].filter((id) => !before.has(id)),
        removed: [...before].filter((id) => !afterIds.has(id)),
        pinned: after,
      }
    },

    /** 开一个扫码会话。 */
    async loginStart(body) {
      const variantKey = requireVariant(body.variantKey)
      const session = await login().start(variantKey)
      // 只回传能展示的字段：verificationUri 是给用户去扫的登录页。
      // `state` 绝不外泄 —— 它是换 token 的凭据，泄露等于把这次登录送人。
      return {
        loginId: session.loginId,
        variantKey: session.variantKey,
        verificationUri: session.verificationUri,
        expiresIn: session.expiresIn,
        expiresAt: session.expiresAt,
        timeoutMs: LOGIN_TIMEOUT_MS,
      }
    },

    /** 轮询扫码会话；成功时顺手入库，且只回传脱敏后的账号信息。 */
    async loginPoll(body) {
      const loginId = requireString(body.loginId, 'loginId')
      const result = await login().poll(loginId)
      if (result.done !== true) return { done: false, status: result.status }
      if (result.ok !== true) return { done: true, ok: false, error: safeMessage(result.error) }

      // `result.document` 里装着 accessToken / refreshToken —— **绝不回传**。
      try {
        const meta = await pool.upsertAccount(result.variantKey, result.document, { source: 'oauth' })
        await pool.ensureActive(result.variantKey)
        await syncNow()
        return {
          done: true,
          ok: true,
          variantKey: result.variantKey,
          uid: meta.uid,
          label: meta.label,
          nickname: meta.label,
          domain: meta.domain,
          source: meta.source,
        }
      } catch (error) {
        // 登录本身成功了，但这份凭据没能入库（例如档位串号）—— 如实报出来，别假装成功。
        return { done: true, ok: false, error: safeMessage(error) }
      }
    },

    /** 取消一个扫码会话。没构造过登录管理器就说明根本没有会话。 */
    async loginCancel(body) {
      const loginId = requireString(body.loginId, 'loginId')
      const cancelled = loginManager === undefined ? false : loginManager.cancel(loginId)
      return { loginId, cancelled }
    },

    /**
     * 立刻刷新一个账号的 token。
     *
     * 桌面 App 收割来的国内版凭据是**密文**（`$wbEncrypted`），插件无法自行解密刷新，
     * 只能等它成为当前账号时由 dsh-workbuddy-connect 刷新 —— 这种情况如实回报，不当成错误吼叫。
     */
    async refreshAccount(body) {
      const variantKey = requireVariant(body.variantKey)
      const uid = requireString(body.uid, 'uid')

      const text = await pool.readSnapshotDocument(variantKey, uid)
      if (text === null) throw new Error('这个账号的快照不存在（可能刚被删除），请刷新卡片')

      let document
      try {
        document = JSON.parse(text)
      } catch {
        throw new Error('这个账号的快照不是合法 JSON，无法刷新')
      }

      if (accessTokenOf(document).kind === 'encrypted') {
        return {
          ok: false,
          uid,
          reason: 'encrypted-credential',
          message:
            '这个账号是从桌面 App 收割的加密凭据，插件无法自行刷新；它成为当前账号时会由 dsh-workbuddy-connect 刷新。想让它也能被插件自动续期，请用「扫码添加账号」重新登录一次。',
        }
      }

      // 必须把注入的 fetch/now 一路带下去：漏了就会绕过 fake fetch 打到真网络
      // （集成测试真的抓到过这一点 —— 表现为上游回 401）。
      const result = await refreshDocument({
        variantKey,
        document,
        fetchImpl: fetchFn,
        now: nowFn,
        logger,
      })
      if (result.ok !== true) {
        await pool.setLastRefreshError(variantKey, uid, result.error)
        if (result.needsRelogin === true) await pool.markNeedsRelogin(variantKey, uid, result.error)
        await syncNow()
        return {
          ok: false,
          uid,
          reason: result.error,
          terminal: result.terminal === true,
          needsRelogin: result.needsRelogin === true,
        }
      }

      const written = await pool.writeSnapshotDocument(
        variantKey,
        uid,
        JSON.stringify(result.document, null, 2),
      )
      if (written.ok !== true) {
        await pool.setLastRefreshError(variantKey, uid, written.error)
        return { ok: false, uid, reason: written.error }
      }
      await syncNow()
      return {
        ok: true,
        uid,
        expiresAt: written.meta.expiresAt,
        refreshedAt: written.meta.lastRefreshAt,
      }
    },

    /**
     * 重新统计积分（合并组的「合计」用它）。
     *
     * 只发计费 GET、不写盘。`variantKey` 省略 = 两档都刷；`force:false` 允许吃缓存。
     */
    async refreshCredits(body) {
      const cache = creditsInstance()
      if (cache === undefined) return { cn: null, ai: null, disabled: true }
      const force = body?.force !== false
      const raw = body?.variantKey
      const variantKey = raw === undefined || raw === null || raw === '' ? undefined : requireVariant(raw)
      if (variantKey === undefined) {
        const all = await cache.refreshAll({ force })
        return { cn: all?.cn ?? null, ai: all?.ai ?? null }
      }
      return { [variantKey]: await cache.get(variantKey, { force }) }
    },
  }

  function notReadyMessage() {
    if (state.upstreamMissing) return `缺少依赖插件 ${UPSTREAM_PACKAGE}`
    return state.bootError ? `插件启动失败：${safeMessage(state.bootError)}` : '插件尚未就绪'
  }

  /** 上游缺失时，每 10 秒至多重试一次启动（卡片在轮询 status，装好上游后自动接上）。 */
  function retryUpstreamIfMissing() {
    if (!state.upstreamMissing || state.stopped) return
    const now = Date.now()
    if (now - state.lastUpstreamRetryAt < 10_000) return
    state.lastUpstreamRetryAt = now
    state.boot = bootstrap().catch((error) => {
      state.bootError = error
      logger?.error?.(`启动失败：${safeMessage(error)}`)
    })
  }

  function statusHandler(req, res) {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { ok: false, error: 'request-not-trusted' })
      return
    }
    // 顺手学一次宿主 origin：只有它能让我们服务端读到上游的生效账号积分。
    rememberLoopbackOrigin(req)
    if (!state.ready) {
      retryUpstreamIfMissing()
      // 冻结契约：未就绪一律 503（而不是 500/200）。附带一份 status 空壳，
      // 卡片可以直接把 warnings 显示出来，不必等第二次轮询。
      json(res, 503, {
        ok: false,
        error: notReadyMessage(),
        status: status(),
      })
      return
    }
    try {
      json(res, 200, status())
    } catch (error) {
      json(res, 500, { ok: false, error: safeMessage(error) })
    }
  }

  function actionHandler(req, res) {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { ok: false, error: 'request-not-trusted' })
      return
    }
    rememberLoopbackOrigin(req)
    void (async () => {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        json(res, 400, { ok: false, error: safeMessage(error) })
        return
      }
      const action = typeof body?.action === 'string' ? body.action : ''
      const handler = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : undefined
      if (handler === undefined) {
        json(res, 400, { ok: false, error: `unknown action: ${action}` })
        return
      }
      if (!state.ready) {
        json(res, 503, { ok: false, error: notReadyMessage() })
        return
      }
      try {
        json(res, 200, { ok: true, result: await handler(body) })
      } catch (error) {
        json(res, 400, { ok: false, error: safeMessage(error) })
      }
    })()
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────
  ctx.effect(() => {
    state.boot = bootstrap().catch((error) => {
      state.bootError = error
      logger?.error?.(`启动失败：${safeMessage(error)}`)
    })
    state.detach.push(pool.on('changed', () => scheduleSync()))
    state.timer = setInterval(() => {
      void scan()
    }, config.scanMs)
    state.timer.unref?.()

    return () => {
      state.stopped = true
      if (state.pendingSync !== undefined) clearTimeout(state.pendingSync)
      if (state.timer !== undefined) clearInterval(state.timer)
      for (const off of state.detach) {
        try {
          off()
        } catch {
          /* 卸载时忽略单个监听器的异常 */
        }
      }
      return (async () => {
        try {
          await state.boot
        } catch {
          /* 启动异常已在 bootstrap().catch 里记录 */
        }
        // 先停积分缓存与自动续期：它们会在卸载过程中继续排定时器/挂在飞请求，
        // 必须先断掉再去拆别的东西（照 §3.5.7 的顺序纪律）。
        try {
          creditsCache?.stop?.()
        } catch (error) {
          logger?.warn?.(`credits.stop 失败：${safeMessage(error)}`)
        }
        try {
          keepalive.stop()
        } catch (error) {
          logger?.warn?.(`keepalive.stop 失败：${safeMessage(error)}`)
        }
        try {
          await rotation.stop()
        } catch (error) {
          logger?.warn?.(`rotation.stop 失败：${safeMessage(error)}`)
        }
        try {
          await pinned.dispose()
        } catch (error) {
          logger?.warn?.(`pinned.dispose 失败：${safeMessage(error)}`)
        }
      })()
    }
  }, 'dsh-workbuddy-multi: 账号池与轮换')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = [
        webCtx.webServer.register({
          kind: 'exact',
          path: `${ACTIONS_BASE}/status`,
          handler: statusHandler,
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: `${ACTIONS_BASE}/action`,
          handler: actionHandler,
        }),
      ]
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 卸载时忽略单个路由的异常 */
          }
        }
      }
    }, 'dsh-workbuddy-multi: Web 动作面')
  })
}

export default { name, inject, Config, apply }
