/**
 * test/upstream.test.js — 没装 dsh-workbuddy-connect 时插件必须降级而不是拖垮宿主。
 *
 * DSH 启动是全有全无的：插件模块一抛，整个宿主退出。这里证明三件事：
 *   1) 入口模块不再静态依赖上游（能在「上游缺失」的条件下 import + apply）；
 *   2) status 如实报告 `upstream.installed = false`，并给出可安装的目录 URL；
 *   3) 上游后来装上了，下一次读 status 会自动接上，不需要重启。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FakeHost } from './helpers/fake-host.js'
import { apply } from '../lib/index.js'
import { resetUpstreamForTest, UPSTREAM_REPO_URL } from '../lib/upstream.js'

const STATUS = '/plugins/dsh-workbuddy-multi/status'

async function isolatedPool(t) {
  const root = await mkdtemp(join(tmpdir(), 'wbm-upstream-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('上游缺失：插件照常 apply，status 503 并报告 upstream.installed=false', async (t) => {
  resetUpstreamForTest()
  const host = new FakeHost()
  t.after(() => host.disposeAll())
  const missing = Object.assign(new Error("Cannot find package 'dsh-workbuddy-connect'"), { code: 'ERR_MODULE_NOT_FOUND' })

  apply(
    host,
    { poolRoot: await isolatedPool(t), scanMs: 60_000, keepalive: false, credits: false },
    { importUpstream: () => Promise.reject(missing) },
  )
  await new Promise((resolve) => setImmediate(resolve))

  const res = await host.call(STATUS)
  assert.equal(res.statusCode, 503)
  assert.match(res.body.error, /dsh-workbuddy-connect/)
  assert.equal(res.body.status.ready, false)
  assert.equal(res.body.status.upstream.installed, false)
  assert.equal(res.body.status.upstream.repoUrl, UPSTREAM_REPO_URL)
  assert.match(res.body.status.upstream.error, /Cannot find package/)
  assert.deepEqual(host.registeredRoutes(), [], '上游缺失时不得注册任何模型组')
})

test('上游后来装上了：下一次读 status 自动接上，不需要重启', async (t) => {
  resetUpstreamForTest()
  const host = new FakeHost()
  t.after(() => host.disposeAll())
  let available = false
  const importUpstream = () =>
    available ? import('dsh-workbuddy-connect') : Promise.reject(new Error('not installed'))

  apply(
    host,
    { poolRoot: await isolatedPool(t), scanMs: 60_000, keepalive: false, credits: false, envTakeover: false },
    { importUpstream },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await host.call(STATUS)).statusCode, 503)

  available = true
  // 重试有 10 秒节流；第一次 503 已经消耗了这一轮，所以这里把节流时间拨过去。
  const realNow = Date.now
  Date.now = () => realNow() + 11_000
  t.after(() => {
    Date.now = realNow
  })
  await host.call(STATUS)

  let ready
  for (let i = 0; i < 50 && ready === undefined; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    const res = await host.call(STATUS)
    if (res.statusCode === 200) ready = res.body
  }
  assert.ok(ready, '装上上游后 status 应该变成 200')
  assert.equal(ready.upstream.installed, true)
  assert.equal(ready.ready, true)
})

test('宿主侧任何模块都不得静态 import 上游（静态 import 失败会让 DSH 整个起不来）', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const libDir = new URL('../lib/', import.meta.url)
  const offenders = []
  for (const file of await readdir(libDir)) {
    if (!file.endsWith('.js') || file === 'client.js') continue
    const source = await readFile(new URL(file, libDir), 'utf8')
    if (/^\s*import\s[^;]*from\s+['"]dsh-workbuddy-connect['"]/m.test(source)) offenders.push(file)
  }
  assert.deepEqual(offenders, [])
})
