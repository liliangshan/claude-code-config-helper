# 思考模式落地方案（可执行）

- 日期：2026-09-01
- 上游文档：`docs/thinking-mode-conversion-assessment-2026-09-01.md`（评估与方案比选）
- 本文只写**怎么做**：文件、方法、签名、判定条件、测试。所有行号以当前 HEAD（`c8c965d`）为准。
- 总红线：`reasoningMode !== 'passthrough'` 时，四个转换器输出必须与改动前**逐字节相同**。新逻辑一律走加法式 `if` 分支。

## 阶段划分

| 阶段 | 名称 | 前置 | 可独立验收 |
| --- | --- | --- | --- |
| 0 | 验证 CLI 是否接受无签名 thinking block | — | 是（门禁） |
| 1 | 数据层：`reasoningMode` 字段 | — | 是 |
| 2 | 方案 D：请求侧下发 reasoning 参数 | 阶段 1 | 是 |
| 3 | 方案 B-1：Chat 响应侧读回 thinking block | 阶段 0 通过 | 是 |
| 4 | 打字机：思考块整块补写 | 阶段 3 | 是 |
| 5 | 死字段清理 | 阶段 1 | 是 |

阶段 2 与 3 互不依赖，可并行。阶段 0 未通过则 3、4 全部取消，退方案 C。

---

## 阶段 0：门禁验证（半天，不可跳过）

> **状态：跳过（2026-09-01）**。按你的决定直接放行阶段 3/4，本门禁不作为前置条件。
>
> 说明实际做过一次探测：`claude` 2.1.141 在本机以 `apiKeySource:"none"` 拒绝走自定义
> BaseURL（返回 "Not logged in"），只发出了 `HEAD /` 就退出，**请求从未到达 `/v1/messages`**。
> 因此「CLI 是否接受无签名 thinking block」目前仍是**未验证**状态，不是已验证通过——
> 只是按决策不再等它。
>
> 风险兜底：`reasoningMode` 缺省为 `'off'`，不会默认改变任何现有行为；回传侧
> `sanitizeReplayedThinkingBlocks()`（`anthropicProxy.ts:166`）也会剥离无签名块。
> 若开启 `passthrough` 后思考块不显示或 CLI 报错，第一嫌疑即本门禁未验，退方案 C。

**目的**：确认 `claude` 二进制接受缺 `signature` 的 thinking block。这一步不写产品代码。

**做法**：新建一次性脚本 `scripts/probe-unsigned-thinking.js`（验证完即删，不进 git）：

1. 起一个本地 HTTP server，对 `POST /v1/messages` 返回固定 Anthropic SSE：
   ```
   message_start
   content_block_start  index=0  {"type":"thinking","thinking":""}
   content_block_delta  index=0  {"type":"thinking_delta","thinking":"测试思考"}
   content_block_stop   index=0
   content_block_start  index=1  {"type":"text","text":""}
   content_block_delta  index=1  {"type":"text_delta","text":"你好"}
   content_block_stop   index=1
   message_delta / message_stop
   ```
   **关键：不发 `signature_delta`，`content_block_start` 里不带 `signature` 字段。**
2. 用 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` 启动 `claude -p "hi" --output-format stream-json --verbose`
3. 观察 stdout：是否出现 `content_block_delta` + `thinking_delta`，还是报错退出

**判定**：

| 结果 | 结论 |
| --- | --- |
| CLI 正常输出 thinking_delta | 阶段 3、4 放行 |
| CLI 报错 / 丢弃该 block | 阶段 3、4 取消，改做方案 C（只透传 `reasoning_tokens`） |

顺带验证 §5.2：让脚本记录 CLI 的第二轮请求体，确认 thinking block 是否被带回。即使带回，`anthropicProxy.ts:166` 的 `sanitizeReplayedThinkingBlocks()` 也会因 `isLikelyAnthropicSignature()`（:218，要求 ≥64 字符且非 UUID）失败而剥离，属已有防护。

---

## 阶段 1：数据层 `reasoningMode`（半小时）

完全复刻 `cacheMode` 的既有形状。

### 1.1 `src/types.ts`

在 `ModelCacheMode` 类型定义旁新增：

```ts
/** 模型级思考内容策略。 */
export type ModelReasoningMode = 'off' | 'passthrough';
```

在 `ModelConfig` 接口内、`cacheMode?: ModelCacheMode;`（:101）之后新增：

```ts
/**
 * 思考内容处理策略。
 *
 * - `off`（缺省）：完全保持现状，请求侧不下发 reasoning 参数，响应侧丢弃
 *   上游 reasoning，转换器输出与未启用本特性时逐字节相同。
 * - `passthrough`：请求侧把 Anthropic `thinking.budget_tokens` 映射为
 *   OpenAI `reasoning_effort`；响应侧把 `delta.reasoning_content` 合成为
 *   Anthropic thinking block（无 signature，仅供展示）。
 *
 * 兼容旧数据：未显式设置时由 `ConfigManager.normalizeModel()` 补齐为 `'off'`。
 */
reasoningMode?: ModelReasoningMode;
```

**注意缺省值与 `cacheMode` 不同**：`cacheMode` 缺省 `'auto'`（有行为），`reasoningMode` 缺省 `'off'`（无行为）。理由是本特性会改变 block index 布局，必须显式开启。

### 1.2 `src/configManager.ts`

`normalizeModel()` 内，紧跟 `cacheMode` 那一行（:577）追加：

```ts
reasoningMode: model.reasoningMode === 'passthrough' ? 'passthrough' : 'off'
```

任何非 `'passthrough'` 的值（含 undefined、脏数据）统一落到 `'off'`。

### 1.3 `src/modelFetcher.ts`

`:174` 的 `cacheMode: 'auto'` 之后加 `reasoningMode: 'off'`，保证新拉取的模型带全字段。

### 1.4 `src/relay/modelCacheMode.ts`

在 `resolveModelCacheMode()` 之后并列新增（文件已是「模型级策略查表」定位，无需改名）：

```ts
/**
 * 读取指定模型的思考内容策略。
 *
 * @param provider 目标提供商配置。
 * @param modelId 已剥离前缀的模型 ID。
 * @returns 模型上配置的思考策略；模型不存在或未配置时回落 `'off'`。
 */
export function resolveReasoningMode(provider: ProviderConfig, modelId: string): ModelReasoningMode {
    return provider.models.find((item) => item.modelId === modelId)?.reasoningMode ?? 'off';
}
```

### 1.5 测试

`src/__tests__/configManagerModels.test.ts` 加 3 例，与 cacheMode 现有 3 例同构：

- 旧数据缺 `reasoningMode` → 归一化为 `'off'`
- 非法值（`'auto'` / `123`）→ `'off'`
- `replaceProviderModels` 刷新模型列表时保留本地已设的 `'passthrough'`

---

## 阶段 2：方案 D — 请求侧下发 reasoning 参数（1 天）

### 2.1 阈值映射（先定死，两个转换器共用）

新建 `src/relay/converters/reasoningEffort.ts`：

```ts
/**
 * @file Anthropic thinking 预算 → OpenAI reasoning effort 档位映射。
 *
 * Anthropic 的 budget_tokens 是连续值，OpenAI 的 effort 只有三档，故需人为
 * 切分阈值。两个请求转换器共用本模块，保证 Chat 与 Responses 档位一致。
 */

/** OpenAI reasoning effort 档位。 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * 把 Anthropic thinking.budget_tokens 映射为 OpenAI reasoning effort 档位。
 *
 * 阈值取自 Anthropic 官方文档给出的常用预算区间：1024 是协议允许的最小值，
 * 4096 是「中等推理」的典型档，16384 以上属深度推理。
 *
 * @param budgetTokens Anthropic thinking.budget_tokens 原始值。
 * @returns 对应 effort 档位；入参非有限正数时返回 undefined 表示不下发。
 */
export function mapBudgetToEffort(budgetTokens: unknown): ReasoningEffort | undefined {
    if (typeof budgetTokens !== 'number' || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return undefined;
    if (budgetTokens < 4096) return 'low';
    if (budgetTokens < 16384) return 'medium';
    return 'high';
}
```

| budget_tokens | effort |
| --- | --- |
| 缺失 / ≤0 / 非数字 | 不下发任何 reasoning 参数 |
| 1 ～ 4095 | `low` |
| 4096 ～ 16383 | `medium` |
| ≥ 16384 | `high` |

### 2.2 `src/relay/converters/anthropicToOpenAIChat.ts`

**扩展入参类型**：`AnthropicConversionOptions` 加 `reasoningMode?: ModelReasoningMode`。

**扩展源类型**：源 body 接口（`temperature`/`top_p`/`max_tokens` 所在的那个，:75-82）加：

```ts
/** Anthropic 思考配置，形如 { type: 'enabled', budget_tokens: 8192 }。 */
thinking?: unknown;
```

**新增映射**：在 `convertAnthropicToOpenAIChat()` 里，紧跟 `if (source.stream !== undefined) body.stream = source.stream;`（:154）之后插入：

```ts
if (options?.reasoningMode === 'passthrough') {
    const effort = readThinkingEffort(source.thinking);
    if (effort) body.reasoning_effort = effort;
}
```

**新增私有函数**（放在文件内其它 `read*` 辅助函数附近）：

```ts
/**
 * 从 Anthropic thinking 配置中读出 OpenAI reasoning effort 档位。
 *
 * 仅当 thinking.type === 'enabled' 时才认为用户真的开启了思考；
 * 'disabled' 或缺失一律返回 undefined，避免误开上游推理。
 *
 * @param thinking Anthropic 请求体顶层 thinking 字段。
 * @returns effort 档位；不应下发时返回 undefined。
 */
function readThinkingEffort(thinking: unknown): ReasoningEffort | undefined {
    if (!isRecord(thinking) || thinking.type !== 'enabled') return undefined;
    return mapBudgetToEffort(thinking.budget_tokens);
}
```

### 2.3 `src/relay/converters/anthropicToOpenAIResponses.ts`

同上，差别只在下发字段名：

```ts
if (options?.reasoningMode === 'passthrough') {
    const effort = readThinkingEffort(source.thinking);
    if (effort) body.reasoning = { effort };
}
```

`readThinkingEffort` 从 `reasoningEffort.ts` 导出复用，不要复制两份。

### 2.4 两个代理传参

- `src/relay/openaiChatProxy.ts:137-139`：
  ```ts
  const converted = convertAnthropicToOpenAIChat(anthropicBody, {
      cacheMode: resolveModelCacheMode(provider, modelId),
      reasoningMode: resolveReasoningMode(provider, modelId)
  });
  ```
- `src/relay/openaiResponsesProxy.ts` 对应调用点同样加一行。
- 两个文件的 import 从 `./modelCacheMode` 一并引入 `resolveReasoningMode`。

### 2.5 测试

新建 `src/relay/converters/__tests__/reasoningMode.test.ts`，先写方案 D 部分：

- `off` 时带 `thinking: {type:'enabled', budget_tokens: 8192}` 的请求体 → 输出**不含** `reasoning_effort`，且与不传 options 时 `JSON.stringify` 完全相等（红线）
- `passthrough` + 1024 → `reasoning_effort: 'low'`
- `passthrough` + 8192 → `'medium'`
- `passthrough` + 32000 → `'high'`
- `passthrough` + `thinking: {type:'disabled'}` → 不下发
- `passthrough` 但请求体无 `thinking` → 不下发
- Responses 侧同构 2 例，断言 `body.reasoning.effort`

---

## 阶段 3：方案 B-1 — Chat 响应侧读回（半天）

### 3.1 转换器需要知道 reasoningMode

现状：`OpenAIChatToAnthropicStreamConverter`（`openAIChatToAnthropic.ts:103`）**没有构造函数**，`state` 是字段初始化器（:108-118）。

改动：加构造函数接收模式。

```ts
/**
 * @param reasoningMode 模型级思考策略；'passthrough' 时才合成 thinking block。
 */
constructor(private readonly reasoningMode: ModelReasoningMode = 'off') {}
```

默认值 `'off'` 保证现有 8 处 `new OpenAIChatToAnthropicStreamConverter()`（4 处在 `streamConverters.test.ts`、3 处在 `cachedTokens.test.ts`、1 处在 `openaiChatProxy.ts:320`）无需改动即维持原行为。

`openaiChatProxy.ts:320` 改为传入实参。但 `handleStreamResponse()`（:310）签名里拿不到 provider/modelId——它们只在 `forward()` 上游可见。最小改法：在 `handleStreamResponse` 参数表加一个 `reasoningMode: ModelReasoningMode`，由 `:225` 的调用点透传（该处在 `forward()` 内，`provider`/`modelId` 需一并沿 `forward(args)` 传下来，args 里补两个字段）。

### 3.2 状态字段

`OpenAIChatToAnthropicState`（:70-95）新增两项，放在 `textBlockOpen`（:80）之后：

```ts
/** 当前 thinking content block index。 */
currentThinkingIndex?: number;
/** thinking block 是否打开。 */
thinkingBlockOpen: boolean;
```

初始化器（:112 附近）补 `thinkingBlockOpen: false`。

### 3.3 `handleChunk()` 插入分支

现状（:209-212）：

```ts
const delta = isRecord(choice.delta) ? choice.delta : {};
if (typeof delta.content === 'string' && delta.content.length > 0) {
    out += this.emitTextDelta(delta.content);
}
```

改为（reasoning 分支必须在 content 分支**之前**，保证同一 chunk 内先思考后正文）：

```ts
const delta = isRecord(choice.delta) ? choice.delta : {};
if (this.reasoningMode === 'passthrough' && typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    out += this.emitThinkingDelta(delta.reasoning_content);
}
if (typeof delta.content === 'string' && delta.content.length > 0) {
    out += this.emitTextDelta(delta.content);
}
```

**`length > 0` 是硬要求**：真实报文里首个 chunk 是 `{"reasoning_content":"","content":"","role":"assistant"}`，正文阶段每个 chunk 也带 `"reasoning_content":""`，用 `!== undefined` 会开出空 thinking block 并在正文阶段反复触发。

### 3.4 新增两个私有方法

仿照 `emitTextDelta()`（:280）与 `closeTextBlockIfOpen()`（:398）：

```ts
/**
 * 输出 thinking block 增量，必要时先开启 thinking block。
 *
 * 上游 reasoning 分片先于正文到达且不与正文交错，故 thinking block 天然
 * 占据 index 0，正文与工具块顺次后移，无需重排。
 *
 * 不发 signature_delta：OpenAI 侧不产出 Anthropic 服务端签名，合成的块
 * 仅供展示，不参与多轮回传（回传时会被 anthropicProxy 的签名校验剥离）。
 *
 * @param text 非空 reasoning 文本分片。
 * @returns Anthropic SSE 文本。
 */
private emitThinkingDelta(text: string): string {
    let out = '';
    if (!this.state.thinkingBlockOpen) {
        const index = this.state.nextBlockIndex++;
        this.state.currentThinkingIndex = index;
        this.state.thinkingBlockOpen = true;
        out += formatAnthropicSse('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'thinking', thinking: '' }
        });
    }
    out += formatAnthropicSse('content_block_delta', {
        type: 'content_block_delta',
        index: this.state.currentThinkingIndex,
        delta: { type: 'thinking_delta', thinking: text }
    });
    return out;
}

/**
 * 关闭当前 thinking 块。
 *
 * @returns Anthropic SSE 文本。
 */
private closeThinkingBlockIfOpen(): string {
    if (!this.state.thinkingBlockOpen || this.state.currentThinkingIndex === undefined) return '';
    const index = this.state.currentThinkingIndex;
    this.state.thinkingBlockOpen = false;
    this.state.currentThinkingIndex = undefined;
    return formatAnthropicSse('content_block_stop', { type: 'content_block_stop', index });
}
```

### 3.5 三处关闭时机

`closeThinkingBlockIfOpen()` 必须在**正文/工具块开启前**以及**收尾**调用，共三处：

| 位置 | 现有代码 | 改法 |
| --- | --- | --- |
| `emitTextDelta()` :281 | `let out = '';` | 改为 `let out = this.closeThinkingBlockIfOpen();` |
| `maybeStartToolBlock()` :350 | `let out = this.closeTextBlockIfOpen();` | 前面加一行 `let out = this.closeThinkingBlockIfOpen(); out += this.closeTextBlockIfOpen();` |
| `finishIfNeeded()` :413 | `let out = this.closeTextBlockIfOpen();` | 同上，thinking 先关 |

`handleChunk()` 里 `finish_reason` 分支（:220-223）也要补 `out += this.closeThinkingBlockIfOpen();`，与 `closeTextBlockIfOpen()` 并列——覆盖「只有思考、没有正文」的退化流。

因为 `thinkingBlockOpen` 初始为 `false` 且只有 passthrough 才会置真，`off` 模式下这四处新增调用全部返回空串，**输出逐字节不变**。

### 3.6 非流式路径

`convertOpenAIChatJsonToAnthropic()` 同样要读 `choices[0].message.reasoning_content`，在 content block 数组最前面插入 `{type:'thinking', thinking: <text>}`。同样受 `reasoningMode === 'passthrough'` 保护，需给该函数加 options 入参。

优先级低于流式（Chat UI 走流式），可放到阶段 3 的后半段做。

### 3.7 测试

`reasoningMode.test.ts` 追加：

- **红线**：`off`（默认构造）喂含非空 `reasoning_content` 的 SSE → 输出与不带 reasoning 字段的同序列**完全相等**
- `passthrough` 喂真实报文序列（7 个 reasoning 分片 + 若干 content 分片）→ 断言事件序列为：
  `message_start` → `content_block_start(index=0, thinking)` → 7×`thinking_delta` → `content_block_stop(0)` → `content_block_start(index=1, text)` → N×`text_delta` → `content_block_stop(1)` → `message_delta` → `message_stop`
- `passthrough` 且所有 `reasoning_content` 均为空串 → **不得**出现任何 thinking block，正文 index 仍为 0
- `passthrough` 且只有思考没有正文 → 流结束时 thinking block 被正确关闭
- `passthrough` + 思考后接 tool_call → thinking index 0、tool_use index 1

---

## 阶段 4：打字机（半天）

目标：思考内容渲染成**一个**引用块，文字逐字增长，而不是每片一个 blockquote。

### 4.1 `src/chat/cli/cliAdapter.ts` — `handleThinkingDelta()`（:1059）

现状每片单独格式化后产出，导致 N 次 `renderMarkdown()` = N 个 `div.markdownRoot`。

改为产出**整块累积文本**并带稳定 id：

```ts
private handleThinkingDelta(index: number, delta: Record<string, unknown>): ParsedCliEvent {
    const text = typeof delta.thinking === 'string' ? delta.thinking : '';
    if (!text) return { type: 'segments', segments: [], done: false };
    const block = this.ensureBlockState(index, 'thinking');
    block.text += text;
    // 每次补写整块累积文本并复用同一 segment id，Webview 侧按 id 原地替换，
    // 呈现为单个逐字增长的引用块而非每片一个 blockquote。
    return {
        type: 'segments',
        segments: [{ id: `thinking:${index}`, kind: 'markdown', text: this.formatThinkingBlock(block.text) }],
        done: false
    };
}
```

注意这里**绕开 `parseDisplayText()`**：该函数会把文本喂进 `parseChunk()` 增量解析器并累积 `parserState`（:2037-2038），重复投喂整块会污染解析状态。思考块是纯引用文本，直接产出 markdown segment 即可。

### 4.2 新增 `formatThinkingBlock()`

保留原 `formatThinkingChunk()`（:1295）不动——`normalizeInlineThinkBlocks()`（:1320）仍在用它处理 `<think>` 内联块，改它会波及那条链路。新增一个整块版本：

```ts
/**
 * 把整块思考文本格式化为 Markdown 引用块。
 *
 * 与按片处理的 formatThinkingChunk 不同，本方法用于「每次补写整块累积文本」
 * 的打字机路径：多行文本逐行加 `> ` 前缀，保证 renderMarkdown 把它们合并
 * 成单个 blockquote。
 *
 * @param text 已累积的完整思考文本。
 * @returns 可直接作为 markdown segment 的引用块文本。
 */
private formatThinkingBlock(text: string): string {
    if (!text) return text;
    const lines = text.split(/\r?\n/);
    return lines.map((line, i) => (i === 0 ? `${THINKING_SEGMENT_PREFIX}${line}` : `> ${line}`)).join('\n');
}
```

首行带 `> 💭 `，续行只带 `> `，`renderMarkdown()` 的引用块收集逻辑（`main.js:2418-2434`）会把连续 `> ` 行合并成一个 `blockquote`。

### 4.3 `media/chat/main.js` — `appendSegment()`（:2690）

现状文本分支（:2724）：

```js
appendText(container, segment.text || segment.sourceText || '');
```

改为：

```js
// 带稳定 id 的文本段（思考块打字机）需要在 DOM 上留下 data-segment-id，
// patchMessage 才能按 id 原地替换而不是不断追加新块。
var node = appendText(container, segment.text || segment.sourceText || '');
if (node && segment.id) node.dataset.segmentId = segment.id;
```

`appendText()`（:2671）已经 `return renderMarkdown(...)`，而 `renderMarkdown()`（:2480）已经 `return wrapper`，返回值链路是通的，无需再改。

**加法式**：只在 `segment.id` 存在时才设属性。现有文本段不带 id，行为逐字节不变。

### 4.4 已现成、无需改动的部分

- `main.js:4668`：`patchMessage()` 按 `data-segment-id` 查到已有节点即 `replaceChild`
- `main.js:3069-3075`：本地缓存按 `id` 去重合并，历史回放不留残片
- `protocol.ts:16`：`ChatSegment.id` 本就是为此设计

### 4.5 边界

- **长文本降级**：思考超过 `LONG_TEXT_LIMIT`（`main.js:11`，12000 字符）或 220 行时，`isLongOutput()`（:4182）会让 `appendText()` 走 `appendCollapsibleText()` 而非 `renderMarkdown()`，返回值可能不是 wrapper。`appendText()` 那条分支目前 `return undefined`，所以 `node && segment.id` 判空后不设属性——退化为「超长思考中途变成折叠卡片且不再原地更新」。需实测观感；若不可接受，再让 `appendCollapsibleText` 也返回根节点
- **性能**：每片重渲整块。思考通常几百字，单次 `replaceChild` 成本可忽略

### 4.6 测试

`src/chat/__tests__/` 下新建 `thinkingTypewriter.test.ts`：

- 连续喂 3 个 `thinking_delta`（`"A"` / `"B"` / `"C"`）→ 产出 3 个 segment，`id` 全为 `thinking:0`，`text` 依次为 `> 💭 A` / `> 💭 AB` / `> 💭 ABC`
- 含换行的思考文本 → 续行前缀为 `> `，首行为 `> 💭 `
- 空 `thinking` 分片 → 不产出 segment

`main.js` 的改动无单测覆盖（Webview 无测试基建），靠阶段 6 的手工验收。

---

## 阶段 5：UI 与死字段清理（半天）

### 5.1 `media/configView.js` 加下拉

完全复刻上一轮 `cacheMode` 下拉的做法：

- 在 `#model-cache-mode` 那一行之后加 `#model-reasoning-mode`，两个选项 `off` / `passthrough`
- 选项文本走 `text(label)` 转义
- 默认值 `(model.reasoningMode || 'off')`
- 保存分支：`model.reasoningMode = document.getElementById('model-reasoning-mode').value || 'off';`
- `createDefaultModel()` 加 `reasoningMode: 'off'`
- 4 个 i18n key × 5 语言（en / zh-cn / zh-tw / ko / ja）。passthrough 的说明文案要写清：**会改变 content block 顺序，仅在上游确实返回 reasoning 时开启**

### 5.2 两个死字段的处置

`types.ts:84` 的 `transformThink` 与 `:86` 的 `preserveReasoningContent`，在 `configManager.ts:575-576` 归一化后无任何读取方。

**建议直接删除**，而不是接进 `reasoningMode`：

- 二者语义与 `reasoningMode` 重叠但不等价（一个像开关、一个像保留策略），强行映射会产生「两个开关互相打架」的语义
- `reasoningMode` 是三态化的正解，保留旧字段只会让 UI 出现两个作用相似的控件
- 删除范围：`types.ts` 两个字段声明、`configManager.ts` 两行归一化、`configView.js` 对应的两个勾选框与 i18n key

**兼容性**：旧配置里残留这两个字段不会报错——`normalizeModel()` 是白名单式重建，未列出的字段自然丢弃。

---

## 阶段 6：门禁与验收

### 6.1 自动化门禁（每阶段结束都跑）

```
npx tsc --noEmit -p ./
npm run compile
npm test
```

`package.json` 的 test glob 需加入两个新测试文件：
`out/relay/converters/__tests__/reasoningMode.test.js`、`out/chat/__tests__/thinkingTypewriter.test.js`。

跑完用 `get_errors` MCP 确认 VS Code 侧 0 error / 0 warning。

### 6.2 手工验收（阶段 4 之后）

1. 打包安装：`npx vsce package` → `code --install-extension --force`
2. 配置一个 `openai-compatible` 提供商，模型 `reasoningMode` 设为 `passthrough`
3. Chat 里提问，观察：
   - 思考内容出现在回答**上方**的单个引用块内
   - 文字逐字增长，不是多个分离的 `> 💭` 行
   - 正文正常渲染，工具卡片位置正确
   - 底部 usage 页脚数字仍正确（阶段 3 动了 block index，需确认没影响 usage 链路）
4. 把 `reasoningMode` 改回 `off`，确认输出与本次改动前完全一致

### 6.3 回归重点

| 风险点 | 验证方式 |
| --- | --- |
| block index 后移影响工具卡片 | 阶段 3 测试里的「思考 + tool_call」用例 |
| `off` 模式输出漂移 | 每个阶段都有一条「与改动前逐字节相同」的断言 |
| `parserState` 被整块投喂污染 | 阶段 4 绕开 `parseDisplayText()`，测试断言 segment 内容 |
| 超长思考降级为折叠卡片 | 手工验收，暂不做自动化 |

---

## 未决项

以下三条需要你拍板或提供材料，不影响阶段 0～5 开工：

1. **Responses 侧（B-2）**：`response.completed` 才拿到整块 `reasoning.summary[].text`，补发会排在正文之后。需要一份**带思考的 Responses 流式报文**判断上游是否有 `response.reasoning_summary_text.delta` 之类增量事件。有则同 Chat 侧处理，无则 Responses 侧只做方案 C（把 `output_tokens_details.reasoning_tokens` 计入 usage）
2. **死字段**：本方案按「直接删除」写。若你倾向保留，需另行设计与 `reasoningMode` 的优先级关系
3. **effort 阈值**：4096 / 16384 两个切分点是我按 Anthropic 文档常用区间定的，若你的上游对 effort 敏感可调





