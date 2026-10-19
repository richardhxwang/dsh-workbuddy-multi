# dsh-workbuddy-multi — 设计说明

> 面向开发者。使用说明见 [README](../README.md)。

`dsh-workbuddy-connect` 的**多账号伴侣插件**。让 WorkBuddy / WorkBuddy AI 两个模型组
同时挂多个账号：默认粘住当前账号、撞上游频率限制时自动冷却换号，并且每个账号都能
单独暴露成一个独立模型组手动选。

**硬保证：本插件一行都不改 `dsh-workbuddy-connect`。** 它只使用上游 `package.json`
声明的公开导出面（`WorkBuddyCredentialStore` / `WorkBuddyUpstreamClient` /
`createWorkBuddyAdapter` / `WORKBUDDY_VARIANTS` 等）和上游文档化的
`WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE` 环境变量。上游升级不影响本插件，
本插件的存在也不影响上游。

除了被动收割（从桌面 App 抓、从文件导入），还可以**主动扫码登录**新账号——走 WorkBuddy
官方登录页，本插件只做转发与脱敏；以及**保活**：定时给快过期的账号换 access token，
并把「需要重新登录」的账号单独标出来，而不是让它们静默失效。

---

## ⚠️ 五个必须知道的限制

### (a) 上游若设了显式 `authFile`，会盖过本插件

上游解析凭据路径的优先级是**「插件配置里填的路径 → 环境变量 → 平台默认路径」**
（`host-heartbeat-sjotAEdb.js:3462-3469`，注释原文：_the plugin's configured path, then
the environment variable, then the platform defaults_）：

```js
const fromEnv = process.env[this.variant?.env ?? "WORKBUDDY_AUTH_FILE"];
const explicit =
  this.desktopPathOverride ??
  (fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : void 0);
if (explicit !== void 0) return [explicit];
```

本插件是靠**接管环境变量**把上游指向账号池里的当前账号文件的。如果你在
`dsh-workbuddy-connect` 自己的设置里填过 `authFile` / `authFileAI`，那个显式值会
**优先于环境变量**，于是账号池失效——轮换看起来在工作，实际上上游一直读同一个文件。

**处置**：在设置卡片顶部的「需要注意」区会明确列出这条告警。看到它就去
`dsh-workbuddy-connect` 的设置里**清空 `authFile` / `authFileAI` 两个字段**，
让环境变量重新生效。

### (b) CN 账号的 token 是本机加密信封，快照只有本机能用、不能跨机搬

CN（`workbuddy`）variant 的 `accessToken` / `refreshToken` / `nickname` /
`phoneNumber` 在磁盘上是**加密信封**（`{"$wbEncrypted":1,"envelope":"…"}`），
解密密钥来自 WorkBuddy 桌面 App 的静态密钥（上游 `WorkBuddyAtRestKeyProvider`
会去 spawn App 取）。

因此：

- 账号池里存的是**原始字节快照**（`cp` 级别），本插件**不解析、不解密、不重新序列化**
  ——重新序列化会破坏信封。
- 这份快照**只在这台机器上有意义**。把 `~/.dsh/workbuddy-pool/` 拷到另一台机器，
  CN 账号会直接失败，因为那台机器的 App 密钥不同。
- **不要**把 CN 的 `.info` 文件当凭据跨机传播，也不要用它做备份迁移。
  AI（`workbuddy-ai`）variant 的 token 是明文，没有这个限制。

### (c) 本插件的独立模型组在宿主重启后才出现

每个账号的独立模型组（`WorkBuddy · <显示名>` / `WorkBuddy AI · <显示名>`）是在宿主
启动时注册路由的。新启用一个账号、改显示名、或删除账号后：

- **账号池的轮换立刻生效**（上游每次都重新 `readFile`，见下），
- 但**新增 / 改名的模型组要等宿主重启**（退出并重新打开 DSH Desktop）。

插件本身**不会**替你重启 DSH——那条对话就在 DSH 里跑着。设置卡片会一直显示这条提醒。

---

### (d) 主动登录拿到的凭据，卡片永远看不到

扫码登录成功后，账号直接进池子（`~/.dsh/workbuddy-pool/accounts/<v>/<uid>.info`，权限 0600）。
宿主 HTTP 接口**强制脱敏**：响应里不会出现 `accessToken`、`refreshToken`、
`$wbEncrypted` 信封或快照正文，`loginPoll` 成功时只回 `{uid, nickname, email?}`。
所以卡片不显示凭据、也不提供复制凭据的入口——这是有意的边界，不是没做完。
需要看凭据就自己看池子文件。

### (e) 关掉面板就停止轮询，不留后台定时器

「+ 登录新账号」展开后，等待扫码期间**只有一个 1 秒定时器**：它同时驱动倒计时
和每两秒一次的 `loginPoll`。定时器的生命周期就是组件的生命周期——设置卡片收起、
Plugins 页切走、或组件卸载，定时器立即被清掉，不会留在后台继续打宿主。

所以：**关掉面板 = 不再轮询**。服务端那条登录链接本身仍然有效（默认 600 秒），
重新打开面板可以再生成一条；宿主的 `login.js` 也会自己回收超时的登录。面板关闭时
**刻意不发** `loginCancel`——收起一个面板不该产生一次网络写操作，只有显式点「取消登录」才取消。

## 工作原理

```
dsh-workbuddy-multi（伴侣插件）
├─ lib/pool.js       账号池：快照存储 / 抓取 / 导入 / 索引 / 冷却
├─ lib/rotation.js   环境变量接管 + 轮换策略 + llm/retry 撞限换号
├─ lib/pinned.js     每账号一套 store+shim+adapter → 独立模型组
├─ lib/index.js      入口：Config / apply / 设置卡片的宿主动作线
└─ lib/client.js     设置卡片 UI（浏览器半）
```

### 为什么改文件就生效（不需要重启）

上游 `readDesktop()` **没有任何缓存**，每次调用都重新 `readFile`；而
`resolve() → current() → readDesktop()` 在**每次请求**的发送路径上
（`lib/index.js:774: credential = await store.resolve();`）。

所以本插件切换「当前账号」= 原子地把账号池里那份快照覆盖到
`~/.dsh/workbuddy-pool/active/<cn|ai>.info`，**下一次请求**就换号了，无需重启。

### 磁盘布局

根目录 `~/.dsh/workbuddy-pool`（可用环境变量 `WORKBUDDY_POOL_ROOT` 覆盖）：

```
<root>/
  index.json                     # 唯一索引，原子写
  active/<cn|ai>.info            # 当前生效账号的原始字节（上游实际读它）
  accounts/<cn|ai>/<uid>.info    # 每个账号的原始字节快照（0600）
  accounts/<cn|ai>/<uid>.meta.json
  import/<cn|ai>/*.{info,json}   # 手动导入落地区
```

账号快照一律 `0600`，写入一律「写临时文件 + rename」原子替换。

### 轮换策略

| policy                  | 行为                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `on-rate-limit`（默认） | 平时粘住当前账号；上游报 `RATE_LIMIT` / `QUOTA` / `ACCOUNT_QUOTA` 时，把当前账号冷却到上游文案里的重置时刻并自动换下一个 |
| `round-robin`           | 每次请求分发前换下一个可用账号，跳过停用与冷却中的                                                                       |
| `manual`                | 只认手动选择，不自动换号                                                                                                 |

### 独立模型组

每个启用中的账号会被建一套 `store + client + catalog + shim + adapter`，
用自己的 `providerId` 注册（`workbuddy-<uid前8位>` / `workbuddy-ai-<uid前8位>`），
显示名 `WorkBuddy · <label>` / `WorkBuddy AI · <label>`。

**基准路由 `workbuddy` / `workbuddy-ai` 永远由上游持有**，本插件绝不注册同名 route。

### 区域（region）安全

CN 账号绝不能喂给 AI variant，反之亦然——上游会抛
`WorkBuddyElectronPathError("credential-region-mismatch")`。账号池按 variant 分目录
存放（`accounts/cn/` 与 `accounts/ai/`），导入时也不会跨 variant 混用。

---

## 安装

插件源码在 `~/General/sessions/2026/10/19/08/dsh-workbuddy-multi/`。
把它挂进 DSH profile（以 `desktop` 为例）：

```bash
cd ~/.dsh/profiles/desktop

# 1) 先备份（该目录已有 .bak-* 惯例）
cp package.json      package.json.bak-wbm-$(date +%Y%m%d%H%M%S)
cp cordis.patch.yml  cordis.patch.yml.bak-wbm-$(date +%Y%m%d%H%M%S)

# 2) dependencies 里加本地路径
#    "dsh-workbuddy-multi": "file:/path/to/dsh-workbuddy-multi"
#
# 3) dsh.profile.bundles 数组末尾加
#    "dsh-workbuddy-multi"
#
# 4) 安装
pnpm install
```

> **注意 `pnpm` 的 volta shim 可能报错**（`Could not find executable "pnpm"`）。
> 若如此，改用可用的包管理器安装，或直接把插件目录放进
> `~/.dsh/profiles/desktop/node_modules/dsh-workbuddy-multi`（符号链接即可）
> 并手工改 `package.json` 的 `dependencies` 与 `dsh.profile.bundles`。

装完**完全退出并重新打开 DSH Desktop**（插件不会替你重启）。

### 依赖说明：为什么 `dsh-workbuddy-connect` 在 `peerDependencies` 而不是 `dependencies`

本插件必须和宿主**共用同一个** `dsh-workbuddy-connect` 实例：

- 轮换引擎是通过环境变量让**上游那个实例**的 store 去读账号池的；两个副本会指向两套
  状态。
- `@deepseek-ai/dsh-llm-pi-ai` 对重复 route id 会以 `DUPLICATE_ADAPTER` 拒绝，
  两个副本各自注册 `workbuddy` 会直接冲突。

放进 `dependencies` 会让 pnpm 有可能嵌套装出第二个副本，所以声明成
`peerDependencies`（同时列在 `devDependencies` 里供本仓库跑单测）。
`dsh-workbuddy-connect@^0.7.8` 与 profile 里已有的 `0.7.8` 满足该范围。

`peerDependencies` 里其余的 `@deepseek-ai/*` 版本**照上游 `package.json` 逐字抄**
（`0.2.1-rc.2` 等）。这些包由 DSH 本体内置，不在 profile 的 `node_modules` 里，
所以精确 pin 反映的是「上游 0.7.8 在这个 DSH 构建上验证过的一套」。
如果你在不同 DSH 版本上看到 peer 版本告警，把这几条放宽成 `^0.2.1-rc.1` 即可
（profile 里其它插件就是这么写的）。

---

## 验证

### 1. 静态检查（不需要 DSH）

在插件目录里：

```bash
node --check lib/client.js
python3 -c "import json;json.load(open('package.json'));print('package.json OK')"
python3 -c "import yaml;yaml.safe_load(open('cordis.patch.yml'));print('cordis.patch.yml OK')"
```

### 2. 插件是否被加载

重启 DSH Desktop 后，打开 **设置 → 插件**，应该能看到卡片
**「WorkBuddy 多账号」**。展开后是策略选择器、两个 variant 的账号区、以及
「已暴露为独立模型组」区。

模型选择器里应该出现 `WorkBuddy · <label>` / `WorkBuddy AI · <label>` 这些独立模型组
（每个启用中的账号一个）。

### 3. 宿主动作面直接探（不依赖 UI）

桌面版的 web 服务监听在本机（本会话是 `http://127.0.0.1:50498`）：

```bash
curl -s http://127.0.0.1:50498/plugins/dsh-workbuddy-multi/status | python3 -m json.tool
```

**不要手动加 `Origin` 头**：上游的 `loopbackRequest()` 判据是
`Host` 的 hostname 属于 `127.0.0.1` / `::1` / `localhost`，
**且** `Origin` 缺失或其 hostname 也是 loopback。带上一个外源 `Origin` 会被判为
非回环并返回 403。`curl` 默认不发 `Origin`，所以上面这条能过；卡片是同源 `fetch`，
同样不带 `Origin`。

看得到的字段：

- `policy` —— 当前轮换策略
- `variants[]` —— 每个 variant 的 `key` / `routeId` / `displayName` / `accounts[]` /
  `activeUid` / `cooling[]`
- `pinned[]` —— 已被暴露为独立模型组的账号
- `warnings[]` —— 需要用户处理的问题（含限制 (a) 的 `authFile` 冲突告警）

### 4. 账号池落盘

```bash
ls -la ~/.dsh/workbuddy-pool/
ls -la ~/.dsh/workbuddy-pool/accounts/cn/  ~/.dsh/workbuddy-pool/accounts/ai/
```

`*/*.info` 应为 `-rw-------`（0600）。

---

## 主动登录（扫码加账号）

上一轮只能被动收割（从桌面 App 抓、从文件导入）。这一轮加了主动登录：走 WorkBuddy
**官方**的扫码登录页，本插件不代你登录、不碰验证码、不经手密码。

```
点「+ 登录新账号」→ 选 国内版 / 国际版
   → 宿主 loginStart → POST {endpoint}/v2/plugin/auth/state?platform=…
   → 卡片拿到 verificationUri（https://www.codebuddy.cn/login?platform=workbuddy&state=<uuid>）
   → 你在浏览器/手机打开它，用微信扫码
   → 卡片每 2 秒 loginPoll 一次（宿主转发上游状态）
   → 上游回 code=0/200 且带 accessToken → 宿主写池子 → 卡片重新读 status → 新账号高亮「刚刚加入」
```

面板上的东西：

- 链接**可点**（`target="_blank"` + `rel="noreferrer"`）也**可复制**（剪贴板按钮）
- 600 秒**倒计时**（`m:ss`）
- **状态行**：宿主把上游的 pending 文案原样透过来，通常是 `11217:login ing...`。
  卡片**逐字显示**、不翻译成「等待中」——那会把唯一能反映进度的信息抹掉。
- 三态收尾：成功 / 失败（带「重新生成链接」）/ 取消
- 双区域选择器：国内版（`codebuddy.cn`）/ 国际版（`workbuddy.ai`），
  与池子的 `variantKey` 域 `'cn' | 'ai'` 一一对应

登录成功后账号立刻能用；它自己的**独立模型组**仍然遵守限制 (c)，要宿主重启才出现。

## 保活

卡片顶部有一条 `status().keepalive`：

- `running` 徽标（巡检中 / 已停止）
- 「上次巡检 <时间>」——从来没有巡检过会显示「尚未巡检」
- 统计：`成功 N · 失败 N · 跳过 N`
- 若调度器不可用会显示 `unavailable` 的原因

这条线是给「静默失败」用的：调度器死了以后所有账号看起来都正常，直到它们一起过期。
每个账号行还有一个「刷新」按钮（`refreshAccount`），立刻拿 refresh token 换一个新
access token；失败会显示在账号行上（`lastRefreshError`）。

加密信封的 CN 账号（从桌面 App 收割来的）**不会**被保活刷新——上游会在它成为当前
账号时自己刷。这类账号不标 `needsRelogin`，也不会被反复重试。

### 保活只刷「闲置」账号，绝不碰当前活跃账号

这条规则不是优化，是避免互相作废：

- 当前活跃账号由上游 `dsh-workbuddy-connect` 在**每次请求的发送路径上**按需刷新；
- **OAuth refresh token 是一次性轮换的**——我们若也拿同一份去刷同一个账号，
  谁后刷谁就让对方手里那份作废（轻则误标 `needsRelogin`，重则把你的上游会话踢成
  「需要重新登录」）。

所以分工是**上游管活跃的那个、我们管闲置的那些**，绝不重叠。实现上是
`skipActive: true`（默认）：巡检时按档位读一次 `pool.activeUid()`，命中当前活跃账号就跳过，
**连快照都不读**，并计进「跳过 N」。

> ⚠️ 别把它关掉（`skipActive: false`）除非你在排障且确定没有别的东西在刷同一个账号。
> 关掉之后你要自己承担两个消费者抢同一份 refresh token 的后果。

---

## 设置卡片：显示项与动作

每个 variant（WorkBuddy / WorkBuddy AI）一节。账号行显示：

- 显示名 `label`、uid 前 8 位、`uin`
- 登录到期时间（`expiresAt`）；已过期会显著标出
- **剩余有效期**按粗粒度单位显示（`还有 5 小时` / `还有 42 分钟` / `还有 3 天`），
  过期的账号显示 `已过期` 后跟一段时长
- 是否**当前使用**（`uid === activeUid`）
- 是否**已停用**（`enabled === false`）
- **冷却中**会显示到几点（`冷却中至 HH:mm`）
- 来源（桌面抓取 / 手动导入 / 扫码登录）
- **需要重新登录**（`needsRelogin`）及其原因，例如 refresh token 已被吊销
- 上次刷新失败的原因（`lastRefreshError`）
- 上次使用时间
- **刚刚加入**的高亮：主动登录成功后，那个账号会有一圈醒目描边直到你刷新或切换。

动作按钮：

| 按钮                    | 动作                                       | 形参                     |
| ----------------------- | ------------------------------------------ | ------------------------ |
| 设为当前                | `select`                                   | `variantKey, uid`        |
| 换下一个                | `advance`                                  | `variantKey`             |
| 启用 / 停用             | `setEnabled`                               | `variantKey, uid, on`    |
| 改名                    | `setLabel`                                 | `variantKey, uid, label` |
| 删除                    | `remove`                                   | `variantKey, uid`        |
| 刷新（每个账号一行）    | `refreshAccount`                           | `variantKey, uid`        |
| 从桌面 App 抓取         | `refreshFromDesktop`                       | `variantKey`             |
| 导入文件…               | `importPaths`                              | `variantKey, paths[]`    |
| 登录新账号              | `loginStart` / `loginPoll` / `loginCancel` | 见下                     |
| 策略选择器              | `setPolicy`                                | `policy`                 |
| 分组方式（合并/按账号） | `setPinned`                                | `on`（boolean）          |
| 刷新积分                | `refreshCredits`                           | `variantKey?, force?`    |

顶部还显示 `status().warnings`（其中 `authFile` 冲突那条会用醒目样式）、
`status().keepalive`（保活巡检状态），以及 `status().pinned`（哪些账号已被暴露为独立模型组）。

删除账号只移除**本地快照**，不会把桌面 App 里的账号登出。

---

## 合并模式与积分合计

### 两种分组方式，运行时可切（不用重启）

同一个版本的多账号有两种暴露方式，卡片顶部可随时切换：

| 模式             | 效果                                                         | 模型组的 provider id                 |
| ---------------- | ------------------------------------------------------------ | ------------------------------------ |
| **合并**（默认） | 同版本的所有账号共用**一个**模型组，账号由插件按策略自动轮换 | 上游的 `workbuddy` / `workbuddy-ai`  |
| **按账号**       | 每个账号一个独立模型组，可手动指定用哪个                     | 本插件的 `workbuddy-m-<uid 前 8 位>` |

**国内版与国际版永远分开** —— 这是上游两个 variant 决定的，不是可选项，所以任何模式下你都至少有两个组。

切换是**运行时**的：切换动作会即时注册/注销 provider 并广播 `llm/adapters-updated`，不需要重启
宿主。（需要重启的是另一件事：**新增的** provider 首次进入模型选择器。）

> 默认合并的原因：多账号的意义就是「撞到频控自动换下一个」，合并模式下这才对用户无感；
> 想手动指定某个账号时再切到按账号。

### 积分合计

合并模式下，一个模型组代表整个档位的所有账号，所以「还剩多少积分」应该是**池内合计**。
上游那个 chip 只显示**当前生效的那一个凭据**（它的数据来自上游自己的 status 路由，那个 payload
里没有「池」的概念），我们改不了它 —— 所以本插件在**同一个位置换成自己的数字**：

```
1,150                ← 本插件（池内合计；上游那个「↻ + 数字」被隐藏）
WB AI.100（积分）    ← 上游原来的样子（按账号模式下不变，仍显示这一个账号）
```

**为什么文案只有一个数字**：DSH 的作曲区那一行会测量自己的子元素宽度，**装不下时它会把模型名和
推理强度一起收起来**（只留图标）。我们的数字和模型名挤在同一行，所以文案刻意只留**裸数字**：
连 `（积分）` 这个后缀也去掉（约 44px），把宽度让给模型名。单位、组名、每个账号的明细都在悬停提示里。

- 只在**合并模式**、且当前会话选中的是本插件所属的模型组（`workbuddy` / `workbuddy-ai`）时出现。
- 任一账号 `unlimited` 时显示 `∞`；不全时后缀 `·不完整`；一次都没算出来时显示 `—`。
- 悬停可看各账号的明细（`uid 前 8 → 数`），点 `↻` 立即重算。
- 每账号的完整明细（含「拿不到数的原因」）在设置卡片里。

**数字是怎么来的**：逐个账号去问计费接口；但**桌面 App 收割来的国内版账号拿不到数** ——
它的 token 是 `$wbEncrypted` 加密信封，只有本机 App 能解。这类账号如果正好是当前生效的那个，
就回落到**上游自己的 status 路由**取它算好的那一个数（既不多发请求，也不假装知道）。所以
国内版假如只有一个密文账号，合计就等于上游显示的那个数；有扫码登录来的明文账号时才会真正累加。

**只读**：算积分只发计费 GET，**不写任何文件**，也不缓存到磁盘（内存 TTL 默认 60 秒）。

---

## 宿主 HTTP 接口

浏览器半只能靠 `fetch` 到宿主注册的路由，所以宿主动作面有一层很薄的 HTTP 映射
（照抄上游 `/plugins/<包名>/…` 的布局）：

```
GET  /plugins/dsh-workbuddy-multi/status    只读，绝无副作用
POST /plugins/dsh-workbuddy-multi/action    { action, ...形参 }
```

POST 的成功响应是 `200 {ok:true, result:…}`，失败是 `4xx/5xx {ok:false, error:"…"}`。
卡片**不把 `result` 当真相**：每次写操作后再 `GET /status` 重新读取，这样即使写成功
但响应丢失，界面也仍然正确。

`status()` 本身是**只读**的——它绝不触发抓取、刷新或轮换；抓取由插件的定时器和
显式动作负责。

原因：读操作放 GET、任何改状态的操作（含 `refreshFromDesktop`，它会读桌面文件并花掉
一次上游请求）放 POST，这条分工继承自上游把自己的「刷新模型」写操作放到 probe 路由
而不是 status GET。

### 未就绪时的 503 不是错误

宿主在池子还没装上、插件还没 ready 时，对**任何**请求都回
`503 {ok:false, error, status:<status 空壳>}`。那个 `status` 字段是一份完整的
status 文档（字段齐全、只是 `accounts` 为空），目的就是让卡片能立刻把 `warnings`
显示出来，而不必等下一次轮询。

卡片会**采纳这个空壳**——但只在屏幕上还没有真文档时采纳，绝不把已有的真文档降级成空壳。

### 本轮新增的动作

| 动作             | 形参                       | `result`                                                  |
| ---------------- | -------------------------- | --------------------------------------------------------- |
| `loginStart`     | `variantKey, expiresInMs?` | `{loginId, verificationUri, expiresAt, userCode?}`        |
| `loginPoll`      | `loginId`                  | `{done, status?, code?, uid?, nickname?, email?, error?}` |
| `loginCancel`    | `loginId`                  | `{cancelled}`                                             |
| `refreshAccount` | `variantKey, uid`          | `{uid, refreshed, expiresAt?}`                            |

`loginPoll` 的结果是**互斥三态**：`done:false` 带 `status` 字符串表示还在等；
`done:true` 要么带 `uid`+`nickname`（成功），要么带 `error`（失败）。
判定顺序固定为 **error → uid → status**，所以「同时有 error 和 uid」按失败的失败处理，
不会误报成功。

`status()` 新增两个只读字段：

- `status().keepalive` → `{running, lastSweepAt?, lastOk?, lastFailed?, lastSkipped?, unavailable?}`
- `status().logins` → `[{loginId, variantKey, expiresAt, status?}]`

`status()` 仍然是**只读**的：它不触发巡检、不刷新、不轮询。

### 登录接口是转发的，不是自研协议

`loginStart` 转发上游官方登录页的
`POST {endpoint}/v2/plugin/auth/state?platform=…`，登录完成后用
`POST {endpoint}/v2/plugin/auth/token` 换 token。本插件只做转发与脱敏，
不实现图片验证码，也不经手密码。

---

## 故障排查

| 现象                                        | 原因与处置                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 卡片显示「需要注意」里有 authFile 告警      | 限制 (a)。去上游插件设置里清空 `authFile` / `authFileAI`                                        |
| 轮换看起来没生效，一直用同一个账号          | 同上；或策略是 `manual`（只认手动选择）                                                         |
| `curl` 得到 403                             | 请求被判为非回环。检查是否有代理/反代改写 `Host`，或你手动塞了 `Origin`                         |
| 卡片显示「读取状态失败: HTTP 404」          | 宿主没挂路由。确认 `dsh-workbuddy-multi` 在 `dsh.profile.bundles` 里，且已重启                  |
| 新账号没有出现独立模型组                    | 限制 (c)。主动退出并重开 DSH Desktop                                                            |
| CN 账号一换就失败，AI 账号正常              | 限制 (b)。CN 快照是本机加密信封，确认它是**在这台机器上**抓取/导入的                            |
| 账号导入后报 region mismatch                | 把 CN 的文件导进了 AI（或反之）。按 variant 分别导入                                            |
| 上游升级后 peer 版本告警                    | 见「依赖说明」；把 `@deepseek-ai/*` 收紧/放宽到与上游一致                                       |
| 登录一直停在 `11217:login ing...`           | 扫码还没完成。600 秒后链接失效，点「重新生成链接」                                              |
| 登录报「登录已过期 / 未知的 loginId」       | 宿主已回收该登录，重新生成一条                                                                  |
| 某个账号点「刷新」报 refresh token 已被吊销 | 这个账号**无法自动恢复**，只会标 `needsRelogin`；重新扫码或从桌面 App 重新抓一次                |
| 账号行出现「需要重新登录」                  | 同上。不要反复点刷新——保活会跳过它，不会无限重试                                                |
| 保活显示「已停止」                          | 宿主的调度器不可用（`status().keepalive.unavailable` 里会写原因）；账号仍可用，只是不再自动续期 |
| 「刚刚加入」的高亮一直不消失                | 点一次卡片顶部的「刷新」，或切到别的 variant 再回来                                             |

查看 DSH 日志里本插件的客户端降级信息：搜索
`[dsh-workbuddy-multi] client contribution failed to load`。这类日志表示某个
slot 注册失败（例如 DSH 的 slot API 有破坏性变更），但它**不影响宿主**——上游 provider
和账号池继续工作。

---

## 卸载

1. 从 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 和
   `dsh.profile.bundles` 里移除 `dsh-workbuddy-multi`。
2. `pnpm install` 后重启 DSH Desktop。
3. 可选：删掉 `~/.dsh/workbuddy-pool/`（会丢掉所有账号快照和策略设置）。

移除本插件后，`WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE` 不再被接管，
上游回到它自己的默认凭据路径（桌面 App 的 auth 文件），**不需要**重新登录。

> 本插件 `stop()` 时刻意**不回滚**环境变量：回滚会把正在运行的上游指向一个已不存在的
> 文件。宁可留下一个仍然有效的路径。

---

## 已知风险

- **R2**：加 bundle 很可能需要重启 DSH 才生效，`patchReload: live` 是否能热加载新
  bundle 未实测。
- **R4**：`llm/stream` waterfall 的确切签名在实现时确认。若该 hook 不可用，
  `round-robin` 会退化为「只在 `llm/retry` 与手动动作上换号」，`on-rate-limit`
  不受影响。
- **R5**：每个 pinned 路由要各起一个回环 shim；账号多时端口与句柄必须正确释放
  （`PinnedRoutes.dispose()`）。
- **R7**：保活与上游可能同时持有同一个账号的 refresh token。已用 `skipActive: true`
  （不碰当前活跃账号）预防，但**真机未复现**过作废现象——收益只能靠「之后不再出现
  无端 `needsRelogin`」间接印证。
- **R8（已自动修复）**：上游在**启动时**若读不到凭据，会把该档位的目录 `setVisible(false)` ⇒
  该组一个模型都不显示（`models=0`、`catalog:fallback`）。现在由 `lib/heal.js` 自愈：第一个回环
  请求到达后读一次上游 status，**只有**确属「已登录但目录空」才借上游自己的 `probe` 路由刷一次，
  每档每进程一次、失败静默、好状态零请求（`healBaseline: false` 可关）。它在真机上复现并修好过，
  残留风险只剩「上游把那条内部路由改名」——那时自愈失效，但不影响聊天。
- **R9**：积分合计里，桌面 App 收割来的国内版账号是 `$wbEncrypted` 密文，我们解不开，
  只能借上游 status 路由的**那个数**（`source:'fallback'`）。上游换算法或该路由改名，
  这个数就会退回 `null`（显示为「—」，不会拿 0 冒充）。

### 合并模式下的合计会**取代**上游那个数字，不是并排

输入框右侧那一行会测量自己子元素的宽度，装不下时会把**模型名**收起来（宿主给它加
`data-model-compact`）。模型名比一个数字重要得多，所以合计 chip 不是「再加一个」：

- 我们把自己那个 ↻ 的 `aria-label` 特意做成与上游不同（`creditsRefreshPooled`）；
- 再用一条**只在我们挂载期间生效**的 CSS（锚在上游「↻ + 数字」这个结构上，`:root[data-workbuddy-multi-merged="1"]`）
  把上游那个「当前账号」的数字连同它自己的 ↻ 藏掉。

于是同一个位置只有一个数字：我们的合计。按账号模式下这条 CSS 不生效，上游的数字照旧。
两个方向的失败都是温和的：上游若改了那个 `aria-label`，只是又并排出现两个数字；
我们自己的标签若哪天被改成与上游相同，才会把自己也藏掉 —— 这一条由
单元测试钉住。

## 文件清单

| 文件                   | 作用                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `lib/index.js`         | 宿主入口：`apply` / `Config` / 设置卡片的动作线 / Web 路由       |
| `lib/pool.js`          | 账号池：存储 / 抓取 / 导入 / 索引 / 冷却                         |
| `lib/rotation.js`      | 环境变量接管 + 轮换策略 + 429 换号                               |
| `lib/pinned.js`        | 每账号独立模型组                                                 |
| `lib/login.js`         | 主动登录：转发上游官方扫码登录、轮询、脱敏后写池子               |
| `lib/keepalive.js`     | 保活巡检：定时刷新即将过期的账号，跳过需重登/加密信封账号        |
| `lib/credits.js`       | 积分合计：逐账号问上游（密文账号回落上游 status 路由）           |
| `lib/client.js`        | 设置卡片 UI（浏览器半，`dsh.client.platform: "web"`）            |
| `cordis.patch.yml`     | bundle patch：把本插件插进 profile 的 bundle 列表                |
| `package.json`         | 清单：`dsh.bundle.patch` / `dsh.client.inject` / peer 依赖       |
| `test/`                | `node --test` 单测、集成与渲染级测试（`npm test`）               |
| `tools/check-ascii.py` | 中文注释里混进全角/形近字符的守卫（`lib/client.js` 因 JSX 豁免） |

## 测试

```bash
npm test   # node --test，含单元、集成、渲染级与反向（变异）测试
```
