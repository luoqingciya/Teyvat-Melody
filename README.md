# Teyvat Melody（提瓦特旋律）

基于 **Electron + Python 3.12 (Flask) + Vue 3 (Vite)** 混合架构的原神主题风格音乐播放器桌面应用：本地音乐库 + 自定义源在线播放。

- **Python 后端**：Flask 提供 API / 音频流 / 音乐库 / 元数据解析 / 数据库
- **Electron 壳**：主窗口、系统托盘、单实例、透明桌面歌词（HTML 渲染，效果对标 QQ/酷狗）
- **前端**：Vue 3 SPA，经 preload 兼容层接入（`window.pywebview.api.*` 调用语义保留，前端零改动）
- 可打包为 Windows 安装程序（electron-builder + PyInstaller）

## 功能特性

- **本地音乐库**：选择目录扫描音乐，扫描到的文件自动复制到软件根目录的 `music` 文件夹，数据库与数据统一存放在软件根目录
- **流式播放引擎**：HTTP Range 分段流式播放，支持拖动进度条
- **音频元数据解析**：解析采样率 / 码率 / 声道 / 格式并展示「音质」列
- **专辑封面**：读取并缓存封面，统一作为默认封面显示
- **歌词**：LRC 解析、随播放滚动并高亮当前句
- **收藏与歌单**：「我的收藏」收藏夹、多歌单管理（含推荐封面/横幅）
- **搜索过滤**：按歌名 / 艺术家 / 专辑实时筛选
- **全屏播放器**：旋转封面 + 滚动歌词
- **三主题切换**：蒙德 / 璃月 / 稻妻，景区（地标）图标，无限循环切换
- **玻璃质感（毛玻璃）**：可整体开关
- **全局键盘快捷键**：播放控制、切歌等
- **自定义绘制控制栏**：无原生标题栏，自绘控制栏；主窗口采用**手动 IPC 拖拽**（`win:drag-start` / `win:drag-end`），绕开 `-webkit-app-region`，避免与毛玻璃 `backdrop-filter` 同层合成冲突
- **系统托盘**：点击托盘图标即可显示 / 隐藏主窗口
- **最近播放**：自动记录播放历史，独立入口展示
- **歌单枢纽**：「我的歌单」作为一级入口，进入后以卡片形式浏览各歌单
- **全屏播放页字体自定义**：可设置歌词字体与字号
- **桌面歌词**（Electron 透明窗，HTML 渲染）：
  - **横排卡拉OK**：单行主歌词居中，当前行从左到右逐字高亮，可选翻译行；顶部工具栏含播放控制 / 锁定位置 / 关闭
  - 全透明 / 深色卡片两种背景；当前行 / 普通歌词颜色、字号、字体均可自定义
  - 双击歌词切换播放 / 暂停；工具栏 hover 显示、移出自动隐藏
- **迷你播放器（小窗）**：点击控制条「迷你模式」切换置顶小窗，展示封面 / 标题 / 进度并支持遥控播放；打开小窗时自动隐藏主窗口
- **自定义字体**：界面与全屏歌词均可选用系统字体（微软雅黑 / 思源黑体 / 思源宋体 / 等宽），并支持上传字体文件（.ttf / .otf / .woff / .woff2）持久化复用
- **音效**：基于 Web Audio API 的图形均衡器 + 预设（原声 / 重低音 / 清澈人声 / 现场 / 游戏 / 古典 / 流行 / 自定义 10 段均衡），底部控制条「音效」按钮展开面板调节
- **播放速度**：支持 0.5x–2x 多档（0.25x–3x），控制条与设置页可调并作为默认播放速度，点击控制条按钮快速循环档位
- **翻译/双语歌词**：开关控制主歌词后的翻译/副歌词行渲染，主界面、全屏、桌面歌词统一生效（基于行内 ` | `、` // `、` / `、`\t` 分隔符）
- **界面语言**：中文 / English 全局一键切换，侧栏、顶栏、歌曲列表、歌词面板与设置页文案即时响应
- **启动恢复上次播放队列**：可选在启动时恢复上一会话的播放队列与当前位置（依赖「启动继续播放」开启）
- **主题主色联动**：切换主题时自动清空自定义主色，使主色跟随当前主题的金色，保持观感一致

### 在线播放（自定义源）

- **自定义源**：兼容洛雪音乐自定义源脚本（`.js`），在 Node `vm` 沙箱中运行；源文件存于软件根目录 `sources/`。**应用不内置任何源**，需自行导入并确认可信（源为第三方代码，可发起任意网络请求）
- **在线搜索**：内置 `tx`(QQ) / `kg`(酷狗) / `wy`(网易云) / `kw`(酷我) 四平台搜索适配器；只搜「有启用源支持」的平台，避免搜到却播不了
- **流式播放**：源解析出的 CDN 地址经本机同源代理转发，**透传 `Range`**（进度条可拖动 seek），按平台自动伪装 Referer / User-Agent 绕过防盗链
- **音质降级 + 换源重试**：`flac24bit → flac → 320k → 128k` 逐级降档，同一音质内多个源自动换源；全部失败给出聚合原因
- **在线歌词（含逐字）**：四平台歌词接口；自动合并翻译成双语（复用主/副歌词分隔符约定，`showTranslation` 开关三处界面统一生效）；酷狗 **KRC 解密**后可显示**逐字卡拉OK**
- **在线封面**：远程封面经同源图片代理加载（**不放宽 CSP**），加载失败回退默认封面；切歌通知也带封面
- **本地缓存**：听过的在线歌曲会缓存到软件根目录 `cache/`，重播秒开、拖动进度条也走本地文件；可在设置里关闭或清空
- **在线歌曲与本地歌曲共用同一套播放内核**：队列、播放模式、桌面歌词、迷你小窗、睡眠定时、音效均无需区分

## 项目结构

```
.
├── electron/                  # Electron 主进程
│   ├── main.js                # 主进程：spawn 后端、主窗口、托盘、单实例、桌面歌词窗口、迷你小窗、IPC
│   ├── preload.js             # window.pywebview.api 兼容层（只暴露前端实际调用的方法）
│   ├── sourceHost.js          # 洛雪自定义源宿主运行时（vm 沙箱 + globalThis.lx + 受控 crypto/zlib/buffer）
│   ├── sourceManager.js       # 源文件存储、启停、音质降级与换源解析（resolveMusicUrl）
│   ├── onlineSearch.js        # 在线搜索适配器（tx/kg/wy/kw，含 kw 伪 JSON 解析）
│   ├── onlineLyric.js         # 在线歌词适配器 + LRC/翻译/KRC 逐字解析
│   ├── loading.html           # 主窗口启动加载页（后端就绪后跳转 SPA）
│   ├── lyrics-preload.js      # 桌面歌词窗口数据桥
│   ├── lyrics.html            # 桌面歌词页（透明 / 卡拉OK 逐字 / 锁定 / 进度条）
│   ├── mini-preload.js        # 迷你播放器小窗数据桥
│   └── mini.html              # 迷你播放器小窗页（置顶）
├── electron_backend.py        # 后端入口（纯 Flask，Electron 主进程 spawn）
├── package-electron.ps1       # Electron 一键打包脚本（后端 exe + 前端 + electron-builder）
├── build.spec                 # PyInstaller 打包配置（后端 exe → backend-dist/TeyvatBackend.exe）
├── package.json               # Electron 依赖、脚本与 electron-builder 配置
├── app/                       # Python 后端
│   ├── server.py              # Flask 应用工厂（POST /api/rpc RPC 桥 + CSP 安全头）
│   ├── py_api.py              # 后端 API（hello / scanLibrary / saveFont / removeFont）
│   ├── api/                   # 路由层（songs / playlists / scan / stream / online）
│   ├── services/              # 业务逻辑（library / metadata / playlist / online_cache 在线缓存）
│   ├── models/                # 数据模型与统一响应格式
│   └── utils/
├── frontend/                  # Vue 3 + Vite 工程
│   └── src/
│       ├── router/            # Hash 模式路由
│       ├── stores/            # Pinia（player / library / playlist / config）
│       ├── components/        # 核心组件（侧栏、歌曲列表、全屏播放器、在线搜索等）
│       ├── composables/       # useApi（封装后端 REST 接口）
│       ├── utils/             # 字体 / 歌词桥 / 封面地址 / 轻提示等
│       └── assets/styles/     # 全局样式与主题
├── tests/                     # 自动化测试（Node + Python，由 CI 运行）
│   ├── run.js                 # Node 测试统一入口
│   ├── *.test.js              # 源宿主 / 播放链路 / 搜索 / 歌词解析 / 桥接 / 更新检查 / 数据目录选址
│   ├── run.py                 # Python 测试统一入口
│   ├── online-proxy.test.py   # 音频与封面代理（Range 透传、防盗链头、参数校验）+ 在线缓存与下载
│   ├── migration.test.py      # 老版本数据库升级（列补齐、数据不丢、索引生效、幂等）
│   ├── paths.test.py          # 数据目录选址（免安装版 / 安装版 / 开发模式）
│   ├── backend-port.test.py   # 后端端口命令行契约
│   └── fixtures/              # 测试用源脚本样本（自造，非第三方）
├── tools/                     # 本地开发工具（不进 CI）
│   ├── ui-e2e.js              # CDP 驱动真实 Electron 的界面端到端验证
│   ├── verify-frozen-paths.py # 验证**打包后**后端的选址（安装版不进安装目录）
│   └── verify-packaged-app.js # 验证真实打包布局 + 打包后应用的选址
├── .github/workflows/         # GitHub Actions（ci.yml 测试 / release.yml 打包发布）
└── resources/                 # 打包资源（应用图标等）
```

## 快速开始

> 前端依赖用 npm；后端依赖用 [uv](https://docs.astral.sh/uv/) 管理（见 `pyproject.toml`）。

### 1. 初始化依赖

```bash
uv sync                       # 后端依赖 → .venv
npm install --registry=https://registry.npmmirror.com --cache .npm-cache
                              # Electron 依赖（国内网络建议走 npmmirror；Electron 二进制
                              # 若 postinstall 下载卡住，见下方「Electron 安装排障」）
cd frontend && npm install && npm run build
                              # 构建前端产物到 frontend/dist（Flask 托管）
```

### 2. 启动（Electron 混合架构，推荐）

```bash
npm run dev
```

主进程会自动：spawn `.venv/Scripts/python.exe electron_backend.py`（Flask :5000）→ 立即创建主窗口（先显示内置 loading 页）与桌面歌词/迷你小窗 → 后端就绪后主窗口再跳转到 Flask 提供的 Vue SPA。

### 3. 运行测试

```bash
npm test            # Node + Python 全套（详见下方「测试」）
npm run test:ui     # 真实界面端到端（需图形界面，改过桥接/交互后建议跑）
```

## 测试

自动化测试位于 `tests/`，**不依赖外网**（搜索/歌词用固定样本，代理测试用本地 HTTP 服务器）。
唯一例外是 `source-host.test.js` 里对 QQ 搜索接口的真实请求 —— 外网不可达时记为 `SKIP` 而非失败，
避免把环境问题误判成代码缺陷。

```bash
npm run test:js     # Node 侧：源宿主 / 播放链路 / 搜索 / 歌词解析
npm run test:py     # Python 侧：代理与缓存 / 数据库升级 / 数据目录选址
npm test            # 两者都跑
```

覆盖范围：

- **源宿主**：沙箱隔离（无 `require`/`process`）、`inited` 握手与超时、回调异常隔离、响应体解析（非标 Content-Type）
- **播放链路**：音质降级链、偏好音质优先、多源换源、全失败错误聚合、禁用源后失效
- **搜索**：四平台响应归一化、缺字段过滤、酷我伪 JSON 解析、双重转义还原
- **歌词**：LRC、翻译合并（容差匹配）、LX 逐字、酷狗 KRC 解密往返、组装优先级、本地缓存命中与过期
- **代理**：Range/206 与 `Content-Range` 透传、Referer/UA 注入、协议与参数校验、上游错误透传、封面非图片拒绝
- **在线缓存与下载**：稳定键命中、`0..末尾` 的 Range 视为完整、淘汰 LRU、进度统计含分片、
  并发下载同键被拒、进度表容量上限
- **数据库升级**：老结构库跑迁移后列补齐、旧数据/收藏/歌单/历史一条不少、旧歌仍算本地歌曲、
  唯一索引生效、重复执行幂等
- **数据目录选址**：免安装版与安装版都在**软件目录（跟 EXE 同级）**、开发模式放项目根；
  两边（Electron / Python）规则必须一致
- **更新检查**：版本比较（含 `1.0.10 > 1.0.9` 这类字典序会判错的用例）、资产筛选、四种 API 结果

### 真实界面端到端（改过桥接/交互就该跑一次）

`tools/ui-e2e.js` 启动真实 Electron 并开远程调试，用 CDP 驱动渲染进程**走真实点击路径**：
点侧栏 → 输入关键词 → 点搜索 → 点结果播放 → 打开设置检查更新。

```bash
npm run test:ui     # 前置：frontend/dist 已构建；sources/ 下至少有一个已启用源
```

**它覆盖的是 `tests/` 结构上覆盖不到的那一层**：单元测试会打桩 `electron`，因此
**永远看不到 `contextBridge` 跨边界的行为**。曾经有一次「在线搜索报
`An object could not be cloned.`」的缺陷，单元测试全绿、修复还放错了位置，
就是靠这个工具才复现出来的。

需要图形界面，故不进 CI。**改过前端与主进程之间的交互（桥接调用、IPC 载荷）后请跑一次。**

> 受限环境（沙箱/容器）里 Chromium 的 GPU 进程起不来，脚本已自带 `--no-sandbox --disable-gpu`。

### 数据放在软件目录 —— 三条必须跑的验证

**数据一律放在软件目录（跟 EXE 同级）**：免安装版与安装版规则相同，整个目录自包含、可整体搬移。
但安装版有个陷阱：**升级时安装器会先执行旧版的卸载程序**，而它默认会
`RMDir /r $INSTDIR` 把安装目录整个删掉 —— 数据跟着没（这是真实发生过的用户缺陷）。
所以「数据放在安装目录里」这条约定**必须**配合 `resources/installer.nsh` 的
`customRemoveFiles` 宏（升级时保留 data/music/sources/cache/.appdata，真正卸载时才删）。

三处改动都要验证，分别对应三层：

```bash
# ① NSIS 宏：升级真的不删数据吗？（唯一能验证「保数据」这一层的手段）
#    用 electron-builder 自带的 makensis 编译并运行真实宏，断言两种场景的结果
python tools/verify-nsis-keep-data.py

# ② 后端：把打包后的后端放进「模拟安装版 / 模拟免安装版」两棵树各跑一次，看数据库落在哪
uv run pyinstaller build.spec --noconfirm --distpath backend-dist --workpath build-temp
python tools/verify-frozen-paths.py

# ③ 主进程：在真实打包布局上校验选址规则（不需要打包）；有产物时还会实跑应用
node tools/verify-packaged-app.js
TEYVAT_INSTALLED_DIR=<你的安装目录> node tools/verify-packaged-app.js   # 连自定义安装目录一起验
```

单元测试（`tests/paths.test.py` / `tests/data-root.test.js`）只能测**纯函数** ——
把 frozen/exe 当参数注入，真实打包才走到的部分、以及 NSIS 那段宏，都覆盖不到，所以才有上面三条。

> ⚠️ **`resources/installer.nsh` 必须带 UTF-8 BOM**：NSIS 在 `Unicode true` 下对含非 ASCII
> 注释的脚本要求 BOM，否则 `Bad text encoding` 编译失败（本地不打包发现不了，CI 才会暴露）。
> `python tools/verify-nsis-keep-data.py` 会顺带把这一点测出来。
>
> **卸载行为**：升级保留数据；**真正卸载会连数据一起删**（随包 README 已告知用户先备份）。
>
> ⚠️ **本机跑 electron-builder 很慢**（实测 `--dir` 会卡在压缩阶段 20 分钟以上），
> 需要实跑 ② 时优先用 CI 的产物；日常只跑 ① 与布局校验就够了。

## 在线更新

启动后会**静默检查** GitHub Release 是否有新版本（查不到 / 无新版都静默，不打扰用户）；
发现新版时弹出可操作提示，点「前往下载」即用系统浏览器打开下载页。
设置页「关于与更新」里也可手动检查、查看更新说明、或忽略某个版本。

**为什么不用 electron-updater**：

- **两种分发包都能用** —— electron-updater 只支持 NSIS 安装版（免安装 zip 没有安装位置）。
  本方案只做「查 → 告知 → 跳转下载」，安装版与免安装版行为一致
- **不新增运行时依赖** —— 直接调 GitHub Releases API（公开仓库无需 token）
- **未签名时更省心** —— 静默下载的更新包是未签名 exe，会被 Windows SmartScreen 拦截；
  交给用户走浏览器下载反而更可控

相关代码：`electron/updater.js`（版本比较 + Release 查询）、`frontend/src/composables/useUpdater.js`。

## 在线播放缓存

听过的在线歌曲会缓存到软件根目录 `cache/`，之后**重播秒开、拖动进度条也走本地文件**，不再重新联网。

**为什么不能直接用浏览器缓存**：音乐 CDN 的地址带时效签名，**每次播放都不同**，拿它当缓存键永远命不中。
所以渲染进程会额外传一个**稳定键**（`平台:平台ID:音质`）给代理，缓存以它为准，与 CDN 签名无关。

| 场景 | 行为 |
| --- | --- |
| 命中缓存 | `send_file` 直接由本地文件提供（Range 天然支持，seek 走本地） |
| 未命中 | 边转发边写 `.part`，**读完才转正**；中断即丢弃，绝不让半个文件冒充缓存 |
| 中途 seek / 切歌 | 已下的部分**交给后台用同一条连接读完**再转正 —— 缓存仍能完成且不额外耗流量；但已下不足 1MB 或 30% 时放弃，避免替用户偷跑流量 |
| 容量超限 | 按 LRU（命中刷新 mtime）从最久未用的开始删 |

设置页「在线播放缓存」可开关、选容量上限（256 MB / 512 MB / 1 GB / 2 GB）、查看占用与一键清空。
配置存在 `<根目录>/cache/config.json`。

> 缓存目录可以随时整个删掉，只会让下次播放重新联网取流。

## CI / 发布（GitHub Actions）
- **`.github/workflows/ci.yml`** —— 每次 push / PR 触发：
  - `frontend`：ESLint + `vite build`
  - `tests`：Ubuntu 与 Windows **双平台**跑 Node + Python 测试（尽早暴露路径差异）
- **`.github/workflows/release.yml`** —— 打 `v*` tag（或手动触发）在 `windows-latest` 上打包，
  产出安装包与免安装 zip 并创建 GitHub Release；手动触发只上传 Artifacts，不发 Release。

> **发布前请把 `package.json` 的 `version` 与 tag 对齐**：工作流会校验，不一致直接失败。
> 产物文件名取自 `package.json` 的 `version`，不校验就会产出「版本号对不上」的安装包。

## 打包（Windows）

一键脚本（推荐，需 uv + node/npm）：

```powershell
.\package-electron.ps1                 # 全量：uv sync → 构建前端 → 后端 exe → electron-builder
.\package-electron.ps1 -SkipFrontend   # 跳过前端构建（dist 已存在时加速）
```

等价分步：

```bash
# 1) 后端打成独立 exe（无窗口 Flask 服务）
uv run pyinstaller build.spec --noconfirm --distpath backend-dist --workpath build-temp

# 2) Electron 打包（前端产物、electron/**、backend-dist 一并打入）
npm run build
```

产物输出至 `electron-dist/`：

- **安装包（exe）**：`electron-dist/TeyvatMelody-Setup-<版本>.exe`（NSIS，可自定义安装目录）
- **免安装包（zip）**：`electron-dist/TeyvatMelody-<版本>-x64.zip`（解压即用）
- **便携目录**：`electron-dist/TeyvatMelody-portable/`（即 `win-unpacked` 重命名；内含 `TeyvatMelody.exe` + `resources/backend/TeyvatBackend.exe`）

> **免安装包 / 便携目录都是自包含的可运行应用**：运行数据（`data/`、`music/`、`.appdata/`）保存在目录自身根目录，因此**解压或复制整个文件夹到任意位置即可直接运行**，无需安装程序——适合免安装分发或替换到现有运行根目录。

### 卸载方式

| 分发包 | 怎么卸载 |
|---|---|
| **安装版**（exe） | 安装目录下的 `Uninstall TeyvatMelody.exe`；或「设置 → 应用 → 已安装的应用」里搜「提瓦特旋律」 |
| **免安装版 / 便携目录** | **没有卸载程序是正常的** —— 直接删除整个文件夹即可 |

> 两种分发方式的**数据是通用的**：把旧目录里的 `data/`、`music/`、`.appdata/`、`sources/` 复制到新目录下即可无缝接续（音乐库、歌单、设置、自定义源都会保留）。
>
> 应用根目录会随包附带一份 `使用说明.txt`（由 `build.extraFiles` 写入），用户不必去翻文档。

electron-builder 配置见 `package.json` 的 `build` 字段（`extraResources.backend` → 主进程以 `process.resourcesPath/backend/TeyvatBackend.exe` 启动）。主进程通过 [`electron/main.js`](electron/main.js) 的 `findBackendExe` **递归查找** `resources/backend/` 下的 `TeyvatBackend.exe`，兼容「单文件」与「PyInstaller COLLECT 目录」两种形态。

## 架构说明

```
Electron 主进程 (electron/main.js)
 ├─ spawn Python(Flask 127.0.0.1:5000) 子进程
 ├─ 主窗口 BrowserWindow（frameless）→ 加载 Flask URL（Vue SPA）
 │    └─ preload.js：window.pywebview.api 兼容层（只暴露实际调用的方法）
 │         ├─ minimize/toggleMaximize/close/show   → IPC 操作窗口
 │         ├─ toggleDesktopLyrics / pushDesktopLyrics → IPC 操作歌词窗口
 │         ├─ setFullscreen / toggleMini / pushMiniState → IPC 全屏 / 迷你小窗
 │         ├─ applyGlobalHotkeys / notifySong → 系统快捷键 / 切歌通知
 │         └─ hello / scanLibrary / saveFont / removeFont → POST /api/rpc（Flask）
 ├─ 桌面歌词窗口（transparent/frameless/alwaysOnTop）→ lyrics.html
 │    └─ 歌词数据经 IPC 实时推送（500ms 增量）+ 800ms 拉取兜底，HTML 卡拉OK渲染
 │    └─ 在线歌曲带逐字时间轴时走**真逐字**（字内渐变），窗口内 rAF 插值只重绘主行
 ├─ 迷你播放器小窗（alwaysOnTop）→ mini.html（封面/标题/进度/遥控）
 ├─ 自定义源（洛雪源脚本）：vm 沙箱运行，源文件存于软件根目录 sources/
 │    ├─ 播放：playerStore → IPC online:getUrl → resolveMusicUrl（音质降级 + 换源）
 │    │         → audio.src = /api/online/proxy（Flask 同源代理，透传 Range、伪装 Referer）
 │    └─ 搜索 / 歌词 / 封面：IPC online:search / online:lyric + /api/online/image
 │          （搜索只查「有启用源支持」的平台；歌词优先用源的 lyric 能力，否则走平台接口）
 ├─ 系统托盘 + 单实例（requestSingleInstanceLock）
```

- **前端零改动**：`window.pywebview.api.*` 由 preload 兼容层接管，调用面收敛为前端实际使用的方法，保持语义兼容
- **RPC 桥**：`POST /api/rpc` 调用 `app.py_api.Api` 单例（只暴露 `hello` / `scanLibrary` / `saveFont` / `removeFont`，未知方法返回 404）
- **桌面歌词真透明**：Electron `transparent: true` 原生支持，HTML/CSS 渲染（黑描边、卡拉OK）
- **路由**：**必须使用 Hash 模式**，规避 `file://` 协议下 History 404 白屏
- API 统一返回：`{ "code", "data", "message" }`
- 数据存储：数据库（SQLite）存放于软件根目录 `data`，音乐副本存放于 `music`，自定义源存放于 `sources`，便于移动整个目录到任意位置

## 安全与开发约定

- **CSP**：Flask 统一返回 `Content-Security-Policy`（`script-src 'self'` 等），页面不得含内联脚本；新增内联 JS 会触发浏览器拦截（需移除外链或放宽策略）
- **IPC 序列化（两道边界，别搞混）**：参数跨桥接会经过两次结构化克隆，**Vue reactive 对象是 Proxy，两道都过不去**（报 `An object could not be cloned.`）
  1. **渲染进程主世界 → preload 隔离世界**：由 `contextBridge` 复制参数，**发生在 preload 代码执行之前** —— 所以在 preload 里做深拷贝救不了它，**必须在调用侧先去代理**（用 `utils/bridge.js` 的 `toPlain()`，既有 `desktopLyricsBridge` / `miniModeBridge` 也是这个做法）
  2. **preload 隔离世界 → 主进程**：由 `electron/preload.js` 的 `invoke` 统一深拷贝兜住，新增 preload 方法无需各自处理
- **preload**：contextBridge 暴露对象必须显式枚举方法，不能使用 Proxy（动态 `get` 陷阱在隔离环境下不生效）
- **Electron 后端**：`electron_backend.py` 只跑 Flask，不创建任何窗口；托盘 / 窗口控制全部由主进程负责
- **Flask 必须 `threaded=True`**：音频流是长连接，单线程下一条流会占满 worker，把 `/api/songs` 等请求全部堵死
- **远程资源一律走同源代理**（音频 `/api/online/proxy`、封面 `/api/online/image`），**不放宽 CSP**；代理只放行 `http/https`，防止第三方源脚本把本地代理当成任意协议跳板
- **翻译歌词以 ` | ` 内联进 `text`**：这是项目既有的主/副歌词分隔符约定（`LyricsPanel.vue`、`lyrics.html`、桌面歌词三处共用），改渲染前先看这里
- **源脚本是不可信代码**：在 `vm` 沙箱中运行（不注入 `require` / `process`）；且 `lx.request` 的回调必须异常隔离——源在回调里抛错会冒泡成未捕获异常，**直接把主进程打崩**
- **应用不内置任何源**：`sources/` 只存用户自行导入的脚本，仓库与安装包均不含任何源脚本

## Electron 安装排障（国内网络）

- **npm 缓存被拒（EPERM）**：系统 npm 缓存目录不可写时，加 `--cache .npm-cache` 指定项目内缓存
- **Electron 二进制 postinstall 卡死**：手动下载后解压：

```bash
curl -L -o .npm-cache/electron.zip \
  "https://npmmirror.com/mirrors/electron/v31.7.7/electron-v31.7.7-win32-x64.zip"
unzip -q -o .npm-cache/electron.zip -d node_modules/electron/dist
printf "electron.exe" > node_modules/electron/path.txt
```

- **`npm run dev` 报 `spawn electron.exe\n ENOENT`**：path.txt 含换行所致，用 `printf` 重写（注意别用 `echo`）；或直接运行 `node_modules/electron/dist/electron.exe .`

## 许可证

本项目采用 GPL-3.0-or-later 开源协议，详见 [LICENSE](LICENSE)。
