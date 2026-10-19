/**
 * `lib/context-tiers.js` 的单元测试：上下文选档（拆分选择器条目 + 回环代理改写）。
 *
 * 风险全在两头：派生条目的形状（id/窗口/baseUrl 指向代理），和代理把合成 id
 * 换回真实 id 再转发（含 SSE 逐块透传、非 chat 路径 404、未知合成 id 400）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'

import { ContextTiers, tierLabel, CTX_SUFFIX_RE } from '../lib/context-tiers.js'

const ROWS = [
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 300000, supportedContextWindows: [300000, 1000000] },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 272000, supportedContextWindows: [272000, 600000, 1000000] },
  { id: 'plain', name: 'Plain', contextWindow: 200000 },
]

function makeTiers({ rows = ROWS, enabled = true } = {}) {
  const tiers = new ContextTiers({ enabled, rowsForVariant: () => rows })
  tiers.rebuild(['ai'])
  return tiers
}

test('tierLabel：整千整兆用紧凑标记', () => {
  assert.equal(tierLabel(300000), '300K')
  assert.equal(tierLabel(1000000), '1M')
  assert.equal(tierLabel(272000), '272K')
})

test('派生表：多档窗口的模型各拆出非当前档；单档模型不拆', () => {
  const tiers = makeTiers()
  const ids = [...tiers.tiers.keys()].sort()
  assert.deepEqual(ids, ['gpt-6.1-sol--ctx1000000', 'gpt-6.1-sol--ctx600000', 'kimi-k3--ctx1000000'])
  assert.equal(tiers.tiers.get('kimi-k3--ctx1000000').baseId, 'kimi-k3')
  assert.ok(CTX_SUFFIX_RE.test('kimi-k3--ctx1000000'))
})

test('augment：合成条目带窗口与代理 baseUrl，原条目不动；代理未起时不加', async () => {
  const tiers = makeTiers()
  const models = [{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 300000, baseUrl: 'http://127.0.0.1:39999/v1' }]
  assert.equal(tiers.augment('ai', models).length, 1, '代理没起监听前原样返回')
  await tiers.start()
  try {
    const out = tiers.augment('ai', models)
    assert.equal(out.length, 2)
    const syn = out[1]
    assert.equal(syn.id, 'kimi-k3--ctx1000000')
    assert.equal(syn.name, 'Kimi K3 · 1M')
    assert.equal(syn.contextWindow, 1000000)
    assert.equal(syn.baseUrl, `http://127.0.0.1:${tiers.port}/v1`)
    assert.equal(models[0].baseUrl, 'http://127.0.0.1:39999/v1', '原条目不被改写')
  } finally {
    await tiers.stop()
  }
})

test('代理：把合成 id 换回真实 id 再转发，SSE 逐块透传', async () => {
  // 假上游 shim：记录收到的 body，回两段 SSE。
  const seen = []
  const upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"a":1}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const upstreamPort = upstream.address().port

  const tiers = makeTiers()
  await tiers.start()
  try {
    const models = [{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 300000, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` }]
    tiers.augment('ai', models) // 让代理学到上游地址
    const response = await fetch(`http://127.0.0.1:${tiers.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer shim-token' },
      body: JSON.stringify({ model: 'kimi-k3--ctx1000000', messages: [] }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(text.includes('[DONE]'))
    assert.equal(seen.length, 1)
    assert.equal(seen[0].body.model, 'kimi-k3', '上游必须收到真实 id')
    assert.equal(seen[0].auth, 'Bearer shim-token', '鉴权头原样透传')
    assert.equal(seen[0].url, '/v1/chat/completions')
  } finally {
    await tiers.stop()
    upstream.close()
  }
})

test('代理：未知合成 id 400，非 /v1/ 路径 404，坏 JSON 400', async () => {
  const tiers = makeTiers()
  await tiers.start()
  try {
    const unknown = await fetch(`http://127.0.0.1:${tiers.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nope--ctx1' }),
    })
    assert.equal(unknown.status, 400)
    const other = await fetch(`http://127.0.0.1:${tiers.port}/x`, { method: 'POST' })
    assert.equal(other.status, 404)
    const bad = await fetch(`http://127.0.0.1:${tiers.port}/v1/chat/completions`, { method: 'POST', body: 'not json' })
    assert.equal(bad.status, 400)
  } finally {
    await tiers.stop()
  }
})

test('开关关闭：rebuild 清空派生表，augment 原样返回', async () => {
  const tiers = makeTiers({ enabled: false })
  assert.equal(tiers.tiers.size, 0)
  await tiers.start()
  try {
    const models = [{ id: 'kimi-k3', contextWindow: 300000, baseUrl: 'http://127.0.0.1:1/v1' }]
    assert.equal(tiers.augment('ai', models).length, 1)
  } finally {
    await tiers.stop()
  }
})
