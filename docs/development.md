# Bobo · 桌面上的小伙伴

一个从花盆种子慢慢长大的桌面胡萝卜，也是帮你照看 Agent 的小管理员。第一版面向 macOS 桌面，使用 Electron + React + TypeScript；养成、动画和存档在本地，聊天和自然语言调度由可配置的 LLM 提供。

## 启动

需要 Node.js 22 或更新版本。

```bash
cd bobo
npm install
npm run dev
```

依赖已经安装时直接 `npm run dev`。启动只显示透明桌宠，不打开记录窗口。点击 Bobo 展开对话气泡，拖动它可移动位置。

运行构建后的版本：

```bash
npm run build
npm start
```

仅预览界面：`npm run dev:web`。浏览器预览用于查看记录和设置界面；CLI 接入、调度 Key、桌宠窗口只能在桌面应用里使用。

## 日常交互

平时只需桌面上的 Bobo。点击宠物展开气泡，输入需求或聊聊天；再次点击或按 Esc 收起气泡，宠物继续陪伴。气泡收起时保留未发送的草稿。

- 平时只显示黑色玻璃输入胶囊，有消息时才出现对话卡片。点击「＋」可照料、选择 Agent、打开记录和设置。
- 气泡默认聊天，也可在「＋」里直接选择 Trae、Codex、Claude Code 或豆包创建任务，不需要调度模型。
- 点击「＋」→「任务与结果」或对话卡片的任务图标查看进度、结果、停止任务；豆包的手动结果也可直接记在气泡里。
- 任务结束时宠物旁出现小提示，点击查看结果，不自动弹出大窗口。
- 「＋」菜单中的历史和设置按钮、菜单栏入口，才会打开「记录与设置」窗口。它用于历史任务、陪伴日记、成长档案、额度和偏好；关闭后隐藏，桌宠继续运行。
- 聊天记录、任务和宠物存档在本地共享。未发送草稿仅在本次运行期间保留。

## 配置调度大脑

项目目录已经创建 `.env`。本地填写，不需要发到聊天里：

```dotenv
OPENAI_API_KEY=你的 Key
OPENAI_MODEL=gpt-5.6-sol
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_MODE=responses
OPENAI_REASONING_EFFORT=medium
```

默认保留你指定的 GPT-5.6 Sol。兼容网关可以自行填写准确的部署模型名称和 Base URL；若网关仅支持 Chat Completions，设 `OPENAI_API_MODE=chat`。不会静默换成其他模型。填写后在「偏好设置」点击「重新读取」，新对话会直接采用新配置。

没有 Key 时，养成、日记、额度手动记录和 CLI 直接派发可用；自然语言聊天和模型调度会明确提示尚未配置。

使用 Model Hub 时，支持 `MODEL_HUB_AK`、`MODEL_HUB_BASE_URL`、`MODEL_HUB_MODEL` 和 `MODEL_HUB_API_MODE`。AK 与接口地址分别填写；保留模板里的 OpenAI 官方地址时，会提示还缺 Model Hub 地址，不会向该地址发送 AK。模型部署名称保持配置原样。`MODEL_HUB_API_MODE=chat` 用于 Chat Completions 兼容网关，也支持 `responses`。

组织提供 AzureOpenAI 示例时，另设 `MODEL_HUB_PROTOCOL=azure`、`MODEL_HUB_API_VERSION=2024-02-01`。`MODEL_HUB_BASE_URL` 填示例的完整 `azure_endpoint`（不用手动追加 `/openai/deployments`）。请向你的模型服务提供方获取接口地址。程序使用 Azure SDK 的 `api-key` 认证与部署路径，强制 Chat Completions，每次请求生成新的 `X-TT-LOGID`。Model Hub 默认不发送 `reasoning_effort`；网关支持时可填写 `MODEL_HUB_REASONING_EFFORT`。

Bobo 的角色与工作规则在 `electron/persona.mjs`，版本为 `bobo-keeper-v6-memory`。任务列表只提供概况；模型通过 `read_task_result` 按需读取每页最多 4000 字符的档案，并区分 Agent 自报完成和独立验收。闲聊按完整消息选择最近约 10000 个本地估算 Token，并告知模型有省略；这不是无损压缩。用户确认的项目规则单独保存，可跨对话复用。每次新增调度调用前检查约 24000 Token 的输入预算，超出时停止新增调用。`BOBO_MAX_OUTPUT_TOKENS` 默认 2048，是单次模型请求的输出上限，不是整个任务的总预算。六轮调用上限及每轮最多两个派发仍然有效。

任务另有工作记忆：保存创建时的用户原话、有效纠正与撤销记录、公开报告档案和检查对应的文件版本。跨工具接续选取带来源的原文片段，原生会话接续避免重复塞入报告；文件变化后旧检查显示过期。在任务的「这项工作的记忆」中可查看要求来源、档案数量和交接长度。档案存在 userData 的 `task-memory/`；超过约 128000 字符会保留早期与最新片段并标记不完整。该机制只覆盖 Bobo 创建的任务，无法改写各 CLI 内部的上下文压缩。调研、实现边界与小规模对照见 [长程工作记忆说明](docs/long-horizon-memory.md)。

2026-10-08 新增带版本、来源和作用域的工作账本、用户确认的项目记忆、声明输入依赖的证据复核与按本地 Token 估算装配上下文。设置页可保存/撤下项目记忆；任务检查可指定输入文件，并调整交接预算（默认 8000，512～32000）。详细范围、用法和回归见 [共享工作记忆 v2](docs/work-memory-v2.md)。本地估算不等于实际账单，也不包含执行器原生历史。

2026-10-04 已用配置的 Model Hub 通过真实问答和工具回传测试。高效协作研究、接续设计与对照评测方案见 `docs/agent-coordination.md`。已实现 Trae / Codex / Claude Code 的后台有限恢复、原会话接续、跨工具交接、任务纠正留存和文件检查，见 `docs/supervision-release.md`。首轮评测见 `docs/workflow-release.md`。业务语义验收和运行中硬预算尚未实现；小样本对照未显示节省 Token。

Key 由 Electron 主进程读取，不暴露在 renderer / preload API，不打包进应用，不传入 Bobo 启动的子 Agent 环境。`.env` 已加入 `.gitignore`。已有 CLI 的登录由各工具自己管理。进程环境隔离并不替代文件访问权限：选择工作目录时，该 Agent 仍可能读取它有权限访问的文件。

## Agent 接入

### Trae / Coco 与后台照看

支持本机 traecli（Coco v0.121.1），可通过 BOBO_TRAE_PATH 指定路径。新 CLI 任务默认自动照看，确认中断才有限恢复；原进程未退出时不重复启动。详细规则、权限与已验证范围见 [自动照看说明](docs/supervision-release.md)。

### Codex

检测本地 `codex` CLI，使用 `codex exec --json`，通过 stdin 转交需求并消费 JSONL 事件。Bobo 追踪自己发起的任务；不读取 Codex 桌面应用的全部会话。

- 默认 `read-only`。
- 设置中开启文件修改后，使用 `workspace-write`。
- 不使用 bypass sandbox / approvals 参数。
- 登录状态在实际启动任务时验证；「已检测」只表示找到 CLI。

### Claude Code / CC

检测本地 `claude`，使用 `claude -p --output-format stream-json --verbose`。

- 默认计划模式，只启用 Read / Glob / Grep。
- 开启修改后，允许文件编辑，采用 `acceptEdits`；其他操作沿用 CC 权限规则。
- 接入没有额外提供操作系统级沙箱，CC 的权限行为与 Codex 不相同。
- 权限拒绝会显示「需要处理」，不假装全部完成。

使用前，在终端完成各工具自己的安装与登录。检测不到时可设置：

```dotenv
BOBO_CODEX_PATH=/absolute/path/to/codex
BOBO_CLAUDE_PATH=/absolute/path/to/claude
BOBO_CLAUDE_MODEL=
```

在 Bobo 设置里选择工作目录，也可以配置 `BOBO_WORKSPACE`。切换工作目录后，文件修改开关会重置。每次最多运行三个 CLI 任务，单次模型对话最多派发两个不同任务。任务可以停止，应用退出会停止它发起的运行中任务；重启后遗留任务标记为中断。

### 豆包

当前是明确标注的手动转交入口。Bobo 整理需求 → 创建卡片 → 用户点击「复制需求并打开豆包」 → 在豆包粘贴发送 → 将结果记回卡片。

没有使用火山引擎模型 API 来冒充控制豆包用户账号；不自动读取豆包对话、进度、额度。

## 额度与 Token

Codex、CC 和豆包的订阅剩余额度目前手动记录，可以填写百分比、重置时间和备注。显示更新时间，未知保持未知。模型和 CLI 的 Token 记录是已发生用量，不推算成订阅剩余额度。

调度大脑按 API 实际 usage 统计输入、输出 Token 和调用次数。CLI 任务按返回事件记录 Token；CC 若返回费用则显示为 CLI 估算。这里没有接入自动订阅额度查询。

## 养成与生命周期

- 第一天：种子；第 2 天起：发芽。
- 第 8 天起：幼年；第 22 天起：成年。
- 第 121 天起：老年；约第 181 天：回忆期。
- 正常按日历时间推进。一次离开超过两天，只累计前两天，之后暂停，等待再次打开。
- 浇水每天 3 次、抚摸 5 次、晒太阳 2 次有数值收益。重复互动给出回应，不靠刷点击加速年龄。
- 照料会留下日记，模型用量不影响生命。
- 回忆期可以培育下一代，保留上一代身份和日记。新宠物拥有自己的成长状态；Agent 设置继续保留。
- 「形态预览」只改变当前展示，不修改真实成长存档。

日记、宠物、任务与偏好存储在 Electron 的 userData 目录，存档采用原子写入；启动时遇到损坏存档会保留原文件并报告，不静默覆盖。开发版本通常位于 `~/Library/Application Support/Bobo/state.json`。

## 验证

```bash
npm run build
npm test
npm run test:desktop
npm run test:workflow
npm run test:supervisor
npm run test:memory
npm run test:work-memory
npm run test:permissions
```

核心测试覆盖成长、离线时钟、照料上限、代际存档、任务流、取消、异常、配置隔离和模型工具循环。桌面测试启动真实 Electron，在临时存档下使用本地模拟 API 和 CLI 进程，验证界面交互、模型派发、结果记录、透明桌宠和重启恢复；不会消耗真实模型额度。

2026-10-04 已通过 62 项单元测试和上述四套 Electron 回归。另使用配置的 Model Hub 做了 15 次上下文对照调用，并用本机真实 Trae / Coco 验证只读回查任务档案。实验范围与原始数据见长程工作记忆说明；这不代表完整长任务成功率已经提高。

`npm run eval:memory -- --dry-run` 只检查合成输入，不请求模型；不带 `--dry-run` 的 `npm run eval:memory` 会使用配置的真实模型并消耗额度。可用 `--repeats 3` 设置重复次数，调用受脚本中的预算门槛限制。它只评估三个合成断点的下一步判断，不执行真实项目任务。真实 CLI 测试仍需要各工具的有效登录。

2026-10-05 当前版本通过 73 项单元测试、四套 Electron 回归，以及真实子进程的权限拒绝回放。真实 Trae 已完成 ApplyPatch 写入和文件验收。

实际文件试验与本轮工具权限修正见 [真实工作记忆试验](docs/real-work-memory-evaluation.md)。当前 Trae 允许编辑时支持 ApplyPatch，只读时禁止，内部 Agent / Task 委派关闭。结构化权限拒绝会停止本次进程并提示处理，最终用量可能未知，不自动重试。执行交接保留必要事实，本地计费和内部编号不发送给执行器；任务面板显示实际传输字符数。

`npm run eval:work-memory` 与 `npm run eval:project-memory` 默认只做 dry run；加 `--run` 会请求真实 CLI／Model Hub 并消耗额度。后者使用最小本地文件工具循环，不代表 Codex／CC／Trae 原生能力。两者的 Token 门槛均为调用间检查，不能保证正在执行的调用不越过门槛。

## 本地打包

```bash
npm run package
```

输出在 `release/`，目录构建可直接打开应用。当前是本地未签名开发版，尚未完成分发签名、公证、自动更新和安装器。

打包版默认在 userData 创建 `.env`，配置路径在设置页显示。也可以在设置中选择项目里的 `.env` 文件，路径会保存供下次启动使用；或通过 `BOBO_ENV_PATH=/absolute/path/to/.env` 指定配置文件。

## 下一步

好友串门、共同照片、花盆装饰、自动额度查询、任意 IDE 原有会话接管和语音尚未实现。当前 Bobo 是生命周期与桌面管理员的第一版原型。成年形象采用用户参考图衍生的透明毛绒素材，种子和幼苗暂用矢量形态。「＋」菜单可预览成年形象，不改变真实年龄。界面采用 Apple Design skill 的材料层次、系统字体、即时按压反馈和弹簧动效，并适配减少透明度、减少动效和提高对比度的偏好。

官方接入资料：

- https://developers.openai.com/api/docs/models/gpt-5.6-sol
- https://developers.openai.com/api/docs/guides/function-calling
- https://developers.openai.com/codex/noninteractive
- https://code.claude.com/docs/en/headless
