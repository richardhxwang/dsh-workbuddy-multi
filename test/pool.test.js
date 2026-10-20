import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WorkBuddyPool,
  POOL_VARIANTS,
  parseAccountDoc,
  regionOfDomain,
  isEncryptedToken,
  normalizeExpiry,
  isAccountDead,
  variantFor,
  POLICY_VALUES,
} from '../lib/pool.js'

// ── 夹具 ────────────────────────────────────────────────────────────────

const BASE = 1_700_000_000_000

/** CN 版的 token 是逐字段加密信封；这里用同样形状的假信封，验证「不解析不重写」。 */
function cnDoc(uid, { expiresAt = BASE + 3_600_000, refreshExpiresAt = BASE + 86_400_000 } = {}) {
  return {
    account: {
      uid,
      nickname: { $wbEncrypted: 1, envelope: 'ZmFrZS1uaWNr' },
      uin: '100000000001',
      type: 'personal',
      phoneNumber: { $wbEncrypted: 1, envelope: 'ZmFrZS1waG9uZQ==' },
    },
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'ZmFrZS1hdA==' },
      refreshToken: { $wbEncrypted: 1, envelope: 'ZmFrZS1ydA==' },
      tokenType: 'Bearer',
      domain: 'www.workbuddy.cn',
      expiresAt,
      refreshExpiresAt,
    },
    accounts: [],
    allAccounts: [],
  }
}

function aiDoc(uid, { expiresAt = BASE + 3_600_000, refreshExpiresAt = BASE + 3_600_000 } = {}) {
  return {
    account: { uid, nickname: 'user@example.com', uin: '100000000002', type: 'personal' },
    auth: {
      accessToken: 'plain-access-token',
      refreshToken: 'plain-refresh-token',
      tokenType: 'Bearer',
      domain: 'www.workbuddy.ai',
      expiresAt,
      refreshExpiresAt,
    },
    accounts: [],
    allAccounts: [],
  }
}

/** 故意不使用空格缩进，用来验证快照是**逐字节**复制而不是重新序列化。 */
function rawJson(doc) {
  return JSON.stringify(doc)
}

async function makeEnv(t) {
  const root = await mkdtemp(join(tmpdir(), 'wbp-root-'))
  const desktop = await mkdtemp(join(tmpdir(), 'wbp-desktop-'))
  const prev = process.env.WORKBUDDY_DESKTOP_AUTH_DIR
  process.env.WORKBUDDY_DESKTOP_AUTH_DIR = desktop
  t.after(async () => {
    if (prev === undefined) delete process.env.WORKBUDDY_DESKTOP_AUTH_DIR
    else process.env.WORKBUDDY_DESKTOP_AUTH_DIR = prev
    await rm(root, { recursive: true, force: true })
    await rm(desktop, { recursive: true, force: true })
  })
  let clock = BASE
  const pool = new WorkBuddyPool({ root, now: () => clock })
  await pool.load()
  return {
    root,
    desktop,
    pool,
    tick: (ms = 1000) => {
      clock += ms
      return clock
    },
    clockNow: () => clock,
    async writeDesktop(variantKey, doc) {
      const v = variantFor(variantKey)
      const p = join(desktop, v.desktopFilename)
      const bytes = Buffer.from(rawJson(doc), 'utf8')
      await fsp.writeFile(p, bytes)
      return { path: p, bytes }
    },
  }
}

async function exists(p) {
  try {
    await fsp.stat(p)
    return true
  } catch {
    return false
  }
}

async function modeOf(p) {
  const st = await fsp.stat(p)
  return st.mode & 0o777
}

// ── 纯函数 ──────────────────────────────────────────────────────────────

test('parseAccountDoc: CN 加密信封也能读出 uid/domain/region，且不试图解密', () => {
  const parsed = parseAccountDoc(rawJson(cnDoc('uid-cn-1')))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.uid, 'uid-cn-1')
  assert.equal(parsed.uin, '100000000001')
  assert.equal(parsed.domain, 'www.workbuddy.cn')
  assert.equal(parsed.region, 'cn')
  assert.equal(parsed.expiresAt, BASE + 3_600_000)
  // 加密的 nickname 不是 string，所以「读不到昵称」必须退化为空，而不是 '[object Object]'
  assert.equal(parsed.nickname, '')
})

test('parseAccountDoc: AI 明文文档读得到 nickname', () => {
  const parsed = parseAccountDoc(rawJson(aiDoc('uid-ai-1')))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.region, 'global')
  assert.equal(parsed.nickname, 'user@example.com')
})

test('parseAccountDoc: 非 JSON / 缺 uid 都要拒绝', () => {
  assert.deepEqual(parseAccountDoc('not json'), { ok: false, error: 'invalid-json' })
  assert.deepEqual(parseAccountDoc(JSON.stringify({ account: {}, auth: {} })), {
    ok: false,
    error: 'missing-uid',
  })
  assert.equal(parseAccountDoc('null').ok, false)
})

test('regionOfDomain / normalizeExpiry / isAccountDead', () => {
  assert.equal(regionOfDomain('www.workbuddy.cn'), 'cn')
  assert.equal(regionOfDomain('WWW.WorkBuddy.AI'), 'global')
  assert.equal(regionOfDomain('example.com'), undefined)
  assert.equal(regionOfDomain(''), undefined)

  const ms = 1_794_671_029_521
  assert.equal(normalizeExpiry(ms), ms)
  // 秒 -> 毫秒（秒精度天然丢掉毫秒部分，只能比到秒）
  assert.equal(normalizeExpiry(Math.floor(ms / 1000)), Math.floor(ms / 1000) * 1000)
  assert.equal(normalizeExpiry('2026-10-19T00:00:00Z'), Date.parse('2026-10-19T00:00:00Z'))
  assert.equal(normalizeExpiry(undefined), undefined)

  assert.equal(isAccountDead({ refreshExpiresAt: BASE - 1 }, BASE), true)
  assert.equal(isAccountDead({ refreshExpiresAt: BASE + 1 }, BASE), false)
  assert.equal(isAccountDead({}, BASE), false)
})

test('POOL_VARIANTS 与上游实测值一致（route id / env / region）', () => {
  const cn = variantFor('cn')
  const ai = variantFor('ai')
  assert.equal(cn.routeId, 'workbuddy')
  assert.equal(cn.env, 'WORKBUDDY_AUTH_FILE')
  assert.equal(cn.region, 'cn')
  assert.equal(cn.desktopFilename, 'workbuddy-desktop.info')
  assert.equal(ai.routeId, 'workbuddy-ai')
  assert.equal(ai.env, 'WORKBUDDY_AI_AUTH_FILE')
  // 上游 AI variant 的 region 是 'global'，不是 'ai'
  assert.equal(ai.region, 'global')
  assert.equal(ai.desktopFilename, 'workbuddy-desktop-ai.info')
  assert.deepEqual(POOL_VARIANTS.map((v) => v.key), ['cn', 'ai'])
  assert.ok(POLICY_VALUES.includes('on-rate-limit'))
})

// ── 捕获与字节保真 ──────────────────────────────────────────────────────

test('captureFromDesktop: 快照与源文件逐字节一致，且权限 0600', async (t) => {
  const env = await makeEnv(t)
  const { bytes } = await env.writeDesktop('cn', cnDoc('uid-cn-1'))

  const meta = await env.pool.captureFromDesktop('cn')
  assert.ok(meta)
  assert.equal(meta.uid, 'uid-cn-1')
  assert.equal(meta.source, 'desktop')
  assert.equal(meta.enabled, true)
  assert.equal(meta.bytes, bytes.length)
  // label 退化为 uid 前 8 位（CN 昵称是加密的）
  assert.equal(meta.label, 'uid-cn-1'.slice(0, 8))

  const snap = env.pool.snapshotPath('cn', 'uid-cn-1')
  const snapBytes = await fsp.readFile(snap)
  assert.ok(snapBytes.equals(bytes), '快照必须是原始字节的逐字复制（重新序列化会写坏加密信封）')
  assert.equal(await modeOf(snap), 0o600)
})

test('captureFromDesktop: region 不匹配时不得产生任何快照（守卫必须拦在写盘之前）', async (t) => {
  const env = await makeEnv(t)
  // 把一份 AI 文档塞进 CN 的桌面文件名 —— 上游会以 credential-region-mismatch 抛错
  await env.writeDesktop('cn', aiDoc('uid-wrong-region'))

  const meta = await env.pool.captureFromDesktop('cn')
  assert.equal(meta, null)
  assert.equal(env.pool.list('cn').length, 0)
  assert.equal(await exists(env.pool.snapshotPath('cn', 'uid-wrong-region')), false, '被拒绝的账号绝不能落盘')
})

test('captureAll: 两个 variant 各自捕获', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-cn-1'))
  await env.writeDesktop('ai', aiDoc('uid-ai-1'))

  const out = await env.pool.captureAll()
  assert.equal(out.cn.uid, 'uid-cn-1')
  assert.equal(out.ai.uid, 'uid-ai-1')
  assert.equal(env.pool.list('cn').length, 1)
  assert.equal(env.pool.list('ai').length, 1)
})

// ── 生效文件与轮换 ──────────────────────────────────────────────────────

test('setActive: active 文件与快照逐字节一致，且权限 0600', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-cn-1'))
  await env.pool.captureFromDesktop('cn')

  await env.pool.setActive('cn', 'uid-cn-1', { reason: 'test' })
  assert.equal(env.pool.activeUid('cn'), 'uid-cn-1')

  const activeBytes = await fsp.readFile(env.pool.activeFilePath('cn'))
  const snapBytes = await fsp.readFile(env.pool.snapshotPath('cn', 'uid-cn-1'))
  assert.ok(activeBytes.equals(snapBytes))
  assert.equal(await modeOf(env.pool.activeFilePath('cn')), 0o600)
})

test('setActive: 账号不存在时抛错，且不留下半截文件', async (t) => {
  const env = await makeEnv(t)
  await assert.rejects(() => env.pool.setActive('cn', 'nope'), /account not found/)
  assert.equal(await exists(env.pool.activeFilePath('cn')), false)
})

test('advance: 环形轮换，跳过冷却中的账号', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-a'))
  await env.pool.captureFromDesktop('cn')
  env.tick()
  await env.writeDesktop('cn', cnDoc('uid-b'))
  await env.pool.captureFromDesktop('cn')
  env.tick()
  await env.writeDesktop('cn', cnDoc('uid-c'))
  await env.pool.captureFromDesktop('cn')

  assert.equal(env.pool.list('cn').length, 3)

  const first = await env.pool.advance('cn', { reason: 'test' })
  assert.equal(first, 'uid-a')
  const second = await env.pool.advance('cn', { reason: 'test' })
  assert.equal(second, 'uid-b')

  // 冷却 b，下一次应跳到 c
  await env.pool.setCooldown('cn', 'uid-b', { until: env.clockNow() + 600_000, reason: 'rate-limit' })
  const third = await env.pool.advance('cn', { reason: 'test' })
  assert.equal(third, 'uid-c')

  // 冷却 c 之后只剩 a 可用（b、c 都在冷却）
  await env.pool.setCooldown('cn', 'uid-c', { until: env.clockNow() + 600_000, reason: 'rate-limit' })
  const back = await env.pool.advance('cn', { reason: 'test' })
  assert.equal(back, 'uid-a')
})

test('advance: 冷却到期后重新可用', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-a'))
  await env.pool.captureFromDesktop('cn')
  env.tick()
  await env.writeDesktop('cn', cnDoc('uid-b'))
  await env.pool.captureFromDesktop('cn')

  await env.pool.setActive('cn', 'uid-a', { reason: 'test' })
  await env.pool.setCooldown('cn', 'uid-b', { until: env.clockNow() + 1000, reason: 'rate-limit' })
  assert.deepEqual(
    env.pool.selectable('cn').map((m) => m.uid),
    ['uid-a'],
  )
  env.tick(2000)
  assert.deepEqual(
    env.pool.selectable('cn').map((m) => m.uid),
    ['uid-a', 'uid-b'],
  )
})

test('advance: 全部不可用时返回 undefined，且不改动 active', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-a'))
  await env.pool.captureFromDesktop('cn')
  await env.pool.setActive('cn', 'uid-a', { reason: 'test' })
  await env.pool.setEnabled('cn', 'uid-a', false)

  const r = await env.pool.advance('cn', { reason: 'test' })
  assert.equal(r, undefined)
})

test('ensureActive: 空池返回 undefined；有账号时自动挑一个', async (t) => {
  const env = await makeEnv(t)
  assert.equal(await env.pool.ensureActive('cn'), undefined)

  await env.writeDesktop('cn', cnDoc('uid-a'))
  await env.pool.captureFromDesktop('cn')
  const uid = await env.pool.ensureActive('cn')
  assert.equal(uid, 'uid-a')
  assert.equal(env.pool.activeUid('cn'), 'uid-a')
})

test('ensureActive: 生效账号被停用后自动换到另一个', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-a'))
  await env.pool.captureFromDesktop('cn')
  env.tick()
  await env.writeDesktop('cn', cnDoc('uid-b'))
  await env.pool.captureFromDesktop('cn')

  await env.pool.setActive('cn', 'uid-a', { reason: 'test' })
  await env.pool.setEnabled('cn', 'uid-a', false)
  assert.equal(env.pool.activeUid('cn'), 'uid-b')
})

test('remove: 删快照与索引；删掉生效账号后会换号', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-a'))
  await env.pool.captureFromDesktop('cn')
  env.tick()
  await env.writeDesktop('cn', cnDoc('uid-b'))
  await env.pool.captureFromDesktop('cn')
  await env.pool.setActive('cn', 'uid-a', { reason: 'test' })

  assert.equal(await env.pool.remove('cn', 'uid-a'), true)
  assert.equal(env.pool.get('cn', 'uid-a'), undefined)
  assert.equal(await exists(env.pool.snapshotPath('cn', 'uid-a')), false)
  assert.equal(env.pool.activeUid('cn'), 'uid-b')

  assert.equal(await env.pool.remove('cn', 'uid-gone'), false)
})

// ── 导入 ────────────────────────────────────────────────────────────────

test('importFiles: 合法文件被吸收，region 不匹配被拒绝且不落盘', async (t) => {
  const env = await makeEnv(t)
  const okPath = join(env.desktop, 'external-ok.info')
  await fsp.writeFile(okPath, Buffer.from(rawJson(cnDoc('uid-import-1')), 'utf8'))
  const badPath = join(env.desktop, 'external-bad.info')
  await fsp.writeFile(badPath, Buffer.from(rawJson(aiDoc('uid-ai-into-cn')), 'utf8'))

  const errors = []
  const metas = await env.pool.importFiles('cn', [okPath, badPath], { onError: (e) => errors.push(e) })

  assert.equal(metas.length, 1)
  assert.equal(metas[0].uid, 'uid-import-1')
  assert.equal(metas[0].source, 'import')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].error, 'region-mismatch')

  assert.equal(await exists(env.pool.snapshotPath('cn', 'uid-ai-into-cn')), false)
  assert.ok(await exists(env.pool.snapshotPath('cn', 'uid-import-1')))

  // 导入落地区保留原始字节
  const landed = join(env.pool.importDir('cn'), 'uid-import-1.info')
  assert.ok(await exists(landed))
  const src = await fsp.readFile(okPath)
  assert.ok((await fsp.readFile(landed)).equals(src))
})

test('importFiles: 坏 JSON 被拒绝', async (t) => {
  const env = await makeEnv(t)
  const p = join(env.desktop, 'broken.info')
  await fsp.writeFile(p, 'this is not json')
  const errors = []
  const metas = await env.pool.importFiles('cn', [p], { onError: (e) => errors.push(e) })
  assert.equal(metas.length, 0)
  assert.equal(errors[0].error, 'invalid-json')
})

test('absorbImportDir: 按 sha256 幂等，重复吸收不产生新账号', async (t) => {
  const env = await makeEnv(t)
  const p = join(env.pool.importDir('cn'), 'dropped.info')
  await fsp.writeFile(p, Buffer.from(rawJson(cnDoc('uid-drop-1')), 'utf8'))

  const first = await env.pool.absorbImportDir('cn')
  assert.equal(first.length, 1)
  assert.equal(first[0].uid, 'uid-drop-1')

  const second = await env.pool.absorbImportDir('cn')
  assert.equal(second.length, 0, '同一文件第二次吸收必须被跳过')
  assert.equal(env.pool.list('cn').length, 1)

  // 内容变了才重新吸收
  await fsp.writeFile(p, Buffer.from(rawJson(cnDoc('uid-drop-2')), 'utf8'))
  const third = await env.pool.absorbImportDir('cn')
  assert.equal(third.length, 1)
  assert.equal(third[0].uid, 'uid-drop-2')
})

// ── 刷新回收 ────────────────────────────────────────────────────────────

test('harvestActive: 上游刷新写回 active 后，新 token 必须被收回快照', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-a', { expiresAt: BASE + 3_600_000 }))
  await env.pool.captureFromDesktop('cn')
  await env.pool.setActive('cn', 'uid-a', { reason: 'test' })

  // 模拟上游刷新：它写回的是我们托管给它的那个文件
  const fresher = rawJson(cnDoc('uid-a', { expiresAt: BASE + 7_200_000 }))
  await fsp.writeFile(env.pool.activeFilePath('cn'), fresher)

  await env.pool.harvestActive('cn')
  const meta = env.pool.get('cn', 'uid-a')
  assert.equal(meta.expiresAt, BASE + 7_200_000)
  const snapBytes = await fsp.readFile(env.pool.snapshotPath('cn', 'uid-a'))
  assert.equal(snapBytes.toString('utf8'), fresher)
})

test('harvestActive: active 比快照旧时不回退', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-a', { expiresAt: BASE + 7_200_000 }))
  await env.pool.captureFromDesktop('cn')
  await env.pool.setActive('cn', 'uid-a', { reason: 'test' })

  await fsp.writeFile(env.pool.activeFilePath('cn'), rawJson(cnDoc('uid-a', { expiresAt: BASE + 1000 })))
  await env.pool.harvestActive('cn')
  assert.equal(env.pool.get('cn', 'uid-a').expiresAt, BASE + 7_200_000)
})

// ── 持久化与自愈 ────────────────────────────────────────────────────────

test('load: 快照文件被外部删除后索引自动清理，生效 uid 被清空', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-a'))
  await env.pool.captureFromDesktop('cn')
  await env.pool.setActive('cn', 'uid-a', { reason: 'test' })

  await fsp.unlink(env.pool.snapshotPath('cn', 'uid-a'))

  const pool2 = new WorkBuddyPool({ root: env.root, now: () => env.clockNow() })
  await pool2.load()
  assert.equal(pool2.list('cn').length, 0)
  assert.equal(pool2.activeUid('cn'), undefined)
})

test('load: 磁盘上有快照但索引没有时自动补登（手工丢文件也能用）', async (t) => {
  const env = await makeEnv(t)
  await fsp.mkdir(join(env.root, 'accounts', 'ai'), { recursive: true })
  await fsp.writeFile(
    join(env.root, 'accounts', 'ai', 'uid-manual.info'),
    rawJson(aiDoc('uid-manual')),
  )

  const pool2 = new WorkBuddyPool({ root: env.root, now: () => env.clockNow() })
  await pool2.load()
  const list = pool2.list('ai')
  assert.equal(list.length, 1)
  assert.equal(list[0].uid, 'uid-manual')
})

test('setPolicy: 只接受白名单值', async (t) => {
  const env = await makeEnv(t)
  assert.equal(env.pool.policy(), 'on-rate-limit')
  await env.pool.setPolicy('round-robin')
  assert.equal(env.pool.policy(), 'round-robin')
  await assert.rejects(() => env.pool.setPolicy('bogus'), /unknown policy/)
})

test('setLabel: 空白标签回退到 uid 前 8 位', async (t) => {
  const env = await makeEnv(t)
  await env.writeDesktop('cn', cnDoc('uid-a'))
  await env.pool.captureFromDesktop('cn')

  await env.pool.setLabel('cn', 'uid-a', '工作号')
  assert.equal(env.pool.get('cn', 'uid-a').label, '工作号')
  await env.pool.setLabel('cn', 'uid-a', '   ')
  assert.equal(env.pool.get('cn', 'uid-a').label, 'uid-a'.slice(0, 8))
})

test('changed 事件带 variantKey 与受控 reason', async (t) => {
  const env = await makeEnv(t)
  const seen = []
  env.pool.on('changed', (e) => seen.push(e.reason))

  await env.writeDesktop('cn', cnDoc('uid-a'))
  await env.pool.captureFromDesktop('cn')
  await env.pool.setActive('cn', 'uid-a', { reason: 'test' })
  await env.pool.setLabel('cn', 'uid-a', 'X')
  await env.pool.setPolicy('manual')

  for (const reason of seen) {
    assert.ok(
      ['active', 'enable', 'label', 'remove', 'import', 'capture', 'cooldown', 'policy'].includes(reason),
      `意外的 reason: ${reason}`,
    )
  }
  assert.ok(seen.includes('capture'))
  assert.ok(seen.includes('active'))
  assert.ok(seen.includes('label'))
  assert.ok(seen.includes('policy'))
})

test('未 load 就调用必须报错（防止静默空池）', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wbp-unloaded-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pool = new WorkBuddyPool({ root })
  assert.throws(() => pool.list('cn'), /load\(\) 必须先调用/)
})

// ── 主动登录入库 / 全池自动续期（PLAN §3.5.3）────────────────────────────────

/**
 * 我们自己的 OAuth 登录产物：**明文** token。
 * 国内版的 domain 走 codebuddy.*（登录端点在那边），国际版是 workbuddy.ai。
 */
function oauthDoc(
  variantKey,
  uid,
  { expiresAt = BASE + 3_600_000, refreshExpiresAt = BASE + 86_400_000, domain, label } = {},
) {
  return {
    account: {
      uid,
      nickname: label ?? uid.slice(0, 8),
      uin: '999999999999',
      type: 'personal',
    },
    auth: {
      accessToken: 'oauth-access-token',
      refreshToken: 'oauth-refresh-token',
      tokenType: 'Bearer',
      domain: domain ?? (variantKey === 'ai' ? 'www.workbuddy.ai' : 'www.codebuddy.cn'),
      expiresAt,
      refreshExpiresAt,
    },
    accounts: [],
    allAccounts: [],
  }
}

test('regionOfDomain 也认 OAuth 用的 codebuddy.* 域名', () => {
  assert.equal(regionOfDomain('www.codebuddy.cn'), 'cn')
  assert.equal(regionOfDomain('WWW.CodeBuddy.AI'), 'global')
  assert.equal(regionOfDomain('www.workbuddy.ai.evil.com'), undefined)
  assert.equal(regionOfDomain('codebuddy.com'), undefined)
})

test('parseAccountDoc: 明文 token 记 encrypted:false，密文信封记 true', () => {
  assert.equal(parseAccountDoc(Buffer.from(rawJson(cnDoc('u1')))).encrypted, true)
  assert.equal(parseAccountDoc(Buffer.from(rawJson(aiDoc('u1')))).encrypted, false)
  assert.equal(parseAccountDoc(Buffer.from(rawJson(oauthDoc('cn', 'u1')))).encrypted, false)
  assert.equal(isEncryptedToken('abc'), false)
  assert.equal(isEncryptedToken({ $wbEncrypted: 1, envelope: 'x' }), true)
  assert.equal(isEncryptedToken(null), false)
  assert.equal(isEncryptedToken(undefined), false)
})

test('upsertAccount: 新账号入库为 source=oauth，快照 0600 且逐字可读回', async (t) => {
  const env = await makeEnv(t)
  const doc = oauthDoc('cn', 'uid-oauth-1')
  const meta = await env.pool.upsertAccount('cn', doc)
  assert.equal(meta.uid, 'uid-oauth-1')
  assert.equal(meta.source, 'oauth')
  assert.equal(meta.region, 'cn')
  assert.equal(meta.needsRelogin, false)
  assert.equal(meta.expiresAt, BASE + 3_600_000)
  const text = await env.pool.readSnapshotDocument('cn', 'uid-oauth-1')
  assert.equal(text, JSON.stringify(doc, null, 2))
  assert.equal(await modeOf(env.pool.snapshotPath('cn', 'uid-oauth-1')), 0o600)
  assert.equal(env.pool.get('cn', 'uid-oauth-1').label, 'uid-oaut')
})

test('upsertAccount: 档位不符必须抛错且不落盘', async (t) => {
  const env = await makeEnv(t)
  await assert.rejects(() => env.pool.upsertAccount('cn', oauthDoc('ai', 'uid-cross')), /档位不符/)
  assert.equal(await exists(env.pool.snapshotPath('cn', 'uid-cross')), false)
  assert.equal(env.pool.list('cn').length, 0)
})

test('upsertAccount: 无法解析的文档必须抛错且不落盘', async (t) => {
  const env = await makeEnv(t)
  await assert.rejects(() => env.pool.upsertAccount('cn', { hello: 'world' }), /无法解析/)
  await assert.rejects(() => env.pool.upsertAccount('cn', 'not json at all'), /无法解析/)
  assert.equal(env.pool.list('cn').length, 0)
})

test('upsertAccount: 重新登录同一 uid 保留 enabled/label/冷却，并清掉 needsRelogin', async (t) => {
  const env = await makeEnv(t)
  await env.pool.upsertAccount('ai', oauthDoc('ai', 'uid-re'))
  await env.pool.setEnabled('ai', 'uid-re', false)
  await env.pool.setLabel('ai', 'uid-re', '我的小号')
  await env.pool.setCooldown('ai', 'uid-re', { until: env.clockNow() + 60_000, reason: 'rate-limit' })
  await env.pool.markNeedsRelogin('ai', 'uid-re', 'invalid_grant')
  const meta = await env.pool.upsertAccount('ai', oauthDoc('ai', 'uid-re'))
  assert.equal(meta.enabled, false, '人工禁用的账号不能被一次重新登录悄悄打开')
  assert.equal(meta.label, '我的小号')
  assert.equal(meta.cooldownUntil, env.clockNow() + 60_000)
  assert.equal(meta.needsRelogin, false)
  assert.equal(meta.needsReloginReason, undefined)
})

test('readSnapshotDocument: 不存在的账号返回 null', async (t) => {
  const env = await makeEnv(t)
  assert.equal(await env.pool.readSnapshotDocument('cn', 'nobody'), null)
})

test('writeSnapshotDocument: 成功写回并同步 expiresAt / lastRefreshAt / 清 needsRelogin', async (t) => {
  const env = await makeEnv(t)
  await env.pool.upsertAccount('cn', oauthDoc('cn', 'uid-w1'))
  await env.pool.markNeedsRelogin('cn', 'uid-w1', 'token-expired')
  await env.pool.setLastRefreshError('cn', 'uid-w1', 'boom')
  env.tick(5000)

  const refreshed = oauthDoc('cn', 'uid-w1', {
    expiresAt: BASE + 10_000_000,
    refreshExpiresAt: BASE + 200_000_000,
  })
  const res = await env.pool.writeSnapshotDocument('cn', 'uid-w1', JSON.stringify(refreshed, null, 2))
  assert.equal(res.ok, true)
  assert.equal(res.meta.expiresAt, BASE + 10_000_000)
  assert.equal(res.meta.refreshExpiresAt, BASE + 200_000_000)
  assert.equal(res.meta.lastRefreshAt, env.clockNow())
  assert.equal(res.meta.lastRefreshError, undefined)
  assert.equal(res.meta.needsRelogin, false)
  assert.equal(await env.pool.readSnapshotDocument('cn', 'uid-w1'), JSON.stringify(refreshed, null, 2))
})

test('writeSnapshotDocument: 四类坏输入全部拒绝且快照逐字节不变', async (t) => {
  const env = await makeEnv(t)
  const original = JSON.stringify(oauthDoc('cn', 'uid-w2'), null, 2)
  await env.pool.upsertAccount('cn', oauthDoc('cn', 'uid-w2'))
  const before = await fsp.readFile(env.pool.snapshotPath('cn', 'uid-w2'))

  const cases = [
    ['not json', 'invalid-json'],
    [JSON.stringify({ hello: 1 }), 'missing-uid'],
    [JSON.stringify(oauthDoc('cn', 'uid-OTHER'), null, 2), 'uid-mismatch'],
    [JSON.stringify(oauthDoc('ai', 'uid-w2'), null, 2), 'region-mismatch'],
  ]
  for (const [text, expected] of cases) {
    const res = await env.pool.writeSnapshotDocument('cn', 'uid-w2', text)
    assert.equal(res.ok, false, `${expected} 必须被拒绝`)
    assert.equal(res.error, expected)
  }

  // 目标账号根本不在池里：文档本身完全合法，靠 get() 落空拒绝，且绝不能顺手创建出来
  const ghost = await env.pool.writeSnapshotDocument('cn', 'uid-ghost', JSON.stringify(oauthDoc('cn', 'uid-ghost'), null, 2))
  assert.equal(ghost.ok, false)
  assert.equal(ghost.error, 'unknown-account')
  assert.equal(await exists(env.pool.snapshotPath('cn', 'uid-ghost')), false)
  assert.equal(env.pool.get('cn', 'uid-ghost'), undefined)
  const after = await fsp.readFile(env.pool.snapshotPath('cn', 'uid-w2'))
  assert.deepEqual(after, before, '被拒绝时快照必须逐字节不变')
  assert.equal(after.toString('utf8'), original)
})

test('markNeedsRelogin / setLastRefreshError: 能置位也能清除', async (t) => {
  const env = await makeEnv(t)
  await env.pool.upsertAccount('ai', oauthDoc('ai', 'uid-m1'))

  let meta = await env.pool.markNeedsRelogin('ai', 'uid-m1', 'invalid_grant: Invalid refresh token')
  assert.equal(meta.needsRelogin, true)
  assert.equal(meta.needsReloginReason, 'invalid_grant: Invalid refresh token')

  meta = await env.pool.setLastRefreshError('ai', 'uid-m1', 'code 12153')
  assert.equal(meta.lastRefreshError, 'code 12153')
  assert.equal(meta.needsRelogin, true, '写诊断字段不能顺手清掉 needsRelogin')

  meta = await env.pool.markNeedsRelogin('ai', 'uid-m1', null)
  assert.equal(meta.needsRelogin, false)
  assert.equal(meta.needsReloginReason, undefined)

  meta = await env.pool.setLastRefreshError('ai', 'uid-m1', '')
  assert.equal(meta.lastRefreshError, undefined)

  assert.equal(await env.pool.markNeedsRelogin('ai', 'nobody', 'x'), undefined)
  assert.equal(await env.pool.setLastRefreshError('ai', 'nobody', 'x'), undefined)

  const reloaded = new WorkBuddyPool({ root: env.root, now: env.clockNow })
  await reloaded.load()
  assert.equal(reloaded.get('ai', 'uid-m1').lastRefreshError, undefined)
  assert.equal(reloaded.accountMeta('ai', 'uid-m1').uid, 'uid-m1')
})

test('selectable: needsRelogin 的账号 access token 过期后必须出局，仍有效时保留', async (t) => {
  const env = await makeEnv(t)
  await env.pool.upsertAccount('cn', oauthDoc('cn', 'uid-n1'))

  // (a) access token 仍然有效 → 还能用，不该因为「刷不动了」就立刻踢掉
  await env.pool.markNeedsRelogin('cn', 'uid-n1', 'invalid_grant')
  assert.deepEqual(
    env.pool.selectable('cn').map((m) => m.uid),
    ['uid-n1'],
  )

  // (b) 越过 access token 的过期时刻 → 既不能用、又不能刷，必须出局
  env.tick(3_600_001)
  assert.deepEqual(env.pool.selectable('cn'), [])

  // (c) 重新登录（换到新的明文 token）后立刻可用
  await env.pool.upsertAccount('cn', oauthDoc('cn', 'uid-n1'))
  assert.deepEqual(
    env.pool.selectable('cn').map((m) => m.uid),
    ['uid-n1'],
  )
})

test('明文凭据不得被「并不更新」的桌面密文副本降级覆盖', async (t) => {
  const env = await makeEnv(t)
  // 用户先用插件 OAuth 登录了 uid-d1（明文、可自动续期），桌面 App 里当时也是这个账号
  await env.pool.upsertAccount('cn', oauthDoc('cn', 'uid-d1', { expiresAt: BASE + 7_200_000 }))
  const plaintext = await env.pool.readSnapshotDocument('cn', 'uid-d1')

  // 桌面文件里同一 uid 的密文副本**更旧**（expiresAt 更小）→ 不能覆盖我们的明文快照
  await env.writeDesktop('cn', cnDoc('uid-d1', { expiresAt: BASE + 3_600_000 }))
  const captured = await env.pool.captureFromDesktop('cn')
  assert.equal(captured.uid, 'uid-d1')
  assert.equal(captured.source, 'oauth')
  assert.equal(captured.expiresAt, BASE + 7_200_000, '元信息必须还是明文快照的')
  assert.equal(await env.pool.readSnapshotDocument('cn', 'uid-d1'), plaintext, '快照必须仍是明文原文')

  // 桌面副本**更新**时（用户刚在 App 里登录过）则应该采纳，不能一直抱着旧 token
  await env.writeDesktop('cn', cnDoc('uid-d1', { expiresAt: BASE + 99_000_000 }))
  const fresher = await env.pool.captureFromDesktop('cn')
  assert.equal(fresher.expiresAt, BASE + 99_000_000)
  assert.match(await env.pool.readSnapshotDocument('cn', 'uid-d1'), /\$wbEncrypted/)
})

// ── S-1：uid 进文件名之前必须过白名单（目录穿越）───────────────────────────

test('parseAccountDoc：带路径分隔符/点号的 uid 一律判 invalid-uid', () => {
  for (const uid of ['../../../../tmp/pwned', 'a/b', 'a\\b', '..', '.hidden', 'x'.repeat(200)]) {
    const r = parseAccountDoc(JSON.stringify(cnDoc(uid)))
    assert.equal(r.ok, false, uid)
    assert.equal(r.error, 'invalid-uid', uid)
  }
  assert.equal(parseAccountDoc(JSON.stringify(cnDoc('4a82db90-3cdf-4a0a-84f4-b553f8a59492'))).ok, true, '真实 UUID 必须放行')
})

test('importFiles：uid 为穿越路径的文件被拒，池目录外不落任何文件', async (t) => {
  const env = await makeEnv(t)
  const outside = await mkdtemp(join(tmpdir(), 'wbp-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  // 前提：穿越路径若被 join，确实会落到池目录之外的 outside 目录
  const evilUid = `../../../../../../../../..${outside}/pwned`
  const naive = join(env.root, 'import', 'cn', `${evilUid}.info`)
  assert.ok(naive.startsWith(outside), `前提不成立：${naive}`)
  const src = join(env.desktop, 'evil.info')
  await fsp.writeFile(src, rawJson(cnDoc(evilUid)))
  const errors = []
  const metas = await env.pool.importFiles('cn', [src], { onError: (e) => errors.push(e) })
  assert.equal(metas.length, 0)
  assert.ok(errors.length >= 1, '要报错')
  assert.equal(await exists(join(outside, 'pwned.info')), false, '池目录外绝不能出现文件')
})

test('snapshotPath / metaPath：不安全 uid 直接抛出（索引文件被篡改时的第二道防线）', async (t) => {
  const env = await makeEnv(t)
  assert.throws(() => env.pool.snapshotPath('cn', '../../x'), /invalid-uid/)
  assert.throws(() => env.pool.metaPath('cn', '../../x'), /invalid-uid/)
})

// ── 导入：浏览器上传的字节（§29 B3）─────────────────────────────────────

test('importBuffers：与 importFiles 吸收同一份字节结果一致；region 不匹配与坏内容各报 code', async (t) => {
  const env = await makeEnv(t)
  const okBytes = Buffer.from(rawJson(cnDoc('uid-upload-1')), 'utf8')
  const errors = []
  const metas = await env.pool.importBuffers(
    'cn',
    [
      { name: 'ok.info', bytes: okBytes },
      { name: 'ai.info', bytes: Buffer.from(rawJson(aiDoc('uid-ai-into-cn')), 'utf8') },
      { name: 'junk.txt', bytes: Buffer.from('not json') },
      { name: 'nobytes.info', bytes: 'a string, not a Buffer' },
    ],
    { onError: (e) => errors.push(e) },
  )
  assert.deepEqual(metas.map((m) => m.uid), ['uid-upload-1'])
  assert.equal(metas[0].source, 'import')
  assert.deepEqual(errors.map((e) => [e.path, e.error === 'region-mismatch' || e.error === 'unreadable' ? e.error : 'parse']), [
    ['ai.info', 'region-mismatch'],
    ['junk.txt', 'parse'],
    ['nobytes.info', 'unreadable'],
  ])
  const landed = join(env.pool.importDir('cn'), 'uid-upload-1.info')
  assert.ok((await fsp.readFile(landed)).equals(okBytes), '落地区保留原始字节')
  assert.equal(await exists(env.pool.snapshotPath('cn', 'uid-ai-into-cn')), false)
})

test('importBuffers：uid 为穿越路径的内容被拒，池目录外不落任何文件（文件名不参与落盘路径）', async (t) => {
  const env = await makeEnv(t)
  const outside = await mkdtemp(join(tmpdir(), 'wbp-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const evilUid = `../../../../../../../../..${outside}/pwned`
  const errors = []
  const metas = await env.pool.importBuffers(
    'cn',
    [{ name: `../../../../../../..${outside}/byname.info`, bytes: Buffer.from(rawJson(cnDoc(evilUid))) }],
    { onError: (e) => errors.push(e) },
  )
  assert.equal(metas.length, 0)
  assert.ok(errors.length >= 1, '要报错')
  assert.equal(await exists(join(outside, 'pwned.info')), false)
  assert.equal(await exists(join(outside, 'byname.info')), false)
})
