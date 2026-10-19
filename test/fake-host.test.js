import assert from 'node:assert/strict'
import test from 'node:test'

import { FakeHost } from './helpers/fake-host.js'

test('registerAdapter: 同一 route id 第二次注册必须拒绝（模拟 DUPLICATE_ADAPTER）', () => {
  const host = new FakeHost()
  const release = host.llm.registerAdapter(['workbuddy-m-abc'], host.makeAdapter('a'))
  assert.deepEqual(host.registeredRoutes(), ['workbuddy-m-abc'])
  assert.throws(() => host.llm.registerAdapter(['workbuddy-m-abc'], host.makeAdapter('b')), /owned by another/)
  release()
  assert.deepEqual(host.registeredRoutes(), [])
})

test('effect: 立刻执行、按逆序卸载、disposer 只跑一次', async () => {
  const host = new FakeHost()
  const order = []
  host.effect(() => {
    order.push('a')
    return () => order.push('dispose-a')
  }, 'a')
  host.effect(() => {
    order.push('b')
    return () => order.push('dispose-b')
  }, 'b')
  assert.deepEqual(order, ['a', 'b'])
  await host.disposeAll()
  assert.deepEqual(order, ['a', 'b', 'dispose-b', 'dispose-a'])
  await host.disposeAll()
  assert.deepEqual(order, ['a', 'b', 'dispose-b', 'dispose-a'], '二次卸载不得重复跑 disposer')
})

test('inject: 服务缺席时不调用回调（用来验证降级路径）', () => {
  const host = new FakeHost({ services: ['llm'] })
  let called = false
  host.inject(['webServer'], () => {
    called = true
  })
  assert.equal(called, false)
  assert.deepEqual(host._injections[0].missing, ['webServer'])

  const full = new FakeHost({ services: ['llm', 'webServer'] })
  let calledFull = false
  full.inject(['webServer'], () => {
    calledFull = true
  })
  assert.equal(calledFull, true)
})

test('webServer.register: 重复路径必须拒绝；卸载后路径消失', async () => {
  const host = new FakeHost()
  const off = host.webServer.register({ kind: 'exact', path: '/x', handler: () => {} })
  assert.deepEqual(host.registeredPaths(), ['/x'])
  assert.throws(() => host.webServer.register({ kind: 'exact', path: '/x', handler: () => {} }), /already registered/)
  off()
  assert.deepEqual(host.registeredPaths(), [])
})

test('call: 走通 GET 与 POST，响应体被解析', async () => {
  const host = new FakeHost()
  host.webServer.register({
    kind: 'exact',
    path: '/echo',
    handler: (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ method: 'GET', host: req.headers.host }))
        return
      }
      let raw = ''
      req.on('data', (c) => {
        raw += c.toString('utf8')
      })
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ received: JSON.parse(raw) }))
      })
    },
  })

  const get = await host.call('/echo')
  assert.equal(get.statusCode, 200)
  assert.deepEqual(get.body, { method: 'GET', host: '127.0.0.1:59999' })

  const post = await host.call('/echo', { method: 'POST', body: { action: 'select', uid: 'u1' } })
  assert.deepEqual(post.body, { received: { action: 'select', uid: 'u1' } })
})

test('leaks: 未回收的 adapter 与路由会被点出来', async () => {
  const host = new FakeHost()
  host.effect(() => {
    const releaseAdapter = host.llm.registerAdapter(['r1'], host.makeAdapter('r1'))
    const releaseRoute = host.webServer.register({ kind: 'exact', path: '/p', handler: () => {} })
    return () => {
      releaseAdapter()
      releaseRoute()
    }
  }, 'both')
  assert.deepEqual(host.leaks(), [{ kind: 'adapter', ids: ['r1'] }, { kind: 'route', paths: ['/p'] }])
  await host.disposeAll()
  assert.deepEqual(host.leaks(), [])
})
