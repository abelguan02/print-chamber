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

在装有命令行开发工具的 Mac 上构建开发版菜单栏小助手：

```sh
python3 menu-helper/build.py
open "Print Chamber 小助手.app"
```

开发版引用项目位置；移动仓库后重新构建。
小助手版本号在构建时读取 `extension/manifest.json`，与扩展保持一致。
统一图标的源文件是 `extension/icons/icon.svg`（16/32 px 使用简化版 `icon-small.svg`）。修改后运行 `npm run build:icons`，
重新生成扩展 PNG 与 `menu-helper/AppIcon.icns`，再运行 `menu-helper/build.py` 打包进小助手。
关于窗口的自愿赞助收款码为可选文件：放入 `menu-helper/sponsor/wechat.png`、`alipay.png`（也接受 `.jpg`），
下次打开关于窗口即显示，无需重新构建；缺失时显示“收款码暂未添加”。

## 自包含的菜单栏 App

在 Apple Silicon Mac 上复用同一构建脚本，生成可搬移的 App。首次构建需要联网下载固定的官方 Node.js v22.23.3，后续构建复用已校验的缓存。

```sh
python3 -B menu-helper/build.py --release
python3 -B menu-helper/test_bundle.py -v
```

产物为 `dist/Print Chamber.app`，支持 Apple Silicon、macOS 13 及以上。发布版与开发版使用不同的应用标识，分别从包内资源和开发仓库加载。构建时按官方清单和固定 SHA-256 校验 Node，再仅对外层 App 做 ad-hoc 签名。包内 Node 保留官方签名；使用者可直接启动菜单，无需安装命令行开发工具、Python 或系统 Node。

发布版在 `~/Library/Application Support/Print Chamber/` 保存数据，每次启动将包内扩展同步到其中的 `extension/`。默认 Python 为数据目录的 `python/bin/python`，模型为 `models/FLUX.2-klein-4B`。两种模式都支持 `PRINT_CHAMBER_STATE`；Python 和模型路径依次从环境变量、当前数据目录的 `runtime.json`、模式默认值选取。缺少本地运行环境时，菜单显示「本地模型未安装」，「设置…」显示 Chrome 扩展、本地模型及本机 Codex 状态。首次启动会打开设置，随后可从菜单再次打开。

构建后的测试把 App 复制到仓库外，以临时数据目录运行 `--self-test`，复用真实菜单与控制器入口，不显示窗口。实机检查可将 App 拖到其他目录再打开，点击菜单栏打印机图标，检查状态行、「设置…」与「打开使用说明」。

启动发布版会登记固定 ID 的 Chrome 本机助手，并在搬移后更新路径。扩展在后台启动及打开设置时报告所加载的版本；「更新扩展」会重新加载已同步的副本。选择本地模型后点「测试连接」即可自动配对。开发模式可用 `node native/install.cjs` 登记同一主机名；登记以最近一次为准。

构建后运行 `node --test tests/pairing-browser.cjs` 检查从搬移、登记到 Chrome 配对的完整路径，使用独立的临时 HOME、无窗口 Chromium 和模拟的本地健康检查。原生配对协议测试包含在 `npm test`。

## 可选的本地模型

发布版「设置」中的「下载（约 16 GB）」会安装本地模型。开始或继续前要求至少 20 GB 可用空间。准备环境时显示当前步骤，下载权重时显示已下载字节和总量。关闭设置窗口后安装在后台继续，重新打开即可看到当前进度。点「暂停」或退出 App 才会暂停，下次在设置中点「继续」。安装完成后在菜单中点「启动模型」。删除需要确认，App 会先停止自己管理的服务；正在打印或无法确认已停止时保留文件。

Swift 负责引导全新账户安装：下载并验证官方 arm64 uv 0.13.9，用它安装 Python 3.12.14 和项目锁定的依赖，然后用新环境运行包内的 `installer/local_model.py`。该脚本使用 Hugging Face Hub 的匿名客户端，固定修订版 `e7b7dc27f91deacad38e78976d1f2b499d76a294`，下载 Diffusers 推理组件和 `LICENSE.md`。权重按清单中的 SHA-256 核验，普通 Git 文件按清单中的 Git 对象 ID 核验。校验失败时删除损坏文件，点「继续」会重新下载该文件。uv 缓存、解释器、阶段记录与未完成分片都位于 App 数据目录。安装提交后更新 `runtime.json`，保留其他设置。外部已配置的 Python 和模型可直接使用，删除操作只清理 App 数据目录内的安装文件及配置中的路径。

安装器替身回归使用 `python3 -B tests/installer/test_local_model.py -v`。Hub HTTP 测试和下方 Python 契约测试都要用模型环境的 Python 运行。Hub HTTP 测试用该环境固定版本的 huggingface_hub 访问本地替身，验证续传和校验。发布版实机验收请使用干净的 macOS 标准账户。

## 开发依赖与测试

Node.js 22+；`package-lock.json` 固定开发依赖。插件本身不携带 Node/Playwright。

```sh
npm ci
npx playwright install chromium
npm test
.venv/bin/python -B tests/installer/test_hub_http.py -v
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

2026-10-29 首轮升级验证：64 项 Node 检查、18 项 Python 检查及 7 项小助手控制器检查通过；完整无窗口浏览器回归通过，新增云端等待/明确点击、键盘确认、历史复用、重打失败保留及脚本模拟点击拦截均已验证。最后的点击事件检查改动后，相关内容脚本、模拟云端集成与完整打印机交互已复测通过。测试使用合成素材与模拟推理/供应商响应，没有付费调用；真实 ArtStation 页面及真实生成效果仍未验收。G3 文本、打印机模板/样式及 0.1.1 归档校验未改变。

浏览器默认使用锁定 Playwright 对应的 Chromium；需要测试其他版本时显式设置
`PRINT_CHAMBER_CHROMIUM`，不要将本机路径写进代码。

在已登记本机助手且 Codex 已登录的 Mac 上，可单独运行 `node --test tests/codex-session-live.cjs` 排查创建会话。它在独立的无窗口 Chrome 测试资料中加载实际扩展，经过与打印相同的预检和会话配置，输出 `thread/start` 的回包耗时，随后关闭临时会话。检查不会发起新登录或模型轮次。设置页「连接 Codex」查询已有登录与可用额度。

## 实机验收（单独执行）

1. 菜单栏点“停止模型”，确认插件显示离线；点“启动模型”，等待就绪。
2. 复制连接码并在插件配对；刷新已打开的作品页。
3. 打开真实 ArtStation 作品页，测试悬停、移入打印机、重试、托盘和删除。
4. Behance、Pinterest 分别验证一张真实图片，确认 CDN 来源兼容。

本地模型已就绪且 Downloads 中有原验证样图时，可运行 `npm run test:live`。
它在独立扩展资料中使用本机连接码并调用真实模型，不会将码写入测试报告。
`node inspect-artstation.cjs` 只能检查首页，不能代替真实作品页验收。

## 本轮行为约定

- 普通预览先按 `sourceUrl` 复用持久化打印记录；不读取原画、不请求模型、不改写记录时间。模型离线、缺少连接码或另一张图生成中仍可查看历史；暂停及禁用站点仍生效。
- 历史记录跨生成配置复用，显示为“历史打印”，不声称是当前模型或 G3 的新结果。新记录保存供应商、模型（服务返回时）、提示词 SHA-256、种子和尺寸（服务返回时）。旧记录继续可读；同 URL 原图变化须点“重打”，不自动重新收费。
- 新生成的本地结果仍须通过 G3 提示词指纹校验；缺失或不一致时拒绝显示、写入历史，并提示重启本地模型。更新后须重新加载扩展、重启模型及刷新作品页。
- `preview` 消息只查询历史和生成条件；云端缺少 `confirmed: true` 的生成消息在读取原图前返回等待确认。页面沿用现有“重打”按键，待首次云端打印时显示“打印”，只接受浏览器真实用户输入事件；普通悬停、Alt 悬停及网页脚本模拟点击均不会自动提交云端生成。
- “重打”绕过历史，发送 `X-Print-Chamber-Refresh: 1` 强制本地推理并更换随机种子。首次推理仍用 42；返回实际种子，避免与当前内存缓存的上一种子重复。失败保留服务缓存、历史和当前显示结果。
- 服务仍按输入字节保存 24 张内存缓存，普通服务请求可命中最近一次结果，服务重启自然清空；扩展历史不受服务重启影响。
- 删除会阻止此前开始的同图任务重新写入历史；删除后主动打印仍可保存。
- 远程下载仅支持指定网站及 CDN，拒绝重定向和超过 12 MB 的图片流。
  下载响应必须声明 JPEG、PNG 或 WebP，且文件签名与类型一致；本地服务也只启用这三种图片解码器。
  新增网站需要同时审查域名白名单与扩展 host permissions。
- 本地请求体读取总时限为 15 秒；读完并计算哈希后才尝试获取模型锁，慢上传不占用模型。
  缓存读写和推理仍受同一把锁保护；上传超时不释放其他请求持有的锁。
- 服务启动时将状态目录设为 0700，新连接码直接以 0600 权限创建；已有连接码保留并收紧权限。
  小助手复制连接码遵循其进程的 `PRINT_CHAMBER_STATE`，支持绝对路径及 `~`；不设置时开发版使用项目 `.local`，发布版使用上述数据目录。
  自定义目录时，小助手与服务须使用同一环境值，建议绝对路径；Finder 通常不继承终端环境。
- 缺少云端供应商时提示先选择并保存；本地服务返回非 JSON 时提示响应格式异常，不显示原始解析错误。
- 新服务日志不输出连接码；加载/推理失败记录错误类别和异常类型。
  菜单栏控制器错误写入 `.local/helper.log`，发生控制错误时“查看运行日志”打开它。
  旧 `service.log` 可能仍包含过去的连接码，分享历史日志前应脱敏。

## 延后事项

G3 已在原位置替换 D，不继续迭代提示词；不改变模板结构或重做 UI。
高清模式、多模型/云 API、长页面性能优化及控制器总超时恢复，另行按需求验证。
