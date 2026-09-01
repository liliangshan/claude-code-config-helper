# 思考模式（thinking / reasoning）跨协议转换评估

- 日期：2026-09-01（含当日真实报文修订）
- 结论先行：**当前思考内容在三条链路上全部丢弃，两个相关配置开关是死的**；建议按 `reasoningMode` 模型级开关分两期落地，一期只做「响应侧读回」，二期再做「请求侧回传」。
- 本次修订：Chat 侧字段名与流式时序**已由真实报文定案**（`delta.reasoning_content`，增量分片且先于正文），Chat 侧读回成本由 2 天下调至 1 天；剩余未验证项收敛为「CLI 是否接受无 signature 的 thinking block」与「Responses 是否有增量 reasoning 事件」两条。
- 打字机效果：**可以实现**，且是真正的单块逐字增长——Webview 的 `patchMessage` 已支持按 segment id 原地替换，思考块只需带上稳定 id 并每次补写整块累积文本，详见 §8。
- 本文只做评估与方案比选，不含落地步骤。
- 落地步骤见 `docs/thinking-mode-implementation-2026-09-01.md`（具体到文件、方法、判定条件与测试）。

## 一、现状盘点（已逐处核对源码）

### 1.1 请求侧：Anthropic → OpenAI

| 位置 | 现状 |
| --- | --- |
| `anthropicToOpenAIChat.ts:382`、`:480` | `thinking` / `redacted_thinking` block 直接丢弃，记 `ignored_thinking` warning |
| `anthropicToOpenAIResponses.ts:348`、`:463` | 同上，warning code 相同 |
| 顶层 `thinking: { type, budget_tokens }` 参数 | 全仓库 grep 不到 `budget_tokens` / `reasoning_effort`，**静默丢弃，连 warning 都没有** |

### 1.2 响应侧：OpenAI → Anthropic

| 位置 | 现状 |
| --- | --- |
| `openAIChatToAnthropic.ts` `handleChunk()` | 只读 `delta.content` 与 `delta.tool_calls`，`delta.reasoning_content` 被忽略 |
| `openAIResponsesToAnthropic.ts:772` | `output[].type === 'reasoning'` 丢弃，记 `ignored_reasoning` warning |

上游确实在发这些字段——你提供的两份真实报文即为证据：Chat chunk 里带 `"reasoning_content":""`，Responses 的 `response.completed` 里带 `{"type":"reasoning","summary":[{"text":"We need to respond...","type":"summary_text"}]}`。

### 1.3 配置层：两个死开关

`types.ts:84` 的 `transformThink` 与 `:86` 的 `preserveReasoningContent`，在 `configManager.ts:575-576` 被归一化后**再无任何读取方**。这与刚修完的 `cacheMode` 是同一类缺陷：UI 上能勾，转换器不认，用户以为生效了。

## 二、协议差异与真正的难点

### 2.1 三方数据形态

| 协议 | 思考内容载体 | 是否需回传 |
| --- | --- | --- |
| Anthropic | `content[]` 中的 `{type:'thinking', thinking, signature}` block；流式为 `thinking_delta` + `signature_delta` | **必须**原样回传，含 `signature` |
| OpenAI Chat | `delta.reasoning_content`（非标准扩展，各家字段名不统一） | 一般不回传 |
| OpenAI Responses | `output[]` 中 `{type:'reasoning', summary:[{type:'summary_text',text}], encrypted_content}` | 需回传 `id` 或 `encrypted_content` |

### 2.2 难点一：signature 无法伪造（决定性约束）

Anthropic 的 thinking block 带 `signature`，是服务端签名。多轮对话里客户端必须把上一轮的 thinking block 连同签名原样回传，否则上游拒绝。

而 OpenAI 侧根本不产出这个签名。这意味着：

> **反向合成的 thinking block 不能回传给 Anthropic 内核网关。**

由此推出一条硬边界——响应侧「读回展示」和请求侧「回传续推」是两件难度完全不同的事，必须拆开评估，不能一起做。

### 2.3 难点二：Chat 侧字段名——**已由真实报文确认**

`reasoning_content` 不是 OpenAI 官方规范字段，各家实现不一（DeepSeek 用 `reasoning_content`，部分网关用 `reasoning`，OpenAI 官方 Chat 只给 `completion_tokens_details.reasoning_tokens`，有量无内容）。

2026-09-01 抓到的真实报文已定案：**本网关用 `delta.reasoning_content`**，且同时提供 `completion_tokens_details.reasoning_tokens`（样本值 19）。

报文还暴露两个必须处理的细节：

1. **空串会大量出现**。首个 chunk 是 `{"reasoning_content":"","content":"","role":"assistant"}`，正文阶段每个 chunk 也都带 `"reasoning_content":""`。判定条件必须是「非空字符串」，不能用 `!== undefined`，否则会开出一个空的 thinking block
2. **reasoning 与 content 严格分段**：先连续输出 7 个 reasoning 分片，再输出正文分片，两者不交错

### 2.4 难点三：流式时序——**Chat 侧不成立，Responses 侧仍存在**

原先担心思考内容整块滞后到达、导致 block 顺序失真。真实报文表明 **Chat 侧不存在这个问题**：

- `reasoning_content` 是**增量分片**（`"We"` / `" need respond"` / `" to user \""`…），天然可直接映射为 Anthropic 的 `thinking_delta`
- 且完整地出现在正文之前，block index 顺序天然正确

因此 Chat 侧的读回是一个直白的「开 thinking block → 逐片 delta → 收到首个非空 content 时关闭」状态机，成本远低于原估。

**Responses 侧问题依旧**：`reasoning` 整块出现在 `response.completed` 的 `output[]` 里（`summary[].text`），等到 completed 再补发会排在正文之后。两侧需分别设计，不能共用同一套逻辑。


## 三、方案比选

### 方案 A：完整双向转换（不推荐）

响应侧合成 thinking block，请求侧再把它转回 OpenAI 格式。

- 优点：Chat UI 能展示思考过程，多轮上下文也保留
- 致命问题：signature 缺失（§2.2）。合成的 block 回传到 Anthropic 内核网关会被拒；即便只回传给 OpenAI 侧，也要维护一套「哪些 block 是我们伪造的」状态机
- 判断：**投入产出比不成立，否决**

### 方案 B：只做响应侧读回，请求侧继续丢弃（推荐）

上游 reasoning → Anthropic `thinking` block（不带 signature，供展示）；请求侧遇到 thinking block 仍丢弃并记 warning。

- 优点：改动集中在两个响应转换器，风险可控；用户立刻能看到思考过程
- 代价：多轮对话中思考内容不进入上下文——但这本就是当前行为，不是回退
- 关键前提：**必须确认 Claude Code CLI 收到无 signature 的 thinking block 不会报错**。这是方案成立与否的唯一未验证假设，必须先做验证再动手

#### B-1 Chat 侧状态机（已可据真实报文定稿）

在 `OpenAIChatToAnthropicStreamConverter` 现有 block 状态之外，加一个 `thinkingBlockOpen` 标记：

| 触发 | 动作 |
| --- | --- |
| `delta.reasoning_content` 为**非空字符串**且 thinking block 未开 | 发 `content_block_start`（`{type:'thinking', thinking:''}`），占用当前 block index |
| `delta.reasoning_content` 为非空字符串且已开 | 发 `thinking_delta` |
| `delta.content` 首次为非空字符串 | 先关闭 thinking block（`content_block_stop`），再走原有的开正文 block 流程 |
| 流结束时 thinking block 仍开着 | 在收尾处一并 `content_block_stop` |

要点：判定一律用「非空字符串」，空串直接跳过（§2.3）；不发 `signature_delta`。正文 block 的 index 因此整体后移一位，这只在 `reasoningMode === 'passthrough'` 时发生，`off` 时逐字节不变。

#### B-2 Responses 侧

`response.completed` 才拿到 `reasoning.summary[].text`，此时正文早已发完。两种取舍：

- **补发在正文之后**：实现最简，但 UI 上思考显示在回答下方，语义错位
- **不做**：Responses 侧仅落地方案 C（计 `reasoning_tokens`）

倾向后者——除非上游另有 `response.reasoning_summary_text.delta` 之类的增量事件，需再抓一份 Responses 流式报文确认。

### 方案 C：只透传 token 计数，不碰内容

只把 `reasoning_tokens` 计入 usage，底部展示「思考 N」。

- 优点：几乎零风险，一天可完成
- 局限：看不到思考内容
- 定位：**方案 B 的兜底**。若 §B 的前提验证失败，退到这里

### 方案 D：请求侧补 reasoning 参数（与 B 正交，可单独做）

把 Anthropic 顶层 `thinking.budget_tokens` 映射为 OpenAI 的 `reasoning_effort`（Chat）/ `reasoning: {effort}`（Responses），让上游真的开启思考。

- 现状是静默丢弃（§1.1），用户在客户端调思考预算完全无效果
- 映射需定档：`budget_tokens` 是连续值，`effort` 是 `low/medium/high` 三档，需人为切分阈值
- 判断：**独立价值高、风险低，建议与 B 并行**

## 四、建议方案（B + D）与影响面

### 4.1 配置开关

复用 `cacheMode` 刚验证过的模式，新增模型级 `reasoningMode`：

| 取值 | 语义 |
| --- | --- |
| `off`（缺省） | 完全保持现状，输出逐字节不变 |
| `passthrough` | 响应侧把 reasoning 合成 thinking block；请求侧下发 reasoning 参数 |

同时**清理 `transformThink` 与 `preserveReasoningContent` 两个死字段**——要么接进新逻辑，要么删除。保留一个永远不生效的勾选框比没有更糟。

### 4.2 影响面清单

| 层 | 文件 | 改动性质 |
| --- | --- | --- |
| 数据 | `types.ts`、`configManager.ts`、`modelFetcher.ts` | 加字段 + 归一化，同 cacheMode |
| 请求 | `anthropicToOpenAIChat.ts`、`anthropicToOpenAIResponses.ts` | 顶层 thinking → reasoning 参数（方案 D） |
| 响应 | `openAIChatToAnthropic.ts` | 读 `delta.reasoning_content`（多字段名尝试）→ thinking block |
| 响应 | `openAIResponsesToAnthropic.ts:772` | `type:'reasoning'` 的 summary → thinking block |
| 代理 | `modelCacheMode.ts` 同目录 | 加 `resolveReasoningMode()`，与 `resolveModelCacheMode` 并列 |
| UI | `media/configView.js` | 模型弹窗加下拉 + 5 语言 i18n |

### 4.3 红线

与 cacheMode 完全一致：`reasoningMode !== 'passthrough'` 时，两个转换器的输出必须与改动前**逐字节相同**。所有新逻辑走加法式 `if` 分支，用现有 228 个测试兜底。

## 五、落地前必须先验证的三件事

方案 B 建立在假设之上，动手前需逐条验证，**任一失败则退到方案 C**：

1. **无 signature 的 thinking block 是否被 CLI 接受**——最关键，仍未验证。构造一段带 thinking block 但无 signature 的 Anthropic SSE，喂给 Chat CLI 观察是否报错
2. **多轮回传行为**——仍未验证。CLI 是否会把收到的 thinking block 原样带进下一轮请求？若会，且我们请求侧仍丢弃，需确认不会因缺 signature 触发上游 400
3. ~~**Chat 侧真实字段名**~~——**已解决**，2026-09-01 真实报文确认为 `delta.reasoning_content`，细节见 §2.3
4. **Responses 是否有增量 reasoning 事件**——新增项。决定 B-2 是「补发」还是「不做」，需抓一份 Responses 流式报文

## 六、工作量估算

| 项 | 前提 | 规模 |
| --- | --- | --- |
| 验证（§5.1 / §5.2） | — | 半天，且**不可跳过** |
| 方案 D（reasoning 参数） | 无 | 1 天，含测试 |
| 方案 B-1（Chat 侧读回） | §5.1 通过 | **1 天**（原估 2 天；报文确认为增量分片后，状态机成本大幅下降） |
| 方案 B-2（Responses 侧读回） | §5.4 结论 | 0.5～1 天，或直接放弃改走方案 C |
| 方案 C（仅 token 计数） | — | 半天，仅在 B 被否时启用 |
| 死字段清理 | — | 半天 |

## 七、待你确认

1. ~~Chat 侧真实报文~~——**已提供并入档**（§2.3、§2.4、§B-1）。Chat 侧不再有猜测成分
2. `transformThink` / `preserveReasoningContent` 两个死开关，倾向接进新 `reasoningMode` 还是直接删除？
3. 落地顺序：是否同意 **先 D（风险最低、当前完全缺失）→ 再验证 §5.1/§5.2 → 通过后做 B-1**？B-2 视 §5.4 再定
4. 能否再抓一份 **Responses 流式**报文（带思考的那种），用于判定 §5.4

## 八、打字机效果可行性——**结论：可以，且展示链路已现成**

### 8.1 已存在的渲染管线（逐处核对源码）

打字机效果不需要新写 UI。Chat 侧从 CLI 到 Webview 的思考渲染早就打通：

| 位置 | 现状 |
| --- | --- |
| `cliAdapter.ts:1026` | `content_block_delta` 已按 `delta.type` 分发，`thinking_delta` 有独立分支 |
| `cliAdapter.ts:1059` `handleThinkingDelta()` | 逐片累积到 block state，**每片立即产出 segments**，不等块结束 |
| `cliAdapter.ts:1295` `formatThinkingChunk()` | 给片段套 `> 💭 ` 引用前缀（`THINKING_SEGMENT_PREFIX`，:139） |
| `cliAdapter.ts:1320` `normalizeInlineThinkBlocks()` | 另有一条兜底：上游把思考写在正文里的 `<think>...</think>` 也会被转成同款引用块 |

也就是说，**只要转换器发得出 `thinking_delta`，打字机效果自动成立**——增量到达、增量渲染，与正文 `text_delta`（`handleTextDelta()`，:1042）走的是同一套 segments 流。§B-1 的工作量因此进一步收窄为「只改转换器」，UI 层零改动。

### 8.2 分片粒度：可以「补进同一块」，机制已现成

`formatThinkingChunk()` 给**每个** chunk 单独加前缀并补 `\n`。而 §2.3 的真实报文里 reasoning 分片极碎（`"We"` / `" need respond"` / `" to user \""`…，7 片）。

先说清渲染实况：Webview 侧 `appendSegment()`（`main.js:2690`）对文本 segment 走 `renderMarkdown()`，后者**每次都新建一个 `div.markdownRoot` 并 append**（:2480）。引用块合并只在**单次调用内部**的连续 `> ` 行之间发生（:2418-2434）。所以 7 个分片 = 7 次调用 = 7 个各自独立的 blockquote：

```
> 💭 We
> 💭  need respond
> 💭  to user "
```

不是一行逐字增长的句子。Anthropic 原生 `thinking_delta` 分片较大，所以现有实现没暴露这个问题。

**但「补进同一块」不需要新机制**——`patchMessage()`（`main.js:4640`）已经支持按稳定 id 原地替换：

- `main.js:4668`：segment 带 `id` 且 DOM 里已有同 `data-segment-id` 节点时，重建后 `replaceChild` 原地换掉，而不是追加
- `main.js:3069-3075`：本地缓存同样按 `id` 去重合并，历史回放不会留下 N 个残片
- `protocol.ts:16`：`ChatSegment.id` 本就是为「流式过程中反复更新同一 segment」设计的，工具卡片和 usage 页脚都在用

于是 Chat 侧只需：

| 改动点 | 内容 |
| --- | --- |
| `cliAdapter.ts:1059` `handleThinkingDelta()` | 已有 `block.text += text` 累积。改为产出**整块累积文本**、并带稳定 id（如 `thinking:<blockIndex>`） |
| `cliAdapter.ts:1295` `formatThinkingChunk()` | 改成对整块文本做一次前缀化（多行则每行都加 `> `），而不是对单片 |
| `main.js:2724` `appendSegment()` 文本分支 | `renderMarkdown()` 返回的 wrapper 上补一句 `wrapper.dataset.segmentId = segment.id`——目前只有 task/tool/usage 设了这个属性（:2744、:2860、:3428），文本段没设，不设就命中不了原地替换 |

效果就是**真正的打字机**：一个引用块，文字逐字增长，无顿挫、无聚合延迟，也不必攒标点。

代价与边界：

- 每片重渲整块文本。思考文本通常几百字，`replaceChild` 一次的成本可忽略
- 超过 `LONG_TEXT_LIMIT`（12000 字符）或 220 行会被 `isLongOutput()`（:4182）转成折叠块——极长思考会中途从引用块变折叠卡片，需实测观感
- `main.js` 那一句是**加法式改动**：只在 `segment.id` 存在时才设属性，现有文本段不带 id，行为逐字节不变

对比原先设想的「转换器侧攒到标点再发」：那是在规避渲染限制，本质是把打字机降级成「打词机」。既然原地替换现成，**直接做整块补写更优**，且转换器侧可以老老实实逐片发 `thinking_delta`，与 Anthropic 协议语义一致。

### 8.3 顺带确认：§5.2 多轮回传其实已有防护

`anthropicProxy.ts:166` 的 `sanitizeReplayedThinkingBlocks()` 会在请求回放时剥离历史里的 thinking 块，只保留「最后一个活跃 tool_use 轮」且签名形如真实 Anthropic 签名的块（`isLikelyAnthropicSignature()`，:218，要求 ≥64 字符且非 UUID）。

我们合成的无 signature 块**必然被这道清理拦下**，不会带进下一轮请求。因此 §5.2 从「未验证风险」降级为「已有防护，验证时确认即可」。

**§5.1 仍是硬门禁**：这里说的是 CLI 之前的一段——relay 产出的 SSE 要先被 `claude` 二进制接受。它是否容忍缺 `signature` 的 thinking block，源码里看不到，只能实测。

### 8.4 修订后的路径

| 阶段 | 内容 | 规模 |
| --- | --- | --- |
| 1 | 验证 §5.1（CLI 是否接受无签名 thinking block） | 半天，不可跳过 |
| 2 | 方案 D：请求侧 reasoning 参数 | 1 天 |
| 3 | 方案 B-1：Chat 侧读回（转换器逐片发 `thinking_delta`） | 半天 |
| 4 | 打字机整块补写（`handleThinkingDelta` 带 id + `appendSegment` 设 `data-segment-id`） | 半天 |
| 5 | B-2 / 死字段清理 | 待 §5.4 报文与你的决定 |

注意阶段 3 与 4 可以拆开验收：先只做 3，效果是「多个引用块」但内容完整可用；再做 4 升级为单块打字机。这样即便 4 的观感需要调，也不会阻塞 3 的落地。




