# 01 生成设置页：去除说明小字

分支：`codex/settings-no-helper-text`

## 目标

生成设置页（`extension/settings.html`）只保留控件名、状态和出错提示。功能靠布局与按钮名表达，不用说明性文字解释。云端计费改为“首次计费操作时确认一次”，去掉勾选框。

设计原则（验收时逐项对照）：

- 页面上不出现解释“这个功能是什么 / 会发生什么”的句子、折叠说明或 `.hint` 文本。
- 允许出现的文字：标题、字段标签、选项名、按钮名、输入框 placeholder、操作后的状态（成功 / 失败 / 进行中）和出错原因。
- 状态文字用短句，格式统一为“状态 · 必要的下一步”，不附带解释。

## 范围

修改：`extension/settings.html`、`extension/settings.js`、`extension/local-settings.js`、`extension/settings.css`、`extension/cloud.js`（仅 `name` / `notice` 文案）、相关测试。

不修改：弹出窗口、关于页、打印机模板（`build-design.cjs` 及其产物）、后台消息协议（`background.js` 的消息类型与字段保持不变）。

## 逐项改动

| 位置 | 现状 | 改为 |
|---|---|---|
| `#mode` 选项 | 云端 API（推荐） / 本地模型（进阶） | 云端 API / 本地模型 · Apple Silicon |
| `#first-use-note` | “尚未保存配置” | 删除 |
| `#local-note` 首段 | “需要另行安装模型…暂无一键安装包。” | 删除 |
| `#local-note` 内 `<details>` 首次连接指南 | 4 步说明 | 删除 |
| `#local-check` 后 `.hint` | “测试连接不生成图片。” | 删除 |
| `#local-status` 文案 | 长句 | 见下方“状态文案” |
| `#cloud-fields` 首段 | “无需安装本地模型，使用你自己的 API Key。” | 删除 |
| `#provider-notice` | MiniMax 长段效果说明 | 删除元素及 `Cloud.providers[*].notice` |
| `Cloud.providers` 名称 | “MiniMax · 中国大陆（效果未验证）” | “MiniMax · 中国大陆” / “MiniMax · 海外” |
| `#ali-fields` 内说明 | “工作空间、地区和 API Key 必须匹配。” | 删除；不匹配时由测试连接 / 生成的错误信息指出 |
| `#provider-region-note` | MiniMax 大陆/海外密钥说明 | 删除 |
| `#cloud-check-help` | 测试连接说明 | 删除 |
| `#verification` | “尚未进行真实生成验证” 常显 | 仅在验证过时显示“上次生成成功 · 时间”；未验证或配置更改后隐藏 |
| `#consent` 勾选框 | 长段计费同意 | 删除，改为“首次计费确认”（见下） |
| `<details>` 密钥与使用说明 | 两段说明 + 删除按钮 | 删除说明与折叠；保留“删除此供应商密钥”按钮，仅在该供应商已保存密钥时显示，作为次要按钮放在 API Key 字段旁 |
| `#trial-section` 说明段 | “试生成会上传原画…” | 删除 |
| `#trial` 按钮 | “试生成一张（可能计费）” | “试生成” |
| 试生成每次 `confirm()` | 每次弹窗 | 删除，由首次计费确认取代 |
| 页脚 | “关于 Print Chamber”链接 | 保留 |

被删除的说明内容不丢弃：把“密钥仅保存在本浏览器、不同步、卸载即清除”“MiniMax 效果未验证”“百炼工作空间/地区/Key 须匹配”“本地模式需另行安装”四条写进 `README.md` 对应章节（若已存在则核对一致）。

## 首次计费确认

- 新增 `chrome.storage.local` 键 `cloudChargeAcknowledged`（布尔）。
- 触发点：设置页内任何会进入云端模式或产生云端调用的操作——`保存并使用`（mode=cloud）、云端`测试连接`、`试生成`。
- 若未确认：用 `confirm()` 弹出一次：“云端生成会上传原画到所选供应商，并按次计费。继续？”。用户确认后写入键值并继续；取消则不保存、不发请求，`#notice` 显示“已取消”。
- 已确认后这些操作不再弹窗。
- 删除所有供应商密钥（`cloud-forget` 后无任何 `hasKey`）时清除该键，下次重新确认。
- 作品页上的打印 / 重打流程不变（已要求真实用户点击且云端模式必须先在此页保存，故确认已覆盖）。

## 状态文案

`#notice`、`#local-status` 只用短句，例：

- 本地：`未配置`、`检查中…`、`已就绪`、`连接码不匹配`、`服务未启动 · 在小助手中启动`、`模型加载中`、`模型忙碌`、`模型加载失败 · 查看小助手日志`、`连接超时`、`服务异常 · HTTP 500`、`不是兼容的本地服务`。
- 云端：`已保存`、`已启用云端生成`、`正在生成…`、`生成完成 · 12.3 秒`、`已取消`、`密钥已删除`，错误沿用后台返回的错误信息。
- 删除“请自行确认肤色、表情…”“等待超时也可能已计费”等附加解释。

## 样式

- 删除 `.hint`、`.consent`、`details/summary` 相关 CSS。
- 删除文字后检查间距：字段组之间保持一致的垂直节奏，不出现删除元素留下的空白。
- 不新增颜色或字体；沿用现有 `settings.css` 变量与风格。

## 测试

更新并保证通过：

- `tests/cloud-browser.cjs`：去掉 `#consent`、`#provider-region-note`、`#cloud-check-help`、`#provider-notice` 断言；新增：首次 `保存并使用` 弹出一次确认、确认后再次操作不弹、取消则不保存；删除全部密钥后再次弹出。
- `tests/local-settings-browser.cjs`：去掉 `#first-use-note`、`#consent` 断言；保留本地连接码保存 / 测试流程。
- `tests/about-browser.cjs` 中访问设置页的部分保持通过。
- 新增断言：设置页渲染后（本地、云端两种模式各一次），`document.querySelectorAll('.hint, details, .consent').length === 0`。

运行：

```sh
npm test
npm run test:browser
```

## 验收标准

1. 两种模式下页面上的全部可见文字只属于上方“允许出现的文字”类别（附本地、云端模式截图各一张，存到被忽略的 `output/`）。
2. 首次计费确认行为与上文一致，并有浏览器测试覆盖。
3. 后台消息协议、作品页打印流程、关于页与弹出窗口无改动（`git diff --stat` 证明）。
4. `npm test`、`npm run test:browser` 全部通过。
5. 被移除的四条说明已写入 `README.md`。
