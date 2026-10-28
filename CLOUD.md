# 云端生成 · 0.3.0

本次接入 MiniMax、BFL FLUX、火山方舟、阿里云百炼、Google Gemini，采用使用者自备 API Key。无需本地模型即可走云端生成路径。本地 FLUX 仍为默认方式。

后续补充：BFL 下可选 FLUX.2 Klein 4B、Klein 9B、Pro、Max。使用官方异步提交、查询任务、下载结果流程；只提交一次生成，不自动重新提交。模型请求最多等待 120 秒，随后轮询最多 120 秒，结果下载最多 30 秒。仅向验证过的 BFL API 域名传递 x-key，不向图片下载域名传密钥。真实账号、费用和效果尚未验证。

MiniMax 已按用户授权加入，模型为 image-01，永久显示“人物参考生成，效果未验证”。大陆和海外分别选择、分别保存密钥，端点为 https://api.minimax.cn/v1/image_generation 与 https://api.minimax.io/v1/image_generation 。携带 character 主体参考图、原样默认提示词，prompt_optimizer=false，n=1，返回 Base64；检查 HTTP 200 内的业务错误码，避免把失败当成功。不自动跨地区回退。官方文档证明能接收参考人物图，尚不能证明整张原画的构图、姿势、服饰、背景会被保留；即使一次生成成功，效果未验证提示仍保留。

MiniMax 测试连接仅做不带密钥的 GET 可达性探测，不生成图片、不验证密钥。试生成和作品页生成才调用付费接口，沿用现有上传与计费确认。大陆端点依据当前中文官方文档；Base64 参考图和响应格式同时核对了官方示例：https://raw.githubusercontent.com/MiniMax-AI/skills/main/skills/gif-sticker-maker/scripts/minimax_image.py 。

增加云端供应商只增加接口代码，不会下载模型权重；主要额外成本是维护、权限管理和回归测试。

参考：https://docs.bfl.ai/flux_2/flux2_image_editing 、https://docs.bfl.ai/quick_start/generating_images 、https://platform.minimax.io/docs/api-reference/image-generation-i2i

## 使用入口

1. 在扩展管理页重新加载本项目扩展，并刷新已经打开的作品页。新增供应商网络权限可能需要浏览器确认。
2. 打开插件面板底部“生成设置 · 本地 / 云端”，也可从扩展的“选项”进入。
3. 选择云端、供应商，填写密钥并选择模型。百炼还需工作空间 ID 和密钥所属地区。
4. 确认上传及计费说明。保存或测试会启用选定的云端配置；随后悬停、重试均可能产生费用。
5. “测试连接”不提交图片、不调用生图接口。Google 查询所选模型；火山与百炼只做无密钥 GET 可达性探测。HTTP 401/403/404/405 只说明收到了远端响应，不能证明密钥、路径或模型可用。
6. “试生成一张”选择一张本机原画，确认费用后发起单次真实编辑；结果显示于设置页，可下载，不写入托盘。成功只代表当前配置完成了一次生成，图片效果需要人判断。
7. 在作品页按原有悬停或 Alt 触发方式打印；结果沿用原打印舱、记录、下载和批量操作。

切回本地无需删除密钥。各供应商配置分别保存；模型、地区、工作空间或密钥变化会清除该配置的历史验证标记。删除当前供应商密钥会切回本地。

## 实现边界

- `extension/cloud.js`：固定供应商、模型和域名，构建图片编辑请求并解析响应；没有开放任意 API URL。
- `extension/cloud-config.js`：扩展源的 IndexedDB 保存密钥。设置消息只允许来自本扩展 settings.html；内容脚本不能读取密钥。不是系统钥匙串加密，不防拥有本机浏览器配置访问权的人。
- `extension/background.js`：在原有单任务生成路径中按模式分流；云端完成后写入相同历史结构，添加供应商和模型标记。
- `extension/cloud-prompt.js`：2026-10-26 经用户授权，与本地默认一起替换为 G3 原文；自动测试与 `benchmark_local.py` 比对。未调用付费接口，云端效果仍未验证，供应商原有输入限制不因此改变。
- `settings.html/css/js`：独立设置页；popup.js 只增加设置链接和云端状态。原打印舱模板、样式及设计源文件不变。
- 模型名单来自下列官方文档，是明确适配的固定列表，不是账号已授权模型列表。模型撤下或地区不支持时需更新适配，不会自动换模型。
- 百炼采用工作空间域名接口，北京和新加坡密钥分别配置。API Key 属于另一种端点/地区时需在供应商控制台确认。
- 图片只上传到选定供应商；百炼结果下载限定 HTTPS aliyuncs.com 子域且不携带密钥、不跟随重定向。BFL 下载限定 delivery.*.bfl.ai 或官方旧版 bfldeliveryprod.blob.core.windows.net；其余供应商请求 Base64 结果。
- 云端输入最长边 1536，作品页原有画布采样仍是 768；展示与托盘结果最长边 1280、JPEG。这是预览插件，下载亦为预览图，不是供应商原始高清文件。
- 生成请求超时 120 秒，下载超时 30 秒。无自动重试或跨供应商回退，避免意外重复计费。超时不等于供应商取消任务。
- 火山请求单图、保留供应商水印；百炼明确关闭 prompt_extend；其他供应商内部处理行为由其服务决定。
- Google 使用 Interactions API，store=false，单图响应格式，选择与原图最接近的受支持宽高比；页面中的“曾生成成功”不代表实时在线、额度充足或效果验收通过。

## 官方接口依据（2026-10-16 核对）

- 火山图片编辑与返回格式：https://console.volcengine.com/ark/region%3Acn-beijing/docs/image-generation-api
- 火山模型 ID：https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh
- 百炼编辑请求、工作空间端点、Base64 输入及模型：https://help.aliyun.com/en/model-studio/qwen-image-edit-api
- Gemini 图片编辑、Interactions 输入输出：https://ai.google.dev/gemini-api/docs/image-generation
- Gemini 模型查询：https://ai.google.dev/api/models

这些文档证明接口契约，不代表本项目已完成真实供应商联调。

## 验证状态

2026-10-16 本轮结果：

加入 MiniMax 后：40 项 Node 检查通过。隔离浏览器模拟流程覆盖 MiniMax 大陆/海外及原有四家供应商，检查独立密钥、试生成、效果提示保留及原有云端打印流程；真实 MiniMax API、效果、费用、网络和耗时未验证，未产生付费调用。

补回 FLUX 后：34 项 Node 检查通过；四家供应商的模拟浏览器流程通过，包括 FLUX Pending → Ready 轮询与结果下载、非信任轮询地址拦截、失败/超时终止及下载不携带密钥。未调用真实 API。

- 31 项 Node 自动检查通过（19 项原后台回归、12 项云端请求/提示词/错误处理检查）。
- 真实扩展的隔离无界面浏览器云端流程通过，三家供应商 HTTP 均模拟；验证了配置保存、隐藏密钥、模型变更重置验证、错误显示、试生成、悬停到托盘、网页脚本无权读取配置、删除密钥切回本地。
- 原有完整无界面浏览器回归通过：模拟网站卡片、失效浮窗恢复、打印流程、悬停切换、删除、批量选择/ZIP、透明图片和固定托盘更新。
- 默认提示词、本地基准脚本、打印舱模板和样式、popup/gallery HTML 与本轮前校验一致，0.1.1 归档完整。
- 没有使用真实密钥、发起付费生图、操作用户前台浏览器或创建 Git 提交。现有未提交改动保留。

自动测试使用虚构密钥和模拟 HTTP 响应，不调用付费 API。`npm test` 验证请求构造、提示词一致性、非生图连接测试、错误处理和原有后台行为；`npm run test:cloud` 在隔离无界面 Chromium 中加载真实扩展，验证 IndexedDB、设置表单、三种响应解析、试生成、作品页打印到历史及内容脚本访问限制。`npm run test:browser` 运行原有打印舱交互回归。

未验证：三家供应商的真实密钥、权限、额度、地区网络、真实图片效果、耗时与费用；真实 ArtStation 作品页仍未通过实站验收。不能把模拟测试标为供应商已可用。当前没有要求用户进行付费验证，也没有改动既有归档基线。
