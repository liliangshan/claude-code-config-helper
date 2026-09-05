# 模型显式缓存与低命中率解决方案设计

- 日期：2026-09-05
- 状态：已实施并完成自动验证；尚未执行扩展内手工 UI 验收与打包安装。
- 基于版本：3.2.50。
- 参考报告：`/Users/lls/test3/gpt-6-astra-prompt-cache.md`。
- 下文路径均相对于 `claude-code-config-helper/`；行号为设计时定位，实施以方法名为准。

## 1. 目标与边界

1. 提供商列表 → 查看模型 → 添加/编辑模型弹窗，新增布尔参数“显式缓存”，默认关闭。
2. 按提供商下的模型保存，不是会话开关，也不是前一项子智能体的 workspaceState 配置。相同 modelId 在不同提供商下独立。
3. 重新拉取模型不得覆盖用户的显式缓存选择（true 和 false 都保留）。
4. Assistant 消息结尾用量摘要的缓存命中率低于 80% 时，追加带下划线的“解决方案”；点击展示本地说明弹窗，不自动修改模型、不打开外部网页。
5. 开启后，以当前请求的 CLI session_id 作为 prompt_cache_key；Chat 发送显式参数和消息断点，Responses 使用 instructions 前缀，不发送断点。
6. 七种界面语言同步补齐标签、帮助文本、链接、弹窗、关闭按钮及无模型名时的降级提示。

### 上游能力限制

参考报告已验证指定网关的 `/v1/chat/completions` 和 `/v1/responses`，并非所有上游通用保证。第一版支持 `openai-compatible` 和 `v1-response`，分别生成对应字段；Anthropic 暂不支持，在弹窗禁用参数并保留保存值。

Responses：稳定 key 时 5/6～4/6 命中，无 key 对照组 0/6。静态内容放 instructions，options 可选但建议发送；content 上的 cache_control 报 400。报告第六节三字段缺一不可的说法仅适用于 Chat，不能覆盖第五节 Responses 的差异。

报告同时记载无显式字段时有零星命中（累计约 16%）和对照组 0/6，因此措辞应为“该测试上游需要开启显式缓存才能稳定生效”，不能宣称任何场景隐式命中绝对为零。首轮预热、TTL 到期、前缀变化、短前缀都可能低命中；开启不保证达到 80%。

## 2. 当前代码与改动位置

| 文件 / 当前方法 | 现状 | 计划改动 |
| --- | --- | --- |
| `src/types.ts:60` → `ModelConfig` | 已有 `cacheMode?: ModelCacheMode`，模式为 auto/passthrough/off | 增加 `explicitCache?: boolean`，注释默认 false、网关扩展及模型级保存 |
| `src/configManager.ts:625` → `normalizeModel()` | 显式枚举输出字段，未知参数会丢失 | 增加 `explicitCache: model.explicitCache === true`，旧数据和非法值关闭 |
| `src/configManager.ts:656` → `mergeFetchedModel()` | 已以 previous 为基底，主要更新默认显示名 | 保持现有合并方向，确保新增字段经过 normalizeModel 后保留 |
| `src/configManager.ts:383` → `replaceProviderModels()` | 拉取后逐项合并 | 不改变删除缺失模型等原行为；验证同 provider+modelId 的缓存选择不被 fetched 默认值覆盖 |
| `media/configView.js:1172` → `renderModelModal()` | 已有提示缓存模式下拉 | 在该区域追加显式缓存复选框和协议/优先级说明，添加和编辑共用 |
| `media/configView.js:1350` → `openModelModal()` | 载入模型到弹窗状态 | 确保编辑加载保存值，取消不落库 |
| `media/configView.js:1382` → `saveModelFromModal()` | 从 DOM 构造模型参数 | 写入 checked 布尔值，沿现有保存链发送 |
| `media/configView.js:1488` → `createDefaultModel()` | 创建默认模型 | 新增 explicitCache: false |
| `src/views/configView.ts:176` → `handleMessage()` 的 saveProviders 分支 | 通过 replaceProviders 保存模型列表 | 复用协议和保存链，不新增独立消息；验证往返不丢字段 |
| `src/relay/modelCacheMode.ts` | resolveModelCacheMode()/resolveReasoningMode() 查模型配置 | 新增 `resolveModelExplicitCache(provider, modelId)`，仅明确 true 时开启 |
| `src/relay/openaiChatProxy.ts:103` → `OpenAIChatProxyAdapter.handle()` | 注入后转换、序列化、记录并发送上游 | 读取真实路由模型的开关及请求 sessionId，传入转换器，保证最终记录/发送体一致 |
| `src/relay/converters/anthropicToOpenAIChat.ts:137` → `convertAnthropicToOpenAIChat()` | 不生成 prompt_cache_key/options；auto 会丢弃 Anthropic 缓存断点 | 扩展 options、请求类型，转换后调用显式缓存处理函数 |
| `media/chat/main.js:2981` → `appendUsageFooter()` | 以 textContent 拼接统计；已有命中率 | 保留统计文本，以安全 DOM 追加解决方案按钮 |
| `media/chat/main.js:3007` → `computeCacheHitRate()` | cacheRead/(input+cacheWrite+cacheRead)，显示一位小数 | 保留显示口径，新增原始比例阈值判断，避免四舍五入影响 80% 边界 |
| `src/relay/openaiResponsesProxy.ts:103` → `OpenAIResponsesProxyAdapter.handle()` | 调用 Responses 转换器 | 传入显式开关及严格提取的 sessionId |
| `src/relay/converters/anthropicToOpenAIResponses.ts:105` → `convertAnthropicToOpenAIResponses()` | auto 使用 instructions，passthrough 使用 system input item | 显式开启强制 instructions 分支，追加 key/options，不加断点；扩展本文件 AnthropicConversionOptions 和 OpenAIResponsesRequestBody |
| `src/relay/converters/openAIResponsesToAnthropic.ts` → `convertUsage()` 及流式终止事件处理 | 已读取 cached_tokens，尚未映射 cache_write_tokens | 补充写缓存字段及去重计数；详见 4.4 |
| `media/chat/style.css` | 用量摘要类 assistantUsageFooter_07S1Yg | 新增链接外观按钮、键盘焦点和弹窗样式 |

## 3. 配置持久化及模式优先级

- 使用独立布尔字段，不把 `cacheMode` 改成第四种模式，满足“是否显式缓存”的开关交互。
- 显式缓存关闭：严格保持原 auto/passthrough/off 行为，不新增任何网关缓存参数。
- 显式缓存开启且协议支持：显式策略优先于原 cacheMode；弹窗禁用原缓存模式下拉并说明“显式缓存开启时优先使用显式策略”，但保留原模式值，关闭显式缓存后恢复。
- 转换时按 auto 丢弃原生 Anthropic 缓存标记：Chat 生成消息级 explicit 断点；Responses 使用 instructions，完全不生成 cache_control。
- 配置导入/导出保留 explicitCache，删除模型再添加视为新配置。
- 拉取时旧模型 true 不被 fetched false 覆盖，旧模型 false 也不被 fetched true 覆盖；新模型无本地配置时默认关闭。
## 4. 显式缓存请求实现

### 4.1 新增方法及调用顺序

新增 `src/relay/explicitPromptCache.ts`，所有函数附参数和边界注释：

- `extractExplicitCacheSessionId(anthropicBody)`：先取 metadata.session_id，再解析 metadata.user_id 中 JSON 的 session_id，只接受非空字符串。不能使用整个 user_id/device_id/account_uuid，也不能每轮随机生成键。
- `applyChatExplicitPromptCache(body, sessionId)`：为 Chat 设置 key/options/消息断点；无 sessionId 或 system 时不生成不完整参数，返回原因供 warning 使用。
- `applyResponsesExplicitPromptCache(body, sessionId)`：为 Responses 设置 key 和建议的 options；无 sessionId 或非空 instructions 时不应用并返回原因。绝不向 input/content/tools 添加 cache_control。

现有 `OpenAIChatProxyAdapter.extractSessionId()` 在无 JSON 时会回退完整 user_id，适合原 token budget 兼容但不符合纯 session_id 要求。因此保留原方法不动，显式缓存使用上述严格提取方法，避免顺带改变预算归属。

调用顺序：公共注入和前缀归一化 → 提取 sessionId、读取模型配置 → Chat/Responses 转换（显式开启按 auto 清理缓存标记）→ 对应协议的 apply 方法 → 序列化 → 记录并发送。不能在转换前添加会被转换器丢弃的字段。

在 `AnthropicConversionOptions` 增加 explicitCache 和 cacheSessionId；`OpenAIChatRequestBody` 增加 prompt_cache_key、prompt_cache_options；`OpenAIChatMessage` 增加网关专用消息级 cache_control 类型。关闭状态不改变既有请求结构。

### 4.2 Chat 三个必需字段

- 顶层 `prompt_cache_key = session_id`，同一会话多轮稳定；新会话换 key，恢复同一会话沿用原 key。
- 顶层 `prompt_cache_options = { mode: 'explicit', ttl: '30m' }`。
- 最后一条静态 system 消息上 `cache_control = { prompt_cache_breakpoint: { mode: 'explicit' } }`。

这是缓存分组键，不是把 session_id 文本拼进提示词。不得使用消息 ID、时间戳、每轮输入内容生成 key。缓存键不替代前缀内容匹配，模型或工具变化仍可重新预热。

### 4.3 断点选择

第一版断点落在转换后合并的 system 消息（`convertSystemToMessage()`），不落在当轮 user、tool_result、assistant reasoning 上；保留完整 messages/tools 顺序，不将工具 JSON 重复塞入 system，不删除历史消息。

继续复用 `taskRequestInjection.ts` 的 `stripLegacyInjectedPromptArtifacts()` 清理每轮变化的时间和 billing cch。此步骤不保证用户自定义 system 永远静态，UI 要说明动态前缀会降低命中。

重要限制：只缓存 system 前缀时，大量历史占据输入可能仍低于 80%。参考报告没有证明动态增长历史或 tools 数组的具体覆盖规则。第一版不承诺缓存全部历史，也不凭猜测给最新消息加断点。后续如需滚动历史断点，应对目标上游单独验证后再扩展策略。

`convertAnthropicToOpenAIChat()` 已设置流式 `stream_options.include_usage=true`，保持。`openAIChatToAnthropic.ts` 和 `cachedTokens.test.ts` 已处理 cached_tokens 并扣除新输入，不能重复计数或修改计费数据。

### 4.4 Responses 请求与用量

- 顶层 prompt_cache_key 使用当前 session_id；建议发送 prompt_cache_options = { mode: 'explicit', ttl: '30m' }，但必须说明它不是报告验证的必填项。
- 使用 `convertSystemToInstructions()` 将静态 system 转为 instructions；不走 `convertSystemToInputItem()`，不重复放入 input。
- 不添加 Chat 的消息断点；input/content/tools 不保留 Anthropic cache_control，避免 Unknown parameter 400。保留 input 的原始顺序、工具调用 ID 和结果配对，不改变 reasoning 参数。
- instructions 是静态前缀，不保证缓存所有历史。报告示例 input=1698、cached=1536，仅代表该次测试。
- 非流式读取 usage；流式从 response.completed 的 response.usage 获取，复用现有终止事件逻辑，不添加 Chat 的 stream_options。
- `openAIResponsesToAnthropic.ts` 当前 `convertUsage()` 仅映射 cached_tokens，流式状态也只有缓存读。实施时扩展响应 usage 类型、流式状态和最终 message_delta，接入 input_tokens_details.cache_write_tokens → cache_creation_input_tokens。
- 输入总量计数需明确：参考报告未展示 cache_write_tokens 的完整非零样本，也未定义它是否与 cached_tokens 重叠。先用非零写缓存响应样本确认口径，不能直接新增缓存写导致 footer 分母重复。若读/写均包含在 input_tokens 且互斥，则新输入 = total - cached - write；字段缺失沿用旧行为，非法或不一致数值不可输出负 token。该口径属于实施验收项，不能编造实测结论。
- usage.attribution.request_fields.instructions 可保留用于调试，不参与再次累加，避免字段细分与总量重复。

## 5. 低命中率链接与弹窗

### 5.1 展示规则

在 `appendUsageFooter(container, segment)` 原有摘要后追加 ` · 解决方案`，显示为下划线链接样式的 `button type="button"`，支持 Tab、Enter、Space，不用 href="#" 导致页面跳转。

新增 `shouldShowCacheSolution(usage)`：输入字段为有限非负数，输入总量大于零，按未取整比例判断 `cacheRead / total < 0.8`；无法判断不显示。显示用原 computeCacheHitRate，不改变统计口径。

- 0%、28%、79.9%：显示。
- 80%、100%：不显示。
- 79.96%：即使显示取整成 80%，原始值仍低于阈值，应显示；测试覆盖此边界。
- 输入 1,133,526、缓存写 0、缓存读 441,856：约 28.05%，沿现有显示为 28%，显示链接；输出 1,649 不进分母。
- 不因已经开启显式缓存而隐藏链接，开启后仍可能需要排查预热、TTL 和动态前缀。
- 历史消息使用该消息的 usage.model，不使用当前模型选择；无模型名时显示“本次响应使用的模型”。

### 5.2 弹窗实现

在 `media/chat/main.js` 新增 `showCacheSolutionDialog(modelName)` 和 `ensureCacheSolutionDialog()`；复用当前原生 dialog 模式（参考 showTaskRestoreDialog 和模型选择弹窗），只创建一个可复用实例。

中文内容：

> 缓存命中率低于 80%。请在提供商列表中点击“查看模型”，找到模型“{modelName}”，点击“编辑”，开启“显式缓存”并保存。
>
> GPT-6 Astra：参考测试上游必须开启显式缓存，才能稳定使用该显式缓存机制。此选项要求上游支持相关参数，目前适用于 OpenAI Chat 兼容协议和 Responses 协议，两者的缓存格式由扩展分别处理。
>
> 缓存分组键自动使用当前会话的 session_id，无需手填。首次请求需要预热；30 分钟缓存过期、前缀变化或静态前缀较短都可能导致低命中，开启后不保证命中率达到 80%。

按钮“知道了”，支持 Esc 关闭，关闭恢复触发按钮焦点；设置可访问标题。通过 textContent/文本节点插入模型名，不把模型名写入 innerHTML。这里只指导，不自动更改配置、不自动发起有费用的验证请求。

同名模型存在于多个提供商时，提示检查该响应实际使用的提供商。现有 footer 只有 usage.model 时不得猜测 providerId；第一版无需新增聊天协议或往宿主传消息。

新增翻译键建议：explicitCacheLabel、explicitCacheHelp、explicitCacheUnsupported、explicitCacheOverridesMode（configView）；cacheSolutionLink、cacheSolutionTitle、cacheSolutionSteps、cacheSolutionAstraNotice、cacheSolutionSessionHint、cacheSolutionCaveat、cacheSolutionUnknownModel、cacheSolutionClose（chat）。七语言均补齐，动态弹窗打开时使用当前语言。

## 6. 验证与实施批次

### 测试文件和场景

1. `src/__tests__/configManagerModels.test.ts`：旧数据默认 false；true/false 保存重载；非法值归 false；重新拉取保持本地 true/false；不同提供商同名模型隔离。
2. 新增 `src/relay/__tests__/explicitPromptCache.test.ts`：严格 sessionId 解析；Chat 三字段和消息断点；Responses key/options/instructions 且无 cache_control；同会话同键、新会话换键；无 session 或静态前缀不应用；调用幂等。
3. `src/relay/converters/__tests__/cachePassthrough.test.ts`：关闭不改变原模式，开启不混入 ephemeral；Responses 强制 instructions 且不重复 system、不改变 input/tools；Chat/Responses 均覆盖流式和非流式。
4. `src/relay/converters/__tests__/cachedTokens.test.ts`：Responses JSON 和 response.completed 用量一致；读、写同时非零、写缺失/零/非法、分母不重复；保留 Chat 回归用例。
5. 新增 `src/chatRuntime/__tests__/cacheSolution.test.ts`：提取/执行前端纯判定函数，覆盖 0/28/79.9/79.96/80/100%、缺失/负数/NaN、模型名转义，禁止只用字符串存在断言替代行为测试。
6. Webview 手工验收：添加/编辑/取消/重新拉取、各协议限制、七语言、历史模型名、重复渲染无重复链接、Tab/Enter/Esc/焦点恢复；实际请求体确认全部显式字段。上游连续多轮测试须另获用户授权，不能保证实际命中率。

### 实施顺序

- 批次一：类型和归一化、拉取保留测试。
- 批次二：模型弹窗新增参数、保存和默认值；之后补翻译。
- 批次三：缓存处理纯函数及单元测试，分别接入 Chat 和 Responses adapter/converter；再补 Responses 写缓存用量映射及计数测试。
- 批次四：命中率判定、链接、弹窗；之后补翻译和样式。
- 每次最多修改 2–3 个方法或区块，所有新增方法/类附注释。
- 功能修改后先 MCP 检查 VS Code 诊断，再执行 JS 语法检查、typecheck、compile 和相关单测，最后全量测试。打包安装单独按用户指令执行。

## 7. 实施结果

截至 2026-09-05，任务 1–6 已实现：

- ModelConfig 已持久化 explicitCache，旧数据/非法值/新拉取模型默认关闭，本地 true/false 在重新拉取时保留，配置按提供商隔离并支持导入导出。
- 添加/编辑模型弹窗已接入七语言显式缓存选项；OpenAI Chat/Responses 可开启，Anthropic 禁用但保留已存值；开启后 cacheMode 暂时禁用且不覆盖原值。
- Chat 生成稳定 session_id key、30m options 和 system 消息断点；Responses 使用 instructions、key/options，不生成 cache_control；两条路径均覆盖缺失字段、幂等、流式/非流式和工具配对。
- Responses JSON 与 response.completed 使用统一非负缓存读归一化。由于本地报告、脚本、调试记录及一次获授权实测均没有 cache_write_tokens > 0，无法证明它与 input_tokens/cached_tokens 的包含关系，未映射写缓存；边界记录于工作区 `.LLSOAI/task_error.md`。
- Assistant 用量原始命中率低于 80% 时显示带下划线的本地化解决方案按钮；弹窗使用响应模型名、安全 DOM、原生键盘操作并在关闭后恢复焦点。

### 自动验证

- MCP VS Code 诊断：0 errors、0 warnings；仅有 16 条既有 hint。
- 前端 JS 语法检查：configView.js、chat/cacheSolution.js、chat/main.js 全部通过。
- TypeScript typecheck 与 compile：通过。
- 相关测试：42 项通过、0 失败。
- 全量测试：341 项通过、0 失败、0 跳过。
- git diff --check：相关修改通过。

### 尚未验证

- 未在 Extension Development Host 中逐项点击验收七语言、弹窗布局、Escape/焦点恢复和保存/取消视觉行为。
- 未获得 cache_write_tokens 非零完整 usage 样本，因此没有实现 Responses 写缓存映射。
- 未打包、安装或发布；本任务流明确要求不打包安装。
