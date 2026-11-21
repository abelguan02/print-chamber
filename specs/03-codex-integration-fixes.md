# 03 修正 PR #6：本机 Codex 接入

分支：继续使用 `codex/codex-imagegen-spike`，完成后更新同一个 PR #6。**用合并（`git merge origin/main`）同步主干，不要改写历史或强制推送。**

## 背景

PR #6 已实测跑通：复用本机 ChatGPT 登录，以原画为参考按 G3 出图，并在日常 Chrome 中完成一次真实打印。用户已同意接入扩展，本任务不重新论证可行性，只修正结构与产品问题，使其可以合并。

主干在 PR #6 之后合并了 PR #5（设置页去除说明小字 + 首次云端计费确认），两者在 `extension/settings.html`、`extension/settings.js` 冲突。

**本任务不消耗出图额度。** 所有验证使用模拟助手 / 模拟 app-server；需要真实出图的验收项留给用户执行，开发时不得提交原画。

## 必须修正的问题

### 1. 合并主干，遵守“不用说明小字”

- 合并 `origin/main`，以主干的设置页为准解决冲突，再把 Codex 选项加进去。
- 设置页、弹出窗口、作品页浮层、图库中删除 PR #6 新增的说明句子、`title` 悬停说明与 `<p>` 提示，规则同 `specs/01-settings-no-helper-text.md`：只留控件名、状态、出错原因。
- 作品页等待状态文案：Codex 模式为 `点击「打印」生成`（不再写“发送原画并使用 Codex 额度”）。

### 2. 正式代码不得依赖实验代码

- 新建 `native/codex/`，把助手实际用到的逻辑（app-server 客户端、Codex 定位与签名校验、进程隔离、登录确认、能力预检、建会话与单轮出图）移入这里，作为正式模块。
- `native/` 与 `extension/` 不得 `require` / 引用 `experiments/` 下任何文件。实验脚本可以反过来引用 `native/codex/`，或保持原样独立。
- 验收：`grep -rn "experiments/" native extension` 无结果。

### 3. Codex 定位：独立安装版与桌面版都支持

- 按以下顺序查找，取第一个通过校验的：
  1. 独立安装版：`~/.local/bin/codex`、`/opt/homebrew/bin/codex`、`/usr/local/bin/codex`（解析符号链接后的真实路径）。
  2. ChatGPT / Codex 桌面应用随附的 CLI（保留现有按包标识定位的逻辑）。
- 不搜索任意 `PATH`。每个候选都用现有 `verifyOfficialCodex`（OpenAI 团队 ID `2DC432GLL2`、标识 `codex`）校验签名，不通过则跳过。开发机上 `~/.local/bin/codex` 指向 `~/.codex/packages/standalone/releases/<版本>/bin/codex`，签名符合，可作为测试依据。
- 进程隔离规则要同时适用两种来源；若某来源无法在现有隔离规则下启动，记录原因并跳过该来源，不放宽规则。
- 检测结果记录来源（`standalone` / `desktop`）与 `codex --version`。

### 4. 不写死模型

- 删除 `gpt-6.2-sol` 常量。用 `model/list` 选择：优先 `isDefault` 且支持图片输入的模型，否则取第一个支持图片输入的模型；没有则报错 `当前 Codex 没有支持图片输入的模型`。
- 选中的模型名写入打印记录的 `model` 字段（已有字段）。

### 5. 自动检测与连接只在设置页

- 助手新增 `detect` 请求：只定位与校验 Codex 并返回 `{found, source, version}`，不启动 app-server、不查登录、不建会话。
- 设置页加载时通过后台发送 `detect`：
  - 助手未登记（`connectNative` 报找不到）或 `found:false` → “生成方式”下拉中**不显示** Codex 选项。
  - `found:true` → 显示选项 `本机 Codex`。
- 选中后只显示一个按钮 `连接 Codex` 和一行状态（`已连接`、`未登录 Codex`、`Codex 额度已用完`、`未找到 Codex` 等，沿用助手返回的错误）。
- **删除弹出窗口里的「连接 Codex」按钮**，后台 `codex-connect` 只接受来自 `settings.html` 的消息（与 `cloud-*` 一致）。

### 6. 首次使用确认

- 新增 `chrome.storage.local` 键 `codexUsageAcknowledged`（布尔），行为与 `cloudChargeAcknowledged` 对称。
- 点击 `连接 Codex` 时若未确认，`confirm()`：`Codex 生成会把原画发送给 OpenAI，并消耗你的 Codex 额度。继续？`。取消则不连接、不切换生成方式，状态显示 `已取消`。
- 切换到其他生成方式不清除该键。

### 7. 删除面向用户的测量功能

- 删除 `codex-displayed` 消息、内容脚本里的显示计时、打印记录的 `timings` 字段写入，以及图库 / 弹出窗口中的“Codex 分段耗时”列表和对应 CSS。
- 测量如仍需要，只保留在 `experiments/` 中。

### 8. Node 运行时（本任务只做隔离，不消除）

- 助手暂时继续用 Node 22 运行，但把“用哪个 Node”集中到 `native/install.cjs` 生成的启动脚本一处，其他代码不得假设 Node 路径。后续安装包任务会改为随包运行时。
- 扩展 ID 仍按目录推导，本任务**不**在 manifest 中加 `key`（会导致现有打印记录和设置丢失，留到安装包任务统一处理）。
- README 的“Mac 上连接本机 Codex”一节改为简洁步骤：要求（macOS、Chrome、已登录的 Codex 独立版或桌面版、Node 22）、运行 `node native/install.cjs`、到设置页选择“本机 Codex”并连接。删除耗时、尺寸等实现细节说明。

### 9. 文档与 PR 说明

- 把 `specs/02-codex-imagegen-feasibility.md` 恢复为主干上的原文，并在文末追加一个 `## 结果（2026-11-21）` 小节，用不超过 15 行总结：登录复用、首图结果（尺寸、耗时、指纹匹配）、扩展实机打印、未测项（其余 4 张、单张额度消耗）。过程记录移到 `experiments/codex-imagegen/README.md`。
- `specs/README.md` 中 02 状态改为 `已完成（1/5 张实测）`，03 状态改为 `开发中`。
- 重写 PR #6 描述：一段总述，一个“改了什么”列表，一个“测试”列表，一个“未验证”列表。删除按时间追加的历史段落。

## 不改动

- 后台的云端、本地生成流程，打印机模板（`build-design.cjs` 产物），G3 提示词，`baselines/`。
- 不读取或复制 `~/.codex` 下的登录文件与令牌（隔离规则里按路径授予写权限不算读取）。

## 测试

```sh
npm test
npm run test:codex
npm run test:browser
node --test tests/cloud-browser.cjs tests/local-settings-browser.cjs tests/about-browser.cjs
```

新增或更新：

- `detect`：独立版通过签名、独立版签名不符被跳过、桌面版回退、均未找到。
- 模型选择：默认模型支持图片、默认不支持而另一个支持、都不支持。
- 设置页：助手未登记时无 Codex 选项；检测到时显示；首次连接弹确认、取消不切换、确认后再次连接不弹。
- 弹出窗口中不存在 `#codex-connect`；`codex-connect` 来自弹出窗口时被后台拒绝。
- 设置页 Codex 模式下 `document.querySelectorAll('.hint, details, .consent').length === 0`，且 Codex 区域内没有 `<p>` 说明段。

## 验收标准

1. PR #6 与 `main` 无冲突，上述四组测试全部通过（贴出结果）。
2. `grep -rn "experiments/" native extension`、`grep -rn "gpt-6.2-sol" native extension`、`grep -rn "codex-displayed\|timings" extension` 均无结果。
3. 设置页 Codex 模式截图一张（存到被忽略的 `output/`），只含选项、按钮和状态。
4. PR 描述按第 9 条重写。
5. 留给用户的实机验收（开发时不执行）：
   - 用独立版 Codex（暂时退出 / 不依赖桌面版）在设置页连接成功；
   - 作品页打印一张，浮层显示结果，记录中 `model` 为自动选出的模型名。
