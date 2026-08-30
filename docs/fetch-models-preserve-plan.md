# 重新拉取模型不覆盖已有模型配置 —— 方案

## 一、问题现象

在设置页点击「拉取模型」后，该提供商下**已经手工调过的模型参数被重置回默认值**：
显示名回到 modelId、上下文长度/最大输出 token 归 0、temperature/topP 回到 1、
`vision`/`transformThink`/`preserveReasoningContent` 回到 false、`isUserSelectable` 回到 true。
若上游本次没有返回某个模型，该模型还会**直接从列表消失**。

## 二、根因定位（具体到文件与方法）

调用链：

1. `media/configView.js:1393` `fetchProviderModels(providerId)`
   → `post('fetchProviderModels', { providerId })`。
2. `src/views/configView.ts:242` 消息分发 → `src/views/configView.ts:301`
   `ConfigViewProvider.fetchProviderModels(providerId)`。
3. `src/modelFetcher.ts:182` `fetchModels(input)` 拉到上游列表，内部
   `src/modelFetcher.ts:122` `parseModels(json)` 对每个 id 调用
   `src/modelFetcher.ts:160` `createDefaultModelConfig(modelId, label)`
   —— **这里为每个模型生成的是全默认值**（contextLength=0、maxTokens=0、
   temperature=1、topP=1、vision=false…）。
4. `src/views/configView.ts:316` 把这批默认值交给
   `src/configManager.ts:296` `ConfigManager.replaceProviderModels(providerId, models)`。

根因在 `src/configManager.ts:296` `replaceProviderModels`：

```ts
const previousById = new Map(provider.models.map((m) => [m.modelId, m]));
provider.models = models.map((model) => {
    const previous = previousById.get(model.modelId);
    return this.normalizeModel({ ...model, enabled: previous?.enabled ?? model.enabled });
});
```

它**只保留了 `enabled` 一个字段**，其余字段一律用新拉取的默认值覆盖；
并且 `provider.models` 被整体替换，旧列表中上游未返回的模型被丢弃。

## 三、修改方案

### 3.1 `src/configManager.ts` —— `replaceProviderModels`（约 :296）

改为「以旧配置为基底，用新拉取结果做增量合并」：

- **已存在的 modelId**：完整保留旧的 `ModelConfig`，只允许补齐旧值缺省的项
  （即旧 `displayName` 等于 modelId 时才采用上游 `display_name`）。
  其余字段（contextLength / maxTokens / vision / toolCalling / temperature /
  topP / samplingMode / isUserSelectable / enabled / transformThink /
  preserveReasoningContent）一律沿用旧值。
- **新出现的 modelId**：按新拉取的默认值追加。
- **上游本次未返回、但旧列表里有的 modelId**：**保留**，不再删除，避免上游临时
  抖动或分页导致用户手工添加的模型丢失。
- 排序：先保持旧列表原有顺序，新增模型按 id 升序追加到末尾。

新增一个私有方法承担单条合并逻辑：

- `src/configManager.ts` 新增 `private mergeFetchedModel(previous: ModelConfig | undefined, fetched: ModelConfig): ModelConfig`
  —— previous 为空时返回 `normalizeModel(fetched)`；否则返回
  `normalizeModel({ ...previous, displayName: 择优 })`。

`normalizeModel`（`src/configManager.ts:519`）**不改**，仍作为最后一道补齐。

### 3.2 `src/views/configView.ts` —— `fetchProviderModels`（:301）

- 让 `replaceProviderModels` 返回一个统计对象 `{ added: number; kept: number; total: number }`，
  toast 文案由「已拉取 N 个模型」改为「已拉取 N 个模型：新增 A，保留原有配置 K」，
  让用户明确知道旧配置没被覆盖。

### 3.3 `src/modelFetcher.ts`

不改。`createDefaultModelConfig`（:160）继续只负责「新模型」的默认值，
合并语义收敛在 ConfigManager 一处。

## 四、测试

在现有测试目录新增/补充 `replaceProviderModels` 用例，覆盖：

1. 已有模型手工设置过 `maxTokens=8000`、`displayName='我的模型'`，
   重新拉取后这两个值不变。
2. 上游新返回的模型被追加，且字段为默认值。
3. 上游未返回的旧模型仍然保留。
4. 返回的统计对象数值正确。

## 五、影响面

- 仅影响设置页「拉取模型」按钮的落库行为；
- 不涉及 CLI 注入、Chat 模型选择、导入导出；
- 行为变化对用户是「更安全」的方向（不再丢配置），无需迁移旧数据。
