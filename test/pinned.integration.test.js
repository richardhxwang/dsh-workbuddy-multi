/**
 * 真上游集成测试：用**本机真实安装的** `dsh-workbuddy-connect` 公开导出，把
 * `PinnedRoutes` 真正跑起来（真 `WorkBuddyCredentialStore` / 真 `WorkBuddyUpstreamClient`
 * / 真 `WorkBuddyCatalog` / 真 loopback shim / 真 `createWorkBuddyAdapter`）。
 *
 * 与 `pinned.test.js` 的分工：那边用**假件**验对账逻辑，这边验「真上游能不能接受我的接线」。
 *
 * ── 开关（重要）────────────────────────────────────────────────────────
 * 默认**跳过**，因为这个文件依赖本机真实存在的上游模块（`node_modules/dsh-workbuddy-connect`
 * 是软链到 `~/.dsh/profiles/desktop/node_modules/`）。CI 或别的机器上没有它，进默认套件会红。
 *
 *     WORKBUDDY_MULTI_REAL=1 node --test test/pinned.integration.test.js
 *
 * ── 前置条件 ───────────────────────────────────────────────────────────
 * 只需要「上游模块可解析」这一条：
 *   - `node_modules/dsh-workbuddy-connect` 存在（软链或真装）；裸 specifier 能 import 成功。
 *   - 能绑 loopback 临时端口（shim 自己 `listen(0, '127.0.0.1')`）。
 * 开关打开但模块解析不了 → **故意失败**，不静默跳过（这正是开关的用途）。
 *
 * ── 不读任何真人账号 ────────────────────────────────────────────────────
 * 全程假 pool + 指向临时目录的假 snapshot 路径，**不读真人桌面 auth、不读真账号池、不解 CN 密文**。
 * 之所以这样就够：CN 信封只在 `store.resolve()` / `chatStream()` 时才需要 at-rest key，
 * 本测试只验「模型组装配 + loopback 服务 + 句柄回收」，不发起真实上游请求，所以
 * snapshot 文件不存在也能跑通（也正是它可移植的原因）。
 *
 * 顺手钉住三处已确认的上游事实（避免以后又被 PLAN 的旧描述带偏）：
 *   - AI 变体的 `region` 是 `'global'`，不是 `'ai'`；
 *   - 每个 pinned 账号必须拿到**独立** `ownPath`（上游 `workbuddyOwnAuthPath()` 无参且全 Harness 共用）；
 *   - pinned catalog 必须 `setVisible(true)`，否则 `current()` 返回空、模型列表为 0。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BASELINE_PROVIDER_IDS, DEFAULT_PROVIDER_PREFIX, PinnedRoutes } from '../lib/pinned.js'

const SWITCH = 'WORKBUDDY_MULTI_REAL'
const ENABLED = process.env[SWITCH] === '1'
const SKIP_REASON = `需要本机真实上游模块；显式打开：${SWITCH}=1 node --test test/pinned.integration.test.js`

/** 合成账号（刻意不用真 uid：仓库里不放任何账号标识）。 */
const ACCOUNTS = {
	cn: { variantKey: 'cn', uid: 'aaaaaaaa-1111-2222-3333-444444444444', label: 'cn-one', enabled: true },
	ai: { variantKey: 'ai', uid: 'bbbbbbbb-1111-2222-3333-444444444444', label: 'ai-one', enabled: true }
}
const EXPECTED = [
	{ providerId: `${DEFAULT_PROVIDER_PREFIX}aaaaaaaa`, variantKey: 'cn', region: 'cn' },
	{ providerId: `${DEFAULT_PROVIDER_PREFIX}bbbbbbbb`, variantKey: 'ai', region: 'global' }
]

/** 只实现 PLAN §3.2 冻结的 pool 方法；snapshot 路径落在临时目录里，文件并不存在。 */
function makePool(snapshotDir) {
	return {
		list: (variantKey) => {
			const account = ACCOUNTS[variantKey]
			return account ? [account] : []
		},
		snapshotPath: (variantKey, uid) => join(snapshotDir, `${variantKey}-${uid}.info`)
	}
}

/** 记录 registerAdapter 的假 ctx（真 adapter / 真 shim，只有 registry 是假的）。 */
function makeCtx() {
	const registrations = []
	const events = []
	return {
		registrations,
		events,
		ctx: {
			llm: {
				registerAdapter(ids, adapter) {
					const record = { ids, adapter, released: 0 }
					registrations.push(record)
					return () => {
						record.released += 1
					}
				}
			},
			emit: (name) => events.push(name),
			logger: { info() {}, warn() {}, error() {} }
		}
	}
}

/** fetch，但把「连不上」当预期结果返回 false（dispose 之后就用它）。 */
async function reachable(url) {
	try {
		await fetch(url)
		return true
	} catch {
		return false
	}
}

async function eventuallyUnreachable(url, budgetMs = 2000) {
	const deadline = Date.now() + budgetMs
	for (;;) {
		if (!(await reachable(url))) return true
		if (Date.now() > deadline) return false
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
}

test(
	'真上游：PinnedRoutes 为每条账号各起一套 store/shim/adapter，且 dispose 不泄漏句柄',
	{ skip: ENABLED ? false : SKIP_REASON, timeout: 30_000 },
	async (t) => {
		// 开关打开还解析不了上游 → 明文失败（不要静默跳过）。
		const deps = await import('dsh-workbuddy-connect')
		const snapshotDir = await mkdtemp(join(tmpdir(), 'pinned-it-snap-'))
		const ownDir = await mkdtemp(join(tmpdir(), 'pinned-it-own-'))
		const { ctx, registrations, events } = makeCtx()
		const routes = new PinnedRoutes({
			pool: makePool(snapshotDir),
			ctx,
			config: { deps, ownDir, useMaximumContextWindow: false }
		})
		t.after(async () => {
			await routes.dispose().catch(() => {})
			await rm(snapshotDir, { recursive: true, force: true })
			await rm(ownDir, { recursive: true, force: true })
		})

		const summary = await routes.sync()

		await t.test('sync 把两条账号都拉起来了，且没有任何 warning', () => {
			assert.equal(summary.added, 2)
			assert.equal(summary.removed, 0)
			assert.equal(summary.rebuilt, 0)
			assert.deepEqual(summary.warnings, [], `意外 warning：${JSON.stringify(summary.warnings)}`)
			assert.deepEqual(
				routes.list().map((entry) => entry.providerId).sort(),
				EXPECTED.map((entry) => entry.providerId).sort()
			)
		})

		await t.test('绝不用上游基准 route id', () => {
			for (const entry of routes.list()) {
				assert.equal(BASELINE_PROVIDER_IDS.includes(entry.providerId), false, `${entry.providerId} 是基准 id`)
				assert.ok(entry.providerId.startsWith(DEFAULT_PROVIDER_PREFIX), entry.providerId)
			}
			assert.deepEqual(
				registrations.map((record) => record.ids),
				EXPECTED.map((entry) => [entry.providerId])
			)
		})

		await t.test('两条账号各占一个**不同**的 loopback 端口', () => {
			const origins = EXPECTED.map((entry) => routes.entries.get(entry.providerId).shim.baseUrl())
			for (const origin of origins) assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
			assert.equal(new Set(origins).size, 2, `端口应互不相同：${origins.join(' ')}`)
			console.log(`    loopback origins: ${origins.join('  ')}`)
		})

		await t.test('每个 shim 真的在服务：带 bearer 200，不带 401', async () => {
			for (const entry of EXPECTED) {
				const live = routes.entries.get(entry.providerId)
				const origin = live.shim.baseUrl()
				const auth = { headers: { authorization: `Bearer ${live.shim.token()}` } }

				const health = await fetch(`${origin}/healthz`, auth)
				assert.equal(health.status, 200, `${entry.providerId} /healthz`)
				assert.deepEqual(await health.json(), { ok: true })

				assert.equal((await fetch(`${origin}/healthz`)).status, 401, `${entry.providerId} 无 bearer 应 401`)
				assert.equal((await fetch(`${origin}/v1/models`)).status, 401, `${entry.providerId} 无 bearer 应 401`)
			}
		})

		await t.test('模型列表从 pinned catalog 出来，CN 与 AI 各自一套', async () => {
			const counts = {}
			for (const entry of EXPECTED) {
				const live = routes.entries.get(entry.providerId)
				const res = await fetch(`${live.shim.baseUrl()}/v1/models`, {
					headers: { authorization: `Bearer ${live.shim.token()}` }
				})
				assert.equal(res.status, 200)
				const body = await res.json()
				counts[entry.variantKey] = body.data.length
				// pinned catalog 必须是可见的，否则 current() 给空表、模型数为 0。
				assert.ok(body.data.length > 0, `${entry.providerId} 模型列表为空（catalog 被 setVisible(false) 了？）`)
				// 跟随上游导出的 fallback 名单，而不是把 19/20 写死，免得上游改版假红。
				const fallback = entry.variantKey === 'cn' ? deps.FALLBACK_WORKBUDDY_MODELS : deps.FALLBACK_WORKBUDDY_AI_MODELS
				assert.equal(body.data.length, fallback.length, `${entry.providerId} 模型数应等于上游 fallback 名单`)
			}
			console.log(`    models: cn=${counts.cn} ai=${counts.ai}`)
			// 本机实测口径：CN 19 / AI 20（若上游改了名单，上面的等式仍然成立，这里只提示差异）。
			assert.notDeepEqual(
				deps.FALLBACK_WORKBUDDY_MODELS.map((model) => model.id),
				deps.FALLBACK_WORKBUDDY_AI_MODELS.map((model) => model.id),
				'两套 fallback 名单不应相同'
			)
		})

		await t.test('region 分别透传为 cn / global（上游 AI 变体是 global 不是 ai）', () => {
			for (const entry of EXPECTED) {
				const live = routes.entries.get(entry.providerId)
				assert.equal(live.variant.region, entry.region, `${entry.providerId} region`)
			}
		})

		await t.test('每个 store 读的是自己那份 snapshot，且 ownPath 互不共用', () => {
			const ownPaths = new Set()
			for (const entry of EXPECTED) {
				const live = routes.entries.get(entry.providerId)
				assert.equal(
					live.store.desktopAuthPath(),
					join(snapshotDir, `${entry.variantKey}-${ACCOUNTS[entry.variantKey].uid}.info`),
					`${entry.providerId} 应读 pool.snapshotPath()`
				)
				const own = live.store.ownAuthPath()
				assert.ok(own.startsWith(ownDir), `${entry.providerId} ownPath 应在独立目录：${own}`)
				ownPaths.add(own)
			}
			// 上游 workbuddyOwnAuthPath() 全 Harness 共用一个路径；不注入就会互相踩。
			assert.equal(ownPaths.size, 2, `ownPath 必须一账号一份：${[...ownPaths].join(' ')}`)
		})

		await t.test('再次 sync 是幂等的：不重建 shim、不重复注册', async () => {
			const before = EXPECTED.map((entry) => routes.entries.get(entry.providerId).shim)
			const again = await routes.sync()
			assert.equal(again.added, 0)
			assert.equal(again.removed, 0)
			assert.equal(again.rebuilt, 0)
			assert.equal(registrations.length, 2, '不应重复注册')
			for (const [index, entry] of EXPECTED.entries()) {
				assert.equal(routes.entries.get(entry.providerId).shim, before[index], '不应重建已有 shim')
			}
			assert.deepEqual(events, ['llm/adapters-updated'], '无变化就不该发事件')
		})

		await t.test('dispose 关掉全部 shim、释放注册，端口不可达（PLAN R5）', async () => {
			const live = EXPECTED.map((entry) => ({
				providerId: entry.providerId,
				origin: routes.entries.get(entry.providerId).shim.baseUrl()
			}))
			const closed = await routes.dispose()
			assert.equal(closed, 2)
			for (const record of registrations) assert.equal(record.released, 1, '每个 adapter 注册都要释放')
			assert.deepEqual(routes.list(), [])
			for (const item of live) {
				assert.equal(await eventuallyUnreachable(`${item.origin}/healthz`), true, `${item.providerId} 端口仍在服务`)
			}
		})
	}
)
