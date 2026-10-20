/**
 * test/client-round2.test.js — 前端 UI 第二轮（VERIFY.md §29）的客户端测试。
 *
 * B1 最近记录与「需要处理」分开 / B2 Connect 区默认收起 / B3 导入改文件选择器 / B4 菜单键盘导航。
 * 每条都配一个反向用例：把源码定向改回旧行为后装进新沙箱，同一断言必须变红。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSandbox } from './helpers/client-sandbox.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

/** 一个节点子树里的全部文字。 */
function textOf(node) {
  if (node === null || node === void 0) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/** 源码定向突变：找不到锚点直接失败，防止反向测试因为锚点漂移而「假绿」。 */
function mutate(src, from, to) {
  assert.ok(src.includes(from), `反向测试锚点不在源码里：${from.slice(0, 80)}`)
  return src.replace(from, to)
}

/* ── B1：最近记录 ─────────────────────────────────────────────────────── */

const HISTORY = [
  { message: '国内版触发限流（RATE_LIMIT），且没有其他可用账号，继续使用 uid-aaaa', at: Date.now() - 60_000 },
]

async function historyView(src) {
  const s = createSandbox(src)
  s.state.statusDoc = s.mkStatus({ history: HISTORY })
  const view = await s.settle()
  return { s, view, toggle: view.buttons.find((b) => textOf(b).includes('historyHeadingCount')) }
}

test('B1 最近记录：默认收起，展开后带时间；不进「需要处理」', async (t) => {
  const { s, view, toggle } = await historyView(SOURCE)
  t.after(() => s.unmount())
  assert.ok(toggle !== void 0, '有 history 时要渲染「最近记录」折叠头')
  assert.equal(toggle.props['aria-expanded'], false, '默认收起')
  assert.ok(!view.has('没有其他可用账号'), '收起时不显示内容')
  assert.ok(!view.has('warningsHeading'), 'history 不触发「需要处理」横幅')
  toggle.props.onClick()
  const opened = await s.settle()
  assert.ok(opened.has('没有其他可用账号'))
  assert.ok(opened.texts.some((x) => /^(\d{1,2}\/\d{1,2} )?\d{1,2}:\d{2}$/.test(x)), `展开后每条带时间：${JSON.stringify(opened.texts.slice(-6))}`)
})

test('B1 最近记录：history 为空时什么都不渲染', async (t) => {
  const s = createSandbox(SOURCE)
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus({ history: [] })
  const view = await s.settle()
  assert.ok(!view.buttons.some((b) => textOf(b).includes('historyHeadingCount')))
})

test('B1 反向：不挂 RecentEvents 时，history 在页面上看不到', async (t) => {
  const src = mutate(SOURCE, 'jsx(RecentEvents, { history: status.history, t }),', '')
  const { s, toggle } = await historyView(src)
  t.after(() => s.unmount())
  assert.equal(toggle, void 0, '突变后的世界里不应有折叠头 —— 否则上面的用例证明不了什么')
})

/* ── B2：Connect 区默认收起 ───────────────────────────────────────────── */

/** 只有 Connect 面板会读国际版上游 status（国内版那条还被依赖检测的探针共用，不能拿来数）。 */
const AI_PANEL_PATH = '/plugins/dsh-workbuddy-connect/ai/status'

async function connectView(src, options) {
  const s = createSandbox(src, options)
  s.state.statusDoc = s.mkStatus({ upstream: { installed: true } })
  const view = await s.settle()
  const head = view.buttons.find((b) => textOf(b).includes('connectHeading'))
  const panelGets = () => s.state.calls.filter((c) => c.method === 'GET' && c.url === AI_PANEL_PATH).length
  return { s, view, head, panelGets }
}

test('B2 Connect：默认收起，不挂面板也不读上游 status；点开后面板出现', async (t) => {
  const { s, head, panelGets } = await connectView(SOURCE)
  t.after(() => s.unmount())
  assert.ok(head !== void 0, 'Connect 区要有折叠头')
  assert.equal(head.props['aria-expanded'], false, '默认收起')
  assert.equal(panelGets(), 0, '收起时不应向上游 status 发 GET')
  head.props.onClick()
  await s.settle()
  assert.ok(panelGets() > 0, '展开后面板开始读上游 status')
})

test('B2 Connect：展开状态记在 localStorage，下一张页面沿用', async (t) => {
  const store = new Map()
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  }
  const first = await connectView(SOURCE, { localStorage: () => storage })
  first.head.props.onClick()
  await first.s.settle()
  first.s.unmount()
  assert.equal(store.get('dsh-workbuddy-multi:connect-open'), '1')
  const second = await connectView(SOURCE, { localStorage: () => storage })
  t.after(() => second.s.unmount())
  assert.equal(second.head.props['aria-expanded'], true)
})

test('B2 Connect：localStorage 读取即抛时照常渲染、按收起处理', async (t) => {
  let reads = 0
  const { s, head } = await connectView(SOURCE, {
    localStorage: () => {
      reads += 1
      throw new Error('SecurityError')
    }
  })
  t.after(() => s.unmount())
  assert.ok(reads > 0, '前提：代码确实去读了 localStorage，否则这条证明不了「抛了也不坏」')
  assert.ok(head !== void 0)
  assert.equal(head.props['aria-expanded'], false)
})

test('B2 反向：默认值改成展开时，「默认收起」那条断言会红', async (t) => {
  const src = mutate(SOURCE, 'react.useState(readConnectOpen)', 'react.useState(true)')
  const { s, head, panelGets } = await connectView(src)
  t.after(() => s.unmount())
  assert.equal(head.props['aria-expanded'], true)
  assert.ok(panelGets() > 0, '突变后的世界会立刻读上游 —— 第一条用例正是在防这个')
})

/* ── B3：导入改文件选择器 ─────────────────────────────────────────────── */

/** 渲染树里所有满足条件的节点。 */
function findAll(node, pred, out = []) {
  if (node === null || node === void 0 || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out)
    return out
  }
  if (pred(node)) out.push(node)
  findAll(node.props?.children, pred, out)
  return out
}

/** 假 File：只有 ImportForm 用到的 name / size / arrayBuffer()。 */
function fakeFile(name, text, size) {
  const bytes = new TextEncoder().encode(text)
  return { name, size: size ?? bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) }
}

/** 打开国内版区头部的 ⋯ 菜单 → 「导入授权文件…」。返回挂好导入表单的视图。 */
async function openImport(src, { onImport } = {}) {
  const s = createSandbox(src)
  s.state.statusDoc = s.mkStatus()
  const inner = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && onImport !== void 0) {
      const body = JSON.parse(init.body)
      if (body.action === 'importContents' || body.action === 'importPaths') {
        s.state.actions.push(body)
        return { ok: true, status: 200, json: async () => ({ ok: true, result: onImport(body) }) }
      }
    }
    return inner(url, init)
  }
  let view = await s.settle()
  const more = view.buttons.find((b) => b.props?.['aria-label'] === 'more')
  more.props.onClick()
  view = await s.settle()
  view.buttons.find((b) => b.props?.role === 'menuitem' && b.props.children === 'actionImport').props.onClick()
  view = await s.settle()
  return { s, view }
}

const fileInputOf = (view) => findAll(view.tree, (n) => n.type === 'input' && n.props?.type === 'file')[0]
const importButton = (view) => view.buttons.find((b) => b.props?.children === 'importSubmit')

test('B3 导入：主控件是文件选择器；选两个文件提交 importContents（base64），干净导入后表单关闭', async (t) => {
  const { s, view } = await openImport(SOURCE, { onImport: () => ({ imported: ['u1', 'u2'], errors: [] }) })
  t.after(() => s.unmount())
  assert.ok(view.buttons.some((b) => b.props?.children === 'importPick'), '有「选择文件…」按钮')
  assert.ok(!findAll(view.tree, (n) => n.type === 'textarea').length, '路径输入默认收起')
  fileInputOf(view).props.onChange({ target: { files: [fakeFile('a.info', '{"a":1}'), fakeFile('b.info', '{"b":2}')] } })
  let next = await s.settle()
  assert.ok(next.has('a.info') && next.has('b.info'), '列出已选文件名')
  importButton(next).props.onClick()
  next = await s.settle()
  const sent = s.state.actions.find((a) => a.action === 'importContents')
  assert.ok(sent !== void 0, '发出了 importContents')
  assert.equal(sent.variantKey, 'cn')
  assert.deepEqual(sent.files.map((f) => [f.name, Buffer.from(f.data, 'base64').toString('utf8')]), [['a.info', '{"a":1}'], ['b.info', '{"b":2}']])
  assert.equal(fileInputOf(next), void 0, '全部导入成功后表单关闭')
})

test('B3 导入：有文件未导入时表单留着，逐个写明原因', async (t) => {
  const { s, view } = await openImport(SOURCE, {
    onImport: () => ({ imported: [], errors: [{ path: '/x/y/wrong.info', code: 'region-mismatch' }, { path: 'junk.txt', code: 'invalid-json' }] })
  })
  t.after(() => s.unmount())
  fileInputOf(view).props.onChange({ target: { files: [fakeFile('wrong.info', '{}'), fakeFile('junk.txt', 'x')] } })
  importButton(await s.settle()).props.onClick()
  const next = await s.settle()
  assert.ok(fileInputOf(next) !== void 0, '表单仍在')
  assert.ok(next.has('importFailedCount'))
  assert.ok(next.has('importErrLine'), `逐文件原因：${JSON.stringify(next.texts.filter((x) => x.startsWith('import')))}`)
})

test('B3 导入：超过 64 KB 的文件在前端就拦下，不发请求', async (t) => {
  const { s, view } = await openImport(SOURCE, { onImport: () => ({ imported: [], errors: [] }) })
  t.after(() => s.unmount())
  fileInputOf(view).props.onChange({ target: { files: [fakeFile('huge.bin', 'x', 64 * 1024 + 1)] } })
  let next = await s.settle()
  assert.ok(next.has('importTooLarge'))
  importButton(next).props.onClick()
  next = await s.settle()
  assert.equal(s.state.actions.filter((a) => a.action === 'importContents').length, 0)
  assert.ok(next.has('importPickEmpty'), '没选到有效文件时提示先选择')
})

test('B3 导入：「按路径导入」展开后仍走 importPaths', async (t) => {
  const { s, view } = await openImport(SOURCE, { onImport: () => ({ imported: ['u1'], errors: [] }) })
  t.after(() => s.unmount())
  view.buttons.find((b) => textOf(b).includes('importByPath')).props.onClick()
  let next = await s.settle()
  findAll(next.tree, (n) => n.type === 'textarea')[0].props.onChange({ target: { value: '/a/one.info\n\n /a/two.info ' } })
  next = await s.settle()
  importButton(next).props.onClick()
  await s.settle()
  const sent = s.state.actions.find((a) => a.action === 'importPaths')
  assert.deepEqual(sent?.paths, ['/a/one.info', '/a/two.info'])
})

test('B3 反向：去掉前端大小校验时，超大文件会被发出去', async (t) => {
  const src = mutate(SOURCE, 'file.size > IMPORT_MAX_BYTES', 'false')
  const { s, view } = await openImport(src, { onImport: () => ({ imported: [], errors: [] }) })
  t.after(() => s.unmount())
  fileInputOf(view).props.onChange({ target: { files: [fakeFile('huge.bin', 'x', 64 * 1024 + 1)] } })
  importButton(await s.settle()).props.onClick()
  await s.settle()
  assert.equal(s.state.actions.filter((a) => a.action === 'importContents').length, 1, '突变后的世界会发请求 —— 上一条用例正是在防这个')
})

/* ── B4：菜单键盘导航 ─────────────────────────────────────────────────── */

test('B4 menuNextIndex：上下循环、跳过不可用项、Home/End、无关键返回 undefined', () => {
  const s = createSandbox(SOURCE)
  const { menuNextIndex } = s.mod.uiInternals
  const enabled = [0, 2, 4] // 1 是分隔线、3 是 disabled
  assert.equal(menuNextIndex(enabled, -1, 'ArrowDown'), 0, '焦点不在菜单里时 ↓ 到第一项')
  assert.equal(menuNextIndex(enabled, -1, 'ArrowUp'), 4, '焦点不在菜单里时 ↑ 到最后一项')
  assert.equal(menuNextIndex(enabled, 0, 'ArrowDown'), 2, '跳过分隔线')
  assert.equal(menuNextIndex(enabled, 2, 'ArrowDown'), 4, '跳过 disabled')
  assert.equal(menuNextIndex(enabled, 4, 'ArrowDown'), 0, '末项 ↓ 回到首项')
  assert.equal(menuNextIndex(enabled, 0, 'ArrowUp'), 4, '首项 ↑ 到末项')
  assert.equal(menuNextIndex(enabled, 2, 'Home'), 0)
  assert.equal(menuNextIndex(enabled, 2, 'End'), 4)
  assert.equal(menuNextIndex(enabled, 2, 'a'), void 0)
  assert.equal(menuNextIndex([], -1, 'ArrowDown'), void 0)
  s.unmount()
})

/** 带 focus() 的假元素，记录谁被聚焦。 */
function focusable(name, log) {
  return { name, focus: () => log.push(name) }
}

test('B4 Menu：↓ 打开菜单；菜单项是 tabIndex=-1 的 menuitem；Escape 把焦点还给触发按钮', async (t) => {
  const listeners = new Map()
  const document = {
    activeElement: null,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type)
  }
  const s = createSandbox(SOURCE, { document })
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus()
  let view = await s.settle()
  const more = view.buttons.find((b) => b.props?.['aria-label'] === 'more')
  const log = []
  more.props.ref.current = focusable('trigger', log)
  let prevented = false
  more.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => (prevented = true) })
  view = await s.settle()
  assert.equal(prevented, true)
  const items = view.buttons.filter((b) => b.props?.role === 'menuitem')
  assert.ok(items.length > 0, '↓ 打开了菜单')
  assert.ok(items.every((b) => b.props.tabIndex === -1), '菜单项不进 Tab 顺序')
  assert.equal(typeof findAll(view.tree, (n) => n.props?.role === 'menu')[0].props.onKeyDown, 'function')
  listeners.get('keydown')({ key: 'Escape' })
  view = await s.settle()
  assert.ok(!view.buttons.some((b) => b.props?.role === 'menuitem'), 'Escape 关闭')
  assert.deepEqual(log, ['trigger'], 'Escape 后焦点回到触发按钮')
})

test('B4 Menu：菜单内 ↓ 按 menuNextIndex 移焦点并 preventDefault；Tab 只关闭', async (t) => {
  const document = { activeElement: null, addEventListener: () => void 0, removeEventListener: () => void 0 }
  const s = createSandbox(SOURCE, { document })
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus()
  let view = await s.settle()
  view.buttons.find((b) => b.props?.['aria-label'] === 'more').props.onClick()
  view = await s.settle()
  const log = []
  const items = view.buttons.filter((b) => b.props?.role === 'menuitem')
  const nodes = items.map((b, i) => focusable(`item${i}`, log))
  items.forEach((b, i) => b.props.ref(nodes[i]))
  const menu = findAll(view.tree, (n) => n.props?.role === 'menu')[0]
  document.activeElement = nodes[0]
  let prevented = false
  menu.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => (prevented = true) })
  assert.equal(prevented, true)
  assert.notEqual(log.at(-1), 'item0', `↓ 离开第一项：${JSON.stringify(log)}`)
  menu.props.onKeyDown({ key: 'Tab' })
  view = await s.settle()
  assert.ok(!view.buttons.some((b) => b.props?.role === 'menuitem'), 'Tab 关闭菜单')
})

test('B4 反向：触发按钮不处理方向键时，↓ 打不开菜单', async (t) => {
  const src = mutate(SOURCE, 'if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;', 'return;')
  const s = createSandbox(src, { document: { activeElement: null, addEventListener: () => void 0, removeEventListener: () => void 0 } })
  t.after(() => s.unmount())
  s.state.statusDoc = s.mkStatus()
  let view = await s.settle()
  const more = view.buttons.find((b) => b.props?.['aria-label'] === 'more')
  more.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => void 0 })
  view = await s.settle()
  assert.ok(!view.buttons.some((b) => b.props?.role === 'menuitem'))
})
