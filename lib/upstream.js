/**
 * dsh-workbuddy-multi — 上游 dsh-workbuddy-connect 的可选加载
 *
 * 为什么不能 `import { … } from 'dsh-workbuddy-connect'`：DSH 启动是全有全无的，
 * 一个插件模块加载失败整个宿主就退出。静态 import 意味着「用户没装上游」= DSH 起不来，
 * 连提示「请先装上游」的机会都没有。
 *
 * 所以上游一律在运行时按需加载：加载失败时插件进入降级态（只挂 status 路由，
 * 报告 `upstream.installed = false`），由设置卡片去插件市场把上游装上。
 *
 * 不用顶层 await：宿主可能用 `require(esm)` 加载插件，带 TLA 的模块会被拒。
 */

export const UPSTREAM_PACKAGE = 'dsh-workbuddy-connect'

/** 上游在 awesome-dsh-plugin 精选目录里的 URL —— 插件市场只接受目录内的 URL 安装。 */
export const UPSTREAM_REPO_URL = 'https://github.com/corrinehu/dsh-workbuddy-connect'

let loaded = null
let lastError

/**
 * 加载上游模块；成功后缓存，失败则下次调用重试（装好上游后不重启也能接上）。
 *
 * @param {() => Promise<object>} [importer] 测试注入点
 * @returns {Promise<object|null>}
 */
export async function loadUpstream(importer) {
  if (loaded !== null) return loaded
  try {
    loaded = await (typeof importer === 'function' ? importer() : import(UPSTREAM_PACKAGE))
    lastError = undefined
  } catch (error) {
    lastError = error
    loaded = null
  }
  return loaded
}

/** 已加载的上游模块；尚未加载或加载失败时为 `null`。 */
export function upstreamModule() {
  return loaded
}

/** 最近一次加载失败的原因（只给状态页显示用）。 */
export function upstreamLoadError() {
  return lastError
}

/** 仅供测试：清空缓存。 */
export function resetUpstreamForTest() {
  loaded = null
  lastError = undefined
}
