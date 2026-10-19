/**
 * dsh-workbuddy-multi — 主动加账号：WorkBuddy OAuth 微信扫码登录
 *
 * 权威规格：../PLAN.md 的 §3.5.0（已用 curl 实测的协议）与 §3.5.1（冻结接口）。
 * 协议来源：[changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch)（MIT）
 * 的 `crates/wb-switch-core/src/modules/oauth.rs` —— **只复刻协议，不引入其代码或依赖**。
 *
 * 流程（两档位端点见 LOGIN_VARIANTS）：
 *   1. `POST {endpoint}/v2/plugin/auth/state?platform={platform}`       → `{code:0,data:{state,authUrl}}`
 *   2. 把 authUrl 交给用户自己打开（微信扫码）——**本模块不代用户做任何登录动作**
 *   3. `GET  {endpoint}/v2/plugin/auth/token?state={state}`             → 未登录 `code=11217`
 *   4. `GET  {endpoint}/v2/plugin/login/account?state={state}`          → `{uid,nickname,email,…}`
 *
 * 设计约束：
 *  - 纯逻辑：不认识 DSH ctx，也不认识 pool.js。只**返回** document，由调用方决定是否入库。
 *  - `fetchImpl` / `now` / `logger` 全部可注入；**单测绝不打真网络**。
 *  - **绝不打印 token、绝不落盘**：日志里只出现 loginId / variantKey / code / domain。
 *  - `poll()` 始终不抛：网络错误 / 非 JSON / `code` 非 0,200 一律归为「未完成」（可重试）；
 *    终态失败是 §3.5.1 的**五类**判定 —— `timeout` / `domain-mismatch` /
 *    `missing-access-token` / `missing-uid` / `missing-domain`。
 *    缺 `expiresAt` **不算**终态：不凭空造过期时间（pool 侧对缺失是容错的）。
 *    `start()` 的冻结签名没有错误返回位，所以它失败时抛错（调用方 index.js 负责兜住）。
 *  - **幂等**：同一 loginId 一旦拿到终态，后续 `poll()` 返回**同一个结果对象**
 *    （照 oauth.rs 的 `done / result / error` 语义）。
 */

import { randomUUID } from 'node:crypto'

// ── 冻结常量（PLAN §3.5.0 的表 / §3.5.1） ───────────────────────────────

/**
 * 两个档位的端点与 platform。**逐字照 PLAN §3.5.0 的实测表**，不要凭猜测改形状。
 * 路径前缀两档位相同：`/v2/plugin`。
 */
export const LOGIN_VARIANTS = {
  cn: {
    key: 'cn',
    endpoint: 'https://www.codebuddy.cn',
    platform: 'workbuddy',
    apiPrefix: '/v2/plugin',
  },
  ai: {
    key: 'ai',
    endpoint: 'https://www.workbuddy.ai',
    platform: 'workbuddy-ai',
    apiPrefix: '/v2/plugin',
  },
}

/** 扫码会话的本地存活期（毫秒）。PLAN §3.5.5 里的 600 秒倒计时就是它。 */
export const LOGIN_TIMEOUT_MS = 600_000

/** 未登录时服务端返回的 code（实测 `{"code":11217,"msg":"11217:login ing..."}`）。 */
export const PENDING_HINT_CODE = 11217

/** 服务端把「成功」写成 0 或 200 两种（§3.5.0 第 3 步）。 */
const OK_CODES = new Set([0, 200])

/** 单次 HTTP 请求的硬上限。会话总预算仍是 timeoutMs，这里只是防止一条请求挂死。 */
const REQUEST_CEILING_MS = 60_000

// ── 小工具（不导出，冻结清单外的符号一律不外泄） ────────────────────────

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 非空字符串 → 去空白后的值；其余（含数字、对象、空串）→ undefined。 */
function str(v) {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

/** 展示类字段：接受非空字符串（去空白）或信封对象（原样保留）。 */
function textOrEnvelope(v) {
  if (typeof v === 'string') return str(v)
  if (isRecord(v)) return v
  return undefined
}

/**
 * token 类字段：**原样保留**（不去空白，避免动到凭据字节）。
 * 接受非空字符串，也接受 CN 版可能出现的加密信封对象（`{$wbEncrypted:1,envelope:…}`）。
 */
function pickToken(...values) {
  for (const v of values) {
    if (typeof v === 'string') {
      if (v.trim() !== '') return v
      continue
    }
    if (isRecord(v)) return v
  }
  return undefined
}

function toEpochMs(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number') return Number.isFinite(raw) ? (raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw)) : undefined
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t === '') return undefined
    const asNum = Number(t)
    if (Number.isFinite(asNum)) return toEpochMs(asNum)
    const parsed = Date.parse(t)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** `expiresIn` / `refreshExpiresIn` 是「秒」的相对量 → `now + n*1000`。 */
function toRelativeMs(raw, now) {
  let n
  if (typeof raw === 'number') n = raw
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw)
  else return undefined
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.round(now + n * 1000)
}

/** 先绝对量（epoch 秒/毫秒/ISO），回落到相对量（expiresIn 秒）。 */
function expiryOf(absolute, relative, now) {
  const abs = toEpochMs(absolute)
  if (abs !== undefined) return abs
  return toRelativeMs(relative, now)
}

function okCode(code) {
  if (typeof code === 'number') return OK_CODES.has(code)
  if (typeof code === 'string' && code.trim() !== '') return OK_CODES.has(Number(code))
  return false
}

function msgOf(json) {
  return str(json?.msg) ?? str(json?.message)
}

/**
 * 未完成时的 status 文案。
 * 优先服务端 `msg`（实测 `'11217:login ing...'`）；没有 msg 时：
 * `11217` → `'login-pending'`（PENDING_HINT_CODE 的实际用途），其余 → `'code:<code>'`。
 */
function pendingStatusOf(json) {
  const msg = msgOf(json)
  if (msg !== undefined) return msg
  if (Number(json?.code) === PENDING_HINT_CODE) return 'login-pending'
  return `code:${json?.code === undefined ? 'unknown' : String(json.code)}`
}

function errorText(err) {
  const m = err && typeof err.message === 'string' ? err.message.trim() : ''
  return m === '' ? 'network-error' : `network-error: ${m}`
}

/** 终态失败的唯一构造点，保证三个字段一个不少。 */
function terminalError(error) {
  return { done: true, ok: false, error, terminal: true }
}

function variantOf(key) {
  if (typeof key !== 'string') return undefined
  return Object.prototype.hasOwnProperty.call(LOGIN_VARIANTS, key) ? LOGIN_VARIANTS[key] : undefined
}

/** 与 pool.js 的 makeLog 同形；日志失败绝不影响主流程，且**永不打印 token**。 */
function makeLog(logger) {
  const emit = (level, message, detail) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](message, detail)
      else if (logger && typeof logger.log === 'function') logger.log(message, detail)
      else if (level === 'error') console.error(`[workbuddy-login] ${message}`, detail ?? '')
      else if (level === 'warn') console.warn(`[workbuddy-login] ${message}`, detail ?? '')
    } catch {
      /* 日志失败绝不影响主流程 */
    }
  }
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  }
}

// ── 档位判定（PLAN §3.5.0 的「档位一致性守卫」） ────────────────────────

/**
 * 国际版域名后缀白名单。
 *
 * 上游 `workbuddy-switch` 的 `variant.rs` 对 AI 档同时定义了
 * `AI_DOMAIN_SUFFIX = '.workbuddy.ai'` 与 `AI_CODEBUDDY_DOMAIN = 'www.codebuddy.ai'`
 * —— 即**国际版的 domain 既可能是 `workbuddy.ai` 也可能是 `codebuddy.ai`**，
 * 只认前者会把一次合法登录 fail-closed 掉；且 pool.js 的 `regionOfDomain` 已把
 * `codebuddy.ai` 判为 `'global'`，两边判据必须一致。
 */
const AI_DOMAIN_SUFFIXES = ['.workbuddy.ai', '.codebuddy.ai']

/**
 * 去空白 + 小写后以白名单后缀结尾 ⇒ 国际版。
 * 空/非字符串 → false（「认不出」由 domainMatchesVariant 单独处理，不在这里当否定证据）。
 * 后缀匹配天然挡住 `www.workbuddy.ai.evil.com` 这类拼接域名。
 */
export function isAiDomain(domain) {
  if (typeof domain !== 'string') return false
  const d = domain.trim().toLowerCase()
  if (d === '') return false
  return AI_DOMAIN_SUFFIXES.some((suffix) => d.endsWith(suffix))
}

/**
 * 档位一致性守卫：`''` / `undefined` / 非字符串 → `true`（无法判定，**不阻断**）；
 * 否则按 isAiDomain 的白名单后缀判为 ai 档、其余判为 cn 档，与 variantKey 比对。
 */
export function domainMatchesVariant(variantKey, domain) {
  if (typeof domain !== 'string') return true
  const d = domain.trim()
  if (d === '') return true
  const ai = isAiDomain(d)
  if (variantKey === 'ai') return ai
  if (variantKey === 'cn') return !ai
  // variantKey 不在两档位里 → 无从判定，不阻断（start() 早已拦掉这种 key）
  return true
}

// ── 响应归一 ───────────────────────────────────────────────────────────

/**
 * 把 `auth/token` 的 `data` 归一成固定六键（camel 与 snake 都认，
 * `expiresIn` / `refreshExpiresIn` 按秒换算成 epoch 毫秒）。
 * 缺失的键**显式置 `undefined`**（这个函数产出的是记录形状；
 * 「缺失就不写」的落盘规则在 buildAccountDocument 里执行）。
 */
export function normalizeTokenPayload(data, now) {
  const src = isRecord(data) ? data : {}
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  return {
    accessToken: pickToken(src.accessToken, src.access_token),
    refreshToken: pickToken(src.refreshToken, src.refresh_token),
    expiresAtMs: expiryOf(src.expiresAt ?? src.expires_at, src.expiresIn ?? src.expires_in, at),
    refreshExpiresAtMs: expiryOf(
      src.refreshExpiresAt ?? src.refresh_expires_at,
      src.refreshExpiresIn ?? src.refresh_expires_in,
      at,
    ),
    domain: str(src.domain),
    tokenType: str(src.tokenType) ?? str(src.token_type),
  }
}

// ── 账号文档 ───────────────────────────────────────────────────────────

/**
 * 把 OAuth 结果拼成上游（dsh-workbuddy-connect）认得的账号文档形状。
 *
 * - `expiresAt` / `refreshExpiresAt` 写 **epoch 毫秒**（上游 `expiryToMs` 兼容秒/毫秒）。
 * - **缺失字段直接不写**，不写 `null`、不写 `0`。
 * - `accounts` / `allAccounts` 恒为 `[]`（与桌面 App 落盘形状一致），`source:'multi'`、`version:1`。
 *
 * @param {object} p
 * @param {string} p.variantKey 冻结签名保留位：文档里没有档位字段，这里只是为了调用方原样透传。
 * @param {object} p.token       `normalizeTokenPayload()` 的结果。
 * @param {object} p.profile     `login/account` 的 `data`。
 * @param {number} [p.now]       冻结签名保留位：时间换算已在 normalizeTokenPayload 完成。
 */
export function buildAccountDocument({ variantKey, token, profile, now } = {}) {
  // 两个保留位显式引用一下，避免被读成「漏了档位/时间处理」。
  void variantKey
  void now

  const t = isRecord(token) ? token : {}
  const p = isRecord(profile) ? profile : {}

  const auth = {}
  if (t.accessToken !== undefined) auth.accessToken = t.accessToken
  if (t.refreshToken !== undefined) auth.refreshToken = t.refreshToken
  if (t.expiresAtMs !== undefined) auth.expiresAt = t.expiresAtMs
  if (t.refreshExpiresAtMs !== undefined) auth.refreshExpiresAt = t.refreshExpiresAtMs
  const domain = str(t.domain) ?? str(p.domain)
  if (domain !== undefined) auth.domain = domain
  if (t.tokenType !== undefined) auth.tokenType = t.tokenType

  const account = {}
  const uid = str(p.uid)
  if (uid !== undefined) account.uid = uid
  const nickname = textOrEnvelope(p.nickname)
  if (nickname !== undefined) account.nickname = nickname
  const email = textOrEnvelope(p.email)
  if (email !== undefined) account.email = email
  const enterpriseId = textOrEnvelope(p.enterpriseId ?? p.enterprise_id)
  if (enterpriseId !== undefined) account.enterpriseId = enterpriseId
  const enterpriseName = textOrEnvelope(p.enterpriseName ?? p.enterprise_name)
  if (enterpriseName !== undefined) account.enterpriseName = enterpriseName

  return {
    auth,
    account,
    accounts: [],
    allAccounts: [],
    source: 'multi',
    version: 1,
  }
}

/** 只含 uid/nickname/email 的展示用元信息（**永不含 token**）。 */
function buildLoginMeta(profile) {
  const p = isRecord(profile) ? profile : {}
  const meta = {}
  const uid = str(p.uid)
  if (uid !== undefined) meta.uid = uid
  const nickname = textOrEnvelope(p.nickname)
  if (nickname !== undefined) meta.nickname = nickname
  const email = textOrEnvelope(p.email)
  if (email !== undefined) meta.email = email
  return meta
}

// ── 登录会话管理器 ─────────────────────────────────────────────────────

/**
 * 扫码登录会话管理器。构造函数不读任何 DSH 上下文；`fetchImpl` / `now` / `logger` 都可注入。
 */
export class WorkBuddyLoginManager {
  constructor({ fetchImpl, now, logger, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
    const f = fetchImpl ?? globalThis.fetch
    if (typeof f !== 'function') throw new TypeError('fetchImpl must be a function')
    if (typeof now !== 'undefined' && typeof now !== 'function') throw new TypeError('now must be a function')
    this._fetch = f
    this._now = typeof now === 'function' ? now : () => Date.now()
    this.log = makeLog(logger)
    this._timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : LOGIN_TIMEOUT_MS
    /** loginId → 会话。终态会话**保留**在表里以供 poll 幂等，由 gc() 回收。 */
    this._sessions = new Map()
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  /**
   * 申请 state 并开一个本地会话。
   * 失败（网络 / 非 JSON / code 非 0,200 / 缺 state 或 authUrl）会抛错 ——
   * 冻结签名里没有错误返回位，调用方 index.js 负责兜住。
   */
  async start(variantKey) {
    const v = variantOf(variantKey)
    if (!v) throw new Error(`unknown login variant: ${String(variantKey)}`)

    const startedAt = this._now()
    const url = `${v.endpoint}${v.apiPrefix}/auth/state?platform=${encodeURIComponent(v.platform)}`
    const res = await this._request(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
      timeoutMs: this._timeoutMs,
    })
    const json = await readJson(res)
    if (json === undefined) throw new Error('auth/state: response is not a JSON object')
    if (!okCode(json.code)) {
      const msg = msgOf(json)
      throw new Error(`auth/state: code ${String(json.code)}${msg === undefined ? '' : ` ${msg}`}`)
    }
    const data = isRecord(json.data) ? json.data : {}
    const state = str(data.state)
    const authUrl = str(data.authUrl) ?? str(data.auth_url)
    if (state === undefined) throw new Error('auth/state: response missing state')
    if (authUrl === undefined) throw new Error('auth/state: response missing authUrl')

    const loginId = `wbm_${randomUUID().replace(/-/g, '')}`
    const expiresAt = startedAt + this._timeoutMs
    this._sessions.set(loginId, {
      loginId,
      variantKey: v.key,
      verificationUri: authUrl,
      state,
      startedAt,
      expiresAt,
      result: null,
    })
    this.log.info('login session started', { loginId, variantKey: v.key, expiresAt })
    return {
      loginId,
      variantKey: v.key,
      verificationUri: authUrl,
      state,
      startedAt,
      expiresAt,
      expiresIn: Math.round(this._timeoutMs / 1000),
    }
  }

  /**
   * 轮询一次。
   * → `{done:false, status}`                                   还在等扫码 / 可重试的错误
   * → `{done:true, ok:true, variantKey, document, meta}`        已拿到账号
   * → `{done:true, ok:false, error, terminal:true}`             终态失败
   * 拿到终态后本方法**幂等**：再次调用返回同一个对象，不再发任何请求。
   */
  async poll(loginId) {
    const s = this._sessions.get(loginId)
    if (!s) return terminalError('unknown-login')
    if (s.result) return s.result
    if (this._now() >= s.expiresAt) {
      this.log.warn('login session timed out', { loginId: s.loginId, variantKey: s.variantKey })
      return this._finish(s, terminalError('timeout'))
    }

    const result = await this._pollOnce(s)
    if (result.done === true) return this._finish(s, result)
    return result
  }

  /** true = 曾存在（真删掉了）；再次调用同一个 id → false。 */
  cancel(loginId) {
    const existed = this._sessions.delete(loginId)
    if (existed) this.log.info('login session cancelled', { loginId })
    return existed
  }

  /** 未完成的会话（终态与已过期的都不列），供 index.js 的 status() 用。 */
  list() {
    const at = this._now()
    const out = []
    for (const s of this._sessions.values()) {
      if (s.result) continue
      if (at >= s.expiresAt) continue
      out.push({
        loginId: s.loginId,
        variantKey: s.variantKey,
        verificationUri: s.verificationUri,
        startedAt: s.startedAt,
        expiresAt: s.expiresAt,
      })
    }
    return out
  }

  /**
   * 清掉已超时的会话（终态会话也在此回收），返回清掉的条数。
   * 幂等：同一时刻连调两次，第二次返回 0。
   */
  gc() {
    const at = this._now()
    let removed = 0
    for (const [loginId, s] of this._sessions) {
      if (at >= s.expiresAt) {
        this._sessions.delete(loginId)
        removed += 1
      }
    }
    if (removed > 0) this.log.debug('login gc', { removed })
    return removed
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  /** 缓存终态结果，保证 poll 幂等。 */
  _finish(session, result) {
    session.result = result
    return result
  }

  /** 走一遍「换 token → 取账号」两步；任何非终态问题都返回 `{done:false, status}`。 */
  async _pollOnce(s) {
    const v = variantOf(s.variantKey)
    if (!v) return terminalError('unknown-variant')

    // 第 3 步：换 token
    const tokenUrl = `${v.endpoint}${v.apiPrefix}/auth/token?state=${encodeURIComponent(s.state)}`
    const tokenRes = await this._softJson(tokenUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: s.expiresAt - this._now(),
    })
    if (tokenRes.json === undefined) return { done: false, status: tokenRes.status }
    const tj = tokenRes.json
    if (!okCode(tj.code)) return { done: false, status: pendingStatusOf(tj) }

    const token = normalizeTokenPayload(tj.data, this._now())
    if (token.accessToken === undefined) {
      this.log.warn('token response has no accessToken', { loginId: s.loginId, variantKey: s.variantKey })
      return terminalError('missing-access-token')
    }
    // 守卫①：token 响应里的 domain 必须与本档位一致
    if (!domainMatchesVariant(s.variantKey, token.domain)) {
      this.log.warn('token response domain does not match variant', {
        loginId: s.loginId,
        variantKey: s.variantKey,
        domain: token.domain,
      })
      return terminalError('domain-mismatch')
    }

    // 第 4 步：取账号信息
    const headers = { Accept: 'application/json', Authorization: `Bearer ${String(token.accessToken)}` }
    if (token.domain !== undefined) headers['X-Domain'] = token.domain
    const accountUrl = `${v.endpoint}${v.apiPrefix}/login/account?state=${encodeURIComponent(s.state)}`
    const accountRes = await this._softJson(accountUrl, {
      method: 'GET',
      headers,
      timeoutMs: s.expiresAt - this._now(),
    })
    if (accountRes.json === undefined) return { done: false, status: accountRes.status }
    const aj = accountRes.json
    if (!okCode(aj.code)) return { done: false, status: pendingStatusOf(aj) }

    const profile = isRecord(aj.data) ? aj.data : {}
    // 守卫②：account 响应的 domain 也要校验（§3.5.0「两处都要校验」）
    const profileDomain = str(profile.domain) ?? token.domain
    if (!domainMatchesVariant(s.variantKey, profileDomain)) {
      this.log.warn('account response domain does not match variant', {
        loginId: s.loginId,
        variantKey: s.variantKey,
        domain: profileDomain,
      })
      return terminalError('domain-mismatch')
    }

    // §3.5.1 五类终态判定的后两类：`code` 成功，但拿到的东西**根本不能入库**。
    // 与 `missing-access-token` 同类 —— 不可重试，且必须挡在构造 document 之前
    // （pool.upsertAccount 对 uid / domain 是硬要求，缺了会抛）。
    const uid = str(profile.uid)
    if (uid === undefined) {
      this.log.warn('account response has no uid', {
        loginId: s.loginId,
        variantKey: s.variantKey,
        domain: profileDomain,
      })
      return terminalError('missing-uid')
    }
    if (profileDomain === undefined) {
      this.log.warn('account response has no domain', { loginId: s.loginId, variantKey: s.variantKey })
      return terminalError('missing-domain')
    }

    const document = buildAccountDocument({ variantKey: s.variantKey, token, profile, now: this._now() })
    this.log.info('login session completed', { loginId: s.loginId, variantKey: s.variantKey })
    return {
      done: true,
      ok: true,
      variantKey: s.variantKey,
      document,
      meta: buildLoginMeta(profile),
    }
  }

  /**
   * 软失败版请求：网络错误 / 非 JSON 都变成 `{status}`，**不抛**。
   * （`code` 判定交给调用方，因为两处请求对「成功」的定义一致但文案不同。）
   */
  async _softJson(url, opts) {
    let res
    try {
      res = await this._request(url, opts)
    } catch (err) {
      return { status: errorText(err) }
    }
    const json = await readJson(res)
    if (json === undefined) return { status: 'non-json-response' }
    return { json }
  }

  /**
   * 唯一的出网点。带 AbortController 超时（`unref` 过，不会吊住事件循环），
   * 超时表现为 fetch reject → 上层归为「未完成」。
   */
  async _request(url, { method, headers, body, timeoutMs }) {
    const ms =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(Math.round(timeoutMs), REQUEST_CEILING_MS) : REQUEST_CEILING_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      return await this._fetch(url, { method, headers, body, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 读成 JSON 对象；空体 / 非 JSON / 数组 / 读取失败 → undefined。 */
async function readJson(res) {
  if (!res || typeof res.text !== 'function') return undefined
  let text
  try {
    text = await res.text()
  } catch {
    return undefined
  }
  if (typeof text !== 'string') return undefined
  const t = text.trim()
  if (t === '' || (t[0] !== '{' && t[0] !== '[')) return undefined
  try {
    const parsed = JSON.parse(t)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
