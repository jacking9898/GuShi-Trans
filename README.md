# 拾文 · 古诗文 AI 译注

一个无需构建、可直接加载的 Chrome Manifest V3 扩展。像翻译插件一样划选文字，读懂古诗词、文言文、生字与生词。

[下载 v1.0.0 插件安装包](https://github.com/jacking9898/GuShi-Trans/raw/refs/heads/main/releases/shiwen-1.0.0.zip) · [隐私说明](PRIVACY.md) · [验证记录](docs/VERIFICATION.md)

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

支持流式或普通 JSON 返回的 **Chat Completions 兼容接口**，默认 DeepSeek，也可使用自己的兼容服务或本地网关。不是所有“AI API”都兼容该协议。

| 项目 | 示例 / 说明 |
| --- | --- |
| 基础地址 | `https://api.deepseek.com`；也可填写 `https://your-provider.example/v1` |
| 完整地址 | `https://your-provider.example/v1/chat/completions`，不会重复拼接路径 |
| 模型 | 服务商实际支持的模型 ID；默认预填 `deepseek-chat`，可修改 |
| 认证 | `Authorization: Bearer <你的 API Key>` |
| 本地服务 | 支持 `http://localhost:端口/v1` 或 `http://127.0.0.1:端口/v1`；仍需填写服务接受的密钥 |
| JSON 模式 | 默认关闭；仅模型支持 `response_format: {type: "json_object"}` 时开启 |

接口地址不可含账号密码、查询参数或片段。除 localhost / 127.0.0.1 外只接受 HTTPS。跨域请求在后台服务工作线程中发出，不依赖目标网页的 CORS 设置。默认请求流式生成，界面在收到并验证完整 JSON 后显示结果；不会展示模型思考过程。单次查询最多 1600 字；首个响应头等待 25 秒，完整查询最长约 65 秒。过慢的推理模型可能超时，宜选择响应较快的模型。

默认只发送选中文字。开启「结合附近上下文」后，额外发送同一局部段落附近最多 1200 字，辅助多音字与词义消歧；手动输入的独立查询没有网页上下文。切换服务商域名时请重新填写该服务商的密钥。

## 权限与数据

- `storage`：本机设置、密钥、最近阅读、生词笺。关闭内容脚本对本地存储的访问，仅通过受控后台消息提供公共偏好与查询结果。
- `contextMenus`：选中文字后的右键入口。
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

`npm run package` 生成 `dist/shiwen/` 和 `dist/shiwen-1.0.0.zip`。解压 zip 后选中其中带 `manifest.json` 的 `shiwen` 文件夹加载。维护者如需从 SVG 重新生成 PNG 图标，可执行 `npm run icons`。

协议与实现参考：[Chrome 跨域请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[Chrome 权限声明](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)、[扩展存储访问控制](https://developer.chrome.com/docs/extensions/reference/api/storage)、[后台生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。
