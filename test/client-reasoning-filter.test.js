/**
 * test/client-reasoning-filter.test.js — 「推理等级」按钮隐藏过滤器的单元测试。
 *
 * 过滤器是 lib/client.js 里的 `createReasoningFilter` / `installReasoningFilter`
 * （经 exports.connectInternals 取出）。它包装 window.fetch，把本插件已知的模型从
 * 上游 status 文档的 probe.candidates / probe.results 里过滤掉。这里用假 window +
 * 假 fetch 驱动它，断言的全是「不能让上游坏掉」的边界：放行、fail-open、还原。
 *
 * 注意：client.js 在求值时把 `window`/`globalThis` 绑定为同一个对象（模块顶部就是
 * `window.__ModuleLoader__.load(...)`），所以测试世界的 window 必须是**求值时传入、
 * 之后原地改字段**的那一个 —— 换对象模块看不见。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

/**
 * 只求值、不渲染：world.window 是模块认识的 window/globalThis 共同体，
 * connectInternals 从 load 的返回值里取。每个测试一个全新世界。
 */
function makeWorld({ multiDoc, upstreamDoc } = {}) {
  const world = { calls: [] }
  const window = {
    location: { href: 'http://127.0.0.1:59999/', origin: 'http://127.0.0.1:59999' },
    __ModuleLoader__: {
      load: ({ factory }) => {
        world.exports = factory((name) => {
          if (name === 'react') return { Fragment: Symbol('Fragment') }
          if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
  }
  const multi = multiDoc ?? {
    ready: true,
    reasoning: {
      enabled: true,
      ttlMs: 12096e5,
      variants: {
        cn: { routeId: 'workbuddy', wrapped: true, models: [] },
        ai: { routeId: 'workbuddy-ai', wrapped: true, models: [{ id: 'm-known', validation: 'validating', efforts: ['low'] }] },
      },
    },
  }
  const upstream = upstreamDoc ?? {
    status: 'signed-in',
    probeKey: 'k',
    probe: {
      consent: false,
      running: false,
      candidates: ['m-known', 'm-unknown'],
      results: [{ id: 'm-known', name: 'm-known', validation: 'validating', efforts: ['low'], probedAt: 1 }],
    },
  }
  const jsonResponse = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const original = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url
    world.calls.push({ url: raw, method: init.method ?? 'GET' })
    if (raw === '/plugins/dsh-workbuddy-multi/status') return jsonResponse(typeof multi === 'function' ? multi() : multi)
    if (typeof raw === 'string' && raw.startsWith('/plugins/dsh-workbuddy-connect/')) {
      return jsonResponse(typeof upstream === 'function' ? upstream() : upstream)
    }
    return jsonResponse({ untouched: true })
  }
  window.fetch = original
  world.window = window
  world.original = original
  new Function('window', 'globalThis', SOURCE)(window, window)
  world.internals = world.exports.connectInternals
  return world
}

test('已知模型从 candidates 与 results 里同时消失（按钮的两个可见性来源都被掐掉）', async () => {
  const world = makeWorld()
  const dispose = world.internals.installReasoningFilter()
  try {
    const response = await world.window.fetch('/plugins/dsh-workbuddy-connect/ai/status')
    const doc = await response.json()
    assert.deepEqual(doc.probe.candidates, ['m-unknown'])
    assert.deepEqual(doc.probe.results, [])
    assert.equal(doc.status, 'signed-in', '文档其余部分原样保留')
    assert.equal(doc.probeKey, 'k')
  } finally {
    dispose()
  }
})

test('功能关闭（reasoning.enabled false）时一律放行，等于上游原生行为', async () => {
  const world = makeWorld({
    multiDoc: {
      ready: true,
      reasoning: { enabled: false, ttlMs: 1, variants: {} },
    },
  })
  const dispose = world.internals.installReasoningFilter()
  try {
    const response = await world.window.fetch('/plugins/dsh-workbuddy-connect/ai/status')
    const doc = await response.json()
    assert.deepEqual(doc.probe.candidates, ['m-known', 'm-unknown'])
    assert.equal(doc.probe.results.length, 1)
  } finally {
    dispose()
  }
})

test('本插件 status 读不到时 fail-open：不过滤、不炸', async () => {
  const world = makeWorld()
  world.window.fetch = async (input) => {
    const raw = typeof input === 'string' ? input : input.url
    world.calls.push({ url: raw, method: 'GET' })
    if (raw === '/plugins/dsh-workbuddy-multi/status') throw new Error('host down')
    return new Response(JSON.stringify({
      status: 'signed-in',
      probe: { candidates: ['m-known'], results: [] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  // installReasoningFilter 在 install 时抓取当前 window.fetch：必须现在才装。
  const dispose = world.internals.installReasoningFilter()
  try {
    const response = await world.window.fetch('/plugins/dsh-workbuddy-connect/status')
    const doc = await response.json()
    assert.deepEqual(doc.probe.candidates, ['m-known'])
  } finally {
    dispose()
  }
})

test('上游 probe 路由的 POST 把缓存标脏：下一次 status 拦截强制重读本插件状态', async () => {
  const world = makeWorld()
  const dispose = world.internals.installReasoningFilter()
  try {
    await world.window.fetch('/plugins/dsh-workbuddy-connect/ai/status')
    assert.equal(world.calls.filter((c) => c.url === '/plugins/dsh-workbuddy-multi/status').length, 1)

    // 未标脏时：最小间隔内不重读
    await world.window.fetch('/plugins/dsh-workbuddy-connect/ai/status')
    assert.equal(world.calls.filter((c) => c.url === '/plugins/dsh-workbuddy-multi/status').length, 1)

    await world.window.fetch('/plugins/dsh-workbuddy-connect/ai/probe', {
      method: 'POST',
      body: JSON.stringify({ action: 'probe', model: 'm-unknown' }),
    })
    await world.window.fetch('/plugins/dsh-workbuddy-connect/ai/status')
    assert.equal(
      world.calls.filter((c) => c.url === '/plugins/dsh-workbuddy-multi/status').length,
      2,
      'POST 之后的第一次 status 必须重读本插件状态',
    )
  } finally {
    dispose()
  }
})

test('不相干路径与跨源请求完全不经手', async () => {
  const world = makeWorld()
  const dispose = world.internals.installReasoningFilter()
  try {
    const own = await world.window.fetch('/plugins/dsh-workbuddy-multi/status')
    assert.equal((await own.json()).ready, true)
    const before = world.calls.length
    await world.window.fetch('/x/y')
    await world.window.fetch('https://api.github.com/x')
    assert.equal(world.calls.length, before + 2)
    // 过滤器对这些路径不得发起任何额外的本插件 status 读取
    assert.equal(world.calls.filter((c) => c.url === '/plugins/dsh-workbuddy-multi/status').length, 1)
  } finally {
    dispose()
  }
})

test('dispose 还原 window.fetch，且重复安装幂等', async () => {
  const world = makeWorld()
  const original = world.window.fetch
  const dispose1 = world.internals.installReasoningFilter()
  const wrapped = world.window.fetch
  assert.notEqual(wrapped, original)
  const dispose2 = world.internals.installReasoningFilter()
  assert.equal(world.window.fetch, wrapped, '第二次安装不得再包一层')
  dispose1()
  assert.notEqual(world.window.fetch, wrapped, '还原后不得再是包装函数')
  // install 时抓的是 bind 后的原函数：还原回的正是它，调用行为与原函数一致
  await world.window.fetch('/x')
  assert.equal(world.calls.length, 1)
  dispose2()
})
