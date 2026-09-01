# 转换路径缓存修复落地方案（2026-09-01）

> 前置分析见 `docs/cache-miss-analysis-2026-08-31.md`。本文只写**怎么改**，
> 具体到文件、方法、行号与函数签名。

## 前提：缺陷完全在本扩展侧

用户的中转网关是**已在大厂生产环境长期运行的标准实现**，协议行为可信：
按 Anthropic 协议请求就按 Anthropic 协议应答，按 OpenAI 协议请求就按 OpenAI
协议应答，缓存字段该有就有。实测表现：

- 走 `anthropic` apiType 直连时，**缓存正常命中**；
- 转成 Chat / Responses 后，**响应里没有任何缓存字段**。

结论是确定的：网关没有拿到缓存断点，因为**我们在转换时把 `cache_control` 丢了**。
一份无断点的请求，网关既不会写缓存也无从返回缓存字段——它的行为完全正确。

因此本文档**不做任何针对网关行为的兼容、猜测或兜底**。字段名、时序、数据形态
一律以协议规范为准；修复范围严格限定在本扩展的转换层与响应层。

优先级相对分析文档**要调整**：

| 分析文档中的编号 | 原优先级 | 现优先级 | 理由 |
| --- | --- | --- | --- |
| 3.4 `anthropic-passthrough` 透传断点 | 4 | **1** | 这是本例的真正修复 |
| 3.2 读回 cached_tokens | 1 | **2** | 按协议规范读，无需猜字段 |
| 3.1 模型弹窗 cacheMode | 2 | 3 | 3.4 的开关载体 |
| 3.3 `prompt_cache_key` | 3 | 4 | 对本例无用，留给官方 OpenAI 上游 |
| 3.5 TTL 文案 | 5 | 5 | 不变 |

落地顺序：**A（透传）→ B（读回）→ C（弹窗开关）→ D（prompt_cache_key）→ E（文案）**。
其中 A 依赖 C 提供的开关字段，所以实际编码次序是 **C 的数据层 → A → B → C 的 UI 层 → D → E**。

---

## A. 数据层：`cacheMode` 字段

### A1 `src/types.ts` — `ModelConfig` 新增字段

`ModelConfig` 定义在 :41-78，末尾字段是 `preserveReasoningContent?: boolean;` :77。
在其后追加：

```ts
    /**
     * Anthropic → OpenAI 转换时的缓存断点处理策略。
     *
     * - `auto`（缺省）：保持现状——丢弃 `cache_control` 并记 warning。
     *   适用于严格校验请求体的官方 OpenAI 上游。
     * - `passthrough`：把 Anthropic 的 `cache_control` 原样写入转换后的请求体，
     *   供「OpenAI 形态入口 + Anthropic 内核」的中转网关继续命中缓存。
     * - `off`：不做任何缓存相关处理，且不下发 `prompt_cache_key`。
     */
    cacheMode?: ModelCacheMode;
```

并在 `ModelConfig` 之前新增类型别名（放在 :40 `/** 提供商下的单个模型配置。 */`
上方）：

```ts
/** 模型级缓存策略。 */
export type ModelCacheMode = 'auto' | 'passthrough' | 'off';
```

> 命名用 `passthrough` 而非分析文档里的 `anthropic-passthrough`：转换器只在
> Anthropic→OpenAI 方向被调用，前缀是冗余的。

### A2 `src/configManager.ts` — `normalizeModel()` :562 补缺省

返回对象末尾 `preserveReasoningContent: !!model.preserveReasoningContent` :576
之后追加（注意上一行要补逗号）：

```ts
            cacheMode: model.cacheMode === 'passthrough' || model.cacheMode === 'off'
                ? model.cacheMode
                : 'auto'
```

用白名单而非 `?? 'auto'`，可同时挡住磁盘上被手工改坏的非法值。

`mergeFetchedModel()` :592 走的是 `{ ...previous, displayName }` 再过
`normalizeModel`，新字段自动保留，无需改动。

### A3 `src/modelFetcher.ts` — `createDefaultModelConfig()` :160 补默认值

`preserveReasoningContent: false` :173 之后追加 `cacheMode: 'auto'`，
使新拉取的模型与 `normalizeModel` 结果一致。

---

## B. 转换层：断点透传（本次真正的修复）

### B1 转换函数扩参

两个转换函数当前都是单参：

- `src/relay/converters/anthropicToOpenAIChat.ts` `convertAnthropicToOpenAIChat(anthropicBody: unknown)` :120
- `src/relay/converters/anthropicToOpenAIResponses.ts` `convertAnthropicToOpenAIResponses(anthropicBody: unknown)` :88

各自新增**可选**第二参数，保证既有三个调用点
（`openaiChatProxy.ts` :136、`openaiResponsesProxy.ts` :136、
`tokenBudget/compactor.ts` :237）不改也能编译：

```ts
/** Anthropic → OpenAI 转换的可选行为开关。 */
export interface AnthropicConversionOptions {
    /** 模型级缓存策略；缺省按 'auto' 处理。 */
    cacheMode?: ModelCacheMode;
}
```

签名改为
`export function convertAnthropicToOpenAIChat(anthropicBody: unknown, options?: AnthropicConversionOptions): AnthropicToOpenAIChatResult`，
Responses 同理。函数体首行加：

```ts
const cacheMode = options?.cacheMode ?? 'auto';
```

> `ModelCacheMode` 从 `../../types` 导入。转换器目前已经 import 过
> `./openaiTypes` 之类的纯类型模块，再加一个纯类型 import 不引入运行时依赖。

### B2 system 断点透传

`convertSystemToText()`（Chat :166）与 `convertSystemToInstructions()`
（Responses :126）当前把 system 数组**拍平成一整段文本**，`cache_control`
无处可放——这是两个函数丢断点的结构性原因。

改造方式：给两个函数加 `cacheMode` 参数，并让 Chat 侧在 `passthrough` 时
输出**结构化 content 数组**而不是字符串。

`anthropicToOpenAIChat.ts` :124-127 当前是：

```ts
const systemText = convertSystemToText(source.system, warnings);
if (systemText.trim()) {
    messages.push({ role: 'system', content: systemText });
}
```

改为：

```ts
const systemMessage = convertSystemToMessage(source.system, warnings, cacheMode);
if (systemMessage) messages.push(systemMessage);
```

新增 `convertSystemToMessage(system, warnings, cacheMode)`：

- `cacheMode !== 'passthrough'`：内部仍调用原 `convertSystemToText()`
  （连同其 `unsupported_cache_control` warning 一并保留），行为零变化；
- `cacheMode === 'passthrough'`：把每个 text block 转成
  `{ type: 'text', text, ...(block.cache_control ? { cache_control: block.cache_control } : {}) }`
  的数组作为 `content`，**不再**推 `unsupported_cache_control` warning。

`OpenAIChatMessage.content` 的类型需要放宽到 `string | unknown[]`
（定义在 `anthropicToOpenAIChat.ts` 顶部的 `OpenAIChatMessage` 接口，
搜 `interface OpenAIChatMessage`）。

Responses 侧的 `instructions` 字段协议上只接受字符串，无法挂断点。
因此 Responses 的 system 断点改为：`passthrough` 时**不写 instructions**，
而是把 system 作为 `input` 数组的第一个 item
（`{ role: 'system', content: [{ type: 'input_text', text, cache_control }] }`），
使断点有容器可挂。该改动风险高于 Chat，实现时须在
`convertAnthropicToOpenAIResponses()` :88 的 `body.instructions` 赋值处（:103）
用 `cacheMode` 分支，且**默认路径完全不变**。

### B3 message 断点透传（收益最大的一处）

Claude Code 的滚动缓存断点打在最后几条 message 的 content block 上。当前
`convertAnthropicMessage()`（Chat :200 / Responses :160）→
`convertUserContent()`（Chat :229 / Responses :200）/
`convertAssistantContent()`（Chat :275 / Responses :248）
全程不读 `cache_control`，静默丢弃。

改造：给这四个函数（每个文件两个）逐层传下 `cacheMode`，在构造 text block 的
位置，当 `cacheMode === 'passthrough'` 且源 block 带 `cache_control` 时，
把该字段原样复制到输出 block 上。

需要注意 Chat 的 user 文本在只有单个 text block 时会被压成字符串
（`convertUserContent` 内部的合并逻辑）——`passthrough` 下必须保持数组形态，
否则断点无处附着。实现时在该压平分支加 `cacheMode !== 'passthrough'` 条件。

assistant 消息的断点可以一并透传；Anthropic 允许，网关按前缀匹配处理。

### B4 `tools` 断点

`convertTools()`（Chat :414 / Responses :402）同样丢弃 tools 上的
`cache_control`。tools 位于请求最前缀，是命中率最高的一段，**必须一起透传**。
在 `passthrough` 分支下把 `cache_control` 复制到输出的 tool 对象上
（Chat 是 `{ type: 'function', function: {...} }`，断点挂在**外层**对象）。

---

## C. 代理层：把模型配置传进转换器

### C1 `cacheMode` 的来源

`UpstreamRequestContext`（`src/relay/router.ts` :47-71）已经带了
`provider: ProviderConfig` 与 `modelId: string`，而 `ProviderConfig.models`
是完整的 `ModelConfig[]`。因此**不需要**新增 context 字段或访问 ConfigManager，
在代理内部按 modelId 查表即可。

### C2 `src/relay/openaiChatProxy.ts` `handle()` :101

在 :136 `const converted = convertAnthropicToOpenAIChat(anthropicBody);` 之前插入：

```ts
const cacheMode = resolveModelCacheMode(provider, modelId);
```

调用改为 `convertAnthropicToOpenAIChat(anthropicBody, { cacheMode })`。

### C3 `src/relay/openaiResponsesProxy.ts` `handle()` 同位置（:136）

同样处理，调用 `convertAnthropicToOpenAIResponses(anthropicBody, { cacheMode })`。

### C4 新增共享工具函数

两个代理都要用，放在既有的 relay 共享模块里（与
`buildOpenAIForwardHeaders` / `joinUpstreamUrl` 同文件，见两个 proxy 的
import 段），新增：

```ts
/**
 * 读取指定模型的缓存策略。
 *
 * @param provider 目标提供商配置。
 * @param modelId 已剥离前缀的模型 ID。
 * @returns 模型上配置的缓存策略；模型不存在时回落 'auto'。
 */
export function resolveModelCacheMode(provider: ProviderConfig, modelId: string): ModelCacheMode {
    return provider.models.find((item) => item.modelId === modelId)?.cacheMode ?? 'auto';
}
```

### C5 `src/relay/tokenBudget/compactor.ts` :237 保持不变

该处只是为了**估算 token 数**做一次转换，不发给上游，缓存策略无意义。
保持单参调用（走 `auto`），并在该行上方补一行注释说明「仅用于估算，不需要
缓存断点」，避免后来人误以为漏改。

---

## D. 响应层：读回缓存 token

请求走的是 OpenAI 协议，网关就按 OpenAI 协议应答，缓存 token 出现在协议规定的
明细字段里。**只按规范读这一处，不做多形态探测：**

- Chat：`usage.prompt_tokens_details.cached_tokens`
- Responses：`usage.input_tokens_details.cached_tokens`

OpenAI 协议没有「缓存写入量」的对应字段，所以只能映射出 Anthropic 的
`cache_read_input_tokens`，`cache_creation_input_tokens` 不产出。

### D1 扩展 Anthropic usage 类型

`openAIChatToAnthropic.ts` 的 `AnthropicMessageResponse.usage` :31-36 与
`openAIResponsesToAnthropic.ts` 的同名结构 :32-37 各追加一个可选字段：

```ts
        /** 命中缓存读取的 token 数；上游 usage 未给出明细时省略。 */
        cache_read_input_tokens?: number;
```

用可选字段而非默认 0：`usageReporter.collectUsage()`（:177-187）用
`readPositiveNumber` 判断有效值，写 0 与不写在 UI 上等价，但省略更能区分
「没有明细」与「确实是 0」，便于排查。

### D2 新增缓存 token 读取辅助

两个反向转换器各写一份（两文件本就无共享模块）：

```ts
/**
 * 读取 OpenAI usage 明细中的缓存命中 token。
 *
 * @param usage 上游 usage 对象。
 * @param detailsKey 明细字段名：Chat 为 prompt_tokens_details，
 *                   Responses 为 input_tokens_details。
 * @returns 缓存命中 token；无明细字段时返回 undefined。
 */
function readCachedTokens(usage: unknown, detailsKey: string): number | undefined
```

实现：`isRecord(usage)` 且 `isRecord(usage[detailsKey])` 且
`cached_tokens` 是有限数字时返回该值，否则 `undefined`。

### D3 Chat 非流式：`openAIChatToAnthropic.ts` :473-476

```ts
            usage: {
                input_tokens: readNumber(...prompt_tokens),
                output_tokens: readNumber(...completion_tokens)
            }
```

改为先算 `const cachedTokens = readCachedTokens(source.usage, 'prompt_tokens_details');`，
再：

```ts
            usage: {
                input_tokens: readNumber(...prompt_tokens) - (cachedTokens ?? 0),
                output_tokens: readNumber(...completion_tokens),
                ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {})
            }
```

**减法是必须的**：按 OpenAI 规范 `prompt_tokens` 是含缓存部分的总数，而
Anthropic 的 `input_tokens` 是不含缓存的增量，不减会在 UI 上重复计数。
`cached_tokens ≤ prompt_tokens` 由协议保证，不需要 `Math.max` 兜底。

### D4 Chat 流式：`readUsage()` :250

`OpenAIChatToAnthropicState`（:68）新增 `cacheReadTokens?: number`
（初始化在 :111-112 附近，保持 `undefined` 即可，不必显式赋值）。
`readUsage()` 内按 D2 读取并写入 state，同时对 `promptTokens` 做同样的减法。

输出位置需要两处都写：

- `message_start` :240 的 `usage` —— 追加 `cache_read_input_tokens`；
- `finishIfNeeded()` :396 的 `message_delta` usage —— 一并追加。

> 原因是时序：OpenAI 流式的 usage 只在**最后一个 chunk** 返回
> （`stream_options.include_usage` 已在 `anthropicToOpenAIChat.ts` :143-148 下发），
> 而 `message_start` 早就发出去了——当前代码 :240 的 promptTokens 那时恒为 0，
> 这是既有问题。缓存字段写在 message_delta 才拿得到真值；message_start 那份
> 保持结构完整，`usageReporter` 取最后一次有效值，不会冲突。

### D5 Responses：`convertUsage()` :995 与 `readResponseMetadata()` :494

- `convertUsage()` 按 D3 同样处理，`detailsKey` 用 `'input_tokens_details'`；
- `readResponseMetadata()` :499-503 读 usage 时一并把 `cacheReadTokens` 存进
  `ResponsesStreamState`（新增一个可选字段），并在 `ensureMessageStart()` :524
  与 `finishIfNeeded()` :658 的 usage 上输出。
  Responses 的 `response.completed` 事件带完整 usage，时序好于 Chat，
  但 `message_start` 仍可能早于它，故同样两处都写。

### D6 验证方式

改完后在 Chat UI 底部看 cache_read 数值，这是判断 A/B 是否生效的直接手段。

---

## E. UI 层：模型编辑弹窗的缓存下拉

### E1 `media/configView.js` `renderModelModal()` :1137

在 `model-preserve-reasoning` 复选框行（:1163）之后插入一个 `field full`：

```js
                        <div class="field full"><label>${t('cacheMode')}</label><select id="model-cache-mode">
                            ${[
                                ['auto', t('cacheModeAuto')],
                                ['passthrough', t('cacheModePassthrough')],
                                ['off', t('cacheModeOff')]
                            ].map(([value, label]) => `<option value="${value}" ${(model.cacheMode || 'auto') === value ? 'selected' : ''}>${text(label)}</option>`).join('')}
                        </select></div>
```

结构与紧邻的 `model-sampling-mode` 下拉（:1150-1157）保持一致。
用下拉而非复选框：缓存是三态语义，布尔表达不了。

### E2 `media/configView.js` `saveModelFromModal()` :1336

在 `model.preserveReasoningContent = ...`（:1356）之后追加：

```js
        model.cacheMode = document.getElementById('model-cache-mode').value || 'auto';
```

### E3 `media/configView.js` 新建模型默认值 :1444

`createDefaultModel()`（返回对象见 :1444-1457，末字段
`preserveReasoningContent: false` :1456）追加 `cacheMode: 'auto'`。

### E4 i18n 文案

`media/configView.js` 的 `translations`（:40 起）是**内联的**多语言表，不是
`package.nls*.json`。需要在 **en / zh-cn / zh-tw / ko / ja** 五个语言块里
（分别参考 `samplingMode` 所在行 :110 / :205 / :302 / :379 / :456）各补 4 个键：

| key | en | zh-cn |
| --- | --- | --- |
| `cacheMode` | Prompt Cache | 提示词缓存 |
| `cacheModeAuto` | Auto (by protocol) | 自动（按协议） |
| `cacheModePassthrough` | Pass through cache_control | 透传 cache_control |
| `cacheModeOff` | Off | 关闭 |

`cacheModePassthrough` 需要一句 hint 说明「仅在上游能识别 `cache_control` 时开启，
严格按 OpenAI 规范校验请求体的上游会因未知字段返回 400」。若弹窗没有 hint 位，
可写进 option 文案里，如 `透传 cache_control（上游需支持）`。

> 文件底部 :700-711 有一段「缺失键回落英文」的补齐逻辑，只覆盖白名单里的几个
> key。新增的 4 个键**建议一次补全五种语言**，不要依赖该回落。

---

## F. `prompt_cache_key`（对本例无用，留给官方 OpenAI 上游）

仅在 `cacheMode === 'auto'` 且上游是真 OpenAI 时有意义。实现：

- 在 `convertAnthropicToOpenAIChat()` :151 `body.user = userId` 附近追加
  `body.prompt_cache_key = buildPromptCacheKey(systemText, source.messages)`，
  `cacheMode === 'off'` 时跳过；
- 键值取「system 文本 + 首条 user 消息文本」的 SHA-256 前 16 位十六进制
  （`crypto.createHash('sha256')`）。该前缀在会话内恒定、跨会话必然不同，
  无需引入状态管理；
- Responses 侧在 :103 附近同样处理。

**风险**：严格按 OpenAI 规范校验请求体的上游会对未知字段返回 400。因此该字段应与
`passthrough` 互斥——`passthrough` 模式下不下发 `prompt_cache_key`
（走 Anthropic 断点语义即可）。

优先级最低，可以在 A~E 验证通过后再评估是否需要。

---

## G. TTL 文案（纯文案）

`applyCacheTtlToRequest()`（`src/relay/taskRequestInjection.ts` :285）改写的是
`cache_control.ttl`。B 落地后，`passthrough` 模式下这些断点会被透传，**TTL 设置
对 Chat / Responses 上游重新变得有效**——这是 B 的一个附带收益。

但 `auto` / `off` 模式下 TTL 仍是空操作。因此在 Chat 侧缓存时长选项
（协议 `cacheTtl/select`，见 `src/chat/protocol.ts` :592）的说明文案里补一句：
「对 OpenAI 兼容 / Responses 提供商，需在模型设置中开启 cache_control 透传后才生效」。

---

## H. 验收标准

### 单元测试

- 新增 `src/relay/converters/__tests__/cachePassthrough.test.ts`：
  - `cacheMode` 缺省时，输出 body 与改动前**逐字节一致**（快照式回归，
    确保默认路径零变化），且 `unsupported_cache_control` warning 仍在；
  - `cacheMode: 'passthrough'` 时，tools / system / 最后一条 message 上的
    `cache_control` 均出现在输出 body 中，且不再产生该 warning；
  - `passthrough` 下 Chat 的单 text block user 消息保持数组形态而非被压平；
  - Responses 的 `passthrough` 把 system 移入 input 首项且不写 instructions。
- 新增 `src/relay/converters/__tests__/cachedTokens.test.ts`：
  - Chat 非流式 usage 带 `prompt_tokens_details.cached_tokens` 时，
    `cache_read_input_tokens` 正确且 `input_tokens` 已扣除；
  - Chat 流式在 `message_delta` 上能读到该字段；
  - Responses 的 `input_tokens_details.cached_tokens` 同理；
  - usage 无明细字段时，`cache_read_input_tokens` **不出现**在输出中
    （不写 0、不 NaN），且 `input_tokens` 与改动前一致。
- `src/__tests__/configManagerModels.test.ts` 补：`normalizeModel` 对旧数据补
  `cacheMode: 'auto'`，对非法值（如 `'yes'`）同样归一为 `'auto'`，
  且 `mergeFetchedModel` 后不丢失用户设置的 `'passthrough'`。

### 手工验证

1. 把目标模型的 `cacheMode` 设为 `passthrough`；
2. 在 Chat 里连发两轮相同上下文的对话；
3. 第二轮 UI 底部应出现非 0 的 cache_read；
4. 同一模型切回 `auto`，cache_read 应回到 0（证明开关确实生效）；
5. 再用一个官方 OpenAI provider 验证 `auto` 下不报 400（回归）。

### 门禁

`npx tsc --noEmit -p ./`、`npm run compile`、`npm test` 全绿，
`get_errors` 无诊断。

---

## I. 落地顺序与风险

| 顺序 | 项 | 影响面 | 风险 |
| --- | --- | --- | --- |
| 1 | A 数据层 cacheMode | types / configManager / modelFetcher | 低（纯新增可选字段） |
| 2 | B 断点透传 | 两个转换器共 8 个函数 | **中高**，默认路径必须零变化 |
| 3 | C 代理层传参 | 两个 proxy + 一个共享函数 | 低 |
| 4 | D 读回缓存 token | 两个反向转换器 | 中（涉及 input_tokens 减法） |
| 5 | E UI 下拉 + i18n | configView.js 五语言 | 低 |
| 6 | F prompt_cache_key | 两个转换器 | 中（未知字段可能 400），可延后 |
| 7 | G TTL 文案 | 纯文案 | 无 |

B 是唯一有实质风险的一项。**红线：`cacheMode !== 'passthrough'` 时，两个转换器
的输出必须与改动前完全一致。** 所有 `passthrough` 分支都写成
`if (cacheMode === 'passthrough') { ... }` 的加法，不改动既有代码路径。
