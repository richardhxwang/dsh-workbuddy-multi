/**
 * dsh-workbuddy-multi · lib/keepalive.js
 *
 * 全池 token 自动续期（PLAN.md §3.5.0 协议 / §3.5.2 冻结接口；本文件只归 keepalive 所有）。
 *
 * 解决什么问题：上游 dsh-workbuddy-connect 只在「某个账号成为当前账号」时才刷新它的
 * token，池里其余账号会自然过期死掉，轮换换到它们时就是「永久登录失效」。所以必须由
 * 我们**主动**给池里每个即将过期的账号续期。
 *
 * 协议来自 MIT 项目 changexbc/workbuddy-switch 的 `crates/wb-switch-core/src/modules/refresh.rs`
 * （只复刻协议，不引入其代码或依赖）：
 *
 *   POST {endpoint}/v2/plugin/auth/token/refresh    body `{}`
 *   → {code:0|200, data:{accessToken, refreshToken, domain, expiresAt, refreshExpiresAt}}
 *
 * 两个档位（PLAN §3.5.0 实测表）：cn = https://www.codebuddy.cn，ai = https://www.workbuddy.ai。
 *
 * ⚠️ 最容易踩的一条：请求头必须带 `X-Auth-Refresh-Source: plugin`。缺了它国际版实测返回
 *    `invalid_grant: Invalid refresh token`（code 12153），看起来像 refreshToken 坏了，
 *    实际只是少了个头 —— 会让人误判成「账号需要重新登录」。
 *
 * ⚠️ 第二条：**加密信封账号不能自己刷新**。从桌面 App 收割来的国内版账号，`auth.accessToken`
 *    是 `{$wbEncrypted:1,envelope:...}` 对象而非明文串，我们没有它的刷新凭据。这类账号
 *    必须返回 `{ok:false, terminal:false, needsRelogin:false, error:'encrypted-credential'}`：
 *    既不标 needsRelogin（标记了 UI 就会误导用户去重新登录），也不做退避重试轰炸
 *    （重试一万次也不会成功）。它们由上游在成为当前账号时自己刷新。
 *
 * 依赖纪律：零第三方依赖、零相对静态 import（只 import node 内置模块）。`fetchImpl` /
 * `now` / `logger` / `pool` 全部可注入，因此可以独立单测，也不会因为兄弟模块
 * （pool.js / index.js / login.js）还没落盘而炸。
 */

import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from 'node:timers'

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** 刷新路径前缀两档位相同（PLAN §3.5.0）。 */
export const REFRESH_PATH_SUFFIX = '/auth/token/refresh'

/** 路径前缀（两档位相同）。 */
export const REFRESH_API_PREFIX = '/v2/plugin'

/**
 * 内置 variant 表（逐字取自 PLAN §3.5.0 的实测表）。
 *
 * 形状与 `lib/login.js` 的 `LOGIN_VARIANTS` 逐项兼容（key/endpoint/platform/apiPrefix），
 * 所以调度器的 `config.variants` 可以直接收 login 的那张表。本模块不 import login.js：
 * 那张表是权威来源，但本模块必须能在 login.js 还没落盘时独立工作。
 */
export const KEEPALIVE_VARIANTS = Object.freeze([
  Object.freeze({
    key: 'cn',
    endpoint: 'https://www.codebuddy.cn',
    platform: 'workbuddy',
    apiPrefix: REFRESH_API_PREFIX,
  }),
  Object.freeze({
    key: 'ai',
    endpoint: 'https://www.workbuddy.ai',
    platform: 'workbuddy-ai',
    apiPrefix: REFRESH_API_PREFIX,
  }),
])

/** 自动续期默认参数（PLAN §3.5.2，逐字照抄，勿改数值）。 */
export const KEEPALIVE_DEFAULTS = Object.freeze({
  /** 提前量：到期前多久开始刷新。 */
  marginMs: 300_000,
  /** 扫描周期。 */
  sweepMs: 900_000,
  /** 失败退避起步。 */
  minRetryMs: 60_000,
  /** 失败退避封顶。 */
  maxRetryMs: 3_600_000,
  /** 抖动比例（±）。 */
  jitterRatio: 0.1,
  /** 每轮并发上限。 */
  concurrency: 2,
  /**
   * 是否跳过「当前活跃账号」。
   *
   * 必须为真：活跃账号由 dsh-workbuddy-connect 自己在**每次请求的发送路径上**按需刷新，
   * 而 OAuth refresh token 是**一次性轮换**的 —— 我们和上游各拿一份刷同一个账号，
   * 谁后刷谁就让对方手里那份作废（实测过同类事故：见 `feedback_shared_oauth_refresh_token_races`）。
   * 所以分工是**上游管活跃的那个、我们管闲置的那些**，绝不重叠。
   */
  skipActive: true,
})

/**
 * 调度器**必需**的 pool 方法（PLAN §3.5.3 冻结面）。
 * 缺任何一个 → 本轮不刷新并把 `status().unavailable` 说出来（不抛异常）。
 */
export const REQUIRED_POOL_METHODS = Object.freeze([
  'list',
  'readSnapshotDocument',
  'writeSnapshotDocument',
])

/**
 * 可选 pool 方法：缺了不影响自动续期本身，只影响 UI 可见性（`lastRefreshError` / `needsRelogin` 标记）。
 * `accountMeta` 是 `get()` 的可读性别名，用来在真正刷新前复核一次账号状态（防 TOCTOU）。
 */
export const OPTIONAL_POOL_METHODS = Object.freeze([
  'accountMeta',
  'markNeedsRelogin',
  'setLastRefreshError',
])

/** 判定为「凭据已死、必须重新登录」的服务端 code（PLAN §3.5.0 实测 12153）。 */
export const TERMINAL_REFRESH_CODES = Object.freeze([12153, 12154, 401, 403])

// ─────────────────────────────────────────────────────────────────────────────
// 小工具（不导出：避免与 login.js 的同名导出在 index.js 里撞名）
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(err) {
  if (err === null || err === undefined) return ''
  if (typeof err === 'string') return err
  if (typeof err.message === 'string' && err.message !== '') return err.message
  try {
    return String(err)
  } catch {
    return ''
  }
}

/** `now` 可注入为函数或数字；解析不出就退回真实时钟。 */
function resolveNow(now) {
  try {
    if (typeof now === 'function') {
      const v = now()
      return Number.isFinite(v) ? v : Date.now()
    }
    if (typeof now === 'number' && Number.isFinite(now)) return now
  } catch {
    /* 注入的时钟自己抛了，也不能让主流程炸 */
  }
  return Date.now()
}

/** 有限数字才采纳，否则用默认值。 */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * 取一个「可以放进请求头」的字符串：非字符串一律丢弃，去掉 CR/LF（防头注入），
 * 去空白后为空也丢弃 —— 这就是「缺 uid/enterpriseId/domain 时不写空头」的实现。
 */
function cleanHeader(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/[\r\n]+/g, ' ').trim()
  return trimmed === '' ? undefined : trimmed
}

/** 取一个「可以放进凭据文档」的字符串：**逐字保留**，不 trim（token 一个字符都不能动）。 */
function cleanToken(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 与 pool.js `normalizeExpiry` 同语义：epoch 秒/毫秒/ISO 串一律归一成 epoch 毫秒。 */
function normalizeExpiryValue(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw)
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const asNum = Number(raw)
    if (Number.isFinite(asNum)) return normalizeExpiryValue(asNum)
    const t = Date.parse(raw)
    return Number.isFinite(t) ? t : undefined
  }
  return undefined
}

/** 从 payload 里按候选键名取第一个有效到期时刻（绝对值优先）。 */
function pickExpiry(payload, absoluteKeys, relativeKeys, at) {
  for (const key of absoluteKeys) {
    const value = normalizeExpiryValue(payload[key])
    if (value !== undefined && value > 0) return value
  }
  for (const key of relativeKeys) {
    const seconds = Number(payload[key])
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(at + seconds * 1000)
  }
  return undefined
}

/** 值是真对象且 `$wbEncrypted` 为真 → 加密信封（PLAN §3.5.2 判据）。 */
function isEncryptedEnvelope(value) {
  return isRecord(value) && Boolean(value.$wbEncrypted)
}

/** 把 variantKey 归一成 {key,endpoint,platform,apiPrefix}；认不出来返回 undefined。 */
function variantOf(value) {
  if (typeof value === 'string') {
    const key = value.trim()
    if (key === '') return undefined
    return KEEPALIVE_VARIANTS.find((v) => v.key === key)
  }
  if (!isRecord(value)) return undefined
  const key = typeof value.key === 'string' ? value.key.trim() : ''
  const known = key === '' ? undefined : KEEPALIVE_VARIANTS.find((v) => v.key === key)
  if (typeof value.endpoint === 'string' && value.endpoint !== '') {
    return { ...(known ?? {}), ...value, key: key !== '' ? key : known?.key }
  }
  return known
}

/**
 * 档位一致性守卫（PLAN §3.5.0 / §3.5.1）：domain 以 `.workbuddy.ai` 结尾 ⇒ 国际版。
 * 空 domain 无法判定、不阻断（返回 true）。
 */
function isAiDomain(domain) {
  if (typeof domain !== 'string') return false
  return domain.trim().toLowerCase().endsWith('.workbuddy.ai')
}

function domainMatchesVariant(variantKey, domain) {
  if (typeof domain !== 'string' || domain.trim() === '') return true
  const key = typeof variantKey === 'string' ? variantKey : variantKey?.key
  if (key === 'ai') return isAiDomain(domain)
  if (key === 'cn') return !isAiDomain(domain)
  return true
}

/** 解析响应 body：优先 `res.json()`，退化到 `res.text()` + JSON.parse。 */
async function readJson(res) {
  if (res && typeof res.json === 'function') return await res.json()
  if (res && typeof res.text === 'function') {
    const text = await res.text()
    return JSON.parse(text)
  }
  throw new Error('no-body-reader')
}

/** 服务端 code：数字，或能转成数字的字符串。 */
function codeOf(payload) {
  const raw = isRecord(payload) ? payload.code : undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * 这个服务端失败是不是「凭据已死」：死了就必须标 needsRelogin，别再无脑重试。
 * 除了实测的 12153，还认下官方可能换的文案（invalid_grant / refresh token expired…）。
 */
function isTerminalServerFailure(code, msg) {
  if (typeof code === 'number' && TERMINAL_REFRESH_CODES.includes(code)) return true
  if (typeof msg !== 'string' || msg === '') return false
  return /invalid_grant|invalid refresh token|invalid_refresh_token|refresh token[^a-z]{0,4}(?:invalid|expired|revoked)|请?重新登录|登录已过期/i.test(
    msg,
  )
}

/** 统一构造失败结果，保证三个字段永远齐备、永不缺省。 */
function failure(terminal, needsRelogin, error) {
  return { ok: false, terminal: Boolean(terminal), needsRelogin: Boolean(needsRelogin), error: String(error) }
}

/** 日志：绝不打印 token / 请求头（头里带 X-Refresh-Token）；日志自身抛错也不影响主流程。 */
function makeLog(logger) {
  const emit = (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](`workbuddy-multi/keepalive: ${message}`)
      else if (logger && typeof logger.log === 'function') logger.log(`workbuddy-multi/keepalive: ${message}`)
    } catch {
      /* 日志失败绝不影响主流程 */
    }
  }
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
  }
}

/** 配置归一：只认有限数值，越界的收敛到安全区间，未知键（注入用逃逸口）原样带过。 */
function normalizeConfig(config) {
  const raw = isRecord(config) ? config : {}
  const minRetryMs = Math.max(0, num(raw.minRetryMs, KEEPALIVE_DEFAULTS.minRetryMs))
  const maxRetryMs = Math.max(minRetryMs, num(raw.maxRetryMs, KEEPALIVE_DEFAULTS.maxRetryMs))
  const sweepMs = num(raw.sweepMs, KEEPALIVE_DEFAULTS.sweepMs)
  return {
    marginMs: Math.max(0, num(raw.marginMs, KEEPALIVE_DEFAULTS.marginMs)),
    sweepMs: sweepMs > 0 ? sweepMs : KEEPALIVE_DEFAULTS.sweepMs,
    minRetryMs,
    maxRetryMs,
    jitterRatio: clamp(num(raw.jitterRatio, KEEPALIVE_DEFAULTS.jitterRatio), 0, 1),
    concurrency: Math.max(1, Math.floor(num(raw.concurrency, KEEPALIVE_DEFAULTS.concurrency))),
    /*
     * 活跃账号豁免闸门 —— 必须在这里显式带出去：本函数是**白名单**式重建，
     * 漏一个键就等于那个配置永远无法生效（曾经漏掉本键，导致 skipActive:false 无人可关）。
     */
    skipActive: raw.skipActive !== false,
    // 逃逸口（可选注入）：定时器 / 随机源 / variant 表。
    setTimeout: typeof raw.setTimeout === 'function' ? raw.setTimeout : nodeSetTimeout,
    clearTimeout: typeof raw.clearTimeout === 'function' ? raw.clearTimeout : nodeClearTimeout,
    random: typeof raw.random === 'function' ? raw.random : Math.random,
    variants: Array.isArray(raw.variants) ? raw.variants : undefined,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数（PLAN §3.5.2 冻结导出）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 刷新端点：`{endpoint}/v2/plugin/auth/token/refresh`。
 * @param {string|{key?:string,endpoint?:string,apiPrefix?:string}} variantKey
 * @returns {string|undefined} 认不出的档位返回 undefined（**绝不**猜一个档位去打）
 */
export function refreshUrl(variantKey) {
  const variant = variantOf(variantKey)
  if (!variant || typeof variant.endpoint !== 'string' || variant.endpoint === '') return undefined
  const prefix =
    typeof variant.apiPrefix === 'string' && variant.apiPrefix !== ''
      ? variant.apiPrefix
      : REFRESH_API_PREFIX
  const endpoint = variant.endpoint.replace(/\/+$/, '')
  return `${endpoint}${prefix}${REFRESH_PATH_SUFFIX}`
}

/**
 * 刷新请求头（PLAN §3.5.2）。
 *
 * 缺 uid / enterpriseId / domain 时**不写**那个头（而不是写空串）——空头会被网关当成
 * 「提供了但无效」，与不提供语义不同。
 *
 * @returns {Record<string,string>}
 */
export function refreshHeaders({ accessToken, refreshToken, uid, enterpriseId, domain } = {}) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  const access = cleanHeader(accessToken)
  if (access !== undefined) headers.Authorization = `Bearer ${access}`

  const user = cleanHeader(uid)
  if (user !== undefined) headers['X-User-Id'] = user

  const enterprise = cleanHeader(enterpriseId)
  if (enterprise !== undefined) {
    headers['X-Enterprise-Id'] = enterprise
    headers['X-Tenant-Id'] = enterprise
  }

  const domainValue = cleanHeader(domain)
  if (domainValue !== undefined) headers['X-Domain'] = domainValue

  const refresh = cleanHeader(refreshToken)
  if (refresh !== undefined) headers['X-Refresh-Token'] = refresh

  /* [anchor:refresh-source] 反向测试锚点：缺这行国际版会返回 invalid_grant（code 12153） */
  headers['X-Auth-Refresh-Source'] = 'plugin'

  return headers
}

/**
 * 用刷新响应里的 data 生成**新** document（PLAN §3.5.2）：
 * 只更新 `auth.accessToken / refreshToken / expiresAt / refreshExpiresAt`，其余键逐字保留；
 * `refreshToken` 没回就沿用旧值；**不修改入参**。
 *
 * @param {unknown} document 原凭据文档
 * @param {unknown} data 刷新响应的 data
 * @param {number|Function} now 可注入时钟
 */
export function applyRefreshResult(document, data, now = Date.now) {
  const at = resolveNow(now)
  const base = isRecord(document) ? document : {}
  const authBase = isRecord(base.auth) ? base.auth : {}
  const payload = isRecord(data) ? data : {}
  const nextAuth = { ...authBase }

  const accessToken = cleanToken(payload.accessToken) ?? cleanToken(payload.access_token)
  if (accessToken !== undefined) nextAuth.accessToken = accessToken

  const refreshToken = cleanToken(payload.refreshToken) ?? cleanToken(payload.refresh_token)
  if (refreshToken !== undefined) nextAuth.refreshToken = refreshToken

  const expiresAt = pickExpiry(payload, ['expiresAt', 'expires_at', 'expireAt'], ['expiresIn', 'expires_in'], at)
  if (expiresAt !== undefined) nextAuth.expiresAt = expiresAt

  const refreshExpiresAt = pickExpiry(
    payload,
    ['refreshExpiresAt', 'refresh_expires_at', 'refreshExpireAt'],
    ['refreshExpiresIn', 'refresh_expires_in'],
    at,
  )
  if (refreshExpiresAt !== undefined) nextAuth.refreshExpiresAt = refreshExpiresAt

  return { ...base, auth: nextAuth }
}

/**
 * accessToken 的三种判定（PLAN §3.5.2）。
 * @returns {{kind:'plaintext',token:string}|{kind:'encrypted'}|{kind:'absent'}}
 */
export function accessTokenOf(document) {
  const auth = isRecord(document) && isRecord(document.auth) ? document.auth : undefined
  const value = auth ? auth.accessToken : undefined
  if (isEncryptedEnvelope(value)) return { kind: 'encrypted' }
  if (typeof value === 'string' && value !== '') return { kind: 'plaintext', token: value }
  return { kind: 'absent' }
}

/**
 * 刷新单个账号的文档（PLAN §3.5.2）。**绝不抛**。
 *
 * @returns {Promise<{ok:true,document:object,expiresAtMs:number|null}
 *                  |{ok:false,terminal:boolean,needsRelogin:boolean,error:string}>}
 */
export async function refreshDocument({ variantKey, document, fetchImpl, now, logger } = {}) {
  const log = makeLog(logger)
  const at = resolveNow(now)
  const variant = variantOf(variantKey)
  if (!variant || typeof variant.key !== 'string' || variant.key === '') {
    // 认不出档位：宁可不刷新，也不要拿着 A 档位的凭据去打 B 档位的网关。
    return failure(true, false, 'unknown-variant')
  }

  const token = accessTokenOf(document)

  /* [anchor:encrypted] 反向测试锚点：加密信封账号不自行刷新，也绝不标 needsRelogin */
  if (token.kind === 'encrypted') {
    return { ok: false, terminal: false, needsRelogin: false, error: 'encrypted-credential' }
  }
  if (token.kind !== 'plaintext') {
    return failure(true, true, 'missing-access-token')
  }

  const auth = isRecord(document) && isRecord(document.auth) ? document.auth : {}
  const account = isRecord(document) && isRecord(document.account) ? document.account : {}

  const refreshToken = cleanToken(auth.refreshToken)
  if (isEncryptedEnvelope(auth.refreshToken) || refreshToken === undefined) {
    // 没有 refreshToken（或它本身也是信封）→ 只能重新登录，重试无意义。
    return failure(true, true, 'missing-refresh-token')
  }

  const uid = cleanHeader(account.uid)
  const enterpriseId = cleanHeader(account.enterpriseId)
  const domain = cleanHeader(auth.domain) ?? cleanHeader(account.domain)

  const url = refreshUrl(variant)
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof fetchFn !== 'function' || typeof url !== 'string') {
    return failure(false, false, 'fetch-unavailable')
  }

  const headers = refreshHeaders({
    accessToken: token.token,
    refreshToken,
    uid,
    enterpriseId,
    domain,
  })

  let res
  try {
    res = await fetchFn(url, { method: 'POST', headers, body: '{}' })
  } catch (err) {
    // 网络层错误绝不冒泡：可重试，不标 needsRelogin。
    log.warn(`刷新请求失败（${variant.key}/${uid ?? 'unknown'}）：${messageOf(err)}`)
    return failure(false, false, messageOf(err) || 'network-error')
  }

  const status = Number(res?.status)
  const httpOk = typeof res?.ok === 'boolean' ? res.ok : !(Number.isFinite(status) && status >= 400)
  if (!httpOk) {
    const label = Number.isFinite(status) ? String(status) : 'error'
    // 401/403 = 凭据不被接受，重试无用；其余 5xx/429 等可重试。
    if (status === 401 || status === 403) return failure(true, true, `http-${label}`)
    return failure(false, false, `http-${label}`)
  }

  let payload
  try {
    payload = await readJson(res)
  } catch {
    return failure(false, false, 'invalid-json')
  }

  const code = codeOf(payload)
  const msg =
    (isRecord(payload) && typeof payload.msg === 'string' && payload.msg) ||
    (isRecord(payload) && typeof payload.message === 'string' && payload.message) ||
    ''

  if (code !== 0 && code !== 200) {
    const terminal = isTerminalServerFailure(code, msg)
    const error =
      code === undefined
        ? msg || 'invalid-response'
        : `code-${code}${msg === '' ? '' : `: ${msg}`}`
    if (terminal) log.warn(`刷新被拒（${variant.key}/${uid ?? 'unknown'}）：${error}`)
    return failure(terminal, terminal, error)
  }

  const data = isRecord(payload) ? payload.data : undefined
  if (!isRecord(data)) {
    // code 成功但没有 data 对象 = 响应形状不对，可重试。
    return failure(false, false, 'invalid-response')
  }

  // 档位一致性守卫（PLAN §3.5.0）：响应里的 domain 与档位不符一律拒绝入库。
  const responseDomain = typeof data.domain === 'string' ? data.domain : ''
  if (responseDomain !== '' && !domainMatchesVariant(variant.key, responseDomain)) {
    return failure(true, true, 'domain-mismatch')
  }

  const nextAccessToken = cleanToken(data.accessToken) ?? cleanToken(data.access_token)
  if (nextAccessToken === undefined) {
    return failure(true, true, 'missing-access-token-in-response')
  }

  const nextDocument = applyRefreshResult(document, data, at)
  const nextAuth = isRecord(nextDocument.auth) ? nextDocument.auth : {}
  const expiresAtMs = Number.isFinite(nextAuth.expiresAt) ? nextAuth.expiresAt : null

  log.debug(`已刷新 ${variant.key}/${uid ?? 'unknown'}`)
  return { ok: true, document: nextDocument, expiresAtMs }
}

/**
 * 指数退避 + 抖动，封顶 `maxRetryMs`（PLAN §3.5.2）。
 *
 * `failures` 是**连续失败次数**（≥1）：第 1 次 = minRetryMs，之后 ×2，直到封顶；
 * 抖动为 ±jitterRatio；抖动后仍然封顶，且永不为 0（避免忙轮询）。
 *
 * @param {number} failures 连续失败次数（≥1）
 * @param {object} [config] 部分配置即可（minRetryMs/maxRetryMs/jitterRatio）
 * @param {Function} [random] 可注入随机源（单测用）
 * @returns {number} 毫秒
 */
export function computeBackoffMs(failures, config = {}, random = Math.random) {
  const raw = isRecord(config) ? config : {}
  const base0 = Math.max(0, num(raw.minRetryMs, KEEPALIVE_DEFAULTS.minRetryMs))
  const cap = Math.max(base0, num(raw.maxRetryMs, KEEPALIVE_DEFAULTS.maxRetryMs))
  const jitterRatio = clamp(num(raw.jitterRatio, KEEPALIVE_DEFAULTS.jitterRatio), 0, 1)
  const n = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 1

  // 2**32 之后再翻也没有意义（早就封顶了），顺便避免溢出成 Infinity。
  const base = Math.min(cap, base0 * 2 ** Math.min(n - 1, 32))

  let jitter = 0
  if (jitterRatio > 0 && base > 0) {
    let r = 0.5
    try {
      const value = typeof random === 'function' ? random() : Math.random()
      if (Number.isFinite(value)) r = clamp(value, 0, 1)
    } catch {
      r = 0.5
    }
    jitter = base * jitterRatio * (r * 2 - 1)
  }

  return Math.max(1, Math.min(cap, Math.round(base + jitter)))
}

// ─────────────────────────────────────────────────────────────────────────────
// 调度器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 全池自动续期调度器（PLAN §3.5.2）。
 *
 * 每轮只挑「已启用、未 needsRelogin、未冷却、refreshToken 未过期、且
 * `expiresAt - now < marginMs`」的账号，最多 `concurrency` 个并发刷新；
 * 失败按指数退避 + 抖动冷却到 `maxRetryMs` 封顶。
 *
 * 铁律：全流程绝不抛；`stop()` 后不留任何定时器。
 */
export class KeepAliveScheduler {
  #pool
  #fetchImpl
  #now
  #logger
  #config
  #log
  #running = false
  #timer = null
  #nextSweepAt = null
  #lastSweepAt = null
  #inFlight = new Set()
  #stats = { ok: 0, failed: 0, skipped: 0 }
  #failures = new Map()
  #sweepPromise = null
  #unavailable = null

  constructor({ pool, fetchImpl, now = Date.now, logger, config } = {}) {
    this.#pool = pool ?? null
    this.#fetchImpl = fetchImpl ?? null
    this.#now = now ?? Date.now
    this.#logger = logger ?? null
    this.#log = makeLog(logger)
    this.#config = normalizeConfig(config)
  }

  /** 归一后的配置副本（只读用途）。 */
  get config() {
    return { ...this.#config }
  }

  /** 启动：立刻扫一轮，然后每 `sweepMs` 扫一轮。重复调用不会叠加定时器。 */
  start() {
    if (this.#running) return this
    this.#running = true
    this.#log.info(`自动续期已启动（每 ${Math.round(this.#config.sweepMs / 1000)}s 一轮）`)
    void this.sync().catch(() => {})
    this.#schedule(this.#config.sweepMs)
    return this
  }

  /** 停止：清定时器、置 running=false。幂等，可重复调用。 */
  stop() {
    const wasRunning = this.#running
    this.#running = false
    if (this.#timer !== null) {
      try {
        this.#config.clearTimeout(this.#timer)
      } catch {
        /* 清定时器失败也不能抛 */
      }
      this.#timer = null
    }
    this.#nextSweepAt = null
    if (wasRunning) this.#log.info('自动续期已停止')
    return this
  }

  /**
   * 立刻扫一轮（也可在未 start 时手动调用）。
   * 已有扫描在跑时返回**同一个** promise，避免叠加扫描把退避计数翻倍。
   */
  sync() {
    if (this.#sweepPromise !== null) return this.#sweepPromise
    const running = this.#sweep()
    this.#sweepPromise = running
    const settle = () => {
      if (this.#sweepPromise === running) this.#sweepPromise = null
    }
    running.then(settle, settle)
    return running
  }

  /** 状态快照（PLAN §3.5.2）。`unavailable` 只在真不可用时出现。 */
  status() {
    const out = {
      running: this.#running,
      lastSweepAt: this.#lastSweepAt,
      nextSweepAt: this.#nextSweepAt,
      inFlight: [...this.#inFlight],
      stats: { ...this.#stats },
    }
    if (this.#unavailable !== null) out.unavailable = this.#unavailable
    return out
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  #nowMs() {
    return resolveNow(this.#now)
  }

  #schedule(delayMs) {
    // 注入的 setTimeout 自己抛了也不能让 start() 炸 —— 退化成「这一轮不排」，由调用方决定下一步。
    try {
      this.#nextSweepAt = this.#nowMs() + delayMs
      const handle = this.#config.setTimeout(() => {
        this.#timer = null
        void this.#tick()
      }, delayMs)
      try {
        if (handle && typeof handle.unref === 'function') handle.unref()
      } catch {
        /* 某些假定时器没有 unref，忽略 */
      }
      this.#timer = handle ?? null
    } catch (err) {
      this.#timer = null
      this.#nextSweepAt = null
      this.#log.warn(`排下一轮自动续期失败：${messageOf(err)}`)
    }
  }

  async #tick() {
    try {
      await this.sync()
    } catch {
      /* sync 本身不抛，这里只是双保险 */
    }
    // stop() 之后绝不再排下一轮 —— 这就是「不留定时器残留」的那道闸。
    if (this.#running) this.#schedule(this.#config.sweepMs)
  }

  /** variant 表：优先 config.variants，其次 pool.variants，最后内置表。 */
  #variants() {
    const raw = Array.isArray(this.#config.variants)
      ? this.#config.variants
      : Array.isArray(this.#pool?.variants)
        ? this.#pool.variants
        : KEEPALIVE_VARIANTS
    const out = []
    for (const item of raw) {
      const variant = variantOf(item)
      if (variant && typeof variant.key === 'string' && !out.some((v) => v.key === variant.key)) {
        out.push(variant)
      }
    }
    return out.length > 0 ? out : KEEPALIVE_VARIANTS.slice()
  }

  /** 账号行是否「该刷」：已启用 + 未 needsRelogin + 未冷却 + refreshToken 未死 + 快过期。 */
  #isDue(meta, at) {
    if (!isRecord(meta) || typeof meta.uid !== 'string' || meta.uid === '') return false
    if (meta.enabled === false) return false
    if (meta.needsRelogin === true) return false
    if (typeof meta.cooldownUntil === 'number' && meta.cooldownUntil > at) return false
    const refreshExpiresAt = meta.refreshExpiresAt
    if (
      typeof refreshExpiresAt === 'number' &&
      Number.isFinite(refreshExpiresAt) &&
      refreshExpiresAt > 0 &&
      refreshExpiresAt <= at
    ) {
      return false
    }
    // 没有到期时刻就无从判断「即将过期」——不猜，留给上游。
    if (!Number.isFinite(meta.expiresAt)) return false
    return meta.expiresAt - at < this.#config.marginMs
  }

  #keyOf(variantKey, uid) {
    return `${variantKey}/${uid}`
  }

  /**
   * 收集本轮要处理的账号。返回 `{items, skipped}`；缺 pool 方法时不抛，
   * 只把原因写进 `#unavailable` 并返回空列表（优雅降级）。
   */
  async #collect(at) {
    const items = []
    let skipped = 0
    this.#unavailable = null

    const pool = this.#pool
    if (!pool) {
      this.#unavailable = 'pool-missing'
      return { items, skipped }
    }
    const missing = REQUIRED_POOL_METHODS.filter((name) => typeof pool[name] !== 'function')
    if (missing.length > 0) {
      this.#unavailable = missing.includes('list') ? 'pool-missing-list' : `pool-incomplete:${missing.join(',')}`
      return { items, skipped }
    }
    if (typeof this.#fetchImpl !== 'function') {
      // 没有注入 fetch 就绝不去碰真网络（也顺便保证单测不会误打真接口）。
      this.#unavailable = 'fetch-missing'
      return { items, skipped }
    }

    let poolError = ''
    for (const variant of this.#variants()) {
      let rows = null
      try {
        // 真实 pool.js 的 list() 是同步的，但这里 await 一下也无损 —— 万一以后变成
        // async，keepalive 不会静默把 Promise 当成「没有账号」（也不会漏出 unhandledRejection）。
        const listed = await pool.list(variant.key)
        if (Array.isArray(listed)) rows = listed
      } catch (err) {
        poolError = poolError || messageOf(err)
      }
      if (rows === null) {
        try {
          const listed = await pool.list()
          if (Array.isArray(listed)) {
            rows = listed.filter(
              (meta) => isRecord(meta) && (meta.variantKey === undefined || meta.variantKey === variant.key),
            )
          }
        } catch (err) {
          poolError = poolError || messageOf(err)
        }
      }
      if (rows === null) continue

      // 当前活跃账号由上游 dsh-workbuddy-connect 按需刷新（它在每次请求的发送路径上都会 resolve），
      // 我们不碰它 —— refresh token 是一次性轮换的，两边同时刷会让对方那份作废，
      // 轻则我们误标 needsRelogin，重则把用户的上游会话踢成「需要重新登录」。
      let activeUid
      if (this.#config.skipActive !== false && typeof pool.activeUid === 'function') {
        try {
          activeUid = pool.activeUid(variant.key)
        } catch {
          activeUid = undefined
        }
      }

      for (const meta of rows) {
        if (!isRecord(meta) || typeof meta.uid !== 'string' || meta.uid === '') continue
        if (typeof meta.variantKey === 'string' && meta.variantKey !== '' && meta.variantKey !== variant.key) {
          continue
        }
        /* [anchor:skip-active] 反向测试锚点：去掉这道闸门，活跃账号会被我们和上游同时刷新 */
        if (typeof activeUid === 'string' && activeUid !== '' && meta.uid === activeUid) {
          skipped += 1
          continue
        }
        if (!this.#isDue(meta, at)) {
          skipped += 1
          continue
        }
        const backoff = this.#failures.get(this.#keyOf(variant.key, meta.uid))
        if (backoff && backoff.nextAt > at) {
          skipped += 1
          continue
        }
        items.push({ variant, uid: meta.uid, meta })
      }
    }

    if (poolError !== '') this.#unavailable = 'pool-error'
    return { items, skipped }
  }

  async #sweep() {
    const startedAt = this.#nowMs()
    const summary = { startedAt, finishedAt: startedAt, considered: 0, refreshed: 0, failed: 0, skipped: 0 }
    try {
      const { items, skipped } = await this.#collect(startedAt)
      summary.considered = items.length
      summary.skipped = skipped
      this.#stats.skipped += skipped

      const tally = await this.#runLimited(items)
      this.#stats.ok += tally.ok
      this.#stats.failed += tally.failed
      this.#stats.skipped += tally.skipped
      summary.refreshed = tally.ok
      summary.failed = tally.failed
      summary.skipped += tally.skipped
    } catch (err) {
      // 兜底：扫描自身出任何意外都不许抛出去。
      this.#unavailable = 'sweep-failed'
      this.#log.warn(`自动续期扫描异常：${messageOf(err)}`)
    }
    this.#lastSweepAt = this.#nowMs()
    summary.finishedAt = this.#lastSweepAt
    return summary
  }

  /** 有限并发执行器：永远最多 limit 个 worker 在飞。 */
  async #runLimited(items) {
    const tally = { ok: 0, failed: 0, skipped: 0 }
    if (items.length === 0) return tally
    const cfg = this.#config

    /* [anchor:concurrency] 反向测试锚点：去掉这道上限，并发断言必须失败 */
    const limit = Math.max(1, Math.min(cfg.concurrency, items.length))

    let cursor = 0
    const lane = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        let outcome = 'failed'
        try {
          outcome = await this.#refreshOne(items[index], this.#nowMs())
        } catch (err) {
          // 单项失败绝不影响整轮。
          this.#log.warn(`自动续期单项异常：${messageOf(err)}`)
          outcome = 'failed'
        }
        if (outcome === 'ok') tally.ok += 1
        else if (outcome === 'skipped') tally.skipped += 1
        else tally.failed += 1
      }
    }

    const lanes = []
    for (let i = 0; i < limit; i += 1) lanes.push(lane())
    await Promise.all(lanes)
    return tally
  }

  /** 刷新一个账号并把结果落回池。返回 'ok' | 'failed' | 'skipped'。 */
  async #refreshOne(item, at) {
    const { variant, uid } = item
    const key = this.#keyOf(variant.key, uid)
    this.#inFlight.add(uid)
    try {
      let meta = item.meta
      // 复核一次账号状态（防 TOCTOU：扫描期间用户可能把它停用/标了重新登录）。
      if (typeof this.#pool.accountMeta === 'function') {
        try {
          const fresh = await this.#pool.accountMeta(variant.key, uid)
          if (isRecord(fresh)) meta = fresh
        } catch {
          /* 复核失败就用列表里的那一份 */
        }
      }
      if (!this.#isDue(meta, at)) return 'skipped'

      const text = await this.#readDocument(variant.key, uid)
      let document = null
      let failureResult = null
      if (typeof text !== 'string' || text.trim() === '') {
        failureResult = failure(false, false, 'missing-document')
      } else {
        try {
          document = JSON.parse(text)
        } catch {
          failureResult = failure(false, false, 'invalid-json')
        }
      }

      const result =
        failureResult ??
        (await refreshDocument({
          variantKey: variant,
          document,
          fetchImpl: this.#fetchImpl,
          now: this.#now,
          logger: this.#logger,
        }))

      if (result.ok) {
        const wrote = await this.#writeDocument(
          variant.key,
          uid,
          JSON.stringify(result.document, null, 2),
        )
        if (!wrote) {
          this.#recordFailure(key, at)
          await this.#setLastRefreshError(variant.key, uid, 'persist-failed')
          return 'failed'
        }
        this.#failures.delete(key)
        await this.#setLastRefreshError(variant.key, uid, null)
        await this.#markNeedsRelogin(variant.key, uid, null)
        return 'ok'
      }

      if (result.error === 'encrypted-credential') {
        // 加密信封账号：记一笔给 UI 看，但**不标 needsRelogin、不进退避**（重试无意义）。
        await this.#setLastRefreshError(variant.key, uid, 'encrypted-credential')
        return 'skipped'
      }

      this.#recordFailure(key, at)
      await this.#setLastRefreshError(variant.key, uid, result.error)
      if (result.needsRelogin) await this.#markNeedsRelogin(variant.key, uid, result.error)
      return 'failed'
    } finally {
      this.#inFlight.delete(uid)
    }
  }

  #recordFailure(key, at) {
    const previous = this.#failures.get(key)
    const failures = (previous?.failures ?? 0) + 1
    const delay = computeBackoffMs(failures, this.#config, this.#config.random)
    this.#failures.set(key, { failures, nextAt: at + delay })
  }

  // ── pool 调用（全部包一层，pool 自己的异常绝不许冒泡） ─────────────────────

  async #readDocument(variantKey, uid) {
    try {
      return await this.#pool.readSnapshotDocument(variantKey, uid)
    } catch (err) {
      this.#log.warn(`读取账号快照失败（${variantKey}/${uid}）：${messageOf(err)}`)
      return null
    }
  }

  async #writeDocument(variantKey, uid, text) {
    try {
      await this.#pool.writeSnapshotDocument(variantKey, uid, text)
      return true
    } catch (err) {
      this.#log.warn(`写入账号快照失败（${variantKey}/${uid}）：${messageOf(err)}`)
      return false
    }
  }

  async #setLastRefreshError(variantKey, uid, text) {
    if (typeof this.#pool.setLastRefreshError !== 'function') return
    try {
      await this.#pool.setLastRefreshError(variantKey, uid, text)
    } catch (err) {
      this.#log.warn(`记录 lastRefreshError 失败（${variantKey}/${uid}）：${messageOf(err)}`)
    }
  }

  async #markNeedsRelogin(variantKey, uid, reason) {
    if (typeof this.#pool.markNeedsRelogin !== 'function') return
    try {
      await this.#pool.markNeedsRelogin(variantKey, uid, reason)
    } catch (err) {
      this.#log.warn(`更新 needsRelogin 失败（${variantKey}/${uid}）：${messageOf(err)}`)
    }
  }
}

export default KeepAliveScheduler
