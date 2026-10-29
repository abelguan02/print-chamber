# Print Chamber 开发与验证

现有 UI、G3 提示词及低清推理参数是需要保护的行为基线。G3 于 2026-10-26 经用户授权替换 D；原文见 `output/scenes-g3-20261025-060950/prompt.txt`。历史归档与
`baseline-1.0-candidate-20261008` 保留不动；本轮修复不是新的正式发布基线。

## 本地环境

当前模型环境：Apple Silicon、Python 3.12.14。
`requirements-macos-arm64.txt` 是实际运行环境的完整版本快照，不含模型权重；
尚未在第二台电脑验证全部安装过程，也不是带文件哈希的供应链锁文件。
不要为使用这些修复升级现有模型环境。

新机器可以创建独立环境：

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-macos-arm64.txt
python3 configure-local.py --python "$PWD/.venv/bin/python" --model "/你的模型目录/FLUX.2-klein-4B"
```

已安装模型环境的电脑，直接把 `--python` 指向现有环境，无需重新下载模型。
路径写入被 Git 忽略的 `.local/runtime.json`。服务、终端入口和菜单栏控制器共用它。
可用 `FLUX_PYTHON`、`FLUX_MODEL_PATH` 覆盖路径，但 Finder 启动的 App 通常不继承终端变量，
因此日常使用优先保存本机配置。样图默认读取 `~/Downloads`，可用 `FLUX_SAMPLES_DIR` 覆盖。

菜单栏仍需 macOS 的命令行开发工具：

```sh
python3 menu-helper/build.py
open "Print Chamber 小助手.app"
```

App 当前引用项目位置。移动项目后重新构建；它尚不是自包含的分发安装包。

## 开发依赖与测试

Node.js 22+；`package-lock.json` 固定开发依赖。插件本身不携带 Node/Playwright。

```sh
npm ci
npx playwright install chromium
npm test
PYTHONPATH=. .venv/bin/python -B -m unittest discover -s tests -p 'test_*.py'
python3 -B menu-helper/test_controller.py
npm run test:browser
```

如果使用项目外的 Python 环境，把 `.venv/bin/python` 替换为配置中的可执行文件。
Python 契约测试使用真实 HTTP handler、临时端口及合成图片，只替换模型推理边界，
不会加载模型或修改日常连接码。执行器需要允许绑定本地回环端口。
`tests/test_menu_helper.py` 还会用 Swift 编译器编译小助手代码（排除 AppKit 启动入口），
验证默认及自定义状态目录的连接码读取；不会打开菜单栏或操作剪贴板。

`npm test` 覆盖扩展缓存、删除并发、刷新请求及网络边界。
`npm run test:browser` 使用独立浏览器资料和 `tests/fixtures/artwork.png` 合成素材；
不依赖个人 Downloads、历史 output 图片或正在运行的模型。
图片只用于 UI 测试，不能代替原画生成质量验证。
截图和测试结果写入被忽略的 `output/`。

浏览器默认使用锁定 Playwright 对应的 Chromium；需要测试其他版本时显式设置
`PRINT_CHAMBER_CHROMIUM`，不要将本机路径写进代码。

## 实机验收（单独执行）

1. 菜单栏点“停止模型”，确认插件显示离线；点“启动模型”，等待就绪。
2. 复制连接码并在插件配对；刷新已打开的作品页。
3. 打开真实 ArtStation 作品页，测试悬停、移入打印机、重试、托盘和删除。
4. Behance、Pinterest 分别验证一张真实图片，确认 CDN 来源兼容。

本地模型已就绪且 Downloads 中有原验证样图时，可运行 `npm run test:live`。
它在独立扩展资料中使用本机连接码并调用真实模型，不会将码写入测试报告。
`node inspect-artstation.cjs` 只能检查首页，不能代替真实作品页验收。

## 本轮行为约定

- 普通请求按实际图片字节命中服务内存缓存；服务重启自然清空缓存。
- 服务返回实际编码提示词的 SHA-256；扩展与当前提示词比对，缺失或不一致时拒绝显示、写入历史，并提示重启本地模型。更新后须重新加载扩展、重启模型及刷新作品页；旧历史保留，不作为生成缓存。
- 扩展不再用 URL 缓存生成结果。重复悬停仍需传输图片，但可免去重复推理。
- “重新打印”发送 `X-Print-Chamber-Refresh: 1`，强制推理。种子仍为 42，
  所以强制推理不表示随机生成新方案。
- 删除会阻止此前开始的同图任务重新写入历史；删除后主动打印仍可保存。
- 远程下载仅支持指定网站及 CDN，拒绝重定向和超过 12 MB 的图片流。
  下载响应必须声明 JPEG、PNG 或 WebP，且文件签名与类型一致；本地服务也只启用这三种图片解码器。
  新增网站需要同时审查域名白名单与扩展 host permissions。
- 本地请求体读取总时限为 15 秒；读完并计算哈希后才尝试获取模型锁，慢上传不占用模型。
  缓存读写和推理仍受同一把锁保护；上传超时不释放其他请求持有的锁。
- 服务启动时将状态目录设为 0700，新连接码直接以 0600 权限创建；已有连接码保留并收紧权限。
  小助手复制连接码遵循其进程的 `PRINT_CHAMBER_STATE`，支持绝对路径及 `~`；不设置时使用项目 `.local`。
  自定义目录时，小助手与服务须使用同一环境值，建议绝对路径；Finder 通常不继承终端环境。
- 缺少云端供应商时提示先选择并保存；本地服务返回非 JSON 时提示响应格式异常，不显示原始解析错误。
- 新服务日志不输出连接码；加载/推理失败记录错误类别和异常类型。
  菜单栏控制器错误写入 `.local/helper.log`，发生控制错误时“查看运行日志”打开它。
  旧 `service.log` 可能仍包含过去的连接码，分享历史日志前应脱敏。

## 延后事项

G3 已在原位置替换 D，不继续迭代提示词；不改变模板结构或重做 UI。
高清模式、多模型/云 API、长页面性能优化及控制器总超时恢复，另行按需求验证。
