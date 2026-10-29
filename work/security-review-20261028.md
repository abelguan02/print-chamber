# 问题核查（2026-10-28）

后续修复：用户已授权修复下表的 6 项已确认问题。图片格式限制、上传锁与总时限、缺失供应商提示、非 JSON 提示、连接码权限、小助手连接码路径均已修复；其余项保持原状。下方表格保留修复前的核查证据。

验证：55 项 JavaScript 单元测试、16 项 Python/Swift 测试、7 项菜单栏控制器测试、完整 `npm run test:browser`、云端设置及本地设置浏览器测试全部通过。EPS 在调用 Ghostscript 前被拒绝；慢上传期间其他完整请求可生成，超时不误释放其他任务的锁；新 token 从首次写入前就是 0600，已有 token 不变；Swift 路径测试覆盖默认、绝对、相对及 `~` 路径。浏览器云端调用均为模拟，不产生费用。

使用更新：重新加载浏览器扩展并刷新作品页，重启本地模型服务；小助手重新构建后需退出并重新打开才能使用新代码。无需更换连接码。此次不自动重启运行中的服务或打开小助手；真实网站和真实云生成仍未验证。

初次核查代码：`8c0c186`。当时的结论：9 项技术问题中，6 项确认存在，2 项只能确认风险条件，1 项在当前使用路径下不成立。首次设置默认云端的产品观察属实。初次核查仅审查，修复及验证结果见上方更新。

| 项目 | 结论 | 依据与影响 |
| --- | --- | --- |
| 本地图片格式未限制 | **确认，中等** | [service.py:193](/Users/abelguan/Desktop/2Dto3DStyle/service.py:193) 未传 `formats`；[background.js:111](/Users/abelguan/Desktop/2Dto3DStyle/extension/background.js:111) 的下载函数只限大小，不检查 MIME 或实际格式。隔离测试中 BMP 返回 200；EPS 进入 Ghostscript 调用边界（用桩替代，未执行 Ghostscript）；后台也确实转发 `application/postscript` 内容。 |
| 请求体未传完就占模型锁 | **确认，中等** | [service.py:169](/Users/abelguan/Desktop/2Dto3DStyle/service.py:169) 先拿锁，再设置 socket 超时并读取全部内容。隔离 HTTP 测试每 4 秒发一个字节，16 秒后锁仍被占用，第二请求返回 409。15 秒是 socket 等待超时，不是上传总时限。 |
| BFL 结果域名误拒 | **有兼容风险，当前接口失败未证实** | [cloud.js:73](/Users/abelguan/Desktop/2Dto3DStyle/extension/cloud.js:73) 实测接受 `delivery.eu1.bfl.ai`，拒绝 `delivery-eu1.bfl.ai`。当前官方文档明确列出 `delivery.*.bfl.ai`，现有规则已经允许地区变化；“地区会变”本身不能证明此规则错误。未调用真实付费生成接口，也未确认旧官方文档原文。 |
| 缺少供应商时英文报错 | **确认，低** | [cloud-config.js:37](/Users/abelguan/Desktop/2Dto3DStyle/extension/cloud-config.js:37) 将 `undefined` 传给 IDB 的 `get`。真实无头 Chromium 复现 `DataError: Failed to execute 'get' on 'IDBObjectStore': No key or key range specified.`，会在到达 `Cloud.validate` 前抛出并传给界面。正常保存流程同时写入供应商；主要影响缺失或不一致的存储状态。 |
| 本地非 JSON 响应英文报错 | **确认，低** | [background.js:58](/Users/abelguan/Desktop/2Dto3DStyle/extension/background.js:58) 直接调用 `response.json()`，外层错误处理保留原始 message。模拟 HTML 502 响应，得到 `Unexpected token '<'... is not valid JSON`。这是异常响应处理缺口；当前 Python handler 的常规业务响应本身是 JSON。 |
| 连接码创建权限空档 | **确认，低，有环境前提** | [service.py:21](/Users/abelguan/Desktop/2Dto3DStyle/service.py:21) 先默认创建文件再 chmod，且 mkdir 不收紧已存在目录。临时目录、umask 022 测试：token 在 chmod 前为 0644，之后 0600，已有 0755 目录仍为 0755。新建的 0700 目录会阻止其他普通用户访问；实际泄露还取决于父目录权限和本地攻击者。本机当前 `.local` 为 0700、token 为 0600，未读取连接码内容。 |
| 滚动卡顿 | **确认开销模式，未确认实际卡顿** | [content.js:228](/Users/abelguan/Desktop/2Dto3DStyle/extension/content.js:228) 遍历最多 100 个标记，交错读取布局和写入位置；[content.js:273](/Users/abelguan/Desktop/2Dto3DStyle/extension/content.js:273) 每个 scroll 事件直接执行。`passive: true` 不等于节流。`describe` 对普通图片主要读取布局和图片属性，仅背景图分支调用 `getComputedStyle`，并非每个标记都读计算样式。本轮没有性能轨迹，不能称为已复现卡顿。 |
| 同源大图 PNG 超 5 MB 失败 | **当前路径不成立** | [content.js:103](/Users/abelguan/Desktop/2Dto3DStyle/extension/content.js:103) 在转 PNG 前将最长边缩到 768，画布最多 768×768。随机 RGBA 像素的 Chromium 实测 Data URL 为 3,158,966 字符，低于后台的 5,000,000 字符限制。原始图片大不代表传输 PNG 大。后台确实对超长数据使用不准确的格式错误，但不能据此认定正常同源大图会触发。 |
| 小助手连接码路径写死 | **确认，低** | [main.swift:110](/Users/abelguan/Desktop/2Dto3DStyle/menu-helper/main.swift:110) 固定读取项目 `.local/token`；[runtime_config.py:7](/Users/abelguan/Desktop/2Dto3DStyle/runtime_config.py:7) 支持 `PRINT_CHAMBER_STATE`。服务使用其他目录时，小助手可能找不到连接码或复制旧码。同文件的日志读写路径也固定为 `.local`。未启动或操作用户的小助手。 |

图片格式问题需要限定风险表述：Pillow 的 EPS 解码确实可能调用 Ghostscript，官方也建议通过 `formats` 限制输入格式；但这不等于本机已有可利用的远程代码执行漏洞，仍取决于安装的软件版本和攻击路径。普通 `<img>` 中无法被浏览器解码的 EPS 会被当前 `complete/naturalWidth` 条件排除，不能简单说任何伪装 EPS 都会因悬停触发；背景图路径、浏览器加载后下载内容变化等仍使服务端格式限制有必要。[Pillow 格式说明](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html)、[Pillow 安全说明](https://pillow.readthedocs.io/en/stable/handbook/security.html)

慢上传问题的限制条件也属实：服务仅监听回环地址，且先验证连接码，再拿锁；不是互联网上任意人可直接占用模型。正常扩展调用还带 45 秒超时，但不能替代服务端总时限，因为其他持有码的客户端不受该超时约束。

BFL 当前官方文档允许白名单使用 `delivery.*.bfl.ai` 或整个 `*.bfl.ai`。如果修复兼容性，可按这一契约处理，但必须保留 HTTPS、无用户名密码、端口限制以及真正的子域名边界，不能使用宽泛字符串包含判断。现有额外 Azure delivery 白名单应单独保留评估。此次没有证据证明当前账号会收到连字符域名。[BFL 官方接入指南](https://docs.bfl.ai/api_integration/integration_guidelines)

首次设置的观察属实：[settings.js:41](/Users/abelguan/Desktop/2Dto3DStyle/extension/settings.js:41) 仅在无模式、无本地连接码、无云端密钥的首次状态下，将表单选为云端；同意框不勾选，保存前会检查同意，试生成另有费用确认。打开设置本身不保存云端模式、不触发付费调用。可以保持现状。

建议修复顺序：先限制服务端图片解码格式，并在扩展下载边界校验类型及必要的文件签名；再将请求体读取和哈希移到模型锁外，并增加上传总时限，缓存与推理仍保持正确同步。随后处理两个中文错误提示、以 0600 权限直接创建连接码以及状态目录路径一致性。滚动优化先测量，当前同源大图路径无需添加回退。

验证均使用测试连接码、临时状态目录、隔离 HTTP 端口、替代模型和无头浏览器；未调用真实模型、Ghostscript 或付费云接口，未操作前台应用。运行中的日常服务及历史基线保持原状。
