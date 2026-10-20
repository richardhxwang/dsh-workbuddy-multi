/**
 * dsh-workbuddy-multi — 账号池（pool）
 *
 * 职责单一：把「多个 WorkBuddy 账号的原始 auth 文档」存成池，并维护一个
 * 「当前生效」的托管文件，供上游 dsh-workbuddy-connect 通过环境变量读取。
 *
 * 设计约束（见 ../PLAN.md §1 / §2.3）：
 *  - 绝不解析或重新序列化 token：CN 版 token 是逐字段加密信封，重新序列化会把
 *    密文结构写坏。所有快照与生效文件都是**原始字节的逐字复制**。
 *  - 所有写入必须原子（temp + rename），权限 0600。
 *  - 本模块是纯逻辑，不认识 DSH ctx，便于单测。
 *
 * 磁盘布局（root 默认 ~/.dsh/workbuddy-pool）：
 *
 *   <root>/
 *     index.json                    # 索引：账号元信息 / 生效 uid / 策略 / 已吸收文件
 *     active/<cn|ai>.info           # 当前生效账号的原始字节（上游实际读它）
 *     accounts/<cn|ai>/<uid>.info   # 每个账号的原始字节快照
 *     accounts/<cn|ai>/<uid>.meta.json
 *     import/<cn|ai>/*.info         # 手动导入落地区（可被 absorbImportDir 吸收）
 */

import { promises as fsp } from 'node:fs'
import { dirname, join, basename, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'

/** 与上游 WORKBUDDY_VARIANTS 对齐的两个 variant。region 取自上游实测值（AI 是 'global'）。 */
export const POOL_VARIANTS = [
  {
    key: 'cn',
    variantId: 'workbuddy',
    routeId: 'workbuddy',
    env: 'WORKBUDDY_AUTH_FILE',
    desktopEnv: 'WORKBUDDY_AUTH_FILE',
    region: 'cn',
    desktopFilename: 'workbuddy-desktop.info',
    ownFilename: '.workbuddy-auth.json',
    displayName: 'WorkBuddy',
    appName: 'WorkBuddy',
  },
  {
    key: 'ai',
    variantId: 'workbuddy-ai',
    routeId: 'workbuddy-ai',
    env: 'WORKBUDDY_AI_AUTH_FILE',
    desktopEnv: 'WORKBUDDY_AI_AUTH_FILE',
    region: 'global',
    desktopFilename: 'workbuddy-desktop-ai.info',
    ownFilename: '.workbuddy-ai-auth.json',
    displayName: 'WorkBuddy AI',
    appName: 'WorkBuddy AI',
  },
]

export const POLICY_VALUES = ['on-rate-limit', 'round-robin', 'manual']

/** 池根目录。可用 WORKBUDDY_POOL_ROOT 覆盖（测试用）。 */
export function poolRoot() {
  const o = process.env.WORKBUDDY_POOL_ROOT
  if (typeof o === 'string' && o.trim() !== '') return resolve(o.trim())
  return join(homedir(), '.dsh', 'workbuddy-pool')
}

/** WorkBuddy 桌面 App 写 auth 的目录。可用 WORKBUDDY_DESKTOP_AUTH_DIR 覆盖。 */
export function desktopAuthDir() {
  const o = process.env.WORKBUDDY_DESKTOP_AUTH_DIR
  if (typeof o === 'string' && o.trim() !== '') return resolve(o.trim())
  return join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
}

export function variantFor(key) {
  return POOL_VARIANTS.find((v) => v.key === key || v.variantId === key || v.routeId === key)
}

/** 某个 variant 的桌面 auth 文件绝对路径。 */
export function desktopAuthPath(variantKey) {
  const v = variantFor(variantKey)
  if (!v) throw new Error(`unknown variant: ${variantKey}`)
  return join(desktopAuthDir(), v.desktopFilename)
}

/**
 * 从 auth.domain 反查 region；认不出时返回 undefined（调用方按「不确定」处理）。
 *
 * 两套域名都要认：桌面 App 写的是 `www.workbuddy.{cn,ai}`，而 OAuth 登录端点与
 * 部分接口在 `www.codebuddy.{cn,ai}`（见 PLAN §3.5.0）。两档位的官方向来是
 * 「AI 一律 *.workbuddy.ai，其余算国内版」，这里对 CN 只做正例识别、不反向否定。
 */
export function regionOfDomain(domain) {
  if (typeof domain !== 'string' || domain === '') return undefined
  const d = domain.toLowerCase()
  if (d.endsWith('workbuddy.ai') || d.endsWith('codebuddy.ai')) return 'global'
  if (d.endsWith('workbuddy.cn') || d.endsWith('codebuddy.cn')) return 'cn'
  return undefined
}

/** 上游把 expiresAt/refreshExpiresAt 存成 epoch 毫秒；顺手兼容秒与 ISO 字符串。 */
export function normalizeExpiry(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw)
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const asNum = Number(raw)
    if (Number.isFinite(asNum)) return normalizeExpiry(asNum)
    const t = Date.parse(raw)
    return Number.isFinite(t) ? t : undefined
  }
  return undefined
}

/** refreshToken 都过期了就没救了。 */
export function isAccountDead(meta, at = Date.now()) {
  if (!meta) return true
  const r = meta.refreshExpiresAt
  if (typeof r === 'number' && Number.isFinite(r) && r > 0) return r <= at
  return false
}

/**
 * 从原始字节里抽出账号元信息。不解密、不重写，只读明文可见字段。
 * @returns {{ok:true, uid, uin, nickname, type, domain, region, expiresAt, refreshExpiresAt, accountsCount, encrypted}
 *          | {ok:false, error:string}}
 */
/**
 * WorkBuddy 5.6+ 起 accessToken 在磁盘上是加密信封对象 `{$wbEncrypted:1, envelope}`。
 * 判据只看「是不是对象」—— 明文 token 永远是字符串（AI 档位的桌面文件就是明文）。
 */
export function isEncryptedToken(value) {
  return value !== null && typeof value === 'object'
}

/**
 * 账号 uid 的白名单。uid 会被直接拼进文件名（`accounts/<variant>/<uid>.info`、导入落地路径），
 * 而它来自**被导入文件的内容**——不做白名单，`"../../../../x"` 这样的 uid 就能让插件把文件
 * 原样写到池目录之外（`atomicWrite` 还会顺手 mkdir 穿越路径上的目录）。
 * 真实 uid 是 UUID（十六进制 + 连字符），这里放宽到字母数字、下划线、连字符，不含 `/` `\\` `.`。
 */
export const SAFE_UID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isSafeUid(uid) {
  return typeof uid === 'string' && SAFE_UID.test(uid)
}

/** 拼出来的路径必须仍在 base 目录之内；否则抛出（第二道防线，防白名单以后被改松）。 */
function assertInside(base, file) {
  const root = resolve(base)
  const target = resolve(file)
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`invalid-uid: 路径越出 ${root}`)
  return file
}

export function parseAccountDoc(bytes) {
  let doc
  try {
    doc = JSON.parse(typeof bytes === 'string' ? bytes : bytes.toString('utf8'))
  } catch {
    return { ok: false, error: 'invalid-json' }
  }
  if (doc === null || typeof doc !== 'object') return { ok: false, error: 'not-an-object' }
  const acct = doc.account && typeof doc.account === 'object' ? doc.account : {}
  const auth = doc.auth && typeof doc.auth === 'object' ? doc.auth : {}
  const uid = typeof acct.uid === 'string' ? acct.uid.trim() : ''
  if (uid === '') return { ok: false, error: 'missing-uid' }
  if (!isSafeUid(uid)) return { ok: false, error: 'invalid-uid' }
  const nickname = typeof acct.nickname === 'string' ? acct.nickname.trim() : ''
  let uin = ''
  if (typeof acct.uin === 'string') uin = acct.uin
  else if (typeof acct.uin === 'number') uin = String(acct.uin)
  return {
    ok: true,
    uid,
    uin,
    nickname,
    type: typeof acct.type === 'string' ? acct.type : undefined,
    domain: typeof auth.domain === 'string' ? auth.domain : '',
    region: regionOfDomain(auth.domain),
    expiresAt: normalizeExpiry(auth.expiresAt),
    refreshExpiresAt: normalizeExpiry(auth.refreshExpiresAt),
    accountsCount: Array.isArray(doc.accounts) ? doc.accounts.length : 0,
    encrypted: isEncryptedToken(auth.accessToken),
  }
}

function makeLog(logger) {
  const emit = (level, message, detail) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](message, detail)
      else if (logger && typeof logger.log === 'function') logger.log(message)
      else if (level === 'error') console.error(`[workbuddy-pool] ${message}`, detail ?? '')
      else if (level === 'warn') console.warn(`[workbuddy-pool] ${message}`, detail ?? '')
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

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function readBytesSafe(file) {
  try {
    return await fsp.readFile(file)
  } catch {
    return undefined
  }
}

async function readJsonSafe(file) {
  const b = await readBytesSafe(file)
  if (b === undefined) return undefined
  try {
    return JSON.parse(b.toString('utf8'))
  } catch {
    return undefined
  }
}

/** 原子写 + 0600。先写同目录临时文件再 rename，避免上游读到半截 JSON。 */
async function atomicWrite(file, data, mode = 0o600) {
  await fsp.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  await fsp.writeFile(tmp, buf, { mode })
  try {
    await fsp.chmod(tmp, mode)
  } catch {
    /* 某些文件系统不支持，忽略 */
  }
  await fsp.rename(tmp, file)
}

function emptyIndex() {
  return {
    version: 1,
    policy: 'on-rate-limit',
    variantActive: { cn: null, ai: null },
    accounts: { cn: {}, ai: {} },
    absorbed: { cn: {}, ai: {} },
    updatedAt: 0,
  }
}

/**
 * 账号池。构造函数不读任何 DSH 上下文；`root` 与 `now` 都可注入，便于单测。
 */
export class WorkBuddyPool {
  constructor({ root, logger, now } = {}) {
    this.root = root ? resolve(root) : poolRoot()
    this.log = makeLog(logger)
    this._now = typeof now === 'function' ? now : () => Date.now()
    this.index = emptyIndex()
    this._loaded = false
    this._listeners = new Map()
    this._writeChain = Promise.resolve()
  }

  // ── 事件 ──────────────────────────────────────────────────────────────
  on(evt, fn) {
    let set = this._listeners.get(evt)
    if (!set) {
      set = new Set()
      this._listeners.set(evt, set)
    }
    set.add(fn)
    return () => this.off(evt, fn)
  }

  off(evt, fn) {
    const set = this._listeners.get(evt)
    if (set) set.delete(fn)
  }

  _emit(evt, payload) {
    const set = this._listeners.get(evt)
    if (!set || set.size === 0) return
    for (const fn of [...set]) {
      try {
        fn(payload)
      } catch (err) {
        this.log.warn(`listener for "${evt}" threw`, err)
      }
    }
  }

  // ── 路径 ──────────────────────────────────────────────────────────────
  indexPath() {
    return join(this.root, 'index.json')
  }

  activeFilePath(variantKey) {
    return join(this.root, 'active', `${variantKey}.info`)
  }

  snapshotPath(variantKey, uid) {
    if (!isSafeUid(uid)) throw new Error(`invalid-uid: ${String(uid).slice(0, 40)}`)
    return assertInside(this.root, join(this.root, 'accounts', variantKey, `${uid}.info`))
  }

  metaPath(variantKey, uid) {
    if (!isSafeUid(uid)) throw new Error(`invalid-uid: ${String(uid).slice(0, 40)}`)
    return assertInside(this.root, join(this.root, 'accounts', variantKey, `${uid}.meta.json`))
  }

  importDir(variantKey) {
    return join(this.root, 'import', variantKey)
  }

  // ── 持久化 ────────────────────────────────────────────────────────────
  async _persist() {
    this.index.updatedAt = this._now()
    const payload = JSON.stringify(this.index, null, 2)
    this._writeChain = this._writeChain
      .then(() => atomicWrite(this.indexPath(), payload, 0o600))
      .catch((err) => this.log.error('写 index.json 失败', err))
    return this._writeChain
  }

  async _ensureDirs() {
    await fsp.mkdir(this.root, { recursive: true })
    await fsp.mkdir(join(this.root, 'active'), { recursive: true })
    for (const v of POOL_VARIANTS) {
      await fsp.mkdir(join(this.root, 'accounts', v.key), { recursive: true })
      await fsp.mkdir(this.importDir(v.key), { recursive: true })
    }
  }

  // ── 加载 ──────────────────────────────────────────────────────────────
  /** 幂等：建目录、读索引、与磁盘快照对账。 */
  async load() {
    await this._ensureDirs()
    const raw = await readJsonSafe(this.indexPath())
    const next = emptyIndex()
    if (raw && typeof raw === 'object') {
      if (POLICY_VALUES.includes(raw.policy)) next.policy = raw.policy
      if (raw.variantActive && typeof raw.variantActive === 'object') {
        next.variantActive.cn = typeof raw.variantActive.cn === 'string' ? raw.variantActive.cn : null
        next.variantActive.ai = typeof raw.variantActive.ai === 'string' ? raw.variantActive.ai : null
      }
      if (raw.accounts && typeof raw.accounts === 'object') {
        for (const v of POOL_VARIANTS) {
          const bucket = raw.accounts[v.key]
          if (bucket && typeof bucket === 'object') next.accounts[v.key] = { ...bucket }
        }
      }
      if (raw.absorbed && typeof raw.absorbed === 'object') {
        for (const v of POOL_VARIANTS) {
          const bucket = raw.absorbed[v.key]
          if (bucket && typeof bucket === 'object') next.absorbed[v.key] = { ...bucket }
        }
      }
      if (typeof raw.updatedAt === 'number') next.updatedAt = raw.updatedAt
    }
    this.index = next

    // 与磁盘对账：文件被外部删掉的账号从索引里剔除；存在但未登记的补登。
    for (const v of POOL_VARIANTS) {
      const dir = join(this.root, 'accounts', v.key)
      let entries = []
      try {
        entries = await fsp.readdir(dir)
      } catch {
        entries = []
      }
      const onDisk = new Set()
      for (const name of entries) {
        if (!name.endsWith('.info')) continue
        const uid = name.slice(0, -'.info'.length)
        const bytes = await readBytesSafe(join(dir, name))
        if (bytes === undefined) continue
        const parsed = parseAccountDoc(bytes)
        if (!parsed.ok || parsed.uid !== uid) {
          this.log.warn(`快照 ${v.key}/${name} 无法解析（${parsed.ok ? 'uid 不一致' : parsed.error}），忽略`)
          continue
        }
        onDisk.add(uid)
        if (!this.index.accounts[v.key][uid]) {
          this.index.accounts[v.key][uid] = this._buildMeta(v, parsed, bytes, 'desktop', undefined)
        }
      }
      for (const uid of Object.keys(this.index.accounts[v.key])) {
        if (!onDisk.has(uid)) {
          this.log.info(`索引里的 ${v.key}/${uid.slice(0, 8)} 已无快照文件，移除`)
          delete this.index.accounts[v.key][uid]
          if (this.index.variantActive[v.key] === uid) this.index.variantActive[v.key] = null
        }
      }
      const act = this.index.variantActive[v.key]
      if (act && !this.index.accounts[v.key][act]) this.index.variantActive[v.key] = null
    }

    this._loaded = true
    await this._persist()
    return this
  }

  _assertLoaded() {
    if (!this._loaded) throw new Error('WorkBuddyPool.load() 必须先调用')
  }

  _buildMeta(variant, parsed, bytes, source, existing) {
    const label =
      existing && typeof existing.label === 'string' && existing.label.trim() !== ''
        ? existing.label
        : parsed.nickname !== ''
          ? parsed.nickname
          : parsed.uid.slice(0, 8)
    return {
      variantKey: variant.key,
      uid: parsed.uid,
      uin: parsed.uin,
      domain: parsed.domain,
      // 从 domain 推出来的档位（cn / global）；推不出来时是 undefined —— 调用方按「不确定」处理。
      region: parsed.region,
      label,
      type: parsed.type,
      expiresAt: parsed.expiresAt,
      refreshExpiresAt: parsed.refreshExpiresAt,
      capturedAt: existing && typeof existing.capturedAt === 'number' ? existing.capturedAt : this._now(),
      lastUsedAt: existing && typeof existing.lastUsedAt === 'number' ? existing.lastUsedAt : undefined,
      source,
      enabled: existing && typeof existing.enabled === 'boolean' ? existing.enabled : true,
      cooldownUntil: existing ? existing.cooldownUntil : undefined,
      cooldownReason: existing ? existing.cooldownReason : undefined,
      // 自动续期相关（PLAN §3.5.3）：undefined 的字段会被 JSON.stringify 丢掉，index.json 保持干净。
      needsRelogin: existing ? existing.needsRelogin === true : false,
      needsReloginReason: existing ? existing.needsReloginReason : undefined,
      lastRefreshAt: existing && typeof existing.lastRefreshAt === 'number' ? existing.lastRefreshAt : undefined,
      lastRefreshError: existing ? existing.lastRefreshError : undefined,
      bytes: bytes.length,
      sha256: sha256(bytes),
    }
  }

  // ── 查询 ──────────────────────────────────────────────────────────────
  list(variantKey) {
    this._assertLoaded()
    const bucket = this.index.accounts[variantKey]
    if (!bucket) return []
    return Object.values(bucket).sort((a, b) => {
      const ca = a.capturedAt || 0
      const cb = b.capturedAt || 0
      if (ca !== cb) return ca - cb
      return String(a.uid).localeCompare(String(b.uid))
    })
  }

  get(variantKey, uid) {
    this._assertLoaded()
    const bucket = this.index.accounts[variantKey]
    if (!bucket || typeof uid !== 'string') return undefined
    return bucket[uid]
  }

  activeUid(variantKey) {
    this._assertLoaded()
    return this.index.variantActive[variantKey] || undefined
  }

  policy() {
    this._assertLoaded()
    return this.index.policy
  }

  /** 单个账号此刻是否可用于发起请求。 */
  _usableAt(meta, at, { includeCooling = false } = {}) {
    if (!meta || !meta.enabled) return false
    if (isAccountDead(meta, at)) return false
    if (!includeCooling && typeof meta.cooldownUntil === 'number' && meta.cooldownUntil > at) return false
    // 标记了 needsRelogin 的账号已经刷不动了：access token 还有效就仍然可用，过期就彻底不可用。
    if (
      meta.needsRelogin === true &&
      typeof meta.expiresAt === 'number' &&
      Number.isFinite(meta.expiresAt) &&
      meta.expiresAt <= at
    ) {
      return false
    }
    return true
  }

  /** 可用账号：已启用、未冷却（可按需放宽）、refreshToken 未彻底过期。 */
  selectable(variantKey, { at = this._now(), includeCooling = false } = {}) {
    return this.list(variantKey).filter((meta) => this._usableAt(meta, at, { includeCooling }))
  }

  // ── 变更 ──────────────────────────────────────────────────────────────
  async setPolicy(policy) {
    if (!POLICY_VALUES.includes(policy)) throw new Error(`unknown policy: ${policy}`)
    this._assertLoaded()
    this.index.policy = policy
    await this._persist()
    this._emit('changed', { variantKey: null, reason: 'policy' })
    return policy
  }

  async setEnabled(variantKey, uid, on) {
    const meta = this.get(variantKey, uid)
    if (!meta) throw new Error(`account not found: ${variantKey}/${uid}`)
    meta.enabled = Boolean(on)
    await this._persist()
    if (!meta.enabled && this.activeUid(variantKey) === uid) {
      this.index.variantActive[variantKey] = null
      await this.ensureActive(variantKey)
    }
    this._emit('changed', { variantKey, reason: 'enable' })
    return meta
  }

  async setLabel(variantKey, uid, label) {
    const meta = this.get(variantKey, uid)
    if (!meta) throw new Error(`account not found: ${variantKey}/${uid}`)
    const t = typeof label === 'string' ? label.trim() : ''
    meta.label = t !== '' ? t : meta.uid.slice(0, 8)
    await this._writeMetaFile(variantKey, meta)
    await this._persist()
    this._emit('changed', { variantKey, reason: 'label' })
    return meta
  }

  async remove(variantKey, uid) {
    const meta = this.get(variantKey, uid)
    if (!meta) return false
    const wasActive = this.activeUid(variantKey) === uid
    delete this.index.accounts[variantKey][uid]
    if (wasActive) this.index.variantActive[variantKey] = null
    for (const p of [this.snapshotPath(variantKey, uid), this.metaPath(variantKey, uid)]) {
      try {
        await fsp.unlink(p)
      } catch {
        /* 已经不在了 */
      }
    }
    if (wasActive) {
      // 必须把生效文件也删掉：否则紧接着的 ensureActive → harvestActive 会从
      // 这个文件里把刚删掉的账号「回收」回来，等于删不掉。
      try {
        await fsp.unlink(this.activeFilePath(variantKey))
      } catch {
        /* 已经不在了 */
      }
    }
    await this._persist()
    if (wasActive) await this.ensureActive(variantKey)
    this._emit('changed', { variantKey, reason: 'remove' })
    return true
  }

  async setCooldown(variantKey, uid, { until, reason } = {}) {
    const meta = this.get(variantKey, uid)
    if (!meta) throw new Error(`account not found: ${variantKey}/${uid}`)
    meta.cooldownUntil = typeof until === 'number' ? until : this._now()
    meta.cooldownReason = typeof reason === 'string' ? reason : 'rate-limit'
    await this._persist()
    this._emit('changed', { variantKey, reason: 'cooldown' })
    return meta
  }

  async clearCooldown(variantKey, uid) {
    const meta = this.get(variantKey, uid)
    if (!meta) throw new Error(`account not found: ${variantKey}/${uid}`)
    meta.cooldownUntil = undefined
    meta.cooldownReason = undefined
    await this._persist()
    this._emit('changed', { variantKey, reason: 'cooldown' })
    return meta
  }

  async noteUsed(variantKey, uid) {
    const meta = this.get(variantKey, uid)
    if (!meta) return undefined
    meta.lastUsedAt = this._now()
    await this._persist()
    return meta
  }

  async _writeMetaFile(variantKey, meta) {
    try {
      await atomicWrite(this.metaPath(variantKey, meta.uid), JSON.stringify(meta, null, 2), 0o600)
    } catch (err) {
      this.log.warn(`写 meta 文件失败 ${variantKey}/${meta.uid}`, err)
    }
  }

  /**
   * 把某个账号设为「当前生效」：把它的快照字节原子复制到 active/<v>.info。
   * 上游每次请求都重新读这个文件，所以切号即时生效、无需重启。
   */
  async setActive(variantKey, uid, { reason } = {}) {
    this._assertLoaded()
    const meta = this.get(variantKey, uid)
    if (!meta) throw new Error(`account not found: ${variantKey}/${uid}`)
    const bytes = await readBytesSafe(this.snapshotPath(variantKey, uid))
    if (bytes === undefined) throw new Error(`snapshot missing: ${variantKey}/${uid}`)
    await atomicWrite(this.activeFilePath(variantKey), bytes, 0o600)
    this.index.variantActive[variantKey] = uid
    meta.lastUsedAt = this._now()
    await this._persist()
    this.log.info(`生效账号 ${variantKey} -> ${meta.label} (${uid.slice(0, 8)})${reason ? ` · ${reason}` : ''}`)
    this._emit('changed', { variantKey, reason: 'active' })
    return meta
  }

  /** 选下一个可用账号并生效（环形，跳过冷却/停用/彻底过期的）。 */
  async advance(variantKey, { reason, at = this._now() } = {}) {
    const all = this.list(variantKey)
    if (all.length === 0) {
      this.log.warn(`${variantKey} 池里没有账号`)
      return undefined
    }
    const current = this.activeUid(variantKey)
    // 注意：不能只在「可用账号」里找当前位置 —— 当前账号可能刚被冷却而落选，
    // 那样就会以为「当前不存在」然后回绕到第一个，跳号。必须按全量顺序环形前进。
    const startIdx = current === undefined ? -1 : all.findIndex((m) => m.uid === current)
    for (let step = 1; step <= all.length; step += 1) {
      const cand = all[(startIdx + step + all.length) % all.length]
      if (this._usableAt(cand, at)) {
        await this.setActive(variantKey, cand.uid, { reason: reason ?? 'advance' })
        return cand.uid
      }
    }
    this.log.warn(`${variantKey} 没有可用账号（全部停用/冷却/失效）`)
    return undefined
  }

  /**
   * 保证有一个生效账号：
   *  1) 先把 active 文件里更新的 token「回收」进快照（上游刷新后会写回它读的文件）；
   *  2) 当前生效账号仍可用且文件在 → 保持；
   *  3) 否则挑一个可用账号生效。
   */
  async ensureActive(variantKey, { at = this._now() } = {}) {
    this._assertLoaded()
    await this.harvestActive(variantKey)

    const act = this.activeUid(variantKey)
    if (act) {
      const meta = this.get(variantKey, act)
      const bytes = await readBytesSafe(this.activeFilePath(variantKey))
      if (meta && meta.enabled && !isAccountDead(meta, at) && bytes !== undefined) {
        return act
      }
    }

    const cands = this.selectable(variantKey, { at })
    if (cands.length === 0) {
      this.log.warn(`${variantKey} 无可用账号可生效`)
      return undefined
    }
    const pick = cands[0]
    await this.setActive(variantKey, pick.uid, { reason: 'auto' })
    return pick.uid
  }

  /**
   * 上游刷新 token 后会写回它读的那个文件（即我们的 active/<v>.info）。
   * 这里把更「新」的 active 内容收回快照，避免下次切号把新 token 覆盖成旧的。
   */
  async harvestActive(variantKey) {
    const bytes = await readBytesSafe(this.activeFilePath(variantKey))
    if (bytes === undefined) return undefined
    const parsed = parseAccountDoc(bytes)
    if (!parsed.ok) return undefined
    const meta = this.get(variantKey, parsed.uid)
    if (!meta) {
      return this._upsertSnapshot(variantKey, parsed, bytes, 'desktop')
    }
    const activeExp = parsed.expiresAt ?? 0
    const snapExp = meta.expiresAt ?? 0
    if (activeExp > snapExp) {
      await atomicWrite(this.snapshotPath(variantKey, parsed.uid), bytes, 0o600)
      meta.expiresAt = parsed.expiresAt
      meta.refreshExpiresAt = parsed.refreshExpiresAt
      meta.bytes = bytes.length
      meta.sha256 = sha256(bytes)
      await this._writeMetaFile(variantKey, meta)
      await this._persist()
      this.log.debug(`已把刷新后的 token 收回快照 ${variantKey}/${parsed.uid.slice(0, 8)}`)
      return meta
    }
    return meta
  }

  async _upsertSnapshot(variantKey, parsed, bytes, source) {
    const variant = variantFor(variantKey)
    if (!variant) throw new Error(`unknown variant: ${variantKey}`)
    if (parsed.region !== undefined && parsed.region !== variant.region) {
      this.log.warn(
        `region 不匹配：文档是 ${parsed.region}（${parsed.domain}），variant ${variantKey} 需要 ${variant.region}，已跳过`,
      )
      return null
    }
    const existing = this.get(variantKey, parsed.uid)
    // 别把「我们能自己刷新的明文凭据」降级成「只有上游能用的密文凭据」：
    // OAuth 登录过的账号，桌面 App 的密文副本再扫回来时若并不更新，就保住我们的明文快照。
    if (existing && existing.source === 'oauth' && parsed.encrypted === true) {
      const incoming = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0
      const current = typeof existing.expiresAt === 'number' ? existing.expiresAt : 0
      if (incoming <= current) {
        this.log.debug(
          `保留 ${variantKey}/${parsed.uid.slice(0, 8)} 的明文快照：桌面密文副本并不更新（${incoming} <= ${current}）`,
        )
        return existing
      }
    }
    const meta = this._buildMeta(variant, parsed, bytes, source, existing)
    if (existing && existing.source === 'desktop') meta.source = 'desktop'
    await atomicWrite(this.snapshotPath(variantKey, parsed.uid), bytes, 0o600)
    this.index.accounts[variantKey][parsed.uid] = meta
    await this._writeMetaFile(variantKey, meta)
    await this._persist()
    return meta
  }

  // ── 主动登录入库 / 自动续期写回（PLAN §3.5.3 冻结面）──────────────────────

  /** 快照原文。keepalive 读它拿到 token 去刷新；文件不存在返回 null。 */
  async readSnapshotDocument(variantKey, uid) {
    this._assertLoaded()
    const bytes = await readBytesSafe(this.snapshotPath(variantKey, uid))
    return bytes === undefined ? null : bytes.toString('utf8')
  }

  /**
   * 把刷新后的文档写回快照（原子 + 0600），并同步 index.json 的派生字段。
   *
   * 只接受「能解析出 uid、且 uid/region 与目标账号一致」的完整文档 —— 任何一项不符就整体拒绝，
   * 绝不把半截或串号的文档写进快照。写成功后视为一次健康刷新：
   * 更新 expiresAt/refreshExpiresAt、记 lastRefreshAt、清掉 needsRelogin 与 lastRefreshError。
   */
  async writeSnapshotDocument(variantKey, uid, text) {
    this._assertLoaded()
    const variant = variantFor(variantKey)
    if (!variant) throw new Error(`unknown variant: ${variantKey}`)
    const str = typeof text === 'string' ? text : JSON.stringify(text)
    const bytes = Buffer.from(str, 'utf8')
    const parsed = parseAccountDoc(bytes)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    if (parsed.uid !== uid) return { ok: false, error: 'uid-mismatch' }
    if (parsed.region !== undefined && parsed.region !== variant.region) {
      return { ok: false, error: 'region-mismatch' }
    }
    const meta = this.get(variantKey, uid)
    if (!meta) return { ok: false, error: 'unknown-account' }
    await atomicWrite(this.snapshotPath(variantKey, uid), bytes, 0o600)
    meta.expiresAt = parsed.expiresAt
    meta.refreshExpiresAt = parsed.refreshExpiresAt
    meta.bytes = bytes.length
    meta.sha256 = sha256(bytes)
    meta.lastRefreshAt = this._now()
    meta.lastRefreshError = undefined
    meta.needsRelogin = false
    meta.needsReloginReason = undefined
    await this._writeMetaFile(variantKey, meta)
    await this._persist()
    this._emit('changed', { variantKey, reason: 'refreshed', uid })
    return { ok: true, meta }
  }

  /**
   * 把一个 OAuth 登录结果入库（`lib/login.js` 的 `buildAccountDocument()` 产物）。
   *
   * 同 uid 已存在时：覆盖凭据并清掉 needsRelogin，但**保留**人工状态
   * （enabled / label / 冷却），不然用户手工禁用的账号会被一次重新登录悄悄打开。
   * region 不匹配直接抛（档位串号必须响亮地失败，不能静静丢账号）。
   */
  async upsertAccount(variantKey, document, { label, source = 'oauth' } = {}) {
    this._assertLoaded()
    const variant = variantFor(variantKey)
    if (!variant) throw new Error(`unknown variant: ${variantKey}`)
    const str = typeof document === 'string' ? document : JSON.stringify(document, null, 2)
    const bytes = Buffer.from(str, 'utf8')
    const parsed = parseAccountDoc(bytes)
    if (!parsed.ok) throw new Error(`登录结果无法解析（${parsed.error}），已拒绝入库`)
    const meta = await this._upsertSnapshot(variantKey, parsed, bytes, source)
    if (!meta) {
      throw new Error(`登录结果的 domain（${parsed.domain}）与 ${variantKey} 档位不符，已拒绝入库`)
    }
    meta.needsRelogin = false
    meta.needsReloginReason = undefined
    meta.lastRefreshError = undefined
    // 凭据来源必须如实改成 oauth：我们现在持有的是**插件自己登录拿到的明文 token**，
    // 而不是桌面 App 的密文副本 —— 自动续期能不能刷得动，全看这个标记。
    meta.source = source
    if (typeof label === 'string' && label.trim() !== '') meta.label = label.trim()
    await this._writeMetaFile(variantKey, meta)
    await this._persist()
    this.log.info(`已入库账号 ${variantKey}: ${meta.label} (${meta.uid.slice(0, 8)}) · ${source}`)
    this._emit('captured', { variantKey, uid: meta.uid, source })
    this._emit('changed', { variantKey, reason: 'upsert', uid: meta.uid })
    return meta
  }

  /** 标记/清除「需要重新登录」。reason 传 null 表示清除。不存在该账号返回 undefined。 */
  async markNeedsRelogin(variantKey, uid, reason) {
    this._assertLoaded()
    const meta = this.get(variantKey, uid)
    if (!meta) return undefined
    if (reason === null || reason === undefined) {
      meta.needsRelogin = false
      meta.needsReloginReason = undefined
    } else {
      meta.needsRelogin = true
      meta.needsReloginReason = String(reason)
    }
    await this._writeMetaFile(variantKey, meta)
    await this._persist()
    this._emit('changed', { variantKey, reason: 'needs-relogin', uid })
    return meta
  }

  /** 只写诊断字段，绝不碰凭据。传空则清除。 */
  async setLastRefreshError(variantKey, uid, lastError) {
    this._assertLoaded()
    const meta = this.get(variantKey, uid)
    if (!meta) return undefined
    meta.lastRefreshError =
      lastError === null || lastError === undefined || lastError === '' ? undefined : String(lastError)
    await this._writeMetaFile(variantKey, meta)
    await this._persist()
    return meta
  }

  /** `get()` 的语义别名，供 keepalive 侧读起来更顺。 */
  accountMeta(variantKey, uid) {
    return this.get(variantKey, uid)
  }

  /** 读桌面 App 当前的 auth 文件并按 uid 快照。返回 AccountMeta | null。 */
  async captureFromDesktop(variantKey) {
    this._assertLoaded()
    const variant = variantFor(variantKey)
    if (!variant) throw new Error(`unknown variant: ${variantKey}`)
    const file = desktopAuthPath(variantKey)
    const bytes = await readBytesSafe(file)
    if (bytes === undefined) {
      this.log.debug(`桌面 auth 文件不存在，跳过：${file}`)
      return null
    }
    const parsed = parseAccountDoc(bytes)
    if (!parsed.ok) {
      this.log.warn(`桌面 auth 文件无法解析（${parsed.error}）：${file}`)
      return null
    }
    const meta = await this._upsertSnapshot(variantKey, parsed, bytes, 'desktop')
    if (meta) {
      this.log.info(`已捕获账号 ${variantKey}: ${meta.label} (${meta.uid.slice(0, 8)})`)
      this._emit('captured', { variantKey, uid: meta.uid })
      this._emit('changed', { variantKey, reason: 'capture' })
    }
    return meta
  }

  /** 两个 variant 各抓一次，并回收刷新后的 token。 */
  async captureAll() {
    const out = {}
    for (const v of POOL_VARIANTS) {
      await this.harvestActive(v.key)
      out[v.key] = await this.captureFromDesktop(v.key)
    }
    return out
  }

  /** 逐字拷贝外部文件进池。返回成功吸收的 meta 列表。 */
  async importFiles(variantKey, paths, { onError } = {}) {
    this._assertLoaded()
    const variant = variantFor(variantKey)
    if (!variant) throw new Error(`unknown variant: ${variantKey}`)
    const list = Array.isArray(paths) ? paths : [paths]
    const out = []
    for (const p of list) {
      const abs = resolve(String(p))
      const bytes = await readBytesSafe(abs)
      if (bytes === undefined) {
        this.log.warn(`读不到文件：${abs}`)
        if (onError) onError({ path: abs, error: 'unreadable' })
        continue
      }
      const parsed = parseAccountDoc(bytes)
      if (!parsed.ok) {
        this.log.warn(`不是有效的 WorkBuddy auth 文件（${parsed.error}）：${abs}`)
        if (onError) onError({ path: abs, error: parsed.error })
        continue
      }
      if (parsed.region !== undefined && parsed.region !== variant.region) {
        this.log.warn(`region 不匹配：${abs} 属于 ${parsed.region}（${parsed.domain}），不能导入到 ${variantKey}`)
        if (onError) onError({ path: abs, error: 'region-mismatch', region: parsed.region })
        continue
      }
      const landed = assertInside(this.importDir(variantKey), join(this.importDir(variantKey), `${parsed.uid}.info`))
      await atomicWrite(landed, bytes, 0o600)
      this.index.absorbed[variantKey][basename(landed)] = sha256(bytes)
      const meta = await this._upsertSnapshot(variantKey, parsed, bytes, 'import')
      if (meta) {
        out.push(meta)
        this._emit('imported', { variantKey, uid: meta.uid, from: abs })
      }
    }
    if (out.length > 0) {
      await this._persist()
      this._emit('changed', { variantKey, reason: 'import' })
    }
    return out
  }

  /** 吸收 import/<v>/ 下尚未处理过的文件（按 sha256 去重）。 */
  async absorbImportDir(variantKey) {
    this._assertLoaded()
    const variant = variantFor(variantKey)
    if (!variant) throw new Error(`unknown variant: ${variantKey}`)
    let names = []
    try {
      names = await fsp.readdir(this.importDir(variantKey))
    } catch {
      return []
    }
    const out = []
    for (const name of names) {
      if (name.startsWith('.') || name.endsWith('.tmp') || name.includes('.tmp-')) continue
      const file = join(this.importDir(variantKey), name)
      const bytes = await readBytesSafe(file)
      if (bytes === undefined) continue
      const digest = sha256(bytes)
      if (this.index.absorbed[variantKey][name] === digest) continue
      const parsed = parseAccountDoc(bytes)
      if (!parsed.ok) {
        this.log.warn(`import 目录里的 ${name} 无法解析（${parsed.error}），跳过`)
        continue
      }
      if (parsed.region !== undefined && parsed.region !== variant.region) {
        this.log.warn(`import 目录里的 ${name} region 不匹配（${parsed.region}），跳过`)
        continue
      }
      const meta = await this._upsertSnapshot(variantKey, parsed, bytes, 'import')
      this.index.absorbed[variantKey][name] = digest
      if (meta) {
        out.push(meta)
        this._emit('imported', { variantKey, uid: meta.uid, from: file })
      }
    }
    if (out.length > 0) {
      await this._persist()
      this._emit('changed', { variantKey, reason: 'import' })
    }
    return out
  }

  /** 供 rotation/pinned 装配与设置卡片展示用。 */
  describeVariants() {
    return POOL_VARIANTS.map((v) => ({
      key: v.key,
      routeId: v.routeId,
      displayName: v.displayName,
      region: v.region,
      env: v.env,
      desktopPath: desktopAuthPath(v.key),
      activePath: this.activeFilePath(v.key),
      activeUid: this.activeUid(v.key),
      accounts: this.list(v.key),
    }))
  }
}

export default WorkBuddyPool
