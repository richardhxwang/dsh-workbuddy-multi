/**
 * dsh-workbuddy-multi — 推理档位按「版本 + 模型」共享
 *
 * 上游 dsh-workbuddy-connect 的检测记录（~/.dsh/.workbuddy[-ai]-probe.json）是
 * 按账号存的：换一个没检测过的账号，模型选择器里的推理档位就消失，输入框右侧又
 * 冒出「推理等级」按钮。本模块在不改上游任何文件的前提下接管这件事：
 *
 *   1. 只读上游的 probe 文件与已保存目录（catalog），把同一版本（目录指纹一致）
 *      同一模型在**任意账号**下得到的已确认结果汇总出来；
 *   2. 通过 `ctx.llm.adapters`（宿主 llm 注册表的公开字段）拿到上游 adapter 实例，
 *      包装其 `profile.piProvider.getModels`（普通自有属性，pi-ai 每次读取都现调），
 *      给「会思考但当前账号没记录」的模型注入汇总出的档位 —— listModels /
 *      resolveModel / prepareCall 都走这条路，一处注入全部生效；
 *   3. 客户端拿 status 里的汇总清单，把上游输入框按钮的可见性依据
 *      （status 路由的 probe.candidates / probe.results）里已知的模型过滤掉，
 *      按钮就此消失；重新检测入口挪到本插件的设置卡片里。
 *
 * 设计约束：
 *   - 只读不写上游文件（写会被上游的内存副本覆盖）；
 *   - 上游内部结构（adapter.config.profiles()…）可能变：每一步访问都兜底，
 *     包装不上就降级成「只汇总、不注入」，绝不影响聊天链路；
 *   - 上游的语义逐条保留：声明了 supportedEfforts 的模型永远不看检测记录；
 *     记录有过期（14 天）与目录指纹两重有效期；non-validating 只表示
 *     「上游不校验参数」，不注入档位。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

/** 与上游 WorkBuddyProbeStore 的 DEFAULT_TTL_MS 一致：14 天。 */
export const REASONING_TTL_MS = 12096e5

/** 上游 probe 文件格式版本（v2 起按账号嵌套）；不一致时整份文件按「没有记录」读。 */
const PROBE_FORMAT_VERSION = 2

/**
 * 已包装标记。挂在上游 adapter 的 piProvider 对象上：同一进程里重复包装
 * （事件重入、测试连跑）靠它幂等；值里带着还原函数，关闭功能时能干净卸下。
 */
const WRAP_MARK = Symbol.for('dsh-workbuddy-multi:reasoning-wrap')

/**
 * 兜底 variant 表：与上游 WORKBUDDY_VARIANTS 对齐。
 * 上游模块可用时一律用上游的真值（文件名将来若变，跟得上）；这里只是加载不到时的备份。
 */
const FALLBACK_VARIANTS = [
  {
    key: 'cn',
    routeId: 'workbuddy',
    region: 'cn',
    probeFilename: '.workbuddy-probe.json',
    catalogFilename: '.workbuddy-catalog.json',
  },
  {
    key: 'ai',
    routeId: 'workbuddy-ai',
    region: 'global',
    probeFilename: '.workbuddy-ai-probe.json',
    catalogFilename: '.workbuddy-ai-catalog.json',
  },
]

/** DSH 家目录：跟上游 resolveDshHome 同一优先级（$DSH_HOME，然后 ~/.dsh）。 */
function dshHome() {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh')
}

/**
 * 上游 fingerprintModel 的逐字复刻：只对「检测依赖的目录字段」取指纹，
 * 改名、促销徽标、上下文窗口变化都不会作废已有记录。
 * 上游模块在时用上游的原函数（见 constructor），这里只是离线兜底。
 */
function fingerprintModelLocal(info) {
  const basis = JSON.stringify({
    id: info.id,
    reasoning: info.reasoning ?? null,
    supportsImages: info.supportsImages ?? null,
  })
  return createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

/** 上游 isProbeCandidate 的同义判据：会思考、但没声明可选档位。 */
function isProbeCandidate(info) {
  if (info?.reasoning?.supports !== true) return false
  return (info.reasoning.supportedEfforts?.length ?? 0) === 0
}

/**
 * 「按惯例提供档位」的模型族：目录声明了它会思考且给了默认档（defaultEffort），
 * 但没有 supportedEfforts 列表。端点对 effort 值不校验（探测只能报 non-validating），
 * 而实测档位是生效的（见 overrideModel 注释）。
 */
function isConventionalReasoner(info) {
  if (!isProbeCandidate(info)) return false
  const reasoning = info.reasoning ?? {}
  return typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort !== ''
}

/** 惯例档位：实测过行为分级的四档（xhigh 未观察到进一步增强，不提供）。 */
const CONVENTIONAL_EFFORTS = ['low', 'medium', 'high', 'max']

/** 上游 isRecord 的同型校验：坏行丢弃而不是信任。 */
function isProbeRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { validation, fingerprint, probedAtMs, pluginVersion, account, efforts } = value
  if (validation !== 'validating' && validation !== 'non-validating' && validation !== 'unknown') return false
  if (typeof fingerprint !== 'string') return false
  if (typeof probedAtMs !== 'number' || !Number.isFinite(probedAtMs)) return false
  if (typeof pluginVersion !== 'string') return false
  if (typeof account !== 'string' || account === '') return false
  if (!Array.isArray(efforts) || efforts.some((e) => typeof e !== 'string')) return false
  return true
}

/** 读一份 probe 文件；不存在、坏 JSON、版本不符都读成空表。 */
function readProbeFile(path) {
  if (!existsSync(path)) return new Map()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return new Map()
  }
  if (typeof parsed !== 'object' || parsed === null || parsed.version !== PROBE_FORMAT_VERSION) return new Map()
  const records = parsed.records
  if (typeof records !== 'object' || records === null || Array.isArray(records)) return new Map()
  const out = new Map()
  for (const [account, perModel] of Object.entries(records)) {
    if (typeof perModel !== 'object' || perModel === null || Array.isArray(perModel)) continue
    for (const [modelId, record] of Object.entries(perModel)) {
      if (!isProbeRecord(record)) continue
      if (!out.has(modelId)) out.set(modelId, [])
      out.get(modelId).push(record)
    }
  }
  return out
}

/**
 * 读一份已保存目录：文件是 `{version, entries: {account: SavedCatalog}}` —— 按账号
 * 各存一份（不同账号的目录可能不同）。返回 Map<account, {fetchedAtMs, rows: Map<id, info>}>；
 * 坏文件读成空。
 */
function readCatalogFile(path) {
  const out = new Map()
  if (!existsSync(path)) return out
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return out
  }
  const entries = parsed?.entries
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return out
  for (const [account, saved] of Object.entries(entries)) {
    const models = saved?.models
    if (!Array.isArray(models)) continue
    const rows = new Map()
    for (const info of models) {
      if (typeof info !== 'object' || info === null || typeof info.id !== 'string') continue
      rows.set(info.id, info)
    }
    out.set(account, {
      fetchedAtMs: typeof saved.fetchedAtMs === 'number' ? saved.fetchedAtMs : 0,
      rows,
    })
  }
  return out
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 按上游 reasoningFields 的规则，用「观察到的档位」重建 pi 描述符的推理字段。
 * 走到这里时目录必然没声明 supportedEfforts（否则上游自己早就用了），
 * 所以 off 恒为 null —— 与上游对 observed 记录的处理一致。
 */
function observedReasoningFields(info, efforts, region) {
  const reasoning = info.reasoning ?? {}
  return {
    reasoning: true,
    thinkingLevelMap: {
      off:
        reasoning.canDisableThinking === true &&
        (region !== 'cn' || reasoning.onlyReasoning !== true) &&
        (reasoning.supportedEfforts?.length ?? 0) > 0
          ? 'off'
          : null,
      minimal: null,
      low: efforts.includes('low') ? 'low' : null,
      medium: efforts.includes('medium') ? 'medium' : null,
      high: efforts.includes('high') ? 'high' : null,
      xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
      max: efforts.includes('max') ? 'max' : null,
    },
  }
}

export class ReasoningShare {
  /**
   * @param options.ctx cordis 上下文（读 `llm.adapters`、发 `llm/adapters-updated`）
   * @param options.pool 账号池（拿当前生效账号，汇总时优先它的记录）
   * @param options.enabled 总开关（运行时可用 setEnabled 改）
   * @param options.upstreamModule 已加载的上游模块，或返回它的函数
   *   （取 WORKBUDDY_VARIANTS / fingerprintModel；函数形式能在上游后加载时也拿到真值）
   * @param options.home DSH 家目录覆盖（测试用）
   */
  constructor({ ctx, pool, logger, now, enabled = true, upstreamModule, home } = {}) {
    this.ctx = ctx
    this.pool = pool
    this.logger = logger
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.enabled = enabled !== false
    this.home = typeof home === 'string' && home !== '' ? home : dshHome()
    this.resolveUpstream =
      typeof upstreamModule === 'function' ? upstreamModule : () => upstreamModule

    /** 每个 variant 的文件快照：mtime 没变就不重读。 */
    this.files = new Map()
    /** 已包装的 routeId 集合。 */
    this.wrapped = new Set()
    /** 上次注入生效的模型签名（变了才广播 adapters-updated）。 */
    this.lastInjectedSignature = ''
    /** adapters-updated 的合并广播定时器（见 announceIfChanged 的防抖说明）。 */
    this.announceTimer = undefined
    this.timer = undefined
    this.detach = []
    this.notes = []
    this.stopped = false
    /**
     * 可选追加钩子（上下文选档用）：(variantKey, models) => models。
     * 在每个模型的档位注入之后、返回之前调用。
     */
    this.augment = undefined
    /** refresh() 跑完后的钩子（上下文选档的派生表重建挂在上面）。 */
    this.afterRefresh = undefined
  }

  /** variant 表：上游模块给了 WORKBUDDY_VARIANTS 就用真值，否则用兜底表。 */
  variants() {
    const mod = this.resolveUpstream()
    const upstream = Array.isArray(mod?.WORKBUDDY_VARIANTS) ? mod.WORKBUDDY_VARIANTS : []
    return FALLBACK_VARIANTS.map((fallback) => {
      const real = upstream.find((v) => v?.id === fallback.routeId)
      return {
        key: fallback.key,
        routeId: fallback.routeId,
        region: typeof real?.region === 'string' ? real.region : fallback.region,
        probeFilename:
          typeof real?.probeFilename === 'string' ? real.probeFilename : fallback.probeFilename,
        catalogFilename:
          typeof real?.catalogFilename === 'string' ? real.catalogFilename : fallback.catalogFilename,
      }
    })
  }

  fingerprint(info) {
    const fn = this.resolveUpstream()?.fingerprintModel
    return typeof fn === 'function' ? fn(info) : fingerprintModelLocal(info)
  }

  /** 重新读取 mtime 变过的文件；任何一步失败都只留空表，绝不抛出。 */
  refresh() {
    for (const variant of this.variants()) {
      const probePath = join(this.home, variant.probeFilename)
      const catalogPath = join(this.home, variant.catalogFilename)
      const probeMtime = mtimeOf(probePath)
      const catalogMtime = mtimeOf(catalogPath)
      const cached = this.files.get(variant.key)
      if (
        cached !== undefined &&
        cached.probeMtime === probeMtime &&
        cached.catalogMtime === catalogMtime
      ) {
        continue
      }
      let records = new Map()
      let catalogs = new Map()
      try {
        records = readProbeFile(probePath)
        catalogs = readCatalogFile(catalogPath)
      } catch (error) {
        this.logger?.warn?.(`推理档位缓存读取失败（${variant.key}）：${String(error)}`)
      }
      this.files.set(variant.key, { probeMtime, catalogMtime, records, catalogs })
    }
    try {
      this.afterRefresh?.()
    } catch {
      /* 追加钩子的失败不拖累主流程 */
    }
  }

  /**
   * 一个 variant 的目录行并集（同名模型取保存最新的一份）——上下文选档的输入。
   */
  rowsFor(variantKey) {
    const files = this.files.get(variantKey)
    if (files === undefined) return []
    const byId = new Map()
    const entries = [...files.catalogs.values()].sort((a, b) => a.fetchedAtMs - b.fetchedAtMs)
    for (const entry of entries) {
      for (const [id, info] of entry.rows) byId.set(id, info)
    }
    return [...byId.values()]
  }

  /**
   * 一个模型的「主目录行」：生效账号自己那份目录优先（它最接近上游当前在服务的
   * 目录），没有就取保存时间最新的一份。候选判定与注入用的 reasoning 形状都出自它。
   */
  primaryRow(variantKey, modelId) {
    const files = this.files.get(variantKey)
    if (files === undefined) return undefined
    const activeUid = this.activeUid(variantKey)
    if (activeUid !== undefined) {
      for (const [account, entry] of files.catalogs) {
        if (account.startsWith(`${activeUid}:`) && entry.rows.has(modelId)) return entry.rows.get(modelId)
      }
    }
    let newest
    for (const entry of files.catalogs.values()) {
      if (!entry.rows.has(modelId)) continue
      if (newest === undefined || entry.fetchedAtMs > newest.fetchedAtMs) newest = entry
    }
    return newest?.rows.get(modelId)
  }

  /**
   * 一个模型在当前版本下的汇总记录：跨账号挑一条「决定性」记录
   * （validating 且带档位，或 non-validating），生效账号的优先，其余取最新。
   * unknown 只是「没测完」，永远不算数。
   *
   * 指纹校验按**产生记录的那个账号自己的目录行**做（它当时看到的是什么形状），
   * 该行不在时再退回主目录行 —— 与上游「换目录形状就重测」的纪律一致。
   */
  aggregateFor(variantKey, modelId) {
    const files = this.files.get(variantKey)
    if (files === undefined) return undefined
    const primary = this.primaryRow(variantKey, modelId)
    if (!isProbeCandidate(primary)) return undefined
    const now = this.now()
    const decisive = (files.records.get(modelId) ?? []).filter((record) => {
      if (now - record.probedAtMs > REASONING_TTL_MS) return false
      if (record.validation === 'non-validating') {
        // non-validating 也是决定性答案（上游不校验参数），同样要过指纹校验
      } else if (record.validation === 'validating' && record.efforts.length > 0) {
        // validating 且带档位
      } else {
        return false
      }
      const row = files.catalogs.get(record.account)?.rows.get(modelId) ?? primary
      try {
        return this.fingerprint(row) === record.fingerprint
      } catch {
        return false
      }
    })
    if (decisive.length === 0) return undefined
    const activeUid = this.activeUid(variantKey)
    const own =
      activeUid === undefined
        ? undefined
        : decisive.find((record) => record.account.startsWith(`${activeUid}:`))
    const picked =
      own ?? decisive.reduce((a, b) => (a.probedAtMs >= b.probedAtMs ? a : b), decisive[0])
    return {
      validation: picked.validation,
      efforts: picked.efforts,
      probedAtMs: picked.probedAtMs,
      account: picked.account,
      fingerprint: picked.fingerprint,
      shared: own === undefined,
    }
  }

  activeUid(variantKey) {
    try {
      return this.pool?.activeUid?.(variantKey)
    } catch {
      return undefined
    }
  }

  /**
   * 注入点：上游 buildModels() 产出的一个 pi 描述符，缺档位时补上。
   * 两类来源：
   *   1. 汇总缓存里 validating 的检测记录（实测各档被拒/被收的证据）；
   *   2. 目录自己声明「会思考但档位固定」的模型（supports + defaultEffort、无
   *      supportedEfforts）：端点对 effort 不校验（探测只能报 non-validating），
   *      但实测 reasoning_effort 是真生效的（2026-10-20 kimi-k3 实测 low/medium/high/max
   *      四档的思考量 133/205/301/400 递增；xhigh 无进一步增强，故不提供）。
   *      这一类按惯例注入 low/medium/high/max 四档。
   * 上游自己已经给了档位的（reasoning === true）原样放行。
   */
  overrideModel(variant, model) {
    if (!this.enabled) return model
    if (typeof model !== 'object' || model === null || model.reasoning === true) return model
    const record = this.aggregateFor(variant.key, model.id)
    if (record !== undefined && record.validation === 'validating') {
      const info = this.primaryRow(variant.key, model.id)
      return { ...model, ...observedReasoningFields(info, record.efforts, variant.region) }
    }
    const info = this.primaryRow(variant.key, model.id)
    if (isConventionalReasoner(info)) {
      return { ...model, ...observedReasoningFields(info, CONVENTIONAL_EFFORTS, variant.region) }
    }
    return model
  }

  /**
   * 包装上游 adapter 的 piProvider.getModels。上游 adapter 的注册晚于本插件
   * 启动是常态（它要等 shim 起监听），所以这里幂等、可重试：已包装的跳过，
   * 结构对不上的记一笔降级说明，绝不抛出。
   */
  ensureWrapped() {
    if (this.stopped) return
    const adapters = this.ctx?.llm?.adapters
    if (adapters === undefined || adapters === null || typeof adapters.get !== 'function') return
    for (const variant of this.variants()) {
      if (this.wrapped.has(variant.routeId)) continue
      let registration
      try {
        registration = adapters.get(variant.routeId)
      } catch {
        continue
      }
      if (registration === undefined) continue
      const adapter = registration.adapter ?? registration
      let piProvider
      try {
        piProvider = adapter?.config?.profiles?.()?.get(variant.routeId)?.piProvider
      } catch {
        piProvider = undefined
      }
      if (piProvider === undefined || piProvider === null) {
        if (adapter !== undefined && !this.notes.includes(`wrap-shape-${variant.key}`)) {
          this.notes.push(`wrap-shape-${variant.key}`)
          this.logger?.warn?.(
            `推理档位共享：上游 ${variant.routeId} 的 adapter 结构变了，档位注入停用（检测汇总仍然可用）`,
          )
        }
        continue
      }
      const existing = piProvider[WRAP_MARK]
      if (existing !== undefined) {
        if (existing.owner === this) {
          // 本实例已包过：幂等跳过，绝不叠包。
          this.wrapped.add(variant.routeId)
          continue
        }
        // 上一个实例（热重载前的模块）留下的闭包拿着旧数据：先还原，再包新的。
        try {
          existing.restore?.()
        } catch {
          /* 还原失败也继续包，新包装直接盖住旧函数 */
        }
      }
      const original = piProvider.getModels
      if (typeof original !== 'function') continue
      const self = this
      piProvider.getModels = function wrappedGetModels() {
        const models = original.call(this)
        if (!Array.isArray(models)) return models
        let out = models.map((model) => self.overrideModel(variant, model))
        if (typeof self.augment === 'function') {
          try {
            const augmented = self.augment(variant.key, out)
            if (Array.isArray(augmented)) out = augmented
          } catch {
            /* 追加失败不影响原列表 */
          }
        }
        return out
      }
      piProvider[WRAP_MARK] = {
        owner: this,
        restore: () => {
          if (piProvider.getModels?.name === 'wrappedGetModels') piProvider.getModels = original
          try {
            delete piProvider[WRAP_MARK]
          } catch {
            /* 标记删不掉时留着也无害：owner 已对不上，下次会被还原重包 */
          }
        },
      }
      this.wrapped.add(variant.routeId)
      this.logger?.info?.(`推理档位共享：已接入上游 ${variant.routeId} 的模型目录`)
    }
    this.announceIfChanged()
  }

  /** 这个 variant 当前所有「可检测」的模型 id（按主目录行判定，各账号目录取并集）。 */
  candidateIds(variantKey) {
    const files = this.files.get(variantKey)
    if (files === undefined) return []
    const ids = new Set()
    for (const entry of files.catalogs.values()) {
      for (const id of entry.rows.keys()) ids.add(id)
    }
    return [...ids].filter((id) => isProbeCandidate(this.primaryRow(variantKey, id)))
  }

  /** 注入结果集变了才广播一次 adapters-updated，让选择器重新拉模型。 */
  announceIfChanged() {
    const parts = []
    if (this.enabled) {
      for (const variant of this.variants()) {
        for (const id of this.candidateIds(variant.key)) {
          const record = this.aggregateFor(variant.key, id)
          if (record?.validation === 'validating') parts.push(`${variant.routeId}:${id}`)
        }
      }
    }
    const signature = parts.sort().join('|')
    if (signature === this.lastInjectedSignature) return
    this.lastInjectedSignature = signature
    if (signature === '') return
    /*
     * 「全部检测」时上游每个模型完成都会写一次 probe 文件，签名跟着一变再变。
     * 不变防抖的话宿主 UI 会收到一串 llm/adapters-updated（设置页那一面会整个跟着重排，
     * 用户看到的是「页面被滚到最上面」）。聚成一次末尾广播：2s 静默窗口后只发一次。
     */
    if (this.announceTimer !== undefined) clearTimeout(this.announceTimer)
    this.announceTimer = setTimeout(() => {
      this.announceTimer = undefined
      try {
        this.ctx?.emit?.('llm/adapters-updated')
      } catch {
        /* 广播失败只意味着选择器晚些刷新 */
      }
    }, 2_000)
    this.announceTimer.unref?.()
  }

  /**
   * 启动：先包一次，然后每 5s 重试没包上的 + 重读变过的文件。
   * `llm/adapters-updated` 是上游注册完成的信号，收到立刻补包。
   */
  start() {
    if (this.stopped || this.timer !== undefined) return
    this.refresh()
    this.ensureWrapped()
    const onUpdated = () => {
      try {
        this.refresh()
        this.ensureWrapped()
      } catch {
        /* 见 ensureWrapped 的降级纪律 */
      }
    }
    if (typeof this.ctx?.on === 'function') {
      const off = this.ctx.on('llm/adapters-updated', onUpdated)
      if (typeof off === 'function') this.detach.push(off)
    }
    this.timer = setInterval(() => {
      try {
        this.refresh()
        if (this.enabled) this.ensureWrapped()
        else this.announceIfChanged()
      } catch {
        /* 定时器里绝不抛出 */
      }
    }, 5_000)
    this.timer.unref?.()
  }

  /** 运行时开关；关闭时把所有包装干净卸下，并广播一次让选择器回到上游原生行为。 */
  setEnabled(on) {
    const next = on !== false
    if (next === this.enabled) return this.enabled
    this.enabled = next
    if (!next) {
      for (const variant of this.variants()) {
        const adapters = this.ctx?.llm?.adapters
        let piProvider
        try {
          const registration = adapters?.get?.(variant.routeId)
          const adapter = registration?.adapter ?? registration
          piProvider = adapter?.config?.profiles?.()?.get(variant.routeId)?.piProvider
        } catch {
          piProvider = undefined
        }
        try {
          piProvider?.[WRAP_MARK]?.restore?.()
        } catch {
          /* 单个还原失败不拖累其它 variant */
        }
        this.wrapped.delete(variant.routeId)
      }
    } else {
      this.refresh()
      this.ensureWrapped()
    }
    this.lastInjectedSignature = ''
    this.announceIfChanged()
    try {
      this.ctx?.emit?.('llm/adapters-updated')
    } catch {
      /* 同上 */
    }
    return this.enabled
  }

  /** 设置卡片 / 客户端过滤用的只读摘要。 */
  status() {
    if (this.enabled !== true) {
      return { enabled: false, ttlMs: REASONING_TTL_MS, variants: {} }
    }
    const variants = {}
    for (const variant of this.variants()) {
      const models = []
      for (const id of this.candidateIds(variant.key)) {
        const record = this.aggregateFor(variant.key, id)
        if (record === undefined) continue
        const row = this.primaryRow(variant.key, id)
        models.push({
          id,
          name: typeof row?.name === 'string' ? row.name : id,
          validation: record.validation,
          efforts: record.efforts,
          probedAtMs: record.probedAtMs,
          account: record.account,
          shared: record.shared,
        })
      }
      variants[variant.key] = {
        routeId: variant.routeId,
        wrapped: this.wrapped.has(variant.routeId),
        models,
      }
    }
    return { enabled: true, ttlMs: REASONING_TTL_MS, variants }
  }

  stop() {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.announceTimer !== undefined) clearTimeout(this.announceTimer)
    for (const off of this.detach) {
      try {
        off()
      } catch {
        /* 卸载时忽略单个监听器的异常 */
      }
    }
    this.detach = []
    // 卸下包装，把上游 adapter 还给上游。
    if (this.enabled) this.setEnabled(false)
    this.wrapped.clear()
  }
}
