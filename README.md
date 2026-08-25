# Teyvat Melody（提瓦特旋律）

基于 **Electron + Python 3.12 (Flask) + Vue 3 (Vite)** 混合架构的原神主题风格本地音乐播放器桌面应用。

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

## 项目结构

```
.
├── electron/                  # Electron 主进程
│   ├── main.js                # 主进程：spawn 后端、主窗口、托盘、单实例、桌面歌词窗口、迷你小窗、IPC
│   ├── preload.js             # window.pywebview.api 兼容层（只暴露前端实际调用的方法）
│   ├── loading.html           # 主窗口启动加载页（后端就绪后跳转 SPA）
│   ├── lyrics-preload.js      # 桌面歌词窗口数据桥
│   ├── lyrics.html            # 桌面歌词页（透明 / 卡拉OK / 锁定 / 进度条）
│   ├── mini-preload.js        # 迷你播放器小窗数据桥
│   └── mini.html              # 迷你播放器小窗页（置顶）
├── electron_backend.py        # 后端入口（纯 Flask，Electron 主进程 spawn）
├── package-electron.ps1       # Electron 一键打包脚本（后端 exe + 前端 + electron-builder）
├── build.spec                 # PyInstaller 打包配置（后端 exe → backend-dist/TeyvatBackend.exe）
├── package.json               # Electron 依赖与脚本（npm run dev / build）
├── app/                       # Python 后端
│   ├── server.py              # Flask 应用工厂（POST /api/rpc RPC 桥 + CSP 安全头）
│   ├── py_api.py              # 后端 API（hello / scanLibrary / saveFont / removeFont）
│   ├── api/                   # 路由层（songs / playlists / scan / stream）
│   ├── services/              # 业务逻辑（library / metadata / playlist）
│   ├── models/                # 数据模型与统一响应格式
│   └── utils/
├── frontend/                  # Vue 3 + Vite 工程
│   └── src/
│       ├── router/            # Hash 模式路由
│       ├── stores/            # Pinia（player / library / playlist / config）
│       ├── components/        # 核心组件（侧栏、歌曲列表、全屏播放器等）
│       ├── composables/       # useApi（封装后端 REST 接口）
│       └── assets/styles/     # 全局样式与主题
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

- **安装包**：`electron-dist/TeyvatMelody Setup <版本>.exe`（NSIS，可自定义安装目录）
- **便携目录**：`electron-dist/TeyvatMelody-portable/`（即 `win-unpacked` 重命名；内含 `TeyvatMelody.exe` + `resources/backend/TeyvatBackend.exe`）

> **便携目录是一份自包含的可运行应用**：运行数据（`data/`、`music/`、`.appdata/`）保存在目录自身根目录，因此**把整个 `TeyvatMelody-portable` 文件夹复制到目标位置即可直接运行**，无需执行安装程序——适合免安装分发或替换到现有运行根目录。

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
 ├─ 迷你播放器小窗（alwaysOnTop）→ mini.html（封面/标题/进度/遥控）
 ├─ 系统托盘 + 单实例（requestSingleInstanceLock）
```

- **前端零改动**：`window.pywebview.api.*` 由 preload 兼容层接管，调用面收敛为前端实际使用的方法，保持语义兼容
- **RPC 桥**：`POST /api/rpc` 调用 `app.py_api.Api` 单例（只暴露 `hello` / `scanLibrary` / `saveFont` / `removeFont`，未知方法返回 404）
- **桌面歌词真透明**：Electron `transparent: true` 原生支持，HTML/CSS 渲染（黑描边、卡拉OK）
- **路由**：**必须使用 Hash 模式**，规避 `file://` 协议下 History 404 白屏
- API 统一返回：`{ "code", "data", "message" }`
- 数据存储：数据库（SQLite）存放于软件根目录 `data`，音乐副本存放于 `music`，便于移动整个目录到任意位置

## 安全与开发约定

- **CSP**：Flask 统一返回 `Content-Security-Policy`（`script-src 'self'` 等），页面不得含内联脚本；新增内联 JS 会触发浏览器拦截（需移除外链或放宽策略）
- **IPC 序列化**：Electron `ipcRenderer.invoke` 用结构化克隆，**Vue reactive 对象不能直接传**（会抛 `could not be cloned`）——桥接/兼容层已统一做 JSON 深拷贝，新代码沿用该模式
- **preload**：contextBridge 暴露对象必须显式枚举方法，不能使用 Proxy（动态 `get` 陷阱在隔离环境下不生效）
- **Electron 后端**：`electron_backend.py` 只跑 Flask，不创建任何窗口；托盘 / 窗口控制全部由主进程负责

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
