# 在线播放接入方案：复用洛雪音乐自定义源

> 状态：待实施 ｜ 撰写日期：2026-09-13

## 1. 调研结论

**结论：可行。** 在 Electron 主进程内实现洛雪自定义源宿主运行时，兼容性最好、无新增原生依赖、不影响现有 PyInstaller 后端打包。

### 1.1 洛雪自定义源机制要点（依据官方文档）

- 自定义源为 **纯 JavaScript（ES6+）事件驱动脚本**，UTF-8 编码，文件头必须有注释元数据（`@name` 必填，`@description/@version/@author/@homepage` 可选）。
- 脚本通过 **`globalThis.lx`** 与宿主交互，无 DOM 依赖：

| API | 说明 |
|---|---|
| `lx.version` / `lx.env` | API 版本 / 运行环境（桌面端固定 `desktop`） |
| `lx.currentScriptInfo` | 脚本头部解析出的元信息 + `rawScript` 原始代码 |
| `lx.on(EVENT_NAMES.request, handler)` | 注册请求处理回调，**必须返回 Promise** |
| `lx.send(EVENT_NAMES.inited, { sources, openDevTools })` | 初始化完成后上报支持的源声明；inited 之前脚本出错视为加载失败 |
| `lx.send(EVENT_NAMES.updateAlert, { log, updateUrl })` | 源更新提示（每次运行仅可调用一次） |
| `lx.request(url, options, callback)` | 无跨域限制的 HTTP 请求；`options` 支持 `method/headers/body/form/formData/timeout`；`callback(err, resp)`；返回值为取消函数 |
| `lx.utils.buffer` | `from` / `bufToString`（对应 Node Buffer） |
| `lx.utils.crypto` | `aesEncrypt / md5 / randomBytes / rsaEncrypt` |
| `lx.utils.zlib` | `inflate(buffer) => Promise<Buffer>` / `deflate(buffer) => Promise<Buffer>` |

- **支持的操作（actions）**：
  - `musicUrl`：所有源可用。`info = { type, musicInfo }`，`type` 为音质（`128k/320k/flac/flac24bit`），返回歌曲 HTTP URL。
  - `lyric` / `pic`：仅 `local` 源可用。lyric 返回 `{ lyric, tlyric, rlyric, lxlyric }`（`lxlyric` 为逐字歌词，格式 `[mm:ss.ms]<offset,duration>字`）。
- **源 key**：`kw / kg / tx / wy / mg / local`。
- **关键限制**：自定义源脚本**不提供搜索能力**。洛雪应用内搜索由软件内置实现，源脚本只负责"已知 musicInfo → 取 URL/歌词/封面"。

### 1.2 对本项目的含义

1. 源脚本只解决"播放链路"，**搜索需自建平台适配器**（kw/wy/tx 等公开搜索接口），搜索结果构造为含平台 ID 的 `musicInfo` 再交给源脚本。
2. `lx.utils` 依赖的 crypto/zlib/buffer 在 Node 环境可 1:1 实现（洛雪桌面版本身即 Electron + Node）。
3. 音乐平台音频 URL 普遍有**防盗链**（校验 Referer/UA）且时效短 → 必须经本地代理转发音频流，每次播放现取 URL。

### 1.3 方案选型对比

| 方案 | 结论 |
|---|---|
| **A. Electron 主进程 Node `vm` 沙箱运行源脚本（采纳）** | 与洛雪桌面版行为最接近，crypto/zlib/Buffer 原生齐全，无 CORS 问题 |
| B. Python 后端嵌入 JS 引擎（dukpy/quickjs） | 对 async/Promise 与异步 IO 桥接支持差，crypto/zlib 需额外绑定，兼容性风险高 |
| C. 引入第三方 lx-source HTTP 服务（Go） | 外部进程依赖，与单 exe 分发理念冲突 |
| D. 渲染进程内运行脚本 | CORS 限制、Referer 无法伪装、缺 Node crypto/zlib，不可行 |

## 2. 总体架构

```
┌─ 渲染进程 (Vue3) ─────────────┐
│  在线搜索页(新增)  playerStore │  playSong(online 歌曲)
└──────┬───────────────┬────────┘
       │ IPC           │ IPC
┌──────▼───────────────▼── Electron 主进程 ──────┐
│  搜索适配器 onlineSearch.js   SourceHost(核心)  │
│  kw/wy/tx 公开搜索接口        vm 沙箱·lx 事件桥 │
│                               sources/ 源库     │
└──────┬───────────────┬────────────────────────┘
       │ HTTPS         │ lx.request
┌──────▼───────────────▼── 外部 ─────────────────┐
│  平台搜索 API          第三方源服务/聚合 API    │
└────────────────────────────────────────────────┘

播放流：playerStore → IPC musicUrl → 源脚本返回 CDN URL
       → audio.src = /api/online/proxy?url=...  (Flask 代理, 伪装 Referer/UA, 透传 Range)
       → 平台音频 CDN
```

数据流说明：

- **搜索**：渲染进程 → IPC → 搜索适配器 → 平台公开 API → 统一歌曲结构（含平台 ID）返回前端。
- **播放**：playerStore 检测在线歌曲 → IPC 调 SourceHost 执行源脚本 `musicUrl` → 得真实 URL → `audio.src` 指向 Flask 代理 → 代理伪装 Referer 拉流。
- **源文件**：持久化在软件根目录 `sources/`，符合"应用数据存软件根目录"的项目硬约束。

## 3. 模块设计

### 3.1 SourceHost 宿主运行时（核心）— `electron/sourceHost.js`

为每个源脚本创建独立 `vm` 沙箱上下文，注入 `globalThis.lx`：

| lx API | 实现 |
|---|---|
| `request(url, opts, cb)` | Node `http/https`；支持 `method/headers/body/form/formData/timeout`；返回 abort 函数；`resp.body` 按 Content-Type 自动解析 JSON（对齐洛雪行为），否则给 Buffer |
| `utils.buffer.from / bufToString` | 透传 Node `Buffer` |
| `utils.crypto.*` | Node `crypto` 实现 aesEncrypt / md5 / randomBytes / rsaEncrypt |
| `utils.zlib.*` | Node `zlib` 实现 inflate / deflate（返回 Promise） |
| `on / send / EVENT_NAMES` | 宿主事件桥：脚本 `send('inited', …)` 完成注册；宿主调用已注册的 `request` handler 并 await 其 Promise |
| `env / version / currentScriptInfo` | `desktop` / 对齐洛雪当前 API 版本 / 头部注释解析结果 |

**加载流程**：

1. 读取脚本文件（UTF-8）。
2. 正则解析头部注释元数据（`@name` 等）。
3. `vm.createContext` 建沙箱（注入 `lx`、`console`、`setTimeout/setInterval`、`Promise` 等；**不注入** `require/process`）。
4. 执行脚本，等待 `inited` 事件（超时 10s 判失败）。
5. 记录 `sources` 声明：`{ [sourceKey]: { name, actions, qualitys } }`。

**对外接口**：

```js
await sourceHost.load(filePath)                    // 加载并注册
await sourceHost.unload(scriptId)
sourceHost.list()                                   // [{ id, meta, sources, enabled }]
await sourceHost.request(scriptId, source, action, info)  // 调脚本 request handler
```

### 3.2 源管理 — `electron/sourceManager.js` + IPC

- 存储：`<软件根目录>/sources/*.js`；`sources.json` 记录启用状态与排序。
- 导入：Electron 原生文件对话框选 `.js` → 拷贝入 `sources/` → 试加载验证（失败即回滚并提示原因）。
- IPC 通道（沿用现有 `ipcMain.handle` + preload 显式枚举模式）：

| 通道 | 说明 |
|---|---|
| `source:list` | 源列表（含每个源声明的平台/音质/actions） |
| `source:import` | 导入源文件 |
| `source:remove` | 删除源 |
| `source:toggle` | 启用/禁用 |
| `source:reload` | 重新加载（源文件更新后） |

### 3.3 搜索适配器 — `electron/onlineSearch.js`

洛雪源不含搜索，搜索由自建适配器解决。**2026-09-13 已实测验证四平台搜索接口全部可用**：

| 平台 | 接口 | 验证结果 |
|---|---|---|
| tx（QQ） | `c.y.qq.com/soso/fcgi-bin/client_search_cp` | ✅ 标准 JSON，返回 `songmid` |
| kg（酷狗） | `songsearch.kugou.com/song_search_v2` | ✅ 标准 JSON，返回 `FileHash` |
| wy（网易云） | `music.163.com/api/cloudsearch/pc`（POST） | ✅ 免加密，返回 `id` |
| kw（酷我） | `search.kuwo.cn/r.s`（老接口） | ✅ 可用，但返回**单引号伪 JSON**，需 `eval` 沙箱内求值或正则转标准 JSON；新接口 `kuwo.cn/api/www/...` 被 WAF 拦截（Node 裸请求拿不到 `kw_token`），作为备选 |

建议默认启用 tx + kg + wy 三个稳定接口，kw 走老接口兜底。

统一返回结构：

```js
{
  id: 'online:kw:{rid}',   // 字符串 ID，与本地数字 ID 天然区分
  online: true,
  source: 'kw',
  name, singer, album, duration, interval,
  // 平台 ID 全量携带，最大化兼容不同源脚本的 musicInfo 取值习惯
  meta: { rid, hash, songmid, id, mid, ... }
}
```

- 调源脚本 `musicUrl` 时，`musicInfo` 由上述结构展开（`hash/songmid/rid/id/mid` 全塞入）。

### 3.4 播放链路

- 在线歌曲 ID：`online:{source}:{platformId}`。
- `playerStore._play()` 检测 `online` 标记：
  1. IPC `online:getUrl`（sourceHost → 脚本 `musicUrl`）。
  2. 得 URL → `audio.src = /api/online/proxy?url=<encoded>`。
- **Flask 代理**（新增 `app/api/online.py`）：
  - 流式转发音频，**透传 Range 头**（保证 seek/进度条可用）。
  - 按平台注入 Referer / User-Agent。
  - 不落盘、不缓存（URL 时效短）。
  - 现有 CSP `media-src 'self'` **无需改动**（媒体仍同源）。
- **音质降级链**：`flac24bit → flac → 320k → 128k`，取源声明支持的最高可用音质；请求失败自动降档。
- **换源重试**：多个启用源支持同一平台时，失败自动尝试下一源；全部失败 toast 提示。

### 3.5 歌词 / 封面

- 优先调源的 `lyric` action（仅 local 源声明支持时），返回 `{ lyric, tlyric, rlyric, lxlyric }`：
  - `lyric` 标准 LRC → 复用现有歌词解析管线。
  - `lxlyric` 逐字格式 `[mm:ss.ms]<offset,duration>字` → 新增解析器，接入已有卡拉OK逐字模式。
  - `tlyric` 翻译 → 复用现有 `showTranslation` 显示逻辑。
- 源不支持时，由搜索适配器的平台歌词接口兜底。
- 封面：源的 `pic` action 或搜索结果自带 `picUrl`；加载失败回退现有默认封面组件。

### 3.6 UI 接入

- **Sidebar**：新增"在线搜索"入口（图标用语义明确的搜索/云图标，遵循图标辨识度教训）。
- **OnlineSearchView**：搜索框 + 结果列表（来源徽标、时长、音质标识）+ 播放 / 下一首播放 / 加入队列（复用 SongList / SongContextMenu 交互模式）。
- **SettingsModal**：新增"自定义源"分组：
  - 源列表：名称 / 版本 / 作者 / 支持平台与音质 / 启用开关 / 删除 / 重新加载。
  - 导入按钮、默认音质偏好选择。
- 在线歌曲入库时标记 `online=1`（或独立内存表），使收藏 / 队列 / 最近播放 / 睡眠定时等现有机制零改动复用。
- 切歌通知、桌面歌词、迷你播放器：在线歌曲走同一 playerStore 状态，天然适配（通知封面用 `picUrl`）。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 第三方脚本安全性（可发任意网络请求） | vm 沙箱隔离（无 require/process）+ 导入时明确提示；与洛雪同一信任模型，**应用不内置任何源**，规避版权问题 |
| 源脚本兼容性差异 | `musicInfo` 塞全平台 ID 字段；`lx.request` 的 body JSON 解析、form/formData 编码严格对齐洛雪桌面版；用 2~3 个主流第三方源脚本做兼容验证 |
| 音频 URL 时效短 | 每次播放现取，不缓存；代理纯流式转发 |
| `inited` 前脚本出错 / 超时 | 加载失败回滚 + toast 提示具体错误；单源崩溃不影响其他源（沙箱相互独立） |
| 打包分发 | 全部逻辑在 Electron 主进程 JS，无原生依赖；PyInstaller 后端仅新增一个 Flask 蓝图，无影响 |

> **Phase 1 实测补充**：
> - QQ 接口 `Content-Type: application/x-javascript` 但内容为 JSON → 宿主对文本类响应一律先尝试 `JSON.parse`（已在 sourceHost.js 实现）。
> - 部分第三方源用 `/*!`（压缩保留注释）而非 `/**` 写头部元数据 → parseMeta 已兼容两种格式。

## 5. 实施阶段

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **Phase 1** ✅ 已完成 2026-09-13 | SourceHost 宿主 + 源管理 IPC + 设置页源管理 UI | 能导入真实第三方源脚本并完成 `inited` 握手，列表正确显示平台/音质声明 |
| **Phase 2** | 播放链路：musicUrl 调用 + Flask 代理 + playerStore 接入 + 音质降级/换源 | 手工构造在线歌曲可完整播放、可 seek、失败自动降档 |
| **Phase 3** | 在线搜索（酷我适配器）+ 搜索视图 | 关键词搜索 → 结果列表 → 点击播放全链路通畅 |
| **Phase 4** | 歌词/封面/逐字解析 + 通知、桌面歌词、迷你播放器适配 | 在线歌曲歌词（含逐字）正常显示，各子窗口状态同步 |

## 6. 附：关键数据结构

**源声明（inited 上报）**：

```js
{
  sources: {
    kw: { name: '酷我音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k','320k','flac','flac24bit'] },
    local: { name: '本地', type: 'music', actions: ['musicUrl','lyric','pic'], qualitys: [] }
  }
}
```

**musicUrl 请求**：

```js
{ source: 'kw', action: 'musicUrl', info: { type: '320k', musicInfo: { hash, songmid, rid, id, name, singer, ... } } }
// 返回：string 音频 URL
```

**lyric 返回**：

```js
{ lyric: '...', tlyric: '...'|null, rlyric: '...'|null, lxlyric: '[00:00.000]<0,36>测<36,36>试...'|null }
```
