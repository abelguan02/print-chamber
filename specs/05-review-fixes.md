# 05 全项目审核修复

分支：`codex/review-fixes`（基于最新 `main`），一个 PR，不合并。

## 背景

2026-11-23 对 `main`（`a5378f5`）做了全项目代码审核，找到 9 个问题。第 1–5 项会影响测试用户，必须在打包发布前修；第 6–9 项是小问题，一并修掉。

**本任务不真实出图、不下载真实模型或依赖。** 所有测试使用临时 HOME、临时数据目录和本地替身，不在用户真实 HOME 下打开发布版 App。

## 必须修正

### 1. 最低系统要求改为 macOS 14

`requirements-macos-arm64.txt` 固定的 `torch==2.14.1` 只发布了 `macosx_14_0_arm64` 安装包。安装器使用 `--only-binary :all:`，所以在 macOS 13 上下载本地模型必然失败在“安装依赖”。

- `menu-helper/build.py`：`LSMinimumSystemVersion` 改为 `14.0`，发布版编译目标改为 `arm64-apple-macos14`。
- `README.md`、`release/RELEASE_NOTES.md`、`DEVELOPMENT.md`、`menu-helper/使用说明.txt` 中的 “macOS 13” 全部改为 “macOS 14”。
- 测试：`test_bundle.py` 断言 `LSMinimumSystemVersion == '14.0'`；新增一条测试，确认上述文档中不再出现 `macOS 13`。

### 2. 继续下载时按剩余量检查磁盘空间

`ModelInstaller.install()` 与 `Helper.updateModelControls()` 每次都要求 20 GB 可用空间，已下载的部分会占用这部分空间，导致下载到一半后「继续」永久不可用。

- 新增一个计算“所需空间”的函数，`install()` 与 `updateModelControls()` 共用：
  - 没有 `progress.json`（模型下载尚未开始）时：20 GB。
  - 有 `progress.json` 时：`max(0, total − downloaded) + 2 GB`。
- 状态文案不变（`磁盘空间不足`）。
- 测试（替身）：空间 26 GB 开始安装，下载 10 GB 后暂停、空间降到 16 GB，「继续」可用且能完成；剩余量 + 2 GB 大于可用空间时仍显示 `磁盘空间不足`。

### 3. 只拦截磁盘映像，不拦外接硬盘

`requiresAppMove` 把 `/Volumes/` 下所有路径都当作 dmg，装在外接硬盘上的 App 永远打不开。

- 改为：App 所在卷为只读（`URLResourceValues.volumeIsReadOnly == true`），或路径含 `AppTranslocation` 时才拦截。提示和按钮文案不变。
- 保留 `--self-test` 下的 `PRINT_CHAMBER_TEST_BUNDLE_PATH` 测试入口，但判断改为读取该路径所在卷的真实属性。
- 测试：用 `hdiutil` 在临时目录创建小的只读映像（UDZO）与可写映像（UDRW），分别挂载，把测试路径指向其中：只读映像被拦截；可写映像不被拦截；`AppTranslocation` 路径被拦截；普通路径不被拦截。测试结束卸载映像。

### 4. 发布版只打包已提交的文件

`build.py --release` 用 `copytree` 复制工作区里的 `extension/`、`native/`、`installer/`，会把未提交的改动和未跟踪文件（例如 `extension/sponsor/`）打进安装包。

- 发布模式下，`build.py` 先检查要打包的路径（`extension native installer menu-helper service.py runtime_config.py benchmark_local.py demo.html requirements-macos-arm64.txt`）在 `git status --porcelain` 中是否有改动或未跟踪文件。有则停止，列出这些文件，退出码非 0。
- 复制时只复制 `git ls-files` 列出的文件，不复制被忽略的文件。
- 开发模式构建不受影响。
- 测试：在临时 git 仓库副本里分别制造“已跟踪文件有改动”和“新增未跟踪文件”，发布构建均被拒绝；干净时通过，且产物里没有被忽略的文件。

### 5. 助手出错时仍可使用手动粘贴的连接码

`local-settings.js` 的 `check()` 用 `await localToken() || candidate()`，助手返回错误（例如连接码文件读不了）时 `localToken()` 直接抛错，手动粘贴的码永远不会被使用；`popup.js` 的「测试本地连接」同理。

- `Pairing.bindManualEntry` 返回的 `localToken()`：助手出错时显示粘贴框并返回 `null`，不抛错。
- 设置页与弹出窗口：取不到自动连接码时用粘贴框里的码；粘贴框也为空时，才显示助手返回的错误。
- 测试（浏览器，模拟助手返回 `{error}`）：粘贴框可见；粘贴正确的码后「测试连接」显示 `已就绪`；不粘贴时显示助手错误。

## 一并修正

### 6. 本地服务只接受 Print Chamber 的扩展来源

`service.py` 的 `allowed()` 接受任何 32 位扩展 ID 的来源。扩展 ID 已固定为 `nbdbaigecomblojcdodphghghfbhicpe`（`native/identity.cjs`）。

- `allowed()` 只接受本机 `127.0.0.1:8877` / `localhost:8877` 页面来源、无来源请求，以及 `chrome-extension://nbdbaigecomblojcdodphghghfbhicpe`。
- 测试：Python 契约测试覆盖其他扩展 ID 被拒绝（403，且不返回 CORS 头）；另加一条测试确认 `service.py` 中的 ID 与 `native/identity.cjs` 一致。

### 7. 降低后台报到频率

`background.js` 在每次 MV3 后台唤醒时都发 `hello`，每次都会启动一次 Node。

- 后台唤醒时：距上次成功报到不到 1 小时则跳过（时间记在 `chrome.storage.session`）。`runtime.onStartup`、`runtime.onInstalled` 以及设置页、弹出窗口的 `pairing-status` 请求照常报到，不受该限制。
- 测试：连续两次唤醒只发一次 `hello`；打开设置页时仍会发送。

### 8. 「已连接」不长期保留

App 设置窗口只要 `extension-seen.json` 存在就显示「已连接」，删掉扩展后仍然显示。

- 读取 `extension-seen.json` 里的 `time`：7 天内显示 `已连接 · v<版本>`，超过 7 天显示 `未加载`。时间无效时显示 `配对记录无效`（现有文案）。
- 测试：`--self-test` 报告中，替身记录为 1 小时前、8 天前、时间无效三种情况时的状态。

### 9. 去掉弹出窗口与菜单里的说明小字

规则同 `specs/01-settings-no-helper-text.md`：只留控件名、状态和出错原因，不写操作指引。

`extension/popup.js` 中按下表替换：

| 现在 | 改为 |
|---|---|
| `云端模式 · 此配置曾生成成功，当前连通性未检查` | `云端 · 已验证` |
| `云端模式 · 尚未真实生成验证，请打开生成设置` | `云端 · 未验证` |
| `连接码不匹配，请在生成设置中更新` | `连接码不匹配` |
| `模型加载失败，请在菜单栏小助手中查看运行日志` | `模型加载失败` |
| `模型正在准备，稍后重新打开插件查看` | `模型准备中` |
| `请点击菜单栏打印机图标 → 启动模型，等待“模型已就绪”` | `模型未启动` |
| `无法打开生成设置，请重新打开插件` | `无法打开生成设置` |
| `当前页尚未启用，请刷新作品页后再试` | `当前页未启用` |
| `面板加载失败，请重新打开插件` / `面板更新失败，请重新打开插件` | `面板加载失败` / `面板更新失败` |
| `打印过的作品会出现在这里` | `暂无打印记录` |

- 删除弹出窗口中隐藏的 `#help-text`。`extension/popup.html` 由 `build-design.cjs` 生成：改生成脚本，再重新生成，不要手改 `popup.html`。删除后同步移除 `popup.js` 中对它的引用（如有）。
- 删除开发版菜单项 `仅手动启动 · 不随登录加载模型`（`menu-helper/main.swift`）。
- 测试：更新涉及这些文案的现有浏览器测试；新增断言：弹出窗口中不存在 `#help-text`。

## 不改动

G3 提示词（`benchmark_local.py`、`extension/cloud-prompt.js`）、`baselines/`、打印机设计模板与设计源、云端供应商逻辑、Codex 出图协议与隔离规则。不读取 `~/.codex` 登录文件与任何令牌。

## 测试

```sh
npm test
npm run test:codex
npm run test:browser
node --test tests/pairing-browser.cjs tests/cloud-browser.cjs tests/local-settings-browser.cjs tests/about-browser.cjs
python3 -B menu-helper/test_controller.py
python3 -B menu-helper/build.py --release && python3 -B menu-helper/test_bundle.py -v
python3 -B tests/installer/test_local_model.py -v
<模型环境的 Python> -B tests/installer/test_hub_http.py -v
PYTHONPATH=. <模型环境的 Python> -B -m unittest discover -s tests -p 'test_*.py'
npm run release && python3 -B release/test_dmg.py -v
```

`npm run release` 需要干净的工作区（第 4 项），请在提交后、干净的 worktree 中运行。

## 验收标准

1. 上述测试全部通过（贴出结果）；每项修正都有对应的新测试。
2. `grep -rn "macOS 13" README.md release DEVELOPMENT.md menu-helper` 无结果。
3. 在有未提交改动的工作区运行 `npm run release` 被拒绝，并列出文件（贴出输出）。
4. 对照第 1–9 项逐条说明改动与测试；未验证的写明。
5. 留给用户的实机验收：macOS 14 测试账户中安装 dmg、加载扩展后显示「已连接」；下载到一半暂停后可继续。
