# Codex 附图重绘实验

用本机 Codex 的 ChatGPT 登录，在独立会话里按 Print Chamber 的 G3 原文重绘一张原画。默认在出图使用的 macOS 隔离条件下检查启动、协议和账号状态。单图成功率、耗时和额度来自实际发出的请求；视觉还原程度需要看三列对比图。

## 临时登录预检（0 张）

在本机终端执行 `node experiments/codex-imagegen/run.cjs --login-check`。此模式自选 ChatGPT 应用包内的原生 CLI，在本次 0700 临时目录中建立独立配置。它先按出图时的进程隔离策略启动服务并握手；这一步通过后，终端才运行官方登录。请在官方页面选择原本使用的 ChatGPT 账号，回到终端等待结果。CLI 通过临时配置管理此次登录，登录过程只连接到用户的终端。

登录完成后，脚本用同一临时配置重新启动隔离服务，检查 ChatGPT 登录类型、图片功能、模型和限额。成功的最后一行是“临时登录预检通过，已提交 0 张。”实验只核对账号类型，账号选择由本人确认。此命令跳过图片素材，不创建 thread 或 turn。正常完成、登录失败或按 Ctrl-C 时，会关闭子进程并清理临时配置。保存在项目 output 中的是预检报告。之后的独立运行不会继承本次临时登录。

## 临时登录后只试第一张

在工作树根目录执行 `node experiments/codex-imagegen/run.cjs --login-first-image`。这条命令先校验第 1 张原画，再让你在官方页面登录。预检就绪后，它在同一次登录中自动提交第 1 张原画一次，可能占用 ChatGPT 额度。你无需选择或上传文件。终端显示“首图已生成”后，可打开同一行给出的 `comparison.html` 查看原画、FLUX G3 与 Codex 结果。临时登录在结束时清理。重新执行命令会发起新的测试。

## 运行

在这个分支的工作树根目录运行。需要 Node.js 22+、macOS 原生 Codex CLI；图片解码和进程隔离使用系统自带的 sips 与 sandbox-exec，无需安装 npm 包。终端里的官方 CLI 自行管理登录。实验客户端禁止读取、复制或记录用户凭据，禁止打开 ~/.codex/ 下的文件或设置 ACCESS_TOKEN。若 PATH 首个 CLI 指向该目录，实验会停止。在这台 Mac 上可在当前终端选择应用包的独立 CLI，然后执行预检。

```sh
export PATH="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS:$PATH"
node experiments/codex-imagegen/run.cjs --dry-run
```

无参数等同于 `--dry-run`。看终端打印的报告目录，打开 `results.json`。自动扫描只需要一次预检。检查 `preflight.handshake` 和 `ready`，并查看 `issues`。ready 要求账号类型为 chatgpt、image_generation 开启、供应商能力接口明确支持出图、有支持图片输入的模型，且已知账号额度许可未明确拒绝。限额读数缺失会单列原因。dry-run 的退出码 0 表示握手完成，离线模型目录或未登录状态也可能握手成功。

预检就绪后，以下命令只提交第一张，可能占用该 ChatGPT 账号的额度。

```sh
node experiments/codex-imagegen/run.cjs --limit 1
```

用户决定测完整组时可用 `node experiments/codex-imagegen/run.cjs --all` 串行提交五张。每次调用建立独立报告目录，整组执行会重新提交第一张。本次开发期间这两条生成命令均执行了 0 次。

实验从 `output/scenes-g3-20261025-060950/` 读取 prompt.txt、metrics.json 和 5 张 FLUX PNG。Git 链接工作树会自动查找主工作树的此目录，也可设置 `PRINT_CHAMBER_G3_DIR` 指向完整的 G3 数据目录。metrics 中原画的绝对路径必须在本机可读。校验 G3 指纹和每张原画的 SHA-256 后，才会提交相应原画。哈希不符的原画记作跳过。

## 协议与计量

已用安装在应用包内的 0.171.0-alpha.13 执行 `codex app-server generate-json-schema --out <临时目录>`，按生成的本机 schema 编写。任务单中记录的 0.156.1 可执行文件位于受保护安装目录，未验证该版本的协议兼容性。

1. 在每次运行新建的空工作目录中用 stdio 启动 `codex app-server`。发送 `initialize` 和 `initialized`，查询 `account/read`、`experimentalFeature/list`、`modelProvider/capabilities/read`、`model/list`、`account/rateLimits/read`。客户端不请求刷新凭据，只保留账号类型及相关额度窗口。
2. 每张原画新建一个临时 `thread/start`，指定 OpenAI 供应商、只读策略、禁审批，并检查服务端回显。模型工具关闭 shell、MCP、应用、插件、hooks、网页搜索等。真正提交前，macOS 还会限制整个 app-server 的文件写入和子进程。它仅可写本次临时目录，网络仍供官方模型服务使用。系统隔离未能启用时终止。报告由父进程直接写入本工作树。
3. `turn/start` 包含 `localImage` 和文本。外层指令固定为“调用图片生成工具，以附带图片为参考，按以下要求生成 1 张图，不要写代码、不要回复其他内容。”，其后是两个换行和原始 G3 文本。报告保存实际外层指令与 G3 哈希。
4. 用 `item/started`、`item/completed` 中的 `imageGeneration` 判断工具调用，读取 `item/agentMessage/delta` 或完成的 `agentMessage`，记录最多 500 个字符。按线程和 turn 匹配 `turn/completed`。首事件延迟和生成总耗时从提交开始计，成功样本的总耗时截止于终态事件。5 分钟后请求 `turn/interrupt`；无法确认中断或未取得 turn ID 时关闭本次服务器。
5. `imageGeneration.inputImages[].sha256` 与原画一致且取得可解码结果时，可确认生成工具使用了该原画。老版本可能缺少这个字段，届时只能记录附图请求成功返回图片，视觉效果仍需对照。优先解码内联 `result`，其次使用临时目录内的 `savedPath`。系统解码实际像素后记录格式、宽高和副本路径。只有 fileId 或临时目录外的路径时，记录缺失原因。服务端若强制把图片写入自己的常规缓存，隔离策略可能使这次生成失败。
6. 单张提交前后分别读取限额。只比较同一桶、同一重置时间、同一长度的窗口。差值是账号窗口的整数百分点，同时使用账号、显示精度和读数延迟都会影响结果。差值为零也无法证明出图免费。

## 查看结果

终端打印的 `output/codex-imagegen-<时间戳>-<后缀>/` 已被 Git 忽略。打开 `comparison.html` 查看“原画 / 本地 FLUX G3 / Codex”和每张耗时、状态。图片以相对路径引用，整个目录可以一起移动。打开 `results.json` 查看协议观察、错误和 `findings` 中的七项结论。一次单图运行只能给出该次样本的数据；五张全部实际提交后才计算整组产图率。

## 验证记录

2026-11-21，用户使用临时 ChatGPT 登录实测了第 1 张原画。此次提交 1 张，产图 0 张，另外 4 张未提交。会话在 17.814 秒后以 completed 结束，未观测到 imageGeneration 工具事件或输出文件；模型文字回复称图片工具暂不可用。该时长是收到文字回复的耗时。同一账号额度窗口的整数百分点读数没有变化，无法据此计算此次消耗。旧预检未查询供应商侧的图片生成能力，当次结果无法补推。现在会在提交前核对该能力；确认实际使用图片工具仍需工具事件。重复登录来自本实验清理临时配置的设计。

早期预检未启用出图进程的外层隔离。在独立临时配置中，该预检能握手，返回 11 个模型，未创建 thread 或 turn。未登录时 `account/read` 返回空账号，`account/rateLimits/read` 返回 RPC -32600。在临时配置关闭 image_generation 后，实际功能查询返回 enabled=false。上述两种状态均在预检停止，未测生成端错误；额度耗尽的返回也未复现。

用户在普通终端使用现有 ChatGPT 登录时，早期预检就绪，随后单图模式在隔离启动阶段退出，实际提交 0 张。新版预检与单图使用同一隔离启动器。遇到握手失败，请停在预检；重复提交原画无法解决启动问题。

用应用包版 0.171.0-alpha.13 和空白测试配置复核启动行为：测试配置可写时握手成功，仅将测试配置中的 `installation_id` 设为不可写后，同一 CLI 在握手前以代码 1 退出。恢复可写后握手成功。此次用户进程的原始诊断未被保存，无法断定它最先在哪个文件上退出。现有登录配置在运行临时目录之外，已确认该版本至少有一项启动写访问要求与当前隔离冲突。

开发环境禁止嵌套 macOS 进程隔离。离线测试使用合成图片和模拟协议事件，覆盖实际解码、工具记录、额度比较、超时中断、进程回收及报告生成。运行：

```sh
node --test experiments/codex-imagegen/*.test.cjs
```

系统拒绝叠加 sandbox 时，一项实际写入与执行限制的测试会标为跳过。在普通 macOS 进程中，同一测试已用模拟 CLI 验证临时目录内可写、目录外禁止写入、其他命令无法执行。
