<div align="center">

# Codex Board

### 让每段对话，都有自己的位置。

A local conversation map for Codex. Organize your work. Find the right thread. Jump back into VS Code.

[**产品主页**](https://scilwb.github.io/codex-board/) · [**快速开始**](#快速开始) · [**使用方式**](#使用方式) · [**English**](#english)

[![CI](https://github.com/scilwb/codex-board/actions/workflows/ci.yml/badge.svg)](https://github.com/scilwb/codex-board/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-315E49)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-22.13%2B-315E49)](package.json)

</div>

![Codex Board：研究项目、任务与会话关系地图，使用虚构演示数据](docs/assets/board-preview.png)

开着多个项目、多个分支、多个 Codex 对话时，找到“负责这件事的那一条”应该很简单。

Codex Board 把本机对话放进一张可整理的地图。按研究方向和任务归类，拖拽连接关系，再一键回到 VS Code 继续工作。

## 可以做什么

| 功能 | 用途 |
|---|---|
| 项目与任务 | 手动管理 YAM、BEHAVIOR 等研究方向，以及代码模块、PR 审查等任务；一个项目可跨多个文件夹。 |
| 文件夹与分支 | 保留实际工作路径和会话记录的 Git 分支，可独立筛选。 |
| 对话关系 | 拖拽连线，标记串行、并行或参考；真实 Fork 来源自动显示。 |
| 回到 VS Code | 优先复用已经打开的对话标签，并定位到对应窗口。 |
| 新建与 Fork | 通过本机 Codex 创建对话，Fork 延续来源上下文，归类可手动调整。 |
| 实时同步与 ID | 每 2 秒检查本机会话变化；搜索标题或 ID，一键复制具体会话 ID。 |

**管理操作不发起模型推理。** 浏览、归类、拖拽、复制和跳转没有额外模型 token 消耗；后续在 Codex 中运行对话仍遵循你的 Codex 账户与使用规则。

## 快速开始

当前验证环境为 **Linux**。需要：

- Node.js **22.13+**（推荐 Node 24）与 npm。
- VS Code 和 Codex 扩展；已经在本机创建过 Codex 对话，存在本地会话索引。
- Python 3，用于打包轻量 VS Code 桥接扩展。

### 1. 启动对话地图

```bash
git clone https://github.com/scilwb/codex-board.git
cd codex-board
npm ci
npm run build
npm start
```

浏览器打开 **http://127.0.0.1:4317**。

### 2. 安装 VS Code 桥接

在另一个终端运行：

```bash
python3 vscode-bridge/build.py
code --install-extension vscode-bridge/codex-board-bridge-0.1.1.vsix --force
```

安装或升级后，在目标 VS Code 窗口空闲时执行一次 **Developer: Reload Window（开发人员：重新加载窗口）**。若网页提示未连接，在该窗口运行 **Codex Board: Connect**。工作区需要处于受信任状态。

### 可选：Linux 应用菜单与后台服务

需要用户级 systemd、`code`、`curl`、`xdg-open`。先停止手动启动的 `npm start`，再运行：

```bash
node scripts/install-local.mjs
./scripts/launch.sh
```

安装器创建本机桥接、用户服务和应用菜单入口，不设置登录自动启动。

```bash
systemctl --user start codex-board.service
systemctl --user stop codex-board.service
journalctl --user -u codex-board.service -n 30
```

## 使用方式

1. 左侧 **项目** 标题旁的编辑按钮管理项目和任务。选中对话，在右侧指定归类。
2. 顶部按 **文件夹 / Git 分支** 筛选；左侧按 **项目 / 任务** 筛选。
3. 拖动卡片调整位置；从右侧圆点拖到另一张卡片左侧圆点建立关系。点击连线可更改类型或删除。
4. 卡片上的 **VS Code** 定位会话，**ID** 复制完整会话 ID，**Fork** 创建独立对话。

删除项目或任务仅清除分类，对话和连线会保留。手动串行 / 并行关系只表示你整理的关系，不会自动执行任务。

## 数据与边界

- 服务只监听 `127.0.0.1`。本机会话索引只读，日志仅读取有大小限制的头尾。
- 项目、任务、归类、布局和连线存于 `~/.local/share/codex-board/board.json`。
- 新建 / Fork 调用本机 Codex App Server 的元数据接口；不发送 `turn/start`。
- VS Code 桥接使用本机令牌；目标标签激活且窗口取得焦点后才提示成功。12 秒未确认则报错，不自动重试。
- 侧栏会话无法通过标签 API 识别；首次跳转会打开编辑器标签，后续可以复用。
- 定位成功不代表全部历史已渲染。VS Code 自身无响应时，需要先恢复编辑器。
- Git 分支或运行状态缺少可靠来源时，不推测它们。复制 ID 也不会自动把历史注入新对话。
- 当前依赖 Codex 本地 SQLite 索引与扩展的 custom editor 实现。Codex 升级可能需要适配；目前没有宣称 Windows、macOS 或 Remote SSH 支持。

服务支持 `CODEX_BOARD_PORT`、`CODEX_BOARD_CODEX_HOME`、`CODEX_BOARD_DATA_DIR`、`CODEX_BOARD_CODEX_BIN`。**桥接目前固定使用默认端口 4317 和默认数据目录**；需要 VS Code 跳转时请保留这两项默认值。

## 开发与验证

```bash
npm test
npm run build
npm run test:ui
```

默认浏览器验收使用本机 Google Chrome。CI / 无 Chrome 环境可使用 Playwright Chromium：

```bash
npx playwright install --with-deps chromium
PLAYWRIGHT_BUNDLED=1 npm run test:ui
```

前端开发：后端运行 `npm start`，另一个终端运行 `npm run dev`。

- 后端与桥接测试覆盖只读会话索引、分类持久化、SSE、Fork、新建、窗口回执、超时与重复请求。
- 浏览器验收覆盖拖拽、真实剪贴板、关系编辑、筛选、分类 CRUD、表单、错误反馈与窄屏布局。
- 测试使用隔离数据，不会修改你的真实 Codex 会话。宣传截图也全部使用虚构演示数据。

## English

**Codex Board** is a local workspace for organizing Codex conversations. Group threads by research project and task, filter by folder and branch, draw relationships, copy thread IDs, create forks, and return to the right VS Code editor tab.

The board reads local conversation metadata and keeps its own layout and labels separately. Organization and navigation do not submit model turns. Linux is the currently verified platform; setup requires Node.js 22.13+, Python 3, and the VS Code Codex extension with an existing local conversation.

The static [product website](https://scilwb.github.io/codex-board/) contains demonstration data only. Run the application locally to access your own conversations.

## License

[MIT](LICENSE). An independent community project, not affiliated with or endorsed by OpenAI. Codex and VS Code names belong to their respective owners.
