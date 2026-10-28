# Print Chamber

将 2D 原画转换为 3D 风格的悬停图片预览。当前扩展版本为 **0.3.0**，支持本地 FLUX.2 Klein 4B，以及使用者自行配置的云端图片接口。

预览以打印机浮层呈现，可钉入出纸托盘、查看打印记录、放大、复制、下载及批量管理。输出是图片，不能旋转或编辑为 3D 模型。

## 使用

1. 下载或克隆项目，在 Chromium 浏览器的扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，加载本项目的 `extension/` 目录。
2. 打开插件的“生成设置”，配置本地模型连接码或自己的云端 API。
3. 打开支持的作品页面，按当前设置停留约 0.6 秒或按住 Alt 悬停，触发预览。

本地生成需要 Apple Silicon Mac、单独准备的模型权重与 Python 环境。菜单栏小助手需从源码构建；当前没有一键安装包。环境配置、构建与运行步骤见 [DEVELOPMENT.md](DEVELOPMENT.md)。

云端配置、上传与计费说明见 [CLOUD.md](CLOUD.md)。云端悬停、重试及试生成可能产生费用。

## 当前验证范围

- 默认提示词为用户确认采用的 G3，保存在 `benchmark_local.py` 与 `extension/cloud-prompt.js`；秋色森林配色漂移仍是已知限制。
- 模拟网站、合成图片下的悬停、打印、托盘、记录与批量操作已有回归测试。图库窄屏布局已覆盖 320–1440 px，打印机保持原比例。
- 真实 ArtStation 作品页、其他真实网站及云端接口效果尚未完成验收。已实现接口适配不代表真实调用或效果验证通过。
- 本地推理实验的单图耗时约 2–3 秒，不等于实际悬停端到端耗时。

## 开发与测试

Node.js 22+，使用锁定的 Playwright 开发依赖：

```sh
npm ci
npx playwright install chromium
npm test
npm run test:browser
```

Python 测试和菜单栏小助手验证命令见 [DEVELOPMENT.md](DEVELOPMENT.md)。浏览器回归使用隔离资料、模拟响应与 `tests/fixtures/` 合成素材，不需要付费生成。

## 文件范围

| 目录或文件 | 用途 |
| --- | --- |
| `extension/` | 浏览器扩展及本地字体 |
| `service.py`、`benchmark_local.py` | 本地服务与推理基准 |
| `runtime_config.py`、`configure-local.py`、`start-local.command` | 本机路径配置与启动入口 |
| `menu-helper/` | macOS 菜单栏助手源码 |
| `design-reference/`、`build-design.cjs` | 已采用设计来源与编译工具 |
| `tests/`、根目录测试脚本 | 自动回归与验证工具 |
| `baselines/`、`BASELINE.txt` | 不可覆盖的历史归档与采用决定 |
| `work/` | 开发交接、检查记录与独立实验脚本 |

仓库不包含模型权重、本机 Python/Node 依赖、`.local/` 连接码和配置、日志、生成的 App、`output/` 图片与对照页，以及已排除的其他聊天实验。部分历史记录引用这些仅在原机器保留的文件；克隆仓库后不会自动拥有对应素材和实验产物。

项目协作与基线边界见 [AGENTS.md](AGENTS.md)。保留的历史归档不等同于当前版本已发布或全部能力已验收。
