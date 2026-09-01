# 思考模式（thinking / reasoning）跨协议转换评估

- 日期：2026-09-01（含当日真实报文修订）
- 结论先行：**当前思考内容在三条链路上全部丢弃，两个相关配置开关是死的**；建议按 `reasoningMode` 模型级开关分两期落地，一期只做「响应侧读回」，二期再做「请求侧回传」。
- 本次修订：Chat 侧字段名与流式时序**已由真实报文定案**（`delta.reasoning_content`，增量分片且先于正文），Chat 侧读回成本由 2 天下调至 1 天；剩余未验证项收敛为「CLI 是否接受无 signature 的 thinking block」与「Responses 是否有增量 reasoning 事件」两条。
- 本文只做评估与方案比选，不含落地步骤。

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



