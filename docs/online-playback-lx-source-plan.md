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

建议四平台全部默认启用（`kw/kg/tx/wy` 均已实测可用）；`kw` 走老接口，返回**单引号伪 JSON**，需 `eval` 沙箱内求值或正则转标准 JSON；新接口 `kuwo.cn/api/www/...` 被 WAF 拦截（Node 裸请求拿不到 `kw_token`），作为备选。

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
  1. IPC `online:getUrl`（主进程 `sourceManager.resolveMusicUrl` → 脚本 `musicUrl`，内含音质降级与换源）。
  2. 得 URL → `audio.src = /api/online/proxy?url=<encoded>&source=<平台key>`（`source` 供代理选 Referer）。
- **Flask 代理**（新增 `app/api/online.py`）：
  - 流式转发音频，**透传 Range 头**（保证 seek/进度条可用）。
  - 按平台注入 Referer / User-Agent。
  - 上游 URL 时效短，故**不缓存 CDN 地址**；音频字节本身则按稳定键缓存到本地（见 §3.7）。
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

### 3.7 在线播放缓存（Phase 4 之后的追加项）— `app/services/online_cache.py`

**动机**：原先代理返回 `no-store`，每播一次都从 CDN 完整重取，拖动进度条也要重新联网。
但**放开浏览器缓存也没用** —— 代理 URL 里带的是 CDN 地址，而 CDN 签名每次播放都变，缓存键永远不重复。

**做法**：渲染进程额外传一个**稳定键** `key=<平台>:<平台ID>:<音质>`（`player.js` 的 `onlineCacheKey()`），
缓存以它为准，与 CDN 签名无关：

- **命中** → `send_file(conditional=True)` 由本地文件提供，Range/seek 也走本地
- **未命中** → 边转发边写 `<sha1>.part`，**读完才 rename 转正**；中断即丢弃（绝不让半个文件冒充缓存）
- **客户端提前断开**（seek / 切歌）→ `_finish_in_background()` 复用同一条上游连接把剩余读完再转正，
  缓存仍能完成且**不额外增加流量**；`_worth_finishing()` 限定「已下 ≥1MB 且 ≥30%」才继续，
  避免用户点一下立刻切走时替其偷跑流量
- **淘汰**：LRU（命中刷新 mtime），超出 `maxBytes` 从最旧的删；配置在 `<根目录>/cache/config.json`

位置 `<根目录>/cache/audio/`（已 gitignore）。设置页「在线播放缓存」分组提供开关 / 上限 / 占用 / 清空。

> 已知边界：Windows 上正在被 `send_file` 播放的文件删不掉，`clear()`/`evict()` 会静默跳过，下次再清即可。

### 3.8 在线歌曲入库 / 下载 / 音质切换（Phase 5）— `library_service` + `app/api/online.py`

**动机**：收藏、歌单、最近播放、播放统计这些机制**全都挂在 `songs.id` 上**。
在线歌曲此前只有 `online:{平台}:{平台ID}` 这样的字符串 ID，于是这些功能一律用不了。

**做法（一句话）**：让在线歌曲在 `songs` 表里**占一行**。

`songs` 新增列：`online_source`（空串=本地文件）、`online_id`、`online_quality`、
`cover_url`、`online_meta`（完整 musicInfo 的 JSON）。`path` 用 `online://{平台}/{平台ID}` 占位
（该列 NOT NULL + UNIQUE，占位值同时保证重复入库命中同一行）。

于是：

| 能力 | 实现 |
|---|---|
| 收藏 | 复用 `songs.favorite` 与既有 `/api/favorites` |
| 加入歌单 | 复用 `playlist_songs` 与既有 `/api/playlists/<id>/songs` |
| 最近播放 / 播放统计 | 入库后有了整数 id，`pushRecent` 与 `playback_history` 直接可用 |
| 音乐库列表 | `all_songs()` 加 `online_source = ''`，在线歌曲**不会**混进本地曲库 |
| 编辑标签 / 歌词 | 无本地文件可写，只落库（后端按 `online_source` 分支） |

**为什么存 `online_meta`**：源脚本解析地址时要的是平台专有字段
（kw 的 `DC_TARGETID`、kg 的 `album_id`、tx 的 `media_mid`…），只存一个 id
下次从收藏里播放就会解析失败。

**下载**（`POST /api/online/download`）—— 两步，职责分明：

1. 渲染进程让**主进程**按用户选的音质解析出真实地址（含降级与换源）——源脚本只在主进程里；
2. 把地址交给**后端**取流落盘到 `<根目录>/music/`，并：

   - 文件名取 `歌手 - 歌名.ext`，重名自动加序号（不覆盖）
   - 封面：经同源图片代理取回 → 存进 `songs.cover` BLOB **并嵌入文件标签**
   - 歌词：主进程已解析好 → 序列化回 LRC 写成同名 `.lrc`（**只写行级时间轴**，
     逐字是 LX/酷狗私有格式，写进 .lrc 会让其它播放器显示出一堆 `<0,300>`）
   - 标签：`write_tags` 写回文件，文件离开本应用也带着正确的歌名歌手
   - `source_path = online://{平台}/{平台ID}`：既能追溯来源，也让搜索页标「已下载」

   下载结果与扫描入库的歌**完全等价**（可离线播放、可编辑、可再入歌单）。

> **缓存复用**：若这首歌刚播过、字节已在本地缓存里，下载会**直接复制**（秒完成），不再回源。

**进度**：下载是同步请求，进度放在后端内存里，前端每 500ms 轮询
`/api/online/download/progress?key=…`。无损一首 50MB，没有进度反馈用户会以为卡死。

**音质切换**：`playerStore.switchOnlineQuality()` 重新解析地址并从**原位置续播**
（换源会换一条 URL，进度得自己搬）；不改变播放/暂停状态 —— 用户只是换音质，
不该顺带把暂停中的歌放起来。选中的音质写回歌曲对象（入库的还会记进 `online_quality`）。

**歌词缓存**：`cache/lyrics/*.json`，键为「平台 + 平台ID」（与音质无关，各音质共用一份），
7 天 TTL，过期即删；开关跟随设置页的缓存开关（主进程每次取歌词前读一次 `cache/config.json`）。
`stats()` 单独给出 `lyricsBytes`/`lyricsFiles` 与 `totalBytes` —— 容量上限只管音频，
混进同一个数字会让用户觉得「明明没超上限怎么就被清了」。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 第三方脚本安全性（可发任意网络请求） | vm 沙箱隔离（无 require/process）+ 导入时明确提示；与洛雪同一信任模型，**应用不内置任何源**，规避版权问题 |
| 源脚本兼容性差异 | `musicInfo` 塞全平台 ID 字段；`lx.request` 的 body JSON 解析、form/formData 编码严格对齐洛雪桌面版；用 2~3 个主流第三方源脚本做兼容验证 |
| 音频 URL 时效短 | 每次播放现取 CDN 地址；音频字节按**稳定键**缓存到本地（§3.7），与地址签名无关 |
| `inited` 前脚本出错 / 超时 | 加载失败回滚 + toast 提示具体错误；单源崩溃不影响其他源（沙箱相互独立） |
| 打包分发 | 全部逻辑在 Electron 主进程 JS，无原生依赖；PyInstaller 后端仅新增一个 Flask 蓝图，无影响 |

> **Phase 1 实测补充**：
> - QQ 接口 `Content-Type: application/x-javascript` 但内容为 JSON → 宿主对文本类响应一律先尝试 `JSON.parse`（已在 sourceHost.js 实现）。
> - 部分第三方源用 `/*!`（压缩保留注释）而非 `/**` 写头部元数据 → parseMeta 已兼容两种格式。

> **Phase 3 实测补充**：
> - **四平台接口全部实测可用**（开发机直连）：`kw/kg/tx/wy` 各返回结果、零错误，故四平台全部默认启用（原计划"默认三平台 + kw 兜底"已无必要）。
> - **解析与取数拆成纯函数**（`parseTx/parseKg/parseWy/parseKw`）：把"网络"与"响应→归一化"分离，解析逻辑可离线自检（`electron/__test-search.js`，24 项），对接线上接口形态变化时只需改一处。
> - **只搜"有启用源支持"的平台**：搜索走平台公开接口、与源无关，但没有源支持时搜到也播不了。故平台筛选条中不可用平台置灰，且无任何可用源时给出引导文案。
> - **音质标识的处理**：搜索结果本身不知道音质（实际取哪个由播放时的降级链决定），故不逐行硬标，改为把"该平台源声明支持的最高音质"放在平台 chip / 来源徽标的 tooltip 里，避免误导。
> - **kw 伪 JSON 两级解析**：先换引号后 `JSON.parse`（转义单引号 `\'` 先占位，避免被误换后语义漂移），失败再退到**空沙箱**求值（无 require/process，1s 超时）。
> - **源初始化失败要暴露真因**：部分源会因"版本过低"主动拒绝初始化（只发 `updateAlert`、不发 `inited`），此时仅报"超时"会让用户无从下手。现已在失败信息中附带源上报的更新提示与更新地址，并把 `updateInfo` 保留进失败记录供 UI 展示。
> - **`INIT_TIMEOUT` 10s → 30s 且可注入**：真实（尤其混淆过的）源常在 init 阶段做多步服务端握手；构造函数支持 `{ initTimeout }` 覆盖，自检用短超时以免被拖慢。
> - ✅ **端到端已实测通过**（2026-09-13，源 `lx-music-source-v6`）：真实平台搜索 → 源解析 → 真实 CDN 地址 → Flask 代理取流。`kg` 命中 `flac24bit`、`tx` 命中 `flac`；经代理取回的 `kg` FLAC 是 **55.4 MB 有效文件**（魔数 `fLaC`），`Range: bytes=0-1023` 返回 **206 + `Content-Range: bytes 0-1023/55397039`**，第二段 Range 内容不同 → **seek 可用**。
> - **源兼容性差异确实存在**（正是 §4 标注的风险）：`lx-music-source-v5` 被其服务端要求升级到 v6（且更新通道禁止直接下载）；`野花音源` 的 `/v1/url` 接口 404（后端只暴露 `/v1/urlinfo`）。这类问题现在都能在设置页看到明确原因。

> **Phase 4 实测补充**：
> - **源的 `lyric` / `pic` 基本不可用**：实测 v6 源五个平台**全部只声明 `musicUrl`**，与洛雪契约一致（`lyric`/`pic` 仅 `local` 源声明）。因此**平台歌词接口才是主路径**，源的 `lyric` action 仅作优先尝试（兼容扩展了该能力的源）。
> - **四平台歌词接口实测可用**：tx `fcg_query_lyric_new.fcg`（需 Referer `y.qq.com`）、kg 两步 `krcs.kugou.com/search` → `lyrics.kugou.com/download`、wy `api/song/lyric`（自带 `tlyric` 翻译）、kw `m.kuwo.cn/newh5/singles/songinfoandlrc`（**Referer 必须是 `m.kuwo.cn`**，用 `www` 会被拒）。
> - **逐字真跑通（酷狗 KRC）**：`fmt=krc` 返回加密的 KRC，解密链为 base64 → 去掉 `krc1` 头 → 与固定 16 字节密钥异或 → zlib 解压，得到 `[行起始ms,行时长ms]<字偏移ms,字时长ms,0>字…`。实测《晴天》**63/63 行全带逐字**。解析后统一转成 LX 逐字文本（`toLxLyric`），下游只认一种格式。
> - **翻译复用既有分隔符约定**：`tlyric` 以 ` | ` 内联进 `text`，主界面 / 全屏 / 桌面歌词三处的 `showTranslation` 自动生效，**渲染侧零改动**（实测网易云《Shape of You》116 行中 91 行带翻译）。
> - **桌面歌词真逐字 + 本地插值**：当前行带 `words` 时走真逐字（字内渐变，比整字跳变更顺滑），无则回退原按行插值（行为不回归）。主进程每 500ms 才推一次进度，窗口内用 rAF 插值**只重绘主行**，避免逐字高亮以 2Hz 卡顿推进。
> - **封面走同源图片代理**（`/api/online/image`）：CSP `img-src 'self'` **不放宽**。四平台封面来源实测：tx 由 `albummid` 构造、kg 的 `Image` 带 `{size}` 占位符需替换、wy 的 `al.picUrl`（http→https）、kw 该字段多为空（回退占位图）。`AlbumArt` 增加 `error` 回退，杜绝破图。
> - **迷你小窗封面**需绝对地址（窗口加载自 `file://`），由 `songCoverUrl()` 出相对路径、调用方拼 origin。

> **宿主健壮性修复（联调真实源时发现，已修复并回归）**：
> 1. **`lx.request` 回调异常隔离**：源脚本在回调里抛错会沿 Node 事件回调冒泡成未捕获异常，**直接把 Electron 主进程打崩**（一个行为不端的源就能让整个应用挂掉）。现统一 `try/catch` 兜住，只记日志。
> 2. **响应体解析以内容判定**：原先只看 `Content-Type`，遇到"JSON 文本却标 `application/octet-stream`"（实测某源后端如此）就返回 Buffer，源取 `body.code` 得到 `undefined` 而报错。现改为先看内容是否像 JSON，再看类型决定字符串/Buffer。
> 3. **`call()` 超时定时器泄漏**：竞速用的 20s 定时器从不清理，每次调用都吊住事件循环（表现为自检迟迟不退出），长会话下持续累积。现于 `finally` 中清理。
>
> 回归覆盖：`electron/__test-request.js`（8 项：非标 Content-Type 解析 + 回调抛错不崩溃）。

> **Phase 2 实测补充**：
> - **Flask 必须开 `threaded=True`**（`electron_backend.py`）：音频流是长连接，单线程下一条流会占满 worker，把 `/api/songs` 等请求全部堵死。各请求内自建 SQLite 连接、扫描任务已有 `_scan_lock` 保护，多线程安全。
> - **音质降级与换源都放在主进程**（`sourceManager.resolveMusicUrl`）：降级链 `flac24bit→flac→320k→128k`（用户偏好音质优先），每档内部再由 `callEnabled` 逐个启用源重试；渲染进程只拿到最终 URL，失败时返回聚合错误供 toast。这样渲染侧无需感知源与音质的组合复杂度。
> - **代理只放行 http/https**（`app/api/online.py`）：源脚本是第三方代码，避免被当作任意协议跳板。上游错误状态码原样透传（416/404 等），前端据此触发降档。
> - **CSP 无需改动**：媒体经同源 `/api/online/proxy` 加载，仍命中 `media-src 'self'`。
> - **联调入口**：无搜索 UI 时用 `window.__playOnline(song)`（App.vue 暴露）手工构造在线歌曲验证；Phase 3 搜索页上线后可移除。
> - **自检脚本**：`electron/__test-online.js`（降级/换源，7 项）、`app/__test-online.py`（代理 Range/防盗链头，17 项），均在 `.gitignore` 内不入库。

## 5. 实施阶段

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **Phase 1** ✅ 已完成 2026-09-13 | SourceHost 宿主 + 源管理 IPC + 设置页源管理 UI | 能导入真实第三方源脚本并完成 `inited` 握手，列表正确显示平台/音质声明 |
| **Phase 2** ✅ 已完成 2026-09-13 | 播放链路：musicUrl 调用 + Flask 代理 + playerStore 接入 + 音质降级/换源 | 手工构造在线歌曲可完整播放、可 seek、失败自动降档 |
| **Phase 3** ✅ 已完成 2026-09-13 | 在线搜索（四平台适配器）+ 搜索视图 | 关键词搜索 → 结果列表 → 点击播放全链路通畅 |
| **Phase 4** ✅ 已完成 2026-09-13 | 歌词/封面/逐字解析 + 通知、桌面歌词、迷你播放器适配 | 在线歌曲歌词（含逐字）正常显示，各子窗口状态同步 |
| **Phase 5** ✅ 已完成 2026-09-14 | 在线歌曲入库 + 下载（可选音质）+ 音质切换 + 收藏/歌单 + 歌词缓存 | 在线歌曲可收藏、可入歌单、可下载成完整本地歌曲，音质可切换且续播不跳回开头 |
| **Phase 6** ✅ 已完成 2026-09-14 | 搜索体验补完：结果**跨路由持久化** + **翻页**（四平台参数各异）+ 设置页分类标签 | 切走再回来结果与滚动位置都在；可翻页（上限 300 条并明确提示）；设置页按 5 类分标签 |

### 3.9 搜索翻页与状态持久化（Phase 6）

**四平台的翻页参数名与起始值都不同**，`onlineSearch.js` 里逐个适配（改动时对照此表）：

| 平台 | 参数 | 语义 |
|---|---|---|
| tx（QQ） | `p` | 页码，**1 起** |
| kg（酷狗） | `page` | 页码，**1 起** |
| wy（网易云） | `offset` | **条目偏移，0 起**（`(page-1)*limit`） |
| kw（酷我） | `pn` | **页号，0 起**（`page-1`） |

- `hasMore = results.some(r => r.list.length >= limit)` —— 只要**还有任一平台**返回满页就继续翻，
  不能被某个先耗尽的平台提前终止。
- 上限 `MAX_PAGE = 10` / `MAX_RESULTS = 300`（跨页按 `song.id` 去重后截断）；到顶在界面上明确提示，
  而不是静默变少（这正是用户提「不知道是只能显示这点还是只能搜索这点」的原因）。
- ⚠️ 部分平台**不支持回退翻页**，「上一页」用**重放 1..N 页**实现。
- 搜索状态放在 **store（`stores/onlineSearch.js`，模块级 reactive）而非组件内 `ref`**：
  Hash 路由切走会卸载组件、销毁组件内 `ref` —— 这就是「切页面回来结果就没了」的根因。
  另持久化到 `localStorage`（含列表滚动位置），重启后仍在。

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
