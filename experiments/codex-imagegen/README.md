# Codex 附图重绘实验

用本机 Codex 的 ChatGPT 登录，在独立会话里按 Print Chamber 的 G3 原文重绘一张原画。默认在出图使用的 macOS 隔离条件下检查启动、协议和账号状态。单图成功率、耗时和额度来自实际发出的请求；视觉还原程度需要看三列对比图。

## 首图重绘已通过一次实机验证

2026-11-21，新的单次授权下，本机桌面 Codex `0.171.0-alpha.13` 复用已有 ChatGPT 登录，以 `gpt-6.2-sol` 发送一次 G3 原文及清单第 1 张原画。启动参数将 `features.code_mode` 设为 `{enabled=false,direct_only_tool_namespaces=["image_gen"]}`，开启 `features.image_generation`，关闭 `features.omit_app_server_notification_media`。在只读临时会话中显式指定 `image_gen.imagegen`，用 `localImage` 附图，并在指令中提供该图对应的 `referenced_image_paths`。G3 原文和原画均在提交前通过 SHA-256 校验。

工具调用 1 次并返回 `completed`，其参考图指纹与清单第 1 张原画一致。收到有效图片即关闭连接，耗时 43.4 秒。返回的 PNG 可完整解码，尺寸为 1778 × 884。图片与回执位于本地 `output/codex-g3-first-direct-20261121-once/`。仅这一次、这张原画通过验证，风格还原程度由用户看图确认。下方保留之前的试验结果；两次的调用方式有多处差异，无法据此单独确定上次失败的原因。

## 早期首图实机结果（该次授权已结束）

2026-11-21 05:20（美东），用户在普通终端执行了以下命令一次：

```sh
node experiments/codex-imagegen/run.cjs --first-image-once
```

桌面端 Codex 0.171.0-alpha.13 首次连接和重连均识别到已有 ChatGPT 登录。`gpt-6.2-sol` 的图片输入、出图开关、供应商能力和普通额度预检均通过。脚本按清单校验第 1 张原画和 G3 原文，实际提交 1 次。会话在 20.283 秒后以 `completed` 结束，记录里只有文字回复。文字称图片工具未能启动。旧脚本未观测到单独的图片工具事件，也未保存会话结束时的条目。此次产图 0 张，真实调用情况及失败原因未知。

同一 Codex 主额度窗口的已用比例从 72% 到 72%，整数读数无法分辨本次实际消耗。产图 0 张，无成功耗时、格式或尺寸。其余 4 张未测，整组成功率未验证。实验在这里停止。

桌面端 Codex 可以维护安装标识和启动器临时文件。个人图片缓存的写入受限。0.171.0-alpha.13 的完成事件可直接携带图片字节，也可只给附件编号或保存路径。脚本只接收有效的图片字节或本次临时目录内的图片文件。只有编号、外部路径或文字回复时，会说明原因并结束。

启动时独占创建的 `output/codex-imagegen-2026-11-21-first-image-once/` 保留了此次结果，也阻止相同命令再次提交。目录中的 `results.json` 记录 7 项结论；`comparison.html` 显示原画、FLUX 对照及首图失败状态。

## 查询出图条件（提交 0 张）

### 同版本官方实现与本机资格核查

桌面端所用的 Codex 版本 `0.171.0-alpha.13` 在创建 app-server 的线程时安装内置图片组件，由 Codex 自己管理认证。该版本的官方集成测试在模拟 ChatGPT 登录、无 API Key 的条件下，检查模型能看到 `image_gen__imagegen`，也覆盖调用和编辑随消息提交的参考图。[组件安装](https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/app-server/src/extensions.rs#L118-L126) · [工具可见性与调用测试](https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/app-server/tests/suite/v2/imagegen_extension.rs#L958-L1077) · [参考图编辑测试](https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/app-server/tests/suite/v2/imagegen_extension.rs#L859-L913)

注册工具时，Codex 会检查出图开关、账号方案、供应商出图能力、模型图片输入能力和认证方式。下方离线实验使用空白账号且把供应商设为 `requires_openai_auth=false`，这会使它跳过图片工具。因此那 21 个函数只能说明空白模拟环境的情况。针对已有登录的补查只调用账号、供应商、功能和模型查询接口，未创建线程或提交模型请求。本地记录为 `output/codex-image-registration-fx3xfopq/results.json`。[同版注册条件](https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/core/src/tools/spec_plan.rs#L821-L855)

此结论的适用范围是使用本机 Codex 管理登录的个人本地应用。OpenAI 对商业或托管服务另有认证要求，面向第三方的 Sign in with ChatGPT 预览路线目前也明确排除图像生成。[app-server 认证说明](https://learn.chatgpt.com/docs/app-server#auth-endpoints) · [第三方登录预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

### code_mode 离线对照

使用同一份经签名核验的桌面端 0.171.0-alpha.13 和随包的 `gpt-6.2-sol` 模型表（`tool_mode=code_mode_only`）。每组使用空白配置，保持图片功能开启、只读临时会话、禁止子进程。模拟供应商的 `modelProvider/capabilities/read` 返回 `imageGeneration=true`。只放行本机模拟服务端口，向它发送相同的纯文字，服务返回固定文字。两组均正常完成。

| 观察项 | `code_mode=false` | `code_mode=true` |
|---|---|---|
| 模型请求中的 `tools` 字段 | 未提供 | 未提供 |
| 显式图片工具声明或函数绑定 | 未见 | 未见 |
| 动态工具查找说明 `ALL_TOOLS` | 有 | 相同 |
| 图片提交数 / 工具调用数 | 0 / 0 | 0 / 0 |

另外用随包的 `gpt-5.5` 模型表校验接收器，读到 6 个显式工具，包括看图用的 `view_image`。对目标模型，切换开关没有改变首个请求中可见的图片工具声明。动态工具清单与先前已登录的真实会话仍未知。两组均未调用模型或图片服务。观察数据在 `output/codex-offline-code-mode-8t_1rcyd/results.json`。

### 真实会话工具清单查询（纯文字）

桌面端 Codex 0.171.0-alpha.13 返回 `account.type=chatgpt`。在与首图相同的 `gpt-6.2-sol`、只读权限和 `code_mode=false` 下，发送了 1 条文字请求，要求查询 `ALL_TOOLS` 中的图片工具名称。该轮正常结束，模型回复 `CATALOG_UNAVAILABLE`。只观察到用户消息和助手文字，结束清单是摘要，未取得结构化工具输出。没有附图，也未观测到出图调用。Print Chamber 会话里的图片工具仍未确认。报告为 `output/codex-live-catalog-URZYqK/results.json`。

同机当前的 Codex 桌面聊天直接查询动态清单，返回 `image_gen__imagegen`，对应绑定的类型为 `function`。该项只验证桌面聊天自身的工具注册。

随后使用官方配置项 `features.tool_registry.turn_metadata_includes_tool_info=true`，让 Codex 在发给模型的每轮请求中附上工具信息。离线对照沿用上述空白配置和固定文字回复，本机模拟服务读取请求中的 `tool_namespaces_info`。开关 `code_mode` 的两组都列出相同的 3 个命名空间、21 个函数。唯一与图片有关的函数是查看图片的 `functions.view_image`，清单中没有 `image_gen.imagegen`。两组的供应商出图预检均为真。[官方配置定义](https://developers.openai.com/codex/config-schema.json)

同版本的真实连接也识别到已有 ChatGPT 登录。单独观察从握手到创建会话的通知，期间没有启动警告。保持首图的权限和模型，启用上述工具信息选项后，发送 1 条纯文字查询。该轮正常结束，模型回复 `CATALOG_UNAVAILABLE`，客户端只收到用户消息及助手文字。该选项把清单附给模型服务，当前版本的公开会话接口没有向 Print Chamber 返回同一份清单。因此，真实连接能否调用出图工具仍未确认。这次查询与离线对照均提交 0 张图片。真实查询回执和离线清单分别保存在 `output/codex-live-catalog-metadata-sLrBpu/results.json` 和同目录的 `comparison.json`。

### 零提交预检

使用已通过登录复用实测的桌面端连接，在工作树根目录运行：

```sh
node experiments/codex-imagegen/run.cjs --check-image-capability
```

脚本连接一次，确认当前为 ChatGPT 登录，再查出图开关、供应商出图能力、支持参考图输入的模型和账号额度。未确认登录就停止。全程不找素材、不创建模型会话、不发起登录。首图试验的授权和入口见上一节。

终端打印四项结果；`output/codex-image-capability-<时间戳>-<后缀>/results.json` 记录所选模型、额度判断和未查明的原因。开关与供应商能力均为真、有可用图片输入模型、账号未明确拒绝普通额度且 Codex 计量项未报告已触限，才显示“出图预检通过”。普通额度读数缺失时显示“未知”。通过表示可以尝试，实际生成还需图片工具完成事件和图片文件。

2026-11-21 05:05（美东），普通终端实测通过。桌面端 Codex 0.171.0-alpha.13 识别到已有 ChatGPT 登录，出图开关开启，供应商支持出图，`gpt-6.2-sol` 支持图片输入，普通额度可用。报告 `output/codex-image-capability-2026-11-21T10-05-37-321Z-xJxC5Z/results.json` 记录 `ready=true`、`submitted=0`，无错误。此前 9 个模拟场景通过。

## 已验证的登录重连

在本工作树运行这一条命令即可。它会向 ChatGPT 桌面应用随附的 Codex 查询当前账号类型，第一次返回 `chatgpt` 后关闭本次服务，再用同一程序、同一已有配置启动一次并重复查询。首次失败时不会重连。两次结果均为 `chatgpt` 表示本轮已识别已有登录，提交图片数应始终为 0。

```sh
node experiments/codex-imagegen/run.cjs --check-existing-login
```

登录检查和零提交出图预检使用同一启动方式。签名已核验的官方 Codex 按 Ledge 的方式使用当前用户的正常文件权限维护自己的运行状态，并限制启动其他可执行程序。Print Chamber 通过本地进程通信查询状态，不打开登录文件、不保存令牌、不主动刷新登录。登录不可用或连接中断时停止。

2026-11-21 04:06（美东），用户在普通终端对桌面端 Codex `0.171.0-alpha.13` 完成实测。首次连接和关闭后重连均握手成功，`account/read` 两次返回 `chatgpt`；全程无需重新登录。报告 `output/codex-existing-login-2026-11-21T09-06-57-997Z-bxpfJB/results.json` 记录 `existingLogin.verified=true`、`submitted=0`，无错误。本次实测验证了登录专用入口；首图重绘仍未通过验收。

## 此前的首图试验

本轮已经达到单图命令两次的开发上限，实验停在启动阶段。以下是实测时使用的命令，请勿在本轮再次执行。运行环境为实验分支工作树、Node.js 22+ 和 macOS，图片解码和进程隔离使用系统的 sips 和 sandbox-exec。

```sh
node experiments/codex-imagegen/run.cjs --limit 1
```

启动器从已安装的 ChatGPT 桌面应用中定位随附的 Codex，向 macOS 核验它的 OpenAI 签名，并在两次连接和出图中使用同一个可执行文件。若未找到或无法确认签名就停止，不回退到终端中的独立安装版。报告的 `environment.codexSource` 和 `environment.codexExecutable` 指明来源和位置。实验客户端禁止读取 ~/.codex/ 下的登录文件或处理令牌。官方 Codex 自行使用原有登录配置。

第一次连接确认账号类型后，脚本关闭该子进程，再按相同设置启动和检查第二次。两次都返回 `chatgpt`，图片生成功能、供应商能力和模型输入满足要求，且账号未明确拒绝额度，才自动提交第 1 张一次，可能使用账号额度。无法确认登录或出图条件时自动停止，不发起登录。终端打印的报告目录包含 `results.json` 和三列对比页 `comparison.html`。

仅希望检查连接时运行 `node experiments/codex-imagegen/run.cjs --dry-run`，提交 0 张。无参数行为相同。查看 `existingLogin.first`、`existingLogin.reconnect`、`existingLogin.verified` 和 `preflight.ready`。预检全部通过时退出码为 0。

脚本在工作树或主工作树的 `output/scenes-g3-20261025-060950/` 查找 G3 提示词和素材清单。单图模式仅校验及复制第 1 张原画和对应的 `1-G3.png`。重跑单图命令可能再次提交，本阶段首次失败后停止。

## 协议与计量

本机 ChatGPT 桌面应用随附的 Codex 为 0.171.0-alpha.13。已核对这个可执行文件的 OpenAI 签名及其生成的稳定协议定义。该版本支持查询登录、供应商出图能力，并接受本地参考图。图片工具完成事件可报告 `savedPath` 和 `inputImages[].sha256`。仅从临时目录取回图片，实际能否出图及保存在哪里，仍需首图验证。

1. 在每次运行新建的空工作目录中用 stdio 启动 `codex app-server`。发送 `initialize` 和 `initialized`，查询 `account/read`、`experimentalFeature/list`、`modelProvider/capabilities/read`、`model/list`、`account/rateLimits/read`。客户端不请求刷新凭据，只保留账号类型及相关额度窗口。
2. 每张原画新建一个临时 `thread/start`，指定 OpenAI 供应商、只读策略、禁审批，并检查服务端回显。模型工具关闭 shell、MCP、应用、插件、hooks、网页搜索等。真正提交前，macOS 还会限制整个 app-server 的文件写入和子进程。一次性首图入口允许官方程序维护上文所列的启动状态，图片写入限于本次临时目录，网络供官方模型服务使用。系统隔离未能启用时终止。报告由父进程直接写入本工作树。
3. `turn/start` 包含 `localImage` 和文本。外层指令固定为“调用图片生成工具，以附带图片为参考，按以下要求生成 1 张图，不要写代码、不要回复其他内容。”，其后是两个换行和原始 G3 文本。报告保存实际外层指令与 G3 哈希。
4. 从 `item/started`、`item/completed` 和同一轮 `turn/completed.turn.items` 读取 `imageGeneration`，按工具条目 ID 合并重复记录。报告保留调用次数、工具状态和最终条目清单的完整性；清单不完整且没有观察到工具时标为无法确认。旧报告没有最终条目，无法补判。文字回复最多保存 500 个字符，耗时从提交算到终态。5 分钟后请求中断，无法确认中断或未取得 turn ID 时关闭本次服务器。
5. `imageGeneration.inputImages[].sha256` 与原画一致且取得可解码结果时，可确认生成工具使用了该原画。老版本可能缺少这个字段，届时只能记录附图请求成功返回图片，视觉效果仍需对照。优先解码内联 `result`，其次使用临时目录内的 `savedPath`。系统解码实际像素后记录格式、宽高和副本路径。只有 fileId 或临时目录外的路径时，记录缺失原因。服务端若强制把图片写入自己的常规缓存，隔离策略可能使这次生成失败。
6. 单张提交前后分别读取限额。只比较同一桶、同一重置时间、同一长度的窗口。差值是账号窗口的整数百分点，同时使用账号、显示精度和读数延迟都会影响结果。差值为零也无法证明出图免费。

## 查看结果

终端打印的 `output/codex-imagegen-<时间戳>-<后缀>/` 已被 Git 忽略。打开 `comparison.html` 查看“原画 / 本地 FLUX G3 / Codex”和每张耗时、状态。图片以相对路径引用，整个目录可以一起移动。打开 `results.json` 查看协议观察、错误和 `findings` 中的七项结论。一次单图运行只能给出该次样本的数据；五张全部实际提交后才计算整组产图率。

## 验证记录

2026-11-21 03:43（美东），用户在普通终端运行单图命令。桌面端 Codex 0.171.0-alpha.13 的签名及版本检查通过，服务在首次握手前以退出码 1 结束。账号查询、重连和图片工具均未执行，提交 0 张、产图 0 张。报告目录为 `output/codex-imagegen-2026-11-21T08-43-52-440Z-Lb6lxj/`。加上较早一次握手失败，本轮两次 `--limit 1` 均已使用。现有登录复用和首图重绘的验收均未通过。

该次运行时段的 macOS 系统记录中有两次拒绝 Codex 修改自身临时目录的文件权限，一次拒绝设备写入。Ledge 的启动配置允许官方程序维护工作目录外的运行状态；本实验按任务单限制这些写入。服务的原始错误流未留存，无法从退出码或这些拒绝记录断定具体致命操作。

桌面端优先模式在本机定位到经 OpenAI 签名的 0.171.0-alpha.13，已用它实际导出协议，并核对首图与清单中的 SHA-256。零提交预检记录了桌面包内的可执行文件路径。开发环境在启用 macOS 写入限制时停止，服务未启动，首次连接和重连均未查询到账号。此次提交 0 张、产图 0 张。普通终端的单图命令包含相同的写入限制和登录门槛。

此前独立安装版试验中，0.156.1 的第 1 张素材 SHA-256 与清单一致。开发环境在启动 Codex 服务前拒绝叠加 macOS 写入限制。因此这次两次账号检查均未执行，首图提交 0 次，产图 0 张；日常登录和首图仍待普通终端验证。

历史临时登录命令 `--login-check`、`--login-first-image` 会使用独立的临时登录配置，不用于本阶段。

2026-11-21，用户使用临时 ChatGPT 登录实测了第 1 张原画。此次提交 1 张，产图 0 张，另外 4 张未提交。会话在 17.814 秒后以 completed 结束，未观测到 imageGeneration 工具事件或输出文件；模型文字回复称图片工具暂不可用。该时长是收到文字回复的耗时。同一账号额度窗口的整数百分点读数没有变化，无法据此计算此次消耗。旧预检未查询供应商侧的图片生成能力，当次结果无法补推。现在会在提交前核对该能力；确认实际使用图片工具仍需工具事件。重复登录来自本实验清理临时配置的设计。

早期预检未启用出图进程的外层隔离。在独立临时配置中，该预检能握手，返回 11 个模型，未创建 thread 或 turn。未登录时 `account/read` 返回空账号，`account/rateLimits/read` 返回 RPC -32600。在临时配置关闭 image_generation 后，实际功能查询返回 enabled=false。上述两种状态均在预检停止，未测生成端错误；额度耗尽的返回也未复现。

用户在普通终端使用现有 ChatGPT 登录时，早期预检就绪，随后单图模式在隔离启动阶段退出，实际提交 0 张。新版预检与单图使用同一隔离启动器。遇到握手失败，请停在预检；重复提交原画无法解决启动问题。

用应用包版 0.171.0-alpha.13 和空白测试配置复核启动行为：测试配置可写时握手成功，仅将测试配置中的 `installation_id` 设为不可写后，同一 CLI 在握手前以代码 1 退出。恢复可写后握手成功。此次用户进程的原始诊断未被保存，无法断定它最先在哪个文件上退出。现有登录配置在运行临时目录之外，已确认该版本至少有一项启动写访问要求与当前隔离冲突。

开发环境禁止嵌套 macOS 进程隔离。离线测试使用合成图片和模拟协议事件，覆盖实际解码、工具记录、额度比较、超时中断、进程回收及报告生成。运行：

```sh
node --test experiments/codex-imagegen/*.test.cjs
```

本轮共 47 项测试。开发环境通过 44 项，涉及 macOS 进程隔离的 3 项使用模拟程序在普通 macOS 权限下另外通过。
