/**
 * `lib/heal.js` 的单元测试：目录自愈（R8）。
 *
 * 这个模块的全部风险都在**「什么时候不许动手」**上 —— 它戳的是上游的内部路由，
 * 所以绝大多数用例断言的是「一次请求都没发」或「只发了一次 status」。
 * 依赖全部注入，所以这里没有任何真实网络。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
	CatalogHealer,
	HEAL_ACTION,
	HEAL_DEFAULTS,
	HEAL_REASONS,
	HEAL_VARIANT_KEYS,
	PROBE_KEY_HEADER,
	UPSTREAM_PROBE_PATHS,
	UPSTREAM_STATUS_PATHS,
	catalogModelCount,
	healBlockReason,
	isSignedIn,
	probeKeyOf,
	shouldHeal,
	urlFor
} from '../lib/heal.js'

const ORIGIN = '127.0.0.1:59277'
const PROBE_KEY = '2715418b060e8086c121e77eaa9b64c916474dee6568e34f'

/** 上游 status 的一个「已登录、目录里有 n 个模型」的样子。 */
function statusWith({ models = 0, probeKey = PROBE_KEY, signedIn = true, extra = {} } = {}) {
	const doc = { status: signedIn ? 'signed-in' : 'signed-out', ...extra }
	if (models > 0) doc.models = Array.from({ length: models }, (_, i) => ({ id: `m${i}` }))
	if (probeKey !== null) doc.probeKey = probeKey
	return doc
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
	return { ok, status, json: async () => body }
}

/**
 * 记录每一次 fetch 的假实现。
 *
 * `statuses` 是**按顺序**喂给每次 status GET 的返回值（用完之后重复最后一个），
 * 用来表达「自愈前空、自愈后满」这种两次读状态不同的情形。`probe` 决定 POST 的回应。
 */
function makeFetch({ statuses = [statusWith()], probe = { ok: true, status: 200 } } = {}) {
	const calls = []
	let statusReads = 0
	const fetchImpl = async (url, init = {}) => {
		calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })
		const isProbe = String(url).includes('/probe')
		if (isProbe) {
			if (typeof probe === 'function') return probe(url, init)
			return jsonResponse({ state: 'refreshed' }, probe)
		}
		const picked = statuses[Math.min(statusReads, statuses.length - 1)]
		statusReads += 1
		if (typeof picked === 'function') return picked(url, init)
		return jsonResponse(picked)
	}
	return { fetchImpl, calls, posts: () => calls.filter((c) => c.method === 'POST') }
}

function makeHealer(options = {}) {
	const logs = []
	const logger = {
		info: (m) => logs.push({ level: 'info', message: m }),
		warn: (m) => logs.push({ level: 'warn', message: m })
	}
	const healer = new CatalogHealer({ fetchImpl: options.fetchImpl, logger, config: options.config })
	return { healer, logs }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('urlFor：只接受「主机[:端口]」形状的 origin，且 path 必须以 / 开头', () => {
	assert.equal(urlFor(ORIGIN, '/x'), `http://${ORIGIN}/x`)
	assert.equal(urlFor(` ${ORIGIN} `, '/x'), `http://${ORIGIN}/x`)
	assert.equal(urlFor('127.0.0.1:59277', '/a/b'), 'http://127.0.0.1:59277/a/b')

	// origin 里塞进 scheme 或路径就会被拼成别的地址 —— 必须挡住。
	assert.equal(urlFor('http://evil.example', '/x'), null)
	assert.equal(urlFor('evil.example/x', '/x'), null)
	assert.equal(urlFor('evil.example/../x', '/x'), null)
	assert.equal(urlFor('', '/x'), null)
	assert.equal(urlFor('   ', '/x'), null)
	assert.equal(urlFor(undefined, '/x'), null)
	assert.equal(urlFor(123, '/x'), null)
	// path 不合法
	assert.equal(urlFor(ORIGIN, 'x'), null)
	assert.equal(urlFor(ORIGIN, ''), null)
	assert.equal(urlFor(ORIGIN, undefined), null)
})

test('isSignedIn / catalogModelCount / probeKeyOf：上游 status 的三个读法', () => {
	assert.equal(isSignedIn(statusWith()), true)
	assert.equal(isSignedIn(statusWith({ signedIn: false })), false)
	assert.equal(isSignedIn(null), false)
	assert.equal(isSignedIn('signed-in'), false)
	assert.equal(isSignedIn([]), false)

	// 字段缺失就是 0 —— 那正是「组被隐藏」的样子。
	assert.equal(catalogModelCount(statusWith({ models: 0 })), 0)
	assert.equal(catalogModelCount({}), 0)
	assert.equal(catalogModelCount({ models: null }), 0)
	assert.equal(catalogModelCount({ models: 'nope' }), 0)
	assert.equal(catalogModelCount(statusWith({ models: 3 })), 3)

	assert.equal(probeKeyOf({ probeKey: PROBE_KEY }), PROBE_KEY)
	assert.equal(probeKeyOf({ probeKey: ` ${PROBE_KEY} ` }), PROBE_KEY)
	assert.equal(probeKeyOf({ probeKey: '' }), null)
	assert.equal(probeKeyOf({ probeKey: '   ' }), null)
	assert.equal(probeKeyOf({ probeKey: 42 }), null)
	assert.equal(probeKeyOf({}), null)
	assert.equal(probeKeyOf(null), null)
})

test('shouldHeal：四个条件缺一不可（这是全模块唯一的判据）', () => {
	assert.equal(shouldHeal(statusWith({ models: 0 })), true)

	// 每个条件各自被打破一次，都必须为 false。
	assert.equal(shouldHeal(statusWith({ models: 0, signedIn: false })), false, '未登录不许动')
	assert.equal(shouldHeal(statusWith({ models: 1 })), false, '目录非空不许动')
	assert.equal(shouldHeal(statusWith({ models: 19 })), false, '目录非空不许动')
	assert.equal(shouldHeal(statusWith({ models: 0, probeKey: null })), false, '拿不到 probeKey 没法动')
	assert.equal(shouldHeal(null), false)
	assert.equal(shouldHeal(undefined), false)
	assert.equal(shouldHeal('nope'), false)
	assert.equal(shouldHeal([]), false)
})

test('healBlockReason：把「为什么不动」说出来（供日志与断言）', () => {
	assert.equal(healBlockReason(statusWith({ models: 0 })), null)
	assert.equal(healBlockReason(statusWith({ signedIn: false })), HEAL_REASONS.notSignedIn)
	assert.equal(healBlockReason(statusWith({ models: 2 })), HEAL_REASONS.catalogNotEmpty)
	assert.equal(healBlockReason(statusWith({ probeKey: null })), HEAL_REASONS.noProbeKey)
	assert.equal(healBlockReason(null), HEAL_REASONS.statusUnreadable)
})

test('常量：两个档位的路径与上游对齐，动作名与头名固定', () => {
	assert.deepEqual([...HEAL_VARIANT_KEYS], ['cn', 'ai'])
	assert.equal(UPSTREAM_STATUS_PATHS.cn, '/plugins/dsh-workbuddy-connect/status')
	assert.equal(UPSTREAM_STATUS_PATHS.ai, '/plugins/dsh-workbuddy-connect/ai/status')
	assert.equal(UPSTREAM_PROBE_PATHS.cn, '/plugins/dsh-workbuddy-connect/probe')
	assert.equal(UPSTREAM_PROBE_PATHS.ai, '/plugins/dsh-workbuddy-connect/ai/probe')
	assert.equal(HEAL_ACTION, 'refresh')
	assert.equal(PROBE_KEY_HEADER, 'x-workbuddy-probe-key')
	assert.equal(HEAL_DEFAULTS.enabled, true)
})

// ---------------------------------------------------------------------------
// 坏状态：真的动手，且只动一次
// ---------------------------------------------------------------------------

test('坏状态（已登录 + 目录空 + 有 probeKey）：读状态 → POST 探测 → 复读确认', async () => {
	const { fetchImpl, calls, posts } = makeFetch({
		statuses: [statusWith({ models: 0 }), statusWith({ models: 19 })],
		probe: { ok: true, status: 200 }
	})
	const { healer } = makeHealer({ fetchImpl })

	const result = await healer.heal({ variantKey: 'cn', origin: ORIGIN })

	assert.equal(result.healed, true)
	assert.equal(result.attempted, true)
	assert.equal(result.models, 19)
	assert.equal(result.reason, null)

	assert.equal(calls.length, 3, '恰好两次读状态 + 一次探测')
	assert.equal(calls[0].method, 'GET')
	assert.equal(calls[0].url, `http://${ORIGIN}${UPSTREAM_STATUS_PATHS.cn}`)
	assert.equal(calls[2].method, 'GET')

	const probe = posts()[0]
	assert.equal(probe.url, `http://${ORIGIN}${UPSTREAM_PROBE_PATHS.cn}`)
	assert.equal(probe.headers[PROBE_KEY_HEADER], PROBE_KEY, '缺这个头上游会 403')
	assert.deepEqual(JSON.parse(probe.body), { action: HEAL_ACTION })
})

test('国际版走它自己的两条路径（`ai/` 前缀），绝不串到国内版', async () => {
	const { fetchImpl, calls } = makeFetch({
		statuses: [statusWith({ models: 0 }), statusWith({ models: 27 })]
	})
	const { healer } = makeHealer({ fetchImpl })

	const result = await healer.heal({ variantKey: 'ai', origin: ORIGIN })

	assert.equal(result.healed, true)
	assert.equal(result.models, 27)
	assert.equal(calls[0].url, `http://${ORIGIN}${UPSTREAM_STATUS_PATHS.ai}`)
	assert.equal(calls[1].url, `http://${ORIGIN}${UPSTREAM_PROBE_PATHS.ai}`)
	for (const call of calls) {
		assert.ok(!call.url.includes('/plugins/dsh-workbuddy-connect/status'), '不许打成国内版的 status')
	}
})

// ---------------------------------------------------------------------------
// 好状态 / 不该动的情况：一次探测都不许有
// ---------------------------------------------------------------------------

test('目录非空：只读一次状态，绝不探测（好状态下「零请求」指的是零探测请求）', async () => {
	const { fetchImpl, calls, posts } = makeFetch({ statuses: [statusWith({ models: 18 })] })
	const { healer } = makeHealer({ fetchImpl })

	const result = await healer.heal({ variantKey: 'cn', origin: ORIGIN })

	assert.equal(result.healed, false)
	assert.equal(result.attempted, false)
	assert.equal(result.reason, HEAL_REASONS.catalogNotEmpty)
	assert.equal(calls.length, 1)
	assert.equal(posts().length, 0, '目录非空时绝不许碰探测路由')
})

test('未登录：只读一次状态，绝不探测（没有凭据可抓，抓了也白抓）', async () => {
	const { fetchImpl, calls, posts } = makeFetch({ statuses: [statusWith({ signedIn: false })] })
	const { healer } = makeHealer({ fetchImpl })

	const result = await healer.heal({ variantKey: 'cn', origin: ORIGIN })

	assert.equal(result.reason, HEAL_REASONS.notSignedIn)
	assert.equal(calls.length, 1)
	assert.equal(posts().length, 0)
})

test('拿不到 probeKey：只读一次状态，绝不探测', async () => {
	const { fetchImpl, calls, posts } = makeFetch({ statuses: [statusWith({ models: 0, probeKey: null })] })
	const { healer } = makeHealer({ fetchImpl })

	const result = await healer.heal({ variantKey: 'cn', origin: ORIGIN })

	assert.equal(result.reason, HEAL_REASONS.noProbeKey)
	assert.equal(calls.length, 1)
	assert.equal(posts().length, 0)
})

test('上游读不到状态（非 2xx / 非对象）：一次探测都不发', async () => {
	// 注意：这里必须用 thunk —— `makeFetch` 默认会把给定值再包一层 jsonResponse，
	// 直接塞一个现成 response 会被当成 body。
	const notOk = makeFetch({ statuses: [() => jsonResponse({}, { ok: false, status: 503 })] })
	const a = await makeHealer({ fetchImpl: notOk.fetchImpl }).healer.heal({ variantKey: 'cn', origin: ORIGIN })
	assert.equal(a.reason, HEAL_REASONS.statusUnreadable)
	assert.equal(notOk.calls.length, 1)
	assert.equal(notOk.posts().length, 0)

	const notJson = makeFetch({ statuses: [() => jsonResponse('plain text')] })
	const b = await makeHealer({ fetchImpl: notJson.fetchImpl }).healer.heal({ variantKey: 'cn', origin: ORIGIN })
	assert.equal(b.reason, HEAL_REASONS.statusUnreadable)
	assert.equal(notJson.posts().length, 0)
})

// ---------------------------------------------------------------------------
// 探测被拒 / 探测后仍空 / 抛异常：都要如实返回，绝不抛
// ---------------------------------------------------------------------------

test('探测被上游拒绝（403）：如实报告，且不再复读状态', async () => {
	const { fetchImpl, calls } = makeFetch({
		statuses: [statusWith({ models: 0 })],
		probe: { ok: false, status: 403 }
	})
	const { healer, logs } = makeHealer({ fetchImpl })

	const result = await healer.heal({ variantKey: 'cn', origin: ORIGIN })

	assert.equal(result.attempted, true)
	assert.equal(result.healed, false)
	assert.equal(result.reason, HEAL_REASONS.probeRejected)
	assert.equal(calls.length, 2, '被拒之后不该再读一次状态')
	assert.ok(
		logs.some((l) => l.level === 'warn' && l.message.includes('403')),
		'被拒要留一条 warn 日志'
	)
})

test('探测成功但目录仍空：报告 still-empty（上游升级后动作名变了就是这个样子）', async () => {
	const { fetchImpl, calls } = makeFetch({
		statuses: [statusWith({ models: 0 }), statusWith({ models: 0 })]
	})
	const { healer } = makeHealer({ fetchImpl })

	const result = await healer.heal({ variantKey: 'cn', origin: ORIGIN })

	assert.equal(result.attempted, true)
	assert.equal(result.healed, false)
	assert.equal(result.reason, HEAL_REASONS.stillEmpty)
	assert.equal(result.models, 0)
	assert.equal(calls.length, 3)
})

test('fetch 抛异常：返回 error 而不是把异常冒出去（调用点在请求处理路径上）', async () => {
	const fetchImpl = async () => {
		throw new Error('socket hang up')
	}
	const { healer } = makeHealer({ fetchImpl })

	const result = await healer.heal({ variantKey: 'cn', origin: ORIGIN })

	assert.equal(result.healed, false)
	assert.equal(result.reason, HEAL_REASONS.error)
	assert.equal(result.error, 'socket hang up')
})

test('logger 自己抛异常也不能让自愈失败冒泡', async () => {
	const { fetchImpl } = makeFetch({ statuses: [statusWith({ models: 0 }), statusWith({ models: 3 })] })
	const throwingLogger = {
		info: () => {
			throw new Error('log sink exploded')
		},
		warn: () => {
			throw new Error('log sink exploded')
		}
	}
	const healer = new CatalogHealer({ fetchImpl, logger: throwingLogger })

	const result = await healer.heal({ variantKey: 'cn', origin: ORIGIN })
	assert.equal(result.healed, true)
})

// ---------------------------------------------------------------------------
// 关闭开关 / 参数不合法：零请求
// ---------------------------------------------------------------------------

test('关掉开关：零请求', async () => {
	const { fetchImpl, calls } = makeFetch()
	const { healer } = makeHealer({ fetchImpl, config: { enabled: false } })

	assert.equal(healer.enabled, false)
	// heal() 永远返回结构化结果（只是没动手）；maybeHeal() 才是连入口都不进。
	const direct = await healer.heal({ variantKey: 'cn', origin: ORIGIN })
	assert.equal(direct.attempted, false)
	assert.equal(direct.reason, HEAL_REASONS.disabled)
	assert.equal(healer.maybeHeal({ variantKey: 'cn', origin: ORIGIN }), null)
	assert.equal(calls.length, 0)
})

test('档位不认识 / origin 缺失或非法：零请求', async () => {
	const { fetchImpl, calls } = makeFetch()
	const { healer } = makeHealer({ fetchImpl })

	const unknown = await healer.heal({ variantKey: 'global', origin: ORIGIN })
	assert.equal(unknown.reason, HEAL_REASONS.unknownVariant)

	const noOrigin = await healer.heal({ variantKey: 'cn' })
	assert.equal(noOrigin.reason, HEAL_REASONS.noOrigin)

	const badOrigin = await healer.heal({ variantKey: 'cn', origin: 'http://evil.example' })
	assert.equal(badOrigin.reason, HEAL_REASONS.noOrigin)

	assert.equal(calls.length, 0)

	assert.equal(healer.maybeHeal({ variantKey: 'global', origin: ORIGIN }), null)
	assert.equal(healer.maybeHeal({ variantKey: 'cn' }), null)
	assert.equal(calls.length, 0)
})

test('没有 fetchImpl：零请求、如实说明', async () => {
	const { healer } = makeHealer({})
	const result = await healer.heal({ variantKey: 'cn', origin: ORIGIN })
	assert.equal(result.reason, HEAL_REASONS.noFetch)
})

// ---------------------------------------------------------------------------
// 幂等：每档每进程一次
// ---------------------------------------------------------------------------

test('maybeHeal 幂等：同一档位连调多次只跑一遍（并发也一样）', async () => {
	const { fetchImpl, calls } = makeFetch({
		statuses: [statusWith({ models: 0 }), statusWith({ models: 19 })]
	})
	const { healer } = makeHealer({ fetchImpl })

	const first = healer.maybeHeal({ variantKey: 'cn', origin: ORIGIN })
	const second = healer.maybeHeal({ variantKey: 'cn', origin: ORIGIN })
	assert.equal(first, second, '第二次必须拿到同一个 promise')

	const [a, b] = await Promise.all([first, second])
	assert.equal(a.healed, true)
	assert.equal(b.healed, true)
	assert.equal(calls.length, 3, '两档各一次也只该是三请求，不能被调用次数放大')
})

test('两个档位各管各的：一个坏不影响另一个，先好的那个也不拖累坏的', async () => {
	const { fetchImpl, calls } = makeFetch({
		statuses: [statusWith({ models: 18 }), statusWith({ models: 0 }), statusWith({ models: 27 })]
	})
	const { healer } = makeHealer({ fetchImpl })

	const cn = await healer.maybeHeal({ variantKey: 'cn', origin: ORIGIN })
	assert.equal(cn.reason, HEAL_REASONS.catalogNotEmpty)

	const ai = await healer.maybeHeal({ variantKey: 'ai', origin: ORIGIN })
	assert.equal(ai.healed, true)
	assert.equal(ai.models, 27)

	assert.equal(calls.length, 4, 'cn 一次读 + ai 两次读 + ai 一次探测')
	assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
})

test('status()：先报 pending，结算后报真实结果（不许永远停在 pending）', async () => {
	const { fetchImpl } = makeFetch({
		statuses: [statusWith({ models: 0 }), statusWith({ models: 19 })]
	})
	const { healer } = makeHealer({ fetchImpl })

	assert.deepEqual(healer.status(), { enabled: true, attempted: {} })

	const promise = healer.maybeHeal({ variantKey: 'cn', origin: ORIGIN })
	assert.deepEqual(healer.status().attempted.cn, { pending: true }, '还没结算时是 pending')

	await promise
	const settled = healer.status()
	assert.equal(settled.attempted.cn.healed, true, '结算后必须是真实结果')
	assert.equal(settled.attempted.cn.models, 19)
	assert.equal(settled.attempted.cn.reason, null)
	assert.equal(settled.enabled, true)
})

test('status() 里绝不出现凭据字段', async () => {
	const { fetchImpl } = makeFetch({
		statuses: [statusWith({ models: 0 }), statusWith({ models: 19 })]
	})
	const { healer } = makeHealer({ fetchImpl })
	await healer.maybeHeal({ variantKey: 'cn', origin: ORIGIN })

	const text = JSON.stringify(healer.status())
	for (const needle of ['accessToken', 'refreshToken', '$wbEncrypted', PROBE_KEY]) {
		assert.ok(!text.includes(needle), `status 里不许出现 ${needle}`)
	}
})

test('超时可以注入，且默认值固定', async () => {
	const seen = []
	const fetchImpl = async (url, init) => {
		seen.push(init.signal instanceof AbortSignal)
		return jsonResponse(statusWith({ models: 18 }))
	}
	await new CatalogHealer({ fetchImpl, config: { timeoutMs: 12_345 } }).heal({ variantKey: 'cn', origin: ORIGIN })
	assert.deepEqual(seen, [true], '每次请求都必须带 AbortSignal（否则上游卡死会拖住自愈）')
	assert.equal(HEAL_DEFAULTS.timeoutMs, 15_000)
})
