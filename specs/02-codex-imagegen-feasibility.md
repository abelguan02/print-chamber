# 02 Codex 出图可行性验证

分支：`codex/codex-imagegen-spike`

## 目标

验证能否通过用户本机已登录的 Codex（ChatGPT 账号额度）把一张原画按 G3 提示词重绘成 3D 风格，并量化耗时、成功率、额度消耗与效果。**只做独立实验，不接入扩展、服务或小助手。**结论用于决定是否开发“Codex 生成方式”。

已知前提（2026-11-20 在开发机确认）：`codex-cli 0.156.1`，`codex login status` 为 “Logged in using ChatGPT”，`codex features list` 中 `image_generation` 为 stable/true。

## 范围

新增目录 `experiments/codex-imagegen/`，所有代码与说明放在这里。不修改仓库中任何已有文件（`.gitignore` 除外，若需要忽略实验输出）。输出写入被忽略的 `output/codex-imagegen-<时间戳>/`。

语言：Node.js 22（与仓库开发依赖一致），不新增 npm 依赖；如确需依赖先在回复中说明理由。

## 接入方式（必须遵守）

- 通过官方 `codex app-server`（stdio，换行分隔 JSON-RPC）驱动，由脚本 `spawn('codex', ['app-server', ...])` 启动子进程。
- 使用 Codex 自己管理的 ChatGPT 登录。**不得读取、复制、解析 `~/.codex/auth.json` 或任何 token，不设置 `ACCESS_TOKEN`。**
- 协议以本机版本为准：先运行 `codex app-server generate-json-schema --out <临时目录>`（或 `generate-ts`），按生成的 schema 实现，不凭记忆猜方法名。基本流程：`initialize`（`clientInfo: {name:"print-chamber-spike", title:"Print Chamber", version}`）→ `initialized` → `thread/start` → `turn/start` → 监听事件直到 `turn/completed`。
- 子进程工作目录为每次运行新建的空临时目录；沙箱只读、不允许执行命令与写文件以外的副作用；审批策略设为不需要人工审批（以 schema 中可用选项为准）。若出图结果需要写文件，只允许写入该临时目录。
- 原画以本地图片输入项（schema 中的 local image 类型）附带，不要把图片 base64 塞进文本提示。

## 提示词

- G3 原文从 `output/scenes-g3-20261025-060950/prompt.txt` 读取，逐字使用，不修改。
- 外层指令只说明“调用图片生成工具，以附带图片为参考，按以下要求生成 1 张图，不要写代码、不要回复其他内容”，G3 文本原样拼接在后。外层指令写死在脚本中并原样记入报告。

## 测试样本

使用 `output/scenes-g3-20261025-060950/metrics.json` 中 `sources` 的 5 张原画（路径与 sha256 在文件中；运行前校验 sha256，不一致则跳过并记录）。同目录下 `1-G3.png`…`5-G3.png` 是本地 FLUX G3 结果，用于对比。

## 运行方式与额度保护

```sh
node experiments/codex-imagegen/run.cjs --dry-run       # 只做握手、列模型/账号限额，不出图
node experiments/codex-imagegen/run.cjs --limit 1       # 只跑第 1 张
node experiments/codex-imagegen/run.cjs --all           # 跑全部 5 张
```

- 不带 `--limit` 或 `--all` 时默认等同 `--dry-run`，避免误耗额度。
- 每张图单独一个 thread，串行执行；单张超时 5 分钟，超时记为失败并结束该 turn（使用 schema 中的中断方法）。
- 若 schema 提供账号限额读取（如 rate limits 相关方法），在每张图前后各读取一次并记录。

## 记录与报告

每张图记录：开始/结束时间、总耗时、首个事件延迟、`turn/completed` 状态、是否真的调用了图片生成（依据事件中的 item 类型而非模型文字）、输出图片路径与尺寸、Codex 文字回复（截断 500 字）、限额前后值、错误信息。

产出：

- `output/codex-imagegen-<时间戳>/results.json`：上述原始记录 + 运行环境（codex 版本、外层指令、G3 sha256）。
- `output/codex-imagegen-<时间戳>/comparison.html`：每行“原画 | 本地 FLUX G3 | Codex”三列并排，下方列出耗时与状态。图片用相对路径引用复制到该目录的文件。
- `experiments/codex-imagegen/README.md`：如何运行、协议要点（实际用到的方法名与事件名）、已知限制。

## 必须回答的问题（写在回复与 results.json 的 `findings` 中）

1. Codex 能否以附带原画为参考出图（图生图），还是只能文生图？
2. 5 张中实际调用图片生成并产出图片的比例。
3. 单张耗时中位数与最大值。
4. 额度消耗是否可观测；若可，每张约占多少。
5. 输出图片的格式、尺寸及文件位置（是否由 Codex 写到临时目录之外，例如 `~/.codex` 下）。
6. 未登录、额度用尽、`image_generation` 关闭时分别返回什么错误（能复现的就复现；不能复现的写明未验证）。
7. 本机检测 Codex 可用性的最小可靠步骤（命令与判断条件），供后续自动扫描使用。

## 验收标准

1. `--dry-run` 能在不出图的情况下完成握手并退出，进程无残留（`pgrep -f "codex app-server"` 为空）。
2. `--limit 1` 产出 `results.json` 与 `comparison.html`，并回答上述 7 个问题中能回答的部分。
3. 代码中没有读取 `~/.codex` 下文件或处理 token 的逻辑（审核时 `grep -rn "auth.json\|ACCESS_TOKEN\|\.codex/" experiments/` 应仅出现在注释或 README 的禁止说明中）。
4. 仓库其他文件无改动（`git diff --stat main` 只含 `experiments/` 与可能的 `.gitignore`）。
5. `--all` 不由 Codex 在开发时运行，留给用户执行（避免开发过程消耗大量额度）；开发阶段最多运行 `--limit 1` 两次。
