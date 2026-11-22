# 04 GitHub 安装包与自动配对

本任务分 4 个阶段，**每个阶段单独一个分支、一个 PR**，前一阶段合并后再开始下一阶段。分支名：`codex/installer-a-bundle`、`codex/installer-b-pairing`、`codex/installer-c-local-model`、`codex/installer-d-release`。

## 产品目标

用户从 GitHub Releases 下载一个几十 MB 的 `PrintChamber-<版本>-arm64.dmg`，把 `Print Chamber.app` 拖进“应用程序”，打开后按设置窗口完成：

1. 加载 Chrome 扩展（不上架商店，只能“加载已解压的扩展程序”，这一步由用户手动点）。
2. 扩展与 App 自动配对，不再复制粘贴连接码。
3. 云端 API、本机 Codex 立即可用；本地模型（约 16 GB）由用户自行选择是否下载。

不签名、不公证、不上架 Chrome 商店。目标机器：Apple Silicon Mac、macOS 13+、Google Chrome。干净系统上**不得要求**预装 Xcode 命令行工具、Python 或 Node.js。

## 已确认的事实（2026-11-21）

- 模型官方仓库 `black-forest-labs/FLUX.2-klein-4B`：Hugging Face API 显示 `gated: false`、`license: apache-2.0`，匿名下载返回 206。固定修订版 `e7b7dc27f91deacad38e78976d1f2b499d76a294`。开发机上的模型目录 15 GB。
- 现有 Python 环境依赖见 `requirements-macos-arm64.txt`（Python 3.12.14，安装后约 0.8 GB）。
- `uv` 最新版 0.13.9，提供 `uv-aarch64-apple-darwin.tar.gz` 及 `.sha256`。
- 当前小助手用 `/usr/bin/python3` 运行 `controller.py`：干净 Mac 上它只是一个提示安装命令行工具的占位程序，必须移除这一依赖。
- 当前本机 Codex 助手需要系统 Node.js 22（`native/install.cjs` 把 `process.execPath` 写进启动脚本），扩展 ID 由目录路径推导。

## 总体设计（各阶段共同遵守）

| 项目 | 决定 |
|---|---|
| 安装包格式 | `.dmg`，内含 `Print Chamber.app` 和指向 `/Applications` 的快捷方式。不用 `.pkg`。 |
| App | 由现有菜单栏小助手演化，Bundle 名 `Print Chamber.app`，菜单栏标题与功能沿用。仅 arm64；在 Intel Mac 上启动时弹窗说明不支持后退出。 |
| 运行数据目录 | `~/Library/Application Support/Print Chamber/`（下称“数据目录”）：`token`、`runtime.json`、日志、`extension/`、`python/`、`models/`。 |
| Node.js | 随 App 打包固定版本的官方 Node.js 22 LTS（darwin-arm64），构建时按官方 `SHASUMS256.txt` 校验。只给本机助手用。 |
| Python / uv | 不随包。用户选择下载本地模型时，按固定版本与 sha256 下载 `uv`，再由 `uv` 安装 Python 3.12.14 与 `requirements-macos-arm64.txt`。 |
| 扩展文件 | App 内置扩展副本；每次启动同步到 `数据目录/extension/`。用户始终从这个固定目录加载扩展。 |
| 扩展 ID | 在 `manifest.json` 加入固定 `key`，ID 不再随目录变化。 |
| 开发模式 | `python3 menu-helper/build.py` 仍构建引用仓库目录的开发版（行为同现在，状态目录 `.local/`）。发布模式由新脚本构建。两种模式由 `Info.plist` 的 `PrintChamberMode`（`dev` / `app`）区分。 |
| 界面文字 | 遵守 `specs/01-settings-no-helper-text.md` 的规则：设置窗口与扩展里只出现标题、按钮、状态、出错原因，不写说明段落。 |

---

## 阶段 A：自包含的 App

### 改动

1. 新增 `release/build-app.cjs`（或扩展现有 `menu-helper/build.py`，二选一，说明理由），构建 `dist/Print Chamber.app`：
   - `Contents/MacOS/PrintChamberHelper`：现有 `main.swift` 编译产物（`-target arm64-apple-macos13`）。
   - `Contents/Resources/`：`AppIcon.icns`、`service.py`、`runtime_config.py`、`controller.py`、`requirements-macos-arm64.txt`、`extension/` 完整副本、`native/`、`node/`（Node 运行时，阶段 B 接入；本阶段可先放入并验证可执行）。
   - `Info.plist`：`PrintChamberMode=app`，版本取自 `extension/manifest.json`，不再写 `ProjectRoot`。
   - 构建产物 ad-hoc 签名。注意 Resources 内的 Node 二进制保留其官方签名，不被 `--deep` 重签破坏；在报告中写明实际做法与验证结果。
2. `runtime_config.py`：`PRINT_CHAMBER_STATE` 未设置时，若运行于 App 模式（由 App 启动子进程时传入环境变量 `PRINT_CHAMBER_MODE=app`），默认状态目录为数据目录；否则保持仓库 `.local/`。`settings()` 的默认 `python`、`model` 在 App 模式下分别为 `数据目录/python/bin/python`、`数据目录/models/FLUX.2-klein-4B`。现有 `runtime.json` 与环境变量覆盖优先级不变。
3. `main.swift`：
   - App 模式下项目根改为 `Bundle.main.resourceURL`，状态目录改为数据目录；开发模式不变。
   - **运行 `controller.py` 改用 `settings()` 中的 Python**（本地模型环境）。读取方式：App 启动时用该 Python 不可用即视为“本地模型未安装”，不调用 `/usr/bin/python3`。未安装时菜单中的启动 / 停止 / 重启 / 复制连接码隐藏，状态行显示 `本地模型未安装`，新增菜单项 `设置…`（打开阶段 B 的设置窗口，本阶段可先打开一个空窗口）。
   - “查看运行日志”“打开使用说明”指向数据目录内的文件或 App 内置文件。
4. 首次启动时创建数据目录（0700）并把内置扩展同步到 `数据目录/extension/`：内容不同才覆盖；不删除用户放在其他位置的文件。

### 测试

- Python：`runtime_config` 在 dev / app 模式及环境变量覆盖下的路径（新增单测）。现有 `menu-helper/test_controller.py` 通过。
- Swift：`--self-test` 增加 App 模式路径检查（不打开菜单栏）。
- 构建脚本：生成的 App 中存在上述资源；`Contents/Resources/node/bin/node --version` 可运行；`codesign --verify` 通过。
- 在**未安装本地模型**的状态目录下启动 App，菜单不调用 `/usr/bin/python3`（用一个替身状态目录验证，并说明验证方法）。

### 验收

1. `dist/Print Chamber.app` 移到任意目录都能启动，不依赖仓库。
2. 开发模式构建与行为不变（现有测试全部通过）。
3. 日常开发机上已有的 `.local/runtime.json`、模型和连接码不受影响（开发模式继续使用它们）。

---

## 阶段 B：固定扩展 ID、内置助手与自动配对

### 改动

1. **固定扩展 ID**：生成 RSA 2048 密钥对，公钥（base64 DER）写入 `extension/manifest.json` 的 `key`。**私钥不进仓库**，保存到 `~/.print-chamber-signing/extension-key.pem`（0600），在 PR 中提醒用户自行备份。新 ID 写入 `native/` 常量，安装器不再从目录推导 ID。
   - 已知影响：开发机上现有扩展（旧 ID）的打印记录、云端密钥与设置不会迁移到新 ID。只在 PR 与发布说明中写明，不做迁移功能。
2. **本机助手随 App**：
   - 新增 `Contents/MacOS/print-chamber-host`（shell 启动脚本），用 App 内置 Node 运行 `Resources/native/host.cjs`，传入固定的扩展 origin。
   - App 每次启动时登记 / 更新 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.printchamber.codex.json`，`path` 指向当前 App 内的启动脚本，`allowed_origins` 只含固定 ID。App 被移动后下次启动自动修正。
   - `native/install.cjs` 保留给开发模式使用，同样使用固定 ID。
   - 主机名沿用 `com.printchamber.codex`，不改名（避免已登记的开发环境失效）。
3. **助手新增请求**（只接受固定扩展 ID）：
   - `hello`：返回 `{appVersion, extensionVersion}`（App 内置扩展的版本），并在数据目录写入 `extension-seen.json`（扩展版本、时间）。
   - `local-token`：本地服务连接码存在时返回 `{token}`，否则 `{token:null}`。不得写日志。
4. **扩展端**：
   - 后台启动、设置页打开时发送 `hello`。若 `extensionVersion` 高于正在运行的扩展版本：弹出窗口与设置页显示按钮 `更新扩展`，点击调用 `chrome.runtime.reload()`。
   - 设置页本地模式：助手可用时隐藏连接码输入框，`测试连接` 前先通过 `local-token` 取得并保存连接码；助手不可用时保留现有粘贴框（开发场景）。弹出窗口的初始配置视图同理。
5. **设置窗口（App 内，原生 AppKit）**，菜单 `设置…` 打开，首次启动自动打开。三行，每行：名称 + 状态 + 按钮。
   - `Chrome 扩展`：状态 `未加载` / `已连接 · v0.4.0`（依据 `extension-seen.json`）。按钮 `在访达中显示` 打开 `数据目录/extension/`；按钮 `打开扩展页` 用 Chrome 打开 `chrome://extensions`（`open -a "Google Chrome" chrome://extensions`，Chrome 不存在时按钮禁用并显示 `未安装 Chrome`）。
   - `本地模型`：本阶段只显示 `未安装` / `已安装`，按钮留给阶段 C。
   - `本机 Codex`：调用助手同一套检测逻辑，显示 `已检测到 · 独立版 0.156.1` / `未检测到`。
   - 不写任何操作说明段落。

### 测试

- `npm test`、`npm run test:codex`、`npm run test:browser` 全部通过；新增：`hello` / `local-token` 只对固定 origin 响应；版本较新时出现 `更新扩展` 按钮；助手可用时本地模式无连接码输入框且能自动取得连接码（模拟助手）。
- 登记逻辑：App 位置变化后重新登记，`allowed_origins` 只含固定 ID（用临时 HOME 测试，不写入真实 Chrome 目录）。
- 浏览器测试中的扩展 ID 与 `key` 推导结果一致。

### 验收

1. 从任意位置启动阶段 A 的 App 后，在 Chrome 加载 `数据目录/extension/`，扩展 ID 等于固定 ID。
2. 设置窗口 `Chrome 扩展` 一行变为 `已连接`。
3. 本地服务运行时，扩展设置页选本地模型后直接 `测试连接` 成功，无需粘贴。
4. 本机 Codex 连接与打印照旧可用（真实出图留给用户验证）。

---

## 阶段 C：可选的本地模型下载

### 改动

1. 设置窗口 `本地模型` 一行按钮：`下载（约 16 GB）`；进行中显示进度条、已下载 / 总量、`暂停` / `继续`；完成后显示 `已安装` 与按钮 `删除`。磁盘剩余空间不足 20 GB 时按钮禁用，状态 `磁盘空间不足`。
2. 安装流程（新增 `Resources/installer/local_model.py` 由 uv 的 Python 运行，或 Swift 直接调用子进程，二选一并说明理由），全部写入数据目录：
   1. 下载 `uv` 0.13.9 `uv-aarch64-apple-darwin.tar.gz`，与代码中写死的 sha256 比对（开发时从官方 `.sha256` 取值并写入代码），不符即停止。
   2. `uv python install 3.12.14`，`uv venv --python 3.12.14 数据目录/python`，`uv pip install --python 数据目录/python/bin/python -r requirements-macos-arm64.txt`。
   3. 用该环境中的 `huggingface_hub` 下载 `black-forest-labs/FLUX.2-klein-4B`，固定 `revision=e7b7dc27f91deacad38e78976d1f2b499d76a294`，目标 `数据目录/models/FLUX.2-klein-4B`，包含 `LICENSE.md`。支持断点续传；进度以 JSON 行（已下载字节、总字节）报告给 App。
   4. 写入 `数据目录/runtime.json` 的 `python`、`model`。
3. 已有可用的 `runtime.json`（Python 与模型路径都存在）时，直接显示 `已安装`，不下载。开发机的 `.local/runtime.json` 不受影响。
4. `删除`：确认后删除 `数据目录/python` 与 `数据目录/models`，从 `runtime.json` 去掉对应项；模型运行中时先停止。
5. 下载与安装失败时显示简短原因（如 `网络中断 · 可继续`、`校验失败`），保留已下载部分以便继续。
6. 安装完成后菜单栏恢复 启动 / 停止 / 重启 / 复制连接码。

### 测试

- 用本地 HTTP 替身服务提供假的 uv 包与假模型文件，覆盖：sha256 不符停止、断点续传、暂停继续、空间不足、删除。不在测试中下载真实 16 GB 文件或安装真实依赖。
- 现有 Python 契约测试与控制器测试通过。

### 验收

1. 替身测试全部通过。
2. 留给用户：在干净的 macOS 用户账户中点 `下载`，完成后菜单 `启动模型`，扩展本地模式打印成功。

---

## 阶段 D：打包与发布

### 改动

1. `npm run release`：依次构建 App（阶段 A 脚本）、生成 `dist/PrintChamber-<版本>-arm64.dmg`（`hdiutil`，含 `/Applications` 快捷方式，UDZO 或 ULFO 压缩）、输出 `dist/SHA256SUMS`。Node 运行时下载缓存在被忽略的目录，构建时重新校验。
2. 版本号升到 `0.4.0`（`extension/manifest.json` 为唯一来源）。
3. `release/RELEASE_NOTES.md` 模板（发布页内容，不进入 App 界面），包含：
   - 系统要求：Apple Silicon、macOS 13+、Google Chrome。
   - 安装：打开 dmg → 拖入“应用程序” → 首次打开被拦截时到“系统设置 → 隐私与安全性”点“仍要打开”（写明这是未签名应用的正常现象）。
   - 加载扩展：设置窗口点 `打开扩展页`，开启“开发者模式”，“加载已解压的扩展程序”选择 `在访达中显示` 打开的目录。
   - 本地模型可选、Apache-2.0 许可与来源链接。
   - 从开发版升级的说明：扩展 ID 改变，旧记录与云端密钥不会迁移。
4. README 的“使用”一节改为以下载安装包为主，源码构建移到 DEVELOPMENT.md。
5. 不自动发布：脚本最后打印 `gh release create v0.4.0 dist/*.dmg dist/SHA256SUMS --notes-file release/RELEASE_NOTES.md --draft`，由用户执行。

### 测试

- `npm run release` 在开发机完成，dmg 小于 80 MB（报告实际大小）。
- 模拟下载：对复制出的 App 执行 `xattr -w com.apple.quarantine "0081;$(printf %x $(date +%s));Safari;" <App>` 后启动，记录 Gatekeeper 的实际提示；按“仍要打开”后 App 与内置 Node 均可运行。
- `hdiutil verify` 通过；挂载后 App 可复制运行。

### 验收（留给用户）

在一个新建的 macOS 标准用户账户（无 Xcode 命令行工具、无 Python、无 Node）中：

1. 安装 dmg，完成“仍要打开”，设置窗口出现。
2. 加载扩展后 `Chrome 扩展` 显示 `已连接`。
3. 云端 API 试生成成功（使用自己的 Key）。
4. 若该账户登录了 Codex：设置页出现“本机 Codex”并能打印。
5. 可选：下载本地模型并打印。

## 不改动

G3 提示词、`baselines/`、打印机模板与设计源、云端供应商逻辑、Codex 出图协议与隔离规则（除路径与启动方式外）。不读取 `~/.codex` 登录文件与任何令牌。
