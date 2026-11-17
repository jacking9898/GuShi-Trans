# 拾文 · 古诗文 AI 译注

一个无需构建、可直接加载的 Chrome Manifest V3 扩展。像翻译插件一样划选文字，读懂古诗词、文言文、生字与生词。

[下载已发布的 v1.0.6 插件安装包](https://github.com/jacking9898/GuShi-Trans/releases/download/v1.0.6/shiwen-1.0.6.zip) · [隐私说明](PRIVACY.md) · [验证记录](docs/VERIFICATION.md)

## v1.0.6 自动模型列表与侧栏页面归属

- 设置页填好地址与 Key 后，对已授权的接口自动读取模型列表；也可点击「获取 / 刷新模型列表」授权并主动刷新。无需先填写或保存模型，列表支持搜索与选择，也始终保留手动输入。
- OpenAI / DeepSeek / 自定义兼容服务读取对应前缀下的 `/models`；百炼官方域名使用同一主机的 `/api/v1/models`，按页读取原生模型目录。列表只代表服务返回的候选，不保证当前 Key 可调用或每个模型都支持文字译注，可用测试连接核对。
- 模型目录按接口与 Key 隔离，在后台内存中缓存 5 分钟；不自动发送诗文生成请求，不自动替换已填模型。换配置、改 Key / 地址时清除当前选择器，迟到结果不会覆盖新配置；不支持目录、权限错误、空列表等情况均保留手动填写入口。
- 修复侧栏跨页残留：切换到其他标签页、原标签导航、离开 / 关闭原页面时，清空旧选文并收起侧栏，取消尚未完成的侧栏请求。回到原页面不会自动请求，重新划词仍可复用成功缓存。其他窗口及无关后台标签的加载不清空当前阅读。
- 不增加浏览历史权限，不保存模型列表原始响应或页面地址。Chrome 141 以下没有原生 `close()` 时，通过禁用全局侧栏收起，下一次划词前恢复可用状态。

模型接口依据：[OpenAI](https://developers.openai.com/api/reference/resources/models/methods/list)、[DeepSeek](https://api-docs.deepseek.com/api/list-models/)、[百炼](https://help.aliyun.com/en/model-studio/list-models)。侧栏行为依据：[Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)。

## v1.0.5 OpenAI 参数兼容与错误提示

- OpenAI 官方接口使用 `max_completion_tokens`，不再发送旧的 `max_tokens`；DeepSeek、千问和自定义兼容接口维持各自参数。
- `gpt-6-luna`（含日期快照）的深度思考开关可用，默认显式发送 `reasoning_effort=none`，开启后使用 `medium`。其他未确认能力的模型不猜测支持的思考档位。
- HTTP 400 会根据服务返回的已识别参数名，说明是输出上限、思考参数、JSON 格式或模型等问题；没有识别信息时明确提示 HTTP 400。不会直接显示服务端原始错误正文、密钥或选文，也不会为参数错误自动重试。

依据：[OpenAI Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[GPT-6 Luna 模型](https://developers.openai.com/api/docs/models/gpt-6-luna)。

## v1.0.4 设置入口

阅读页、侧栏和划词浮窗右上角显示带文字的「设置」按钮；AI 服务选择框旁也有「配置」快捷入口。右键 Chrome 工具栏里的拾文图标，选择「选项」，也能进入设置。添加 OpenAI 时：选择 OpenAI → 添加配置 → 填写 API Key → 保存设置并授权接口访问。

## v1.0.3 多 Provider 配置

- 支持 DeepSeek、OpenAI、通义千问预设，也可添加兼容接口。最多保存 20 套配置，同一服务商可保存不同模型；每套独立保留 API Key、接口地址、模型、JSON 模式和思考开关。
- 设置页可添加、编辑、移除、设为默认和测试当前已保存的配置。移除配置需保存生效；删除当前密钥立即生效，其他配置不受影响。原有单接口设置自动迁移，保留旧密钥和偏好。
- 阅读页、Chrome 侧栏和网页浮窗均有 AI 选择器。切换会保存为下次查询所用的服务，但不会自动重新查询，也不打断正在生成的译注。点击「重新生成」才使用新服务重新请求；现有译注会标明生成时的服务及模型，收藏 / 导出也保留来源。
- 各套配置的缓存独立，切换服务不清空缓存；不自动回退或把选文转发给其他服务。
- 深度思考默认关闭：DeepSeek 官方接口显式发送 `thinking.type=disabled`，受支持的通义千问混合思考模型显式发送 `enable_thinking=false`。OpenAI 预设 `gpt-4.1-mini` 无推理阶段；其他不支持开关的模型按服务商本身能力运行。

| 预设 | 默认地址 | 默认模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` |
| 通义千问（百炼北京） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-flash` |

地址和模型均可编辑。通义千问可改为百炼控制台提供的工作空间专属地址或其他地域地址；密钥需与地域匹配。预设接口依据：[OpenAI 模型文档](https://developers.openai.com/api/docs/models/gpt-4.1-mini)、[百炼 OpenAI 兼容接口](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)、[千问思考模式](https://platform.qianwenai.com/docs/developer-guides/text-generation/thinking)。

更新已有安装时，用 `dist/shiwen/` 的文件覆盖**原先加载的插件目录**，在 Chrome 扩展管理页点击「重新加载」，然后刷新阅读网页。沿用原目录以保留配置和收藏；不要另装一份扩展替代升级。

## v1.0.2 对照阅读与 DeepSeek Flash 适配

- 宽屏网页划词默认打开 Chrome 原生阅读侧栏，网页获得独立的阅读空间；浏览器侧栏可自行拖动调整宽度，收起后恢复网页空间。位置遵循 Chrome 的侧栏设置，默认在右侧。
- 设置中可关闭「左右对照阅读」改用浮窗。窄窗口首次划词使用浮窗；侧栏已经打开时，即使网页视口因侧栏而缩小，也会继续把新选文送到侧栏。
- 「深度思考」默认关闭。DeepSeek 官方接口会明确发送 `thinking: {type: "disabled"}`；可在设置中主动开启。新配置预填模型为 `deepseek-flash`。
- 默认输出上限为 8192 token；开启受支持的深度思考后为 32768 token、最多等待 180 秒。自定义兼容接口不发送 DeepSeek 专属参数，深度思考开关不可用，按其服务商配置运行。
- 输出达到上限时，仍可解析的译注会展示并标注可能不完整；未形成译注时准确提示输出 / 思考额度耗尽，不再一律要求缩短选文。不自动进行额外的付费重试。
- 原生侧栏 API 不可用时回退到网页浮窗。现代 Chrome 关闭侧栏会取消仍在进行的侧栏查询；也可在内容中主动点击「取消查询」。

## v1.0.1 阅读切换修复

- 一次 AI 查询完整生成翻译、字词解释和赏析；三个标签只切换本地阅读重点，不再重复请求。
- 生成中切换标签会继续等待同一个请求，不会取消并重发。切回已读标签会保留滚动位置和逐句对照的展开状态。
- 相同文字与有效上下文的最近 32 条成功译注在本次浏览器会话中复用；重启浏览器或重载扩展后清除。更换接口、模型、密钥、上下文或 JSON 配置不会误用其他配置的结果。保存设置、删除密钥或清空最近记录会清理临时缓存。
- 需要新结果时，点击译注工具栏的「重新生成译注（会重新请求 AI）」。失败与中断的请求不会缓存。
- 关闭网页浮窗、取消查询或改查其他文字仍会中止当前客户端请求；单纯切换阅读标签不会中止。

## 安装（本地开发者模式）

1. 打开 Chrome，地址栏输入 `chrome://extensions`。
2. 开启右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择**包含 manifest.json 的本项目文件夹**（或发布包解压后的 `shiwen` 文件夹）。
4. 在 Chrome 扩展菜单中固定「拾文」，打开扩展 → 右上角设置。
5. 填写接口地址、模型名称、API Key，点击「保存设置」并允许访问该接口域名。可点击「测试已保存的连接」，会用“学”进行一次真实查询并消耗服务商额度。
6. **刷新安装前已经打开的普通网页**，选中一段中文，点击出现的「白话翻译」「字词解释」或「诗文赏析」。也可通过右键菜单查询。

生产运行无需 npm、Node.js、后端服务器或任何远程脚本。首次使用必须配置有效的 AI API Key；服务商网页会员不等于 API 额度。此版本没有上架 Chrome 应用商店。

## 阅读功能

- **白话翻译**：一字、一句或一段古文都可查询；诗文支持展开逐句对照。
- **字词解释**：关键字词义项、用法、现代普通话拼音、语境辨音，以及有依据时的通假字、古今异义和词类活用。
- **字词溯源**：区分字源、词源和典故；不确定的首见、本义与出处须标注待考。
- **诗文赏析**：意象、情感、修辞或文法补充。
- **继续细读**：点击译注中的字词，继续查询该字词。
- **朗读与复制**：使用浏览器 / 系统中文语音朗读原文，复制完整译注。朗读多音字不保证遵循模型给出的拼音，请结合辨音提示。
- **生词笺**：手动收藏、搜索、移除，导出 JSON；最多 200 条。最近 20 条成功译注自动保存在本机，可清空。
- **独立阅读页**：点击扩展弹窗右上角「在新标签页中阅读」，适合长文；支持 ⌘ / Ctrl + Enter 查询。
- **无需密钥看效果**：点击「展开一则译注示例」。这是明确标注的内置示例，不冒充实时 AI 结果。

## 接口配置

支持流式或普通 JSON 返回的 **Chat Completions 兼容接口**，内置 DeepSeek、OpenAI、通义千问预设，也可使用自己的兼容服务或本地网关。不是所有“AI API”都兼容该协议。

| 项目 | 示例 / 说明 |
| --- | --- |
| 基础地址 | `https://api.deepseek.com`；也可填写 `https://your-provider.example/v1` |
| 完整地址 | `https://your-provider.example/v1/chat/completions`，不会重复拼接路径 |
| 模型 | 服务商实际支持的模型 ID；默认预填 `deepseek-flash`，可修改 |
| 认证 | `Authorization: Bearer <你的 API Key>` |
| 本地服务 | 支持 `http://localhost:端口/v1` 或 `http://127.0.0.1:端口/v1`；仍需填写服务接受的密钥 |
| JSON 模式 | 默认关闭；仅模型支持 `response_format: {type: "json_object"}` 时开启 |

接口地址不可含账号密码、查询参数或片段。除 localhost / 127.0.0.1 外只接受 HTTPS。跨域请求在后台服务工作线程中发出，不依赖目标网页的 CORS 设置。默认请求流式生成，界面在收到并验证 JSON 后显示结果；不会展示模型思考过程。单次查询最多 1600 字；首个响应头等待 25 秒，普通查询最长约 65 秒，开启受支持的深度思考后最长约 180 秒。

默认只发送选中文字。开启「结合附近上下文」后，额外发送同一局部段落附近最多 1200 字，辅助多音字与词义消歧；手动输入的独立查询没有网页上下文。切换服务商域名时请重新填写该服务商的密钥。

## 权限与数据

- `storage`：本机设置、密钥、最近阅读、生词笺。关闭内容脚本对本地存储的访问，仅通过受控后台消息提供公共偏好与查询结果。
- `contextMenus`：选中文字后的右键入口。
- `sidePanel`：在浏览器原生侧栏显示译注，给网页留出独立的阅读空间。此权限不读取额外网页数据。
- HTTP / HTTPS 内容脚本：在普通网页中识别选区并显示闭合 Shadow DOM 浮窗。不会自动查询，不处理输入框、密码框和可编辑区域。
- 可选 AI 接口域名权限：在用户保存设置时才请求具体域名，不申请全站后台网络权限。
- 不请求浏览历史、剪贴板读取、麦克风、Cookie 或所有标签页权限。复制使用用户点击时的剪贴板写入能力。

详见 [PRIVACY.md](PRIVACY.md)。AI 结果不是经联网核验的字典或文献证据，尤其应核对字源、引文、古音与罕见异读。结果提供「搜索原文核对」入口；点击后会在百度搜索中发送相应查询词。

## 使用限制与排查

- Chrome 内置页面、应用商店页面、内置 PDF 阅读器与其他扩展页面不支持注入；可把文字复制到拾文的阅读页查询。
- 划词入口只在包含汉字、非可编辑区的选区出现；键盘选中后松开 Shift 或方向键也可触发。右键菜单可以查询非中文文本。
- 划词工具的主框架与子框架各自处理选区。安装 / 更新后须刷新原网页；旧页面右键查询连接失败时会转到独立阅读页。
- 401 / 403：检查 API Key 和模型权限。404：检查基础地址和模型 ID。429：等待限流恢复或检查额度。格式错误：重试、缩短文本或切换 JSON 模式。设置里的测试功能使用已保存配置。
- 原文、接口响应与模型字符串都按文本节点渲染；不会执行返回的 HTML / Markdown。错误信息不回显服务商原始响应或密钥。
- 从扩展列表移除扩展会删除本地设置与收藏，请先导出生词笺。当前只支持导出，不支持导入。

## 开发与验证

```sh
npm install
npm run check
npm test
npm run setup:browser
npm run test:e2e
npm run package
```

`npm test` 使用 Node.js 内置测试运行器测试接口协议、提示词、响应解析和权限消息边界。浏览器测试在单独的临时 Chromium 用户目录运行，使用本地模拟 AI 服务，不连接日常浏览器，也不使用真实密钥。由于无界面浏览器无法点击 Chrome 原生授权弹窗，测试会在临时 manifest 中预授予模拟接口的 localhost 权限，运行时代码保持不变，发布 manifest 仍只使用可选接口权限；原生授权弹窗需要在普通 Chrome 中完成。截图输出在 `test-results/`。运行期扩展没有第三方依赖。

`npm run package` 按 manifest 版本生成 `dist/shiwen/` 和 `dist/shiwen-<版本号>.zip`。解压 zip 后选中其中带 `manifest.json` 的 `shiwen` 文件夹加载。维护者如需从 SVG 重新生成 PNG 图标，可执行 `npm run icons`。

协议与实现参考：[Chrome 跨域请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[Chrome 权限声明](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)、[扩展存储访问控制](https://developer.chrome.com/docs/extensions/reference/api/storage)、[后台生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。
