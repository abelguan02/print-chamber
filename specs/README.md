# 开发任务单

每个文件是一项可独立交给 Codex 的任务。交付时把对应文件整份交给 Codex，并要求它：

1. 先读仓库根目录 `AGENTS.md`、`DEVELOPMENT.md`，遵守其中约束。
2. 在新分支上开发（分支名见任务单），不直接提交到 `main`。
3. 完成后逐条对照“验收标准”自查，并在回复中贴出测试命令与结果；未能验证的项写明未验证。

所有任务共同的禁止事项：

- 不修改 `baselines/` 归档、G3 提示词文本（`benchmark_local.py`、`extension/cloud-prompt.js`）。
- 不引入 `design-preview/` 或其他对话的实验代码。
- 不把真实 ArtStation 页面标记为已验证。
- 不读取、复制或记录任何用户凭据（API Key、连接码、`~/.codex/auth.json`）。

| 任务 | 文件 | 状态 |
|---|---|---|
| 01 设置页去除说明小字 | `01-settings-no-helper-text.md` | 待开发 |
| 02 Codex 出图可行性验证 | `02-codex-imagegen-feasibility.md` | 本机首图与扩展实际打印已验收，测量边界见任务单 |
| 03 GitHub 安装包与自动配对 | 待验证 02 后拆分编写 | 未开始 |
