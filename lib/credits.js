/**
 * dsh-workbuddy-multi — 跨账号积分合计（合并模式用）
 *
 * 解决什么问题：合并模式把多个账号的路由并成一组之后，界面上那个积分 chip 仍然只显示
 * **当前生效凭据**的数（它是上游 UI 的 composer 贡献，数据来自上游自己的 status 路由，
 * 作用域是选中的 provider，单参数 `fetchCredits(credential)`，payload 里根本没有「池」
 * 的概念）。所以那个 chip 结构上不可能显示合计 —— 想让「合并之后积分是几个账号加总」
 * 成立，只能由我们**每个账号各自去问一次**，再加起来。
 *
 * 已实测（PLAN §3.6.0，2026-10-19 12:44 对真实账号池）：ai 的四个账号分别是
 * 100 / 350 / 350 / 350 ⇒ 合计 1150；cn 唯一账号是桌面 App 收割来的密文信封，
 * `parseWorkBuddyAuth` 对它返回 undefined ⇒ 我们算不出，只能借外壳注入的
 * `fallbackCredits`（上游 status 路由里那个数）。拿不到就如实显示「不完整」，
 * **绝不拿 0 冒充合计**。
 *
 * 设计约束：
 *  - 纯逻辑：不认识 DSH ctx，不认识磁盘，依赖（`pool` / `createClient` / `fallbackCredits`
 *    / `now` / `logger`）全部注入，单测因此不用真 pool、不读真人 auth 文件、不打真网络。
 *  - **永不抛**：单个账号失败只进 `errors`，不连坐；整个模块任何入口都不会把异常抛给调用方。
 *  - **绝不记录或返回凭据**：日志里连 `accessToken` / `refreshToken` 这两个字段名都不出现，
 *    返回的聚合对象里也没有任何 token 字段。
 *  - 密文账号不发请求（它的 token 只有本机 App 能解，问了也是白问，还会把
 *    `invalid_grant` 刷进账号状态）。
 */

import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from 'node:timers'
import { upstreamModule } from './upstream.js'

/** 两个档位。顺序固定，`refreshAll` / `status` 都按它来。 */
const CREDIT_VARIANTS = Object.freeze(['cn', 'ai'])

/** 一个账号的数是从哪来的。UI 里就靠它解释「为什么这个数字不是自己算的」。 */
const SOURCE_COMPUTED = 'computed' // 拿它自己的快照去问回来的
const SOURCE_FALLBACK = 'fallback' // 借上游 status 路由的数（只有生效账号能借）
const SOURCE_NONE = 'none' // 没数

/** 失败原因词表。稳定的短码，不含任何上游原文（上游原文可能带账号信息）。 */
const ERR_ENCRYPTED = 'encrypted-credential'
const ERR_NO_CREDENTIAL = 'no-credential'
const ERR_SNAPSHOT_MISSING = 'snapshot-missing'
const ERR_SNAPSHOT_UNREADABLE = 'snapshot-unreadable'
const ERR_POOL_INCOMPLETE = 'pool-incomplete'
const ERR_POOL_LIST = 'pool-list-failed'
const ERR_TIMEOUT = 'timeout'
const ERR_ABORTED = 'aborted'
const ERR_FETCH = 'fetch-failed'
const ERR_CLIENT = 'client-unavailable'
const ERR_BAD_RESPONSE = 'bad-response'

export const CREDITS_DEFAULTS = Object.freeze({
  ttlMs: 60_000,
  concurrency: 2,
  timeoutMs: 15_000,
  enabled: true,
})

// ── 私有小工具（全部不抛）──────────────────────────────────────────────

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error) {
  try {
    if (error instanceof Error) return error.message
    if (error === undefined || error === null) return ''
    return String(error)
  } catch {
    return ''
  }
}

/** 注入的时钟可能抛、可能返回垃圾；一律退回真实时钟，绝不把异常带进主流程。 */
function resolveNow(now) {
  try {
    if (typeof now === 'function') {
      const value = now()
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  } catch {
    /* 时钟坏了就用下面的 Date.now() */
  }
  return Date.now()
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clampInt(value, fallback, min, max) {
  const n = finiteOr(value, fallback)
  const clamped = Math.min(Math.max(Math.trunc(n), min), max)
  return clamped
}

/** 日志永远不炸主流程；logger 抛错也吞掉。 */
function makeLog(logger) {
  const emit = (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](message)
      else if (logger && typeof logger.log === 'function') logger.log(message)
    } catch {
      /* 日志失败与业务无关 */
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
  }
}

/**
 * 密文信封判据：`auth.accessToken` 是对象且带真值 `$wbEncrypted`。
 *
 * 只看「是不是对象」是不够的（keepalive 那边的教训）：这里要能区分「密文」与
 * 「文档坏了」，因为前者要标 `encrypted-credential`、后者要标 `no-credential`，
 * UI 给的提示完全不同。
 */
function looksEncrypted(text) {
  if (typeof text !== 'string' || text === '') return false
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return false
  }
  if (!isRecord(doc)) return false
  const auth = isRecord(doc.auth) ? doc.auth : {}
  const candidates = [auth.accessToken, doc.accessToken]
  return candidates.some((value) => isRecord(value) && Boolean(value.$wbEncrypted))
}

/** 读一个账号的快照原文。pool 缺方法 / 读失败都不抛，转成错误码。 */
async function readSnapshot(pool, variantKey, uid) {
  if (!pool || typeof pool.readSnapshotDocument !== 'function') return { text: null, error: ERR_POOL_INCOMPLETE }
  try {
    const text = await pool.readSnapshotDocument(variantKey, uid)
    if (typeof text !== 'string') return { text: null, error: ERR_SNAPSHOT_MISSING }
    return { text, error: null }
  } catch (error) {
    return { text: null, error: ERR_SNAPSHOT_UNREADABLE }
  }
}

/**
 * 借上游 status 路由的数。
 *
 * 外壳（index.js）只允许对**生效账号**调它 —— 那路由按生效凭据算，不是这个账号的就
 * 不是它的数。这里只管调用与容错，不做策略判断（策略在 aggregateVariant 里）。
 * 接受 `{ total }` / `{ unlimited: true }`，另外容忍直接给数字（外壳少包一层也不算错）。
 */
async function callFallback(fallbackCredits, args) {
  if (typeof fallbackCredits !== 'function') return null
  let out
  try {
    out = await fallbackCredits(args)
  } catch {
    return null
  }
  if (typeof out === 'number' && Number.isFinite(out)) return { total: out }
  if (!isRecord(out)) return null
  if (out.unlimited === true) return { unlimited: true }
  if (typeof out.total === 'number' && Number.isFinite(out.total)) return { total: out.total }
  return null
}

/** 有上限的并发映射；顺序与输入一致（结果按 index 放回）。 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  if (items.length === 0) return results
  const cfg = { concurrency: limit }
  /* [anchor:concurrency] 并发上限：删掉 Math.min 这一层就是这个测试要钉住的退化 */
  const effective = Math.max(1, Math.min(cfg.concurrency, items.length))
  let next = 0
  const workers = []
  for (let i = 0; i < effective; i += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const index = next
          next += 1
          if (index >= items.length) return
          results[index] = await fn(items[index], index)
        }
      })(),
    )
  }
  await Promise.all(workers)
  return results
}

/**
 * 让一个在飞的请求带上截止时间，且**不产生 unhandledRejection**。
 *
 * 超时/中止时我们提前 resolve，但那个 promise 之后仍可能 reject —— 所以无论走哪条路
 * 都挂了 handler。
 */
function raceWithDeadline(work, signal) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    // handler 必须**无条件先挂上**：下面的早退分支（信号已中止）若直接 return，
    // work 之后再 reject 就是 unhandledRejection —— Node 22 默认直接终止进程（卸载插件时可达）。
    // finish 有 settled 保护，先挂不会改变谁赢。
    work.then(
      (value) => finish({ value }),
      (error) => finish({ error }),
    )
    if (!signal || typeof signal.addEventListener !== 'function') return
    if (signal.aborted) {
      finish({ aborted: true, reason: signal.reason })
      return
    }
    signal.addEventListener('abort', () => finish({ aborted: true, reason: signal.reason }), { once: true })
  })
}

/** 把 `signal.reason` 翻成我们的错误码：截止时间到 vs 被外壳叫停。 */
function abortErrorCode(reason) {
  const name = reason && typeof reason.name === 'string' ? reason.name : ''
  return name === 'TimeoutError' ? ERR_TIMEOUT : ERR_ABORTED
}

/** 合并两个信号：谁先 abort 算谁。AbortSignal.any 不可用时退回截止时间那个。 */
function combineSignals(deadline, extra) {
  if (!extra || typeof extra !== 'object') return deadline
  try {
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([deadline, extra])
  } catch {
    /* 退回单个信号 */
  }
  return extra.aborted ? extra : deadline
}

function defaultCreateClient() {
  const upstream = upstreamModule()
  if (upstream === null) throw new Error('dsh-workbuddy-connect 未加载')
  return new upstream.WorkBuddyUpstreamClient()
}

// ── 冻结接口 ──────────────────────────────────────────────────────────

/**
 * 把快照原文变成凭据；密文信封 / 坏档 / 非字符串一律 undefined，绝不抛。
 *
 * 密文返回 undefined 是**上游的行为**（它只解明文），不是我们额外加的限制 ——
 * 所以调用方拿到 undefined 时要用 `looksEncrypted` 区分「密文」与「文档坏了」。
 */
export function parseCredential(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    const parse = upstreamModule()?.parseWorkBuddyAuth
    if (typeof parse !== 'function') return undefined
    const credential = parse(text)
    return credential === undefined || credential === null ? undefined : credential
  } catch {
    return undefined
  }
}

/**
 * 单个账号问一次积分。每个账号独立失败，绝不连坐。
 *
 * @param {{ credential: object, createClient?: () => object, timeoutMs?: number, signal?: AbortSignal }} input
 * @returns {Promise<{ ok: true, total: number, unlimited: boolean, packages: number }
 *                 | { ok: false, error: string }>}
 */
export async function fetchAccountCredits({ credential, createClient, timeoutMs, signal } = {}) {
  if (!isRecord(credential)) return { ok: false, error: ERR_NO_CREDENTIAL }

  let client
  try {
    const factory = typeof createClient === 'function' ? createClient : defaultCreateClient
    client = factory()
  } catch (error) {
    return { ok: false, error: ERR_CLIENT }
  }
  if (!client || typeof client.fetchCredits !== 'function') return { ok: false, error: ERR_CLIENT }

  const ms = clampInt(timeoutMs, CREDITS_DEFAULTS.timeoutMs, 1, 600_000)
  // 每个请求一个**自己的**截止时间；再和外壳的「叫停」信号合并。
  const deadline = AbortSignal.timeout(ms)
  const effective = combineSignals(deadline, signal)

  let work
  try {
    // 上游的 `fetchCredits(credential)` 没有 signal 形参（它的 fetchModels/chatStream 才有），
    // 所以截止时间由我们自己在下面 race —— 这里把信号一并递过去，客户端愿意用就用。
    work = Promise.resolve(client.fetchCredits(credential, effective))
  } catch (error) {
    return { ok: false, error: ERR_FETCH }
  }

  const outcome = await raceWithDeadline(work, effective)

  if (outcome.aborted) return { ok: false, error: abortErrorCode(outcome.reason) }
  if (outcome.error !== undefined) return { ok: false, error: ERR_FETCH }

  const credits = outcome.value
  if (!isRecord(credits)) return { ok: false, error: ERR_BAD_RESPONSE }

  const accounts = Array.isArray(credits.accounts) ? credits.accounts : []
  const unlimited =
    credits.unlimited === true || accounts.some((row) => isRecord(row) && row.unlimited === true)
  const total = credits.total
  const hasTotal = typeof total === 'number' && Number.isFinite(total)
  // unlimited 的账号没有「剩余量」这个概念：不计入 total，但必须是明确的一档。
  if (!hasTotal && !unlimited) return { ok: false, error: ERR_BAD_RESPONSE }

  return {
    ok: true,
    total: Math.max(0, hasTotal ? total : 0),
    unlimited,
    packages: accounts.length,
  }
}

/**
 * 一档位的合计。
 *
 * 只看启用账号（`meta.enabled !== false`）；密文账号不发请求；生效账号自己算不出时
 * 才允许借 `fallbackCredits`。整个函数永不抛。
 *
 * `fetchImpl` 是外壳按 §3.6.2 一路透传下来的依赖（`deps.fetchImpl`）。上游的
 * `WorkBuddyUpstreamClient` 没有注入 fetch 的入口（构造参数只有 resolveAppVersion /
 * resolveChatIdentity），所以这里**接受但不使用**它 —— 记录在案，免得看起来像是漏接了。
 *
 * @param {{ variantKey: string, pool: object, createClient?: () => object, fetchImpl?: unknown,
 *           fallbackCredits?: (args: { variantKey: string, uid: string, active: boolean }) =>
 *             (number | { total?: number, unlimited?: true } | null),
 *           now?: () => number, logger?: object, timeoutMs?: number, concurrency?: number,
 *           signal?: AbortSignal }} input
 */
export async function aggregateVariant({
  variantKey,
  pool,
  createClient,
  fetchImpl,
  fallbackCredits,
  now,
  logger,
  timeoutMs,
  concurrency,
  signal,
} = {}) {
  const computedAt = resolveNow(now)
  const log = makeLog(logger)
  const cfg = {
    timeoutMs: clampInt(timeoutMs, CREDITS_DEFAULTS.timeoutMs, 1, 600_000),
    concurrency: clampInt(concurrency, CREDITS_DEFAULTS.concurrency, 1, 32),
  }
  const empty = (errors) => ({
    variantKey,
    computedAt,
    total: 0,
    unlimited: false,
    complete: false,
    accountCount: 0,
    readyCount: 0,
    accounts: [],
    errors,
  })

  if (!CREDIT_VARIANTS.includes(variantKey)) return empty([])

  let rows
  try {
    rows = pool && typeof pool.list === 'function' ? await pool.list(variantKey) : null
  } catch (error) {
    rows = null
  }
  if (!Array.isArray(rows)) {
    log.warn(`积分合计：读账号列表失败（${variantKey}）`)
    return empty([{ uid: '', error: ERR_POOL_LIST }])
  }

  // 只看启用账号 —— 禁用账号既不计数也不发请求（它连池里的可用账号都不是）。
  /* [anchor:skip-disabled] 禁用账号过滤：把这个判据放宽，禁用账号就会被算进合计 */
  const enabled = rows.filter((row) => isRecord(row) && typeof row.uid === 'string' && row.enabled !== false)

  let activeUid
  try {
    activeUid = pool && typeof pool.activeUid === 'function' ? await pool.activeUid(variantKey) : undefined
  } catch (error) {
    activeUid = undefined
  }
  if (typeof activeUid !== 'string') activeUid = undefined

  const liveMeta = async (row) => {
    if (!pool || typeof pool.accountMeta !== 'function') return row
    try {
      const meta = await pool.accountMeta(variantKey, row.uid)
      return isRecord(meta) ? meta : row
    } catch (error) {
      return row
    }
  }

  const task = async (row) => {
    const meta = await liveMeta(row)
    const uid = row.uid
    const active = activeUid !== undefined && uid === activeUid
    const label = typeof meta.label === 'string' && meta.label !== '' ? meta.label : typeof meta.nickname === 'string' ? meta.nickname : ''
    const entry = {
      uid,
      label,
      active,
      source: SOURCE_NONE,
      encrypted: false,
      total: null,
      unlimited: false,
      packages: null,
      error: null,
    }

    const snapshot = await readSnapshot(pool, variantKey, uid)
    let credential
    if (snapshot.error === null) {
      credential = parseCredential(snapshot.text)
      if (credential === undefined) {
        entry.encrypted = looksEncrypted(snapshot.text)
        /* [anchor:encrypted] 密文账号：只标原因，绝不放行请求（下面那段只有拿到凭据才会进） */
        entry.error = entry.encrypted ? ERR_ENCRYPTED : ERR_NO_CREDENTIAL
      }
    } else {
      entry.error = snapshot.error
    }

    if (credential !== undefined) {
      const result = await fetchAccountCredits({ credential, createClient, timeoutMs: cfg.timeoutMs, signal })
      if (result.ok) {
        entry.source = SOURCE_COMPUTED
        entry.total = result.total
        entry.unlimited = result.unlimited
        entry.packages = result.packages
        entry.error = null
      } else {
        entry.error = result.error
      }
    }

    // 自己算不出才借上游的数，而且**只对生效账号**借：那路由按生效凭据算，
    // 非生效账号借来的数不是它的（借了就串号）。
    if (entry.unlimited !== true && entry.total === null && active) {
      const borrowed = await callFallback(fallbackCredits, { variantKey, uid, active })
      if (borrowed && borrowed.unlimited === true) {
        entry.source = SOURCE_FALLBACK
        entry.unlimited = true
        entry.error = null
        entry.total = null
        // packages 保持 null：上游 status 路由只给一个数，没有套餐清单，
        // 写 0 会变成「一个套餐都没有」这种我们没测到的断言。
      } else if (borrowed && typeof borrowed.total === 'number') {
        entry.source = SOURCE_FALLBACK
        entry.total = Math.max(0, borrowed.total)
        entry.error = null
      }
    }

    return entry
  }

  let accounts
  try {
    accounts = await mapWithConcurrency(enabled, cfg.concurrency, task)
  } catch (error) {
    // task 自己已经不抛了；这一层是「无论如何都不把异常带出去」的兜底。
    log.warn(`积分合计：账号轮询异常（${variantKey}）`)
    accounts = []
  }

  let total = 0
  let unlimited = false
  let readyCount = 0
  for (const entry of accounts) {
    const hasNumber = typeof entry.total === 'number' && Number.isFinite(entry.total)
    if (entry.unlimited === true) {
      unlimited = true
      readyCount += 1
      continue
    }
    if (hasNumber) {
      total += entry.total
      readyCount += 1
    }
  }

  const accountCount = accounts.length
  const errors = accounts
    .filter((entry) => typeof entry.error === 'string' && entry.error !== '')
    .map((entry) => ({ uid: entry.uid, error: entry.error }))

  if (accountCount > 0) {
    log.info(`积分合计（${variantKey}）：${readyCount}/${accountCount} 个账号有数，合计 ${total}${unlimited ? '（含不限量）' : ''}`)
  }

  return {
    variantKey,
    computedAt,
    total,
    unlimited,
    // 「每个启用账号都拿到了数（或 unlimited）」；一个账号都没有时**不算** complete ——
    // 否则空池会以「0、完整」的样子出现在 UI 上，那正是拿 0 冒充合计。
    complete: accountCount > 0 && readyCount === accountCount,
    accountCount,
    readyCount,
    accounts,
    errors,
  }
}

/**
 * 给 status() / chip 用的摘要。绝不抛：给什么都能回一个形状完整的对象。
 */
export function summarizeVariant(aggregate) {
  const source = isRecord(aggregate) ? aggregate : {}
  return {
    total: Math.max(0, finiteOr(source.total, 0)),
    unlimited: source.unlimited === true,
    complete: source.complete === true,
    accountCount: Math.max(0, Math.trunc(finiteOr(source.accountCount, 0))),
    readyCount: Math.max(0, Math.trunc(finiteOr(source.readyCount, 0))),
    computedAt: typeof source.computedAt === 'number' && Number.isFinite(source.computedAt) ? source.computedAt : null,
  }
}

/**
 * 带 TTL 与并发去重的合计缓存。
 *
 * `get` 在 TTL 内直接回缓存；过期才重算；同一档位并发调用共用同一个在飞 promise（不然
 * chip 每次重渲染都会再打一轮计费接口）。`stop()` 清定时器并叫停在飞请求。
 */
export class CreditsCache {
  #pool
  #createClient
  #fetchImpl
  #fallbackCredits
  #now
  #logger
  #log
  #config
  #entries = new Map()
  #inflight = new Map()
  #timer = null
  #running = false
  #stoppable = null

  constructor({ pool, createClient, fetchImpl, fallbackCredits, now, logger, config } = {}) {
    const raw = isRecord(config) ? config : {}
    this.#config = {
      ttlMs: clampInt(raw.ttlMs, CREDITS_DEFAULTS.ttlMs, 0, 86_400_000),
      concurrency: clampInt(raw.concurrency, CREDITS_DEFAULTS.concurrency, 1, 32),
      timeoutMs: clampInt(raw.timeoutMs, CREDITS_DEFAULTS.timeoutMs, 1, 600_000),
      enabled: raw.enabled !== false,
      intervalMs: clampInt(raw.intervalMs, 0, 0, 86_400_000),
      // 定时器注入口：单测靠它证明「stop 之后没有残留定时器」。
      setTimeout: typeof raw.setTimeout === 'function' ? raw.setTimeout : nodeSetTimeout,
      clearTimeout: typeof raw.clearTimeout === 'function' ? raw.clearTimeout : nodeClearTimeout,
    }
    this.#pool = pool
    this.#createClient = createClient
    this.#fetchImpl = fetchImpl
    this.#fallbackCredits = fallbackCredits
    this.#now = now
    this.#logger = logger
    this.#log = makeLog(logger)
  }

  get ttlMs() {
    return this.#config.ttlMs
  }

  /** 在飞请求的「叫停」信号；stop() 之后重建一个，缓存因此还能被复用。 */
  #stopSignal() {
    if (!this.#stoppable) this.#stoppable = new AbortController()
    return this.#stoppable.signal
  }

  /**
   * 取一个档位的合计。
   *
   * @param {string} variantKey
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<object|null>} 未知档位 / 缓存关闭时给 null（**不给 0 冒充**）
   */
  async get(variantKey, { force = false } = {}) {
    if (!this.#config.enabled) return null
    if (!CREDIT_VARIANTS.includes(variantKey)) return null

    const cached = this.#entries.get(variantKey)
    /* [anchor:ttl] TTL 判据：把这段放宽成「只要有缓存就回」，过期就永远不会重算 */
    if (!force && cached && resolveNow(this.#now) - cached.at < this.#config.ttlMs) return cached.aggregate

    const pending = this.#inflight.get(variantKey)
    if (pending) return pending

    const promise = (async () => {
      try {
        const aggregate = await aggregateVariant({
          variantKey,
          pool: this.#pool,
          createClient: this.#createClient,
          fetchImpl: this.#fetchImpl,
          fallbackCredits: this.#fallbackCredits,
          now: this.#now,
          logger: this.#logger,
          timeoutMs: this.#config.timeoutMs,
          concurrency: this.#config.concurrency,
          signal: this.#stopSignal(),
        })
        // stop() 叫停后回来的那次结果**不能写进缓存**：它是一份「被中断、什么都没拿到」
        // 的空合计，落盘就等于用 0 覆盖掉上次真算出来的数（正是「拿 0 冒充合计」）。
        const cancelled = Array.isArray(aggregate.errors) && aggregate.errors.some((entry) => entry.error === ERR_ABORTED)
        if (cancelled) {
          this.#log.warn(`积分合计被中断（${variantKey}）：不写缓存`)
          return cached ? cached.aggregate : null
        }
        this.#entries.set(variantKey, { at: resolveNow(this.#now), aggregate })
        return aggregate
      } catch (error) {
        // aggregateVariant 已保证不抛；真抛了也不能把旧缓存弄丢，更不能炸调用方。
        this.#log.warn(`积分合计失败（${variantKey}）`)
        return cached ? cached.aggregate : null
      } finally {
        this.#inflight.delete(variantKey)
      }
    })()
    this.#inflight.set(variantKey, promise)
    return promise
  }

  /** 两个档位各取一次。串行：每个档位内部已经按 concurrency 并发，串行才不会把峰值翻倍。 */
  async refreshAll({ force = true } = {}) {
    const out = {}
    for (const variantKey of CREDIT_VARIANTS) {
      out[variantKey] = await this.get(variantKey, { force })
    }
    return out
  }

  status() {
    return {
      cn: this.#entries.get('cn')?.aggregate ?? null,
      ai: this.#entries.get('ai')?.aggregate ?? null,
      ttlMs: this.#config.ttlMs,
      running: this.#running,
    }
  }

  /** 不传 = 全部清掉。只丢缓存，不动在飞请求。 */
  invalidate(variantKey) {
    if (variantKey === undefined || variantKey === null) this.#entries.clear()
    else this.#entries.delete(variantKey)
  }

  /**
   * 武装周期刷新。不调用它就没有定时器（外壳只调 stop() 也是安全的）。
   * 间隔默认取 ttlMs —— 每过一个 TTL 重算一次。
   */
  start() {
    if (this.#running) return
    if (!this.#config.enabled) return
    this.#running = true
    this.#schedule(this.#config.intervalMs > 0 ? this.#config.intervalMs : this.#config.ttlMs)
  }

  /** 清定时器 + 叫停在飞请求。可以重复调用。 */
  stop() {
    this.#running = false
    if (this.#timer !== null) {
      try {
        this.#config.clearTimeout(this.#timer)
      } catch {
        /* 假定时器可能抛，忽略 */
      }
      this.#timer = null
    }
    if (this.#stoppable) {
      try {
        this.#stoppable.abort()
      } catch {
        /* 已经 abort 过 */
      }
      this.#stoppable = null
    }
    this.#inflight.clear()
  }

  #schedule(delayMs) {
    try {
      const handle = this.#config.setTimeout(() => {
        this.#timer = null
        void this.#tick()
      }, delayMs)
      try {
        if (handle && typeof handle.unref === 'function') handle.unref()
      } catch {
        /* 某些假定时器没有 unref */
      }
      this.#timer = handle ?? null
    } catch {
      // 定时器自己抛了也不能让 start() 炸；退化成「不周期刷新」。
      this.#timer = null
      this.#running = false
      this.#log.warn('积分合计：排周期刷新失败')
    }
  }

  async #tick() {
    try {
      await this.refreshAll({ force: true })
    } catch {
      /* refreshAll 不抛；这里是兜底 */
    }
    if (this.#running) this.#schedule(this.#config.intervalMs > 0 ? this.#config.intervalMs : this.#config.ttlMs)
  }
}
