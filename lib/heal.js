/**
 * 上游目录自愈（R8）。
 *
 * 现象（2026-10-19 实机遇到过一次）：上游 `dsh-workbuddy-connect` 在**启动时**若读不到
 * 凭据，会把自己那一档的模型目录 `setVisible(false)` —— 表现为「模型组存在，但一个模型
 * 都没有」，`status` 里 `models` 字段整条消失、`catalog.source` 停在 `fallback`。
 * 我们的 `WORKBUDDY_*_AUTH_FILE` 环境变量接管与它的启动顺序**不保证**，所以重启后可能复发。
 *
 * 做法：等第一个回环请求到达（那时才知道宿主自己的 origin），读一次上游 status；
 * **只有**在「已登录 + 目录为空 + 拿得到 probeKey」这个确切的坏状态下，才 POST 一次上游
 * 自己的 `{"action":"refresh"}` 探测路由，然后复读一次确认。每档每进程只试一次；
 * 任何失败都静默（不抛、不重试、不影响聊天）。
 *
 * 为什么必须「只在坏状态下动作」：这条路径要戳上游的**内部**路由，升级后可能失效。
 * 好状态下必须零请求，坏状态下才值得冒一次险。
 */

/** 两个档位。与 pool.js 的 `POOL_VARIANTS` 对齐（这里只关心「问上游」的两条路径）。 */
export const HEAL_VARIANT_KEYS = Object.freeze(['cn', 'ai'])

/** 上游自己的两个状态路由（国内版在根、国际版在 `ai/` 前缀下）。 */
export const UPSTREAM_STATUS_PATHS = Object.freeze({
	cn: '/plugins/dsh-workbuddy-connect/status',
	ai: '/plugins/dsh-workbuddy-connect/ai/status'
})

/**
 * 上游自己的两个探测路由。
 *
 * ⚠️ 这是它的内部路由，路径与动作名都可能随升级变化。出处：
 * `dsh-workbuddy-connect/lib/host-heartbeat-*.js` 的 `WORKBUDDY_PROBE_PATH`（:1981）
 * 与 `WORKBUDDY_AI_PROBE_PATH`（:1991）。改动这里的风险由「只在坏状态下才碰它」兜住。
 */
export const UPSTREAM_PROBE_PATHS = Object.freeze({
	cn: '/plugins/dsh-workbuddy-connect/probe',
	ai: '/plugins/dsh-workbuddy-connect/ai/probe'
})

/** 上游要求这个头与它 status 里的 `probeKey` 一致，否则 403 `invalid-probe-key`。 */
export const PROBE_KEY_HEADER = 'x-workbuddy-probe-key'

/** 上游认识的「重抓目录」动作。 */
export const HEAL_ACTION = 'refresh'

export const HEAL_DEFAULTS = Object.freeze({
	enabled: true,
	timeoutMs: 15_000
})

export const HEAL_REASONS = Object.freeze({
	disabled: 'disabled',
	noFetch: 'fetch-missing',
	unknownVariant: 'unknown-variant',
	noOrigin: 'origin-missing',
	alreadyAttempted: 'already-attempted',
	statusUnreadable: 'status-unreadable',
	notSignedIn: 'not-signed-in',
	catalogNotEmpty: 'catalog-not-empty',
	noProbeKey: 'probe-key-missing',
	probeRejected: 'probe-rejected',
	stillEmpty: 'still-empty',
	error: 'error'
})

function isRecord(value) {
	return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

function safeMessage(error) {
	if (error === null || error === undefined) return ''
	if (typeof error === 'string') return error
	const message = error.message
	return typeof message === 'string' ? message : String(error)
}

/** 上游 status 的「是否已登录」。字段名就是 `status`（值 `signed-in`）。 */
export function isSignedIn(status) {
	return isRecord(status) && status.status === 'signed-in'
}

/** 目录里现在有几个模型。字段缺失也算 0 —— 那正是「组被隐藏」的样子。 */
export function catalogModelCount(status) {
	const models = isRecord(status) ? status.models : undefined
	return Array.isArray(models) ? models.length : 0
}

/** 上游 status 里的 `probeKey`。拿不到就没法调探测路由，也就没法自愈。 */
export function probeKeyOf(status) {
	const key = isRecord(status) ? status.probeKey : undefined
	if (typeof key !== 'string') return null
	const trimmed = key.trim()
	return trimmed === '' ? null : trimmed
}

/**
 * 唯一的判据：**确切的坏状态**才返回 true。
 *
 * 四个条件缺一不可：已登录（有凭据可抓）、目录为空（真的坏了）、拿得到 probeKey
 * （有办法调）、payload 是可读对象。任何一条不满足就什么都不做。
 */
export function shouldHeal(status) {
	if (isRecord(status) === false) return false
	if (isSignedIn(status) === false) return false
	if (catalogModelCount(status) > 0) return false
	if (probeKeyOf(status) === null) return false
	return true
}

/**
 * 为什么不自愈。仅供日志与测试断言（`shouldHeal` 是唯一判据，这里只是把原因说出来）。
 */
export function healBlockReason(status) {
	if (isRecord(status) === false) return HEAL_REASONS.statusUnreadable
	if (isSignedIn(status) === false) return HEAL_REASONS.notSignedIn
	if (catalogModelCount(status) > 0) return HEAL_REASONS.catalogNotEmpty
	if (probeKeyOf(status) === null) return HEAL_REASONS.noProbeKey
	return null
}

/** `http://<origin><path>`，并挡住 origin 里塞进别的 scheme/路径的情况。 */
export function urlFor(origin, path) {
	if (typeof origin !== 'string' || origin.trim() === '') return null
	if (typeof path !== 'string' || path.startsWith('/') === false) return null
	const trimmed = origin.trim()
	if (/^[a-z0-9.\-:[\]]+$/i.test(trimmed) === false) return null
	return `http://${trimmed}${path}`
}

/**
 * 目录自愈器。**没有定时器、没有后台循环** —— 只在被显式调用时动一次。
 *
 * 依赖全部注入（`fetchImpl` / `now` / `logger`），因此可以在没有真实网络的测试里跑；
 * 不认识 DSH 的 ctx，也不读磁盘。
 */
export class CatalogHealer {
	#fetchImpl
	#now
	#log
	#config
	/**
	 * variantKey -> `{promise, result}`；一旦开过就不再重开（每档每进程一次）。
	 *
	 * 两者都要存：`promise` 用于幂等（同时到两个请求时只能跑一次），`result` 用于
	 * `status()`。早先只存 promise 并读 `promise.__result`，而那个属性从没人写过 ——
	 * 于是 status 里永远是 `{pending:true}`。写测试时才发现的。
	 */
	#attempts = new Map()

	constructor({ fetchImpl, now, logger, config } = {}) {
		this.#fetchImpl = fetchImpl
		this.#now = typeof now === 'function' ? now : () => Date.now()
		this.#log = logger
		const raw = isRecord(config) ? config : {}
		this.#config = {
			enabled: raw.enabled !== false,
			timeoutMs:
				typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
					? raw.timeoutMs
					: HEAL_DEFAULTS.timeoutMs
		}
	}

	get enabled() {
		return this.#config.enabled
	}

	/** 只读摘要，进 status 用。绝不包含凭据。 */
	status() {
		const attempted = {}
		for (const [variantKey, entry] of this.#attempts) {
			attempted[variantKey] = entry.result ?? { pending: true }
		}
		return { enabled: this.#config.enabled, attempted }
	}

	/**
	 * 触发一次（幂等）。**同步返回，绝不抛** —— 调用点在请求处理路径上，
	 * 不能让自愈失败污染任何真实请求。
	 */
	maybeHeal({ variantKey, origin } = {}) {
		if (this.#config.enabled === false) return null
		if (HEAL_VARIANT_KEYS.includes(variantKey) === false) return null
		if (typeof origin !== 'string' || origin.trim() === '') return null
		const existing = this.#attempts.get(variantKey)
		if (existing !== undefined) return existing.promise
		const entry = { promise: undefined, result: undefined }
		// heal() 契约上永不 reject，所以只需要 then；（真出意外也在里面被 catch 住了）
		entry.promise = this.heal({ variantKey, origin }).then((result) => {
			entry.result = result
			return result
		})
		this.#attempts.set(variantKey, entry)
		return entry.promise
	}

	/**
	 * 真正干活的那一次。返回结构化结果，**永不抛**。
	 *
	 * @returns {Promise<{variantKey: string, attempted: boolean, healed: boolean,
	 *   models: number|null, reason: string|null, error?: string}>}
	 */
	async heal({ variantKey, origin } = {}) {
		const base = { variantKey, attempted: false, healed: false, models: null, reason: null }
		if (this.#config.enabled === false) return { ...base, reason: HEAL_REASONS.disabled }
		if (HEAL_VARIANT_KEYS.includes(variantKey) === false) {
			return { ...base, reason: HEAL_REASONS.unknownVariant }
		}
		if (typeof this.#fetchImpl !== 'function') return { ...base, reason: HEAL_REASONS.noFetch }
		const statusUrl = urlFor(origin, UPSTREAM_STATUS_PATHS[variantKey])
		const probeUrl = urlFor(origin, UPSTREAM_PROBE_PATHS[variantKey])
		if (statusUrl === null || probeUrl === null) {
			return { ...base, reason: HEAL_REASONS.noOrigin }
		}

		try {
			const before = await this.#readStatus(statusUrl)
			if (shouldHeal(before) === false) {
				return { ...base, reason: healBlockReason(before) ?? HEAL_REASONS.statusUnreadable }
			}
			const probeKey = probeKeyOf(before)
			const rejected = await this.#postRefresh(probeUrl, probeKey)
			if (rejected !== null) {
				this.#warn(`目录自愈被上游拒绝（${variantKey}）：${rejected}`)
				return { ...base, attempted: true, reason: HEAL_REASONS.probeRejected }
			}
			const after = await this.#readStatus(statusUrl)
			const models = catalogModelCount(after)
			if (models > 0) {
				this.#info(`目录自愈成功（${variantKey}）：${models} 个模型`)
				return { variantKey, attempted: true, healed: true, models, reason: null }
			}
			this.#warn(`目录自愈后仍为空（${variantKey}）`)
			// 把量到的数也带上：0 比 null 更能说明「真的复读过了」
			return { ...base, attempted: true, models, reason: HEAL_REASONS.stillEmpty }
		} catch (error) {
			this.#warn(`目录自愈失败（${variantKey}）：${safeMessage(error)}`)
			return { ...base, attempted: true, reason: HEAL_REASONS.error, error: safeMessage(error) }
		}
	}

	async #readStatus(url) {
		const response = await this.#fetchImpl(url, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(this.#config.timeoutMs)
		})
		if (response === null || typeof response !== 'object') return null
		if (response.ok !== true) return null
		const body = await response.json()
		return isRecord(body) ? body : null
	}

	/** 返回 null 表示上游接受了；返回字符串表示拒绝原因。 */
	async #postRefresh(url, probeKey) {
		const response = await this.#fetchImpl(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				[PROBE_KEY_HEADER]: probeKey
			},
			body: JSON.stringify({ action: HEAL_ACTION }),
			signal: AbortSignal.timeout(this.#config.timeoutMs)
		})
		if (response === null || typeof response !== 'object') return 'unreadable-response'
		if (response.ok === true) return null
		const status = typeof response.status === 'number' ? response.status : 'unknown'
		return `http-${status}`
	}

	#info(message) {
		try {
			this.#log?.info?.(message)
		} catch {
			/* 日志本身抛不能让自愈失败冒泡 */
		}
	}

	#warn(message) {
		try {
			this.#log?.warn?.(message)
		} catch {
			/* 同上 */
		}
	}
}

export default CatalogHealer
