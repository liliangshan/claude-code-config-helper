# Anthropic → Chat / Responses 转换后缓存失效分析与优化方案（2026-08-31）

## 背景

Claude Code CLI 只会说 Anthropic Messages 协议，并在请求体里用
`cache_control: { type: 'ephemeral' }` 显式声明缓存断点。本扩展的 relay 支持三种
上游形态（`src/relay/router.ts` 按 provider 的 `apiType` 分流）：

| apiType | 代理入口 | 转换 |
| --- | --- | --- |
| `anthropic` | `src/relay/anthropicProxy.ts` | 原样透传，不转换 |
| `openai-compatible` | `src/relay/openaiChatProxy.ts` | `converters/anthropicToOpenAIChat.ts` → Chat Completions |
| `v1-response` | `src/relay/openaiResponsesProxy.ts` | `converters/anthropicToOpenAIResponses.ts` → Responses |

用户观察到的现象是：**走 `anthropic` 直连时缓存正常，转成 Chat / Responses 后
有些上游不再命中缓存**。下面按「确凿原因 → 存疑原因 → 方案」展开。

---

## 一、确凿原因

### 1.1 `cache_control` 在转换时被整体丢弃（根因）

- 位置：`src/relay/converters/anthropicToOpenAIChat.ts` `convertSystemToText()` :166-189
- 位置：`src/relay/converters/anthropicToOpenAIResponses.ts` 同名函数 :126-150

两个转换器对 system 数组里的 `cache_control` 只做了一件事——**记一条 warning 然后丢掉**：

```ts
if (block.cache_control !== undefined) {
    warnings.push({
        path: `system[${index}].cache_control`,
        code: 'unsupported_cache_control',
        message: 'OpenAI Chat 不支持 Anthropic cache_control，已忽略。'
    });
}
```

更严重的是**消息级断点连 warning 都没有**：全文件搜索 `cache_control` 只在
`convertSystemToText` 中出现一次，`convertAnthropicMessage()`
（Chat :200 / Responses :160）完全不检查 content block 上的 `cache_control`，
直接静默丢弃。Claude Code 的主要缓存断点恰恰打在**最后几条 messages 上**
（用于滚动缓存对话历史），因此丢失的正是收益最大的那部分。

这个判断本身没错——OpenAI Chat/Responses 协议里确实没有 `cache_control` 字段。
问题在于「丢掉断点」之后**没有任何替代机制**，导致缓存能否命中完全交给上游自行判断。

### 1.2 未下发 OpenAI 侧的缓存控制字段

OpenAI 系协议的缓存是**隐式**的（automatic prompt caching）：不需要断点，但有前提条件，
而我们一个都没满足：

| 字段 | 作用 | 当前状态 |
| --- | --- | --- |
| `prompt_cache_key` | 显式指定缓存分区键，让同一会话稳定路由到同一缓存副本 | **未下发**（全文件搜索无此字段） |
| `user` | 老版本用于缓存路由的次选键 | 仅当 Anthropic `metadata.user_id` 存在时才透传（`anthropicToOpenAIChat.ts` `readMetadataUserId()` :471） |
| `store` / `previous_response_id`（Responses） | 服务端保存上下文、增量续接 | **未下发** |

没有 `prompt_cache_key` 时，上游只能靠请求前缀哈希 + 内部负载均衡决定是否命中。
对自建/中转网关（本扩展的主要使用场景）而言，这类隐式缓存往往根本没实现，
或需要显式字段才启用——这正是「有些会缓存、有些不会」的直接来源。

### 1.3 命中结果读不回来，用户无从判断

- 位置：`src/relay/converters/openAIChatToAnthropic.ts` :473-476
- 位置：`src/relay/converters/openAIResponsesToAnthropic.ts` `convertUsage()` :995

反向转换只映射了两个字段：

```ts
usage: {
    input_tokens: readNumber(source.usage.prompt_tokens),
    output_tokens: readNumber(source.usage.completion_tokens)
}
```

OpenAI Chat 的 `usage.prompt_tokens_details.cached_tokens` 与 Responses 的
`usage.input_tokens_details.cached_tokens` **都没有读取**，因此即便上游真的命中了
缓存，也不会转成 Anthropic 的 `cache_read_input_tokens`。而
`src/relay/usageReporter.ts` :183-185 正是从 `cache_creation_input_tokens` /
`cache_read_input_tokens` 统计的，于是 Chat UI 底部永远显示缓存读取为 0。

> 这意味着「不缓存」的现象里，有一部分可能是**实际命中了但没显示**。修复 1.3
> 是验证 1.1/1.2 是否真正生效的前提，应当**最先做**。

### 1.4 `stream_options.include_usage` 只加在 Chat 路径

`anthropicToOpenAIChat.ts` :143-148 在 `stream === true` 时补了
`stream_options: { include_usage: true }`；`anthropicToOpenAIResponses.ts`
没有等价处理（Responses 协议流式默认在 `response.completed` 事件里带 usage，
通常无需额外字段，但需实测确认中转网关是否照做）。若上游不回 usage，
缓存统计同样是空的。

---

## 二、存疑 / 次要原因（需实测确认）

### 2.1 注入内容位于 system 尾部，可能改变前缀字节

`src/relay/taskRequestInjection.ts` `appendSystemRule()` :484 把内置身份提示词与
共享提示词**追加到 system 末尾**。这一设计对 Anthropic 是安全的（断点在更后面），
但对依赖「整段 prompt 前缀哈希」的中转网关而言，只要注入内容有一处变化，
整个缓存键就变了。

已知的易变输入有两处：

- `replaceBuiltinModelNamePlaceholder()` :412 会把 `{{MODEL_NAME}}` 替换为实际模型名
  ——同一会话内模型不变，稳定；
- `buildSharedSystemPrompt()` :427 读取用户配置的全局/工作区提示词
  ——用户编辑即变，属预期行为。

结论：注入本身**大概率不是**主因，但需要在验证 1.1 之后回归确认。

### 2.2 已有的前缀稳定化处理只覆盖 Anthropic 形态

`stripLegacyCurrentDateText()` :342 做了两件关键的稳定化：

- 删除旧版每秒变化的 `# currentDate\n当前时间：...` 段；
- 把 `x-anthropic-billing-header` 里每轮变化的 `cch=...` 归一化为固定占位符
  （`VOLATILE_BILLING_CCH_PATTERN` :70）。

这两处修复当初正是为了解决 Anthropic 缓存被击穿。它由
`stripLegacyInjectedPromptArtifacts()` :255 调用，而后者在
`injectLlsTaskRequestBody()` :169 中位于**侧轨请求提前 return 之后**——
也就是说侧轨请求（会话标题生成等）不做稳定化。侧轨请求本就短、不缓存，
影响有限，但值得在文档中记录这一差异。

### 2.3 `applyCacheTtlToRequest` 对 OpenAI 路径是空操作

`applyCacheTtlToRequest()` :285 改写的是 `cache_control.ttl`，而这些断点在
1.1 中会被转换器整体丢弃。因此设置页里的「缓存时长 1h/5m」选项
（`ConfigManager.getChatCacheTtl()` :208）**对 Chat / Responses 上游完全无效**，
只对 `anthropic` 直连生效。当前 UI 没有任何提示，属于预期落差。

---

## 三、优化方案

### 3.1 模型编辑弹窗新增缓存设置（用户诉求）

不同上游对缓存的支持差异极大（官方 OpenAI 支持隐式缓存；多数中转网关不支持；
少数网关支持 Anthropic 风格断点透传）。**按模型粒度让用户显式指定**是合理的，
因为同一 provider 下不同模型的缓存能力也可能不同。

#### (1) `src/types.ts` `ModelConfig` :42 新增字段

在 `preserveReasoningContent` :77 之后追加：

```ts
/**
 * 缓存策略。
 *
 * - `auto`（缺省）：按 apiType 走默认行为——anthropic 透传断点，
 *   OpenAI 系下发 prompt_cache_key。
 * - `off`：不做任何缓存处理，转换时连 prompt_cache_key 都不下发。
 * - `anthropic-passthrough`：把 Anthropic cache_control 断点原样透传给上游
 *   （供支持 Anthropic 风格断点的中转网关使用）。
 */
cacheMode?: 'auto' | 'off' | 'anthropic-passthrough';
```

#### (2) `src/configManager.ts` `normalizeModel()` :562 补齐缺省

在返回对象中追加一行，保持旧数据兼容：

```ts
cacheMode: model.cacheMode ?? 'auto',
```

同时确认 `mergeFetchedModels`（:581 起）的「保留本地配置」逻辑会带上该字段——
它是整体拷贝本地模型对象，无需额外改动，但需补测。

#### (3) `media/configView.js` `renderModelModal()` :1137 新增下拉

在 `model-preserve-reasoning` 复选框（:1162）之后插入一个 `field full`：

```html
<div class="field full"><label>${t('cacheMode')}</label><select id="model-cache-mode">
    ${[
        ['auto', t('cacheModeAuto')],
        ['off', t('cacheModeOff')],
        ['anthropic-passthrough', t('cacheModePassthrough')]
    ].map(([value, label]) => `<option value="${value}" ${(model.cacheMode || 'auto') === value ? 'selected' : ''}>${text(label)}</option>`).join('')}
</select></div>
```

用下拉而非复选框：缓存是三态语义（自动/关闭/透传），布尔表达不了。

#### (4) `media/configView.js` `saveModelFromModal()` :1336 读取新字段

在 `model.preserveReasoningContent = ...`（:1356）后追加：

```js
model.cacheMode = document.getElementById('model-cache-mode').value || 'auto';
```

#### (5) i18n 键

`package.nls.json` / `package.nls.zh-cn.json` 补 4 个键：
`cacheMode`、`cacheModeAuto`、`cacheModeOff`、`cacheModePassthrough`。
`cacheModeAuto` 的文案需说明「由上游协议决定」，避免用户误以为一定会缓存。

### 3.2 反向读取 cached_tokens（最高优先级，先做）

#### (1) `src/relay/converters/openAIChatToAnthropic.ts` :473

非流式分支的 usage 映射改为额外读取
`source.usage.prompt_tokens_details.cached_tokens`，映射到
`cache_read_input_tokens`。注意 OpenAI 的 `prompt_tokens` 是**含**缓存部分的总数，
而 Anthropic 的 `input_tokens` 是**不含**缓存的增量，因此需要
`input_tokens = prompt_tokens - cached_tokens`，否则 UI 会重复计数。

流式分支 `readUsageFromChunk()` :251 做同样处理。

#### (2) `src/relay/converters/openAIResponsesToAnthropic.ts` `convertUsage()` :995

同理读取 `usage.input_tokens_details.cached_tokens`；流式的
`readResponseMeta()` :499 一并处理。

#### (3) 验证

改完后在 Chat UI 底部即可看到 `cache_read` 数值。**这是判断后续改动是否生效的唯一手段**，
因此必须最先落地。

### 3.3 下发 `prompt_cache_key`

#### (1) 缓存键的取值

需要一个「同一会话稳定、跨会话不同」的值。候选：

- Anthropic `metadata.user_id`（已被 `readMetadataUserId()` :471 读取）——
  Claude Code 会带，但同一用户的所有会话相同，粒度太粗；
- relay 侧的会话标识——需确认 `anthropicProxy` 是否已有等价概念；
- **推荐**：对「system 文本 + 首条 user 消息」取一次 SHA-256 前 16 位。
  这个前缀在一个会话内恒定、跨会话必然不同，且无需引入新的状态管理。

#### (2) `src/relay/converters/anthropicToOpenAIChat.ts` `convertAnthropicToOpenAIChat()` :120

在 `body.user` 赋值（:151）附近追加 `body.prompt_cache_key = <上述键>`，
仅当模型 `cacheMode !== 'off'` 时下发。转换函数当前签名只接受 `anthropicBody`，
需要扩参传入模型配置——建议加一个可选的第二参数
`options?: { cacheMode?: ModelCacheMode }`，避免破坏既有调用点。

#### (3) `anthropicToOpenAIResponses.ts` 同步处理

Responses 协议同样支持 `prompt_cache_key`。

### 3.4 `anthropic-passthrough` 模式

当模型配置为该模式时，`convertSystemToText()` 与 `convertAnthropicMessage()`
**保留** `cache_control` 字段原样写入输出 body（而不是丢弃 + warning）。
面向的是「Anthropic 风格中转网关」——它们接受 OpenAI 形态的请求体但认得断点。

风险：严格校验的上游会因未知字段返回 400。因此该模式**必须默认关闭**，
由用户显式开启，并在 i18n 文案中写明「仅在上游支持时开启，否则可能报错」。

### 3.5 UI 提示 TTL 设置的适用范围

设置页的缓存时长选项对 Chat / Responses 上游无效（见 2.3）。
在该选项的说明文案里补一句「仅对 Anthropic 协议的提供商生效」，避免误解。

---

## 四、落地顺序

| 顺序 | 项 | 理由 |
| --- | --- | --- |
| 1 | 3.2 读取 cached_tokens | 没有可观测性，后面所有改动都无法验证 |
| 2 | 3.1 模型弹窗 cacheMode 字段 | 后续 3.3 / 3.4 都依赖这个开关 |
| 3 | 3.3 下发 prompt_cache_key | 覆盖官方 OpenAI 与实现了隐式缓存的网关 |
| 4 | 3.4 anthropic-passthrough | 覆盖 Anthropic 风格网关，默认关闭 |
| 5 | 3.5 TTL 文案 | 纯文案 |

## 五、验收标准

- 新增 `src/relay/converters/__tests__/cachedTokens.test.ts`：
  - Chat 非流式 / 流式 usage 含 `prompt_tokens_details.cached_tokens` 时，
    转出的 Anthropic usage 有正确的 `cache_read_input_tokens`，
    且 `input_tokens` 已扣除缓存部分；
  - Responses 的 `input_tokens_details.cached_tokens` 同理；
  - 上游不返回该字段时不产生 `NaN`、不写入 0 以外的值。
- 新增 `src/relay/converters/__tests__/cacheMode.test.ts`：
  - `cacheMode: 'off'` 时输出 body 不含 `prompt_cache_key`；
  - `cacheMode: 'auto'` 时含 `prompt_cache_key`，且同一 system+首条 user
    两次转换得到相同的键、不同输入得到不同的键；
  - `cacheMode: 'anthropic-passthrough'` 时 system 与 message block 上的
    `cache_control` 被保留。
- `src/__tests__/configManagerModels.test.ts` 补一条：`normalizeModel` 为旧数据
  补上 `cacheMode: 'auto'`，且 `mergeFetchedModels` 重新拉取后该字段不丢。
- `npm test` 全绿，`get_errors` 无诊断。

---

## 六、待实测确认的前提

本文档基于源码静态分析，以下三点需要抓包或看 relay 调试快照
（`src/relay/debugRecorder.ts`）确认后再动手：

1. 用户实际使用的中转网关，是否支持 `prompt_cache_key`？不支持的话 3.3 无效，
   重心应转向 3.4。
2. 该网关的 usage 响应里是否带 `cached_tokens`？不带的话 3.2 也看不到数字，
   需要改从响应头或其它字段读取。
3. 「有些会缓存」的那部分上游，具体是哪一类 apiType？若也是
   `openai-compatible`，说明网关自己实现了隐式缓存，问题就集中在前缀稳定性（2.1）
   而非断点丢失（1.1），方案重心需要调整。
