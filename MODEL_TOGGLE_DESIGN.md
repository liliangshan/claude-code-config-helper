# 模型级开关控制方案设计（修订版）

## 1. 需求与目标

### 1.1 背景

当前项目已经有 provider 级启用/禁用机制：

- 数据结构：`src/types.ts` 中 `ProviderConfigWithoutSecrets.enabled`
- 规范化默认值：`src/configManager.ts` 中 `ConfigManager.normalizeProvider()`，`enabled: provider.enabled !== false`
- 设置页开关 UI：`media/configView.js` 中 `renderProvider()` / `toggleProvider()`
- Chat 模型选择过滤：`src/extension.ts` 中 `postChatModelOptions()`、`postChatExpertModelOptions()`、`postChatPlanModelOptions()`、`postChatReviewModelOptions()`、`postModelsSnapshot()` 均已跳过 `!provider.enabled`

但当前模型层面只有 `ModelConfig.isUserSelectable`，语义是"是否出现在模型下拉框中"，不是完整的启用/禁用开关。需要增加模型级开关，并保证 Chat 弹窗只展示启用模型。

同时需要修复 bug：禁用 provider 后，模型拉取入口仍可能对该 provider 调用 `fetchModels()`。当前仓库中已确认唯一显式模型拉取入口是：

- `src/views/configView.ts` 的 `ConfigWebviewController.fetchProviderModels(providerId)`
- 前端触发点为 `media/configView.js` 的 `fetchProviderModels(providerId)`，发送 `{ type: 'fetchProviderModels', payload: { providerId } }`
- 实际网络请求在 `src/modelFetcher.ts` 的 `fetchModels(input)`

### 1.2 本次目标

1. 为每个模型添加启用/禁用开关，行为类似现有 provider 开关，并持久化保存。
2. Chat 模型选择弹窗只展示已启用 provider 下、已启用且可选择的模型。
3. 设置页模型列表展示模型开关，并支持即时保存。
4. 修复禁用 provider 仍触发模型列表 fetch 的问题：在 `fetchModels()` 调用前做 provider enabled guard。
5. 保持旧配置兼容：老用户的模型默认启用。

### 1.3 非目标

- 不改第三方模型列表 API 协议。
- 不引入新的独立存储文件。
- 不改变 provider 级开关已有语义。
- 不把 `isUserSelectable` 删除或重命名；本次新增 `enabled`，两者语义并存。

---

## 2. 技术选型

### 2.1 存储方式

选择直接扩展现有 `ModelConfig`，新增字段：

```typescript
interface ModelConfig {
    modelId: string;
    displayName: string;
    contextLength: number;
    maxTokens: number;
    vision: boolean;
    toolCalling: boolean;
    temperature: number;
    topP: number;
    samplingMode: SamplingMode;
    isUserSelectable?: boolean;
    enabled?: boolean;  // 新增
    transformThink?: boolean;
    preserveReasoningContent?: boolean;
}
```

理由：

- 当前 provider 与 model 都通过 `ProviderConfigWithoutSecrets.models` 持久化在 `PROVIDERS_STATE_KEY = 'claudeRouter.providers'` 下。
- 设置页保存 provider/model 已经走 `saveProviders` / `replaceProviders()` / `normalizeModel()`，直接扩展 `ModelConfig` 改动最小。
- 不需要新增 `modelToggleMap` 并维护 `<provider>:<modelId>` 二级映射。
- 模型来自拉取结果时可以在 `replaceProviderModels()` 中保留旧模型的 `enabled` 状态，避免刷新列表后开关丢失。

### 2.2 默认规则

- `provider.enabled !== false` 视为启用，沿用现状。
- `model.enabled !== false` 视为启用，新增逻辑。
- `model.isUserSelectable !== false` 继续表示是否展示在 Chat 可选模型中。
- Chat 弹窗可见条件统一为：

```
provider.enabled !== false
&& model.enabled !== false
&& model.isUserSelectable !== false
```

### 2.3 UI 策略

设置页模型列表中增加与 provider 风格一致的 switch：

- provider switch 当前由 `media/configView.js` 的 `renderSwitch()` 渲染。
- 模型列表当前由 `renderModels(provider)` 渲染表格。
- 新增每行模型开关，复用 `renderSwitch('js-model-enabled', model.enabled !== false, t('enableModel'))`。

Chat 模型选择弹窗不直接显示开关，只消费后端过滤后的 `models/snapshot`。

### 2.4 协议策略

设置页无需新增独立 message。模型开关作为 `ModelConfig.enabled` 字段随既有协议流转：

- 前端保存：`{ type: 'saveProviders', payload: providers }`
- 后端接收：`src/views/configView.ts` 的 `case 'saveProviders'`
- 后端保存：`ConfigManager.replaceProviders()`

Chat 页协议保持 `models/snapshot` 和 `models/applyPair`，但 `models/snapshot` 的列表需要由后端过滤模型启用状态。

---

## 3. 实际涉及文件与数据结构变更

### 3.1 `src/types.ts`

修改 `ModelConfig`，新增字段：

```typescript
/** 是否启用该模型。禁用后不出现在 Chat 模型选择弹窗，也不可作为新选择。 */
enabled?: boolean;
```

`ProviderConfigWithoutSecrets` 不需要新增字段，已有：

```typescript
enabled: boolean;
autoFetchModels: boolean;
models: ModelConfig[];
```

### 3.2 `src/configManager.ts`

修改点：

1. `ConfigManager.normalizeModel(model)` 增加：

```typescript
enabled: model.enabled !== false,
```

2. `ConfigManager.replaceProviderModels(providerId, models)` 需要保留已有模型的开关状态。

当前逻辑：

```typescript
provider.models = models.map((model) => this.normalizeModel(model));
```

建议改为：

```typescript
const previousById = new Map(provider.models.map((model) => [model.modelId, model]));
provider.models = models.map((model) => {
    const previous = previousById.get(model.modelId);
    return this.normalizeModel({
        ...model,
        enabled: previous?.enabled ?? model.enabled
    });
});
```

这样手动 fetch 刷新模型列表时，不会把用户禁用过的模型重置为启用。

3. 可新增辅助方法，降低 `src/extension.ts` 多处重复判断：

```typescript
public isModelEnabled(providerId: string, modelId: string): boolean {
    const provider = this.getProvider(providerId);
    const model = provider?.models.find((item) => item.modelId === modelId);
    return !!provider && provider.enabled !== false && !!model && model.enabled !== false;
}
```

### 3.3 `src/views/configView.ts`

修改 `ConfigWebviewController.fetchProviderModels(providerId)`，在调用 `fetchModels()` 前加入精确 guard。

当前位置：

```typescript
private async fetchProviderModels(providerId: string): Promise<void> {
    const provider = await this.manager.getProviderWithSecret(providerId);
    if (!provider) throw new Error('提供商不存在');
    const result = await fetchModels({
        baseUrl: provider.baseUrl,
        apiType: provider.apiType,
        authMode: provider.authMode,
        token: provider.authMode === 'auth_token' ? provider.apiKey : undefined,
        apiKey: provider.authMode === 'api_key' ? provider.apiKey : undefined,
        customHeaders: provider.customHeaders
    });
    await this.manager.replaceProviderModels(providerId, result.models);
    this.postToast('success', `已拉取 ${result.models.length} 个模型`);
}
```

建议改为：

```typescript
private async fetchProviderModels(providerId: string): Promise<void> {
    const provider = await this.manager.getProviderWithSecret(providerId);
    if (!provider) throw new Error('提供商不存在');
    if (provider.enabled === false) {
        this.postToast('warn', '提供商已禁用，已跳过模型拉取');
        return;
    }
    const result = await fetchModels({
        baseUrl: provider.baseUrl,
        apiType: provider.apiType,
        authMode: provider.authMode,
        token: provider.authMode === 'auth_token' ? provider.apiKey : undefined,
        apiKey: provider.authMode === 'api_key' ? provider.apiKey : undefined,
        customHeaders: provider.customHeaders
    });
    await this.manager.replaceProviderModels(providerId, result.models);
    this.postToast('success', `已拉取 ${result.models.length} 个模型`);
}
```

这是当前仓库中最明确的 fetch guard 插入点：`getProviderWithSecret()` 之后、`fetchModels()` 之前。

如果后续发现/新增启动自动拉取逻辑，应复用同一规则：任何调用 `fetchModels()` 前都必须先判断 `provider.enabled !== false`。

### 3.4 `media/configView.js`

#### 3.4.1 设置页模型表格增加开关

当前 `renderModels(provider)` 的表头：

```html
<thead><tr><th>${t('displayName')}</th><th>${t('operation')}</th></tr></thead>
```

建议改为：

```html
<thead><tr><th>${t('displayName')}</th><th>${t('enabled')}</th><th>${t('operation')}</th></tr></thead>
```

当前模型行：

```html
<tr data-model-id="${text(model.modelId)}">
    <td>${text(model.displayName || model.modelId)}</td>
    <td class="row-actions">
        <button class="secondary js-edit-model">${t('edit')}</button>
        <button class="danger js-delete-model">${t('delete')}</button>
    </td>
</tr>
```

建议改为：

```html
<tr data-model-id="${text(model.modelId)}">
    <td>${text(model.displayName || model.modelId)}</td>
    <td>${renderSwitch('js-model-enabled', model.enabled !== false, t('enableModel'))}</td>
    <td class="row-actions">
        <button class="secondary js-edit-model">${t('edit')}</button>
        <button class="danger js-delete-model">${t('delete')}</button>
    </td>
</tr>
```

#### 3.4.2 绑定模型开关事件

当前 `bindEvents()` 中模型行只绑定 edit/delete：

```javascript
row.querySelector('.js-edit-model')?.addEventListener('click', () => openModelModal(providerId, findModel(providerId, modelId)));
row.querySelector('.js-delete-model')?.addEventListener('click', () => deleteModel(providerId, modelId));
```

新增：

```javascript
row.querySelector('.js-model-enabled')?.addEventListener('change', () => toggleModel(providerId, modelId));
```

新增函数：

```javascript
function toggleModel(providerId, modelId) {
    const providers = clone(state.providers);
    const provider = providers.find((item) => item.id === providerId);
    const model = provider?.models?.find((item) => item.modelId === modelId);
    if (model) model.enabled = model.enabled === false;
    post('saveProviders', providers);
}
```

#### 3.4.3 模型编辑弹窗支持 enabled

当前 `renderModelModal()` 已有 `model-user-selectable`：

```html
<div class="checkbox-row"><input id="model-user-selectable" type="checkbox" ... /><label ...>${t('showInModelDropdown')}</label></div>
```

建议在其前后新增：

```html
<div class="checkbox-row"><input id="model-enabled" type="checkbox" ${model.enabled !== false ? 'checked' : ''} /><label for="model-enabled">${t('enabled')}</label></div>
```

当前 `saveModelFromModal()` 保存字段：

```javascript
model.isUserSelectable = document.getElementById('model-user-selectable').checked;
```

新增：

```javascript
model.enabled = document.getElementById('model-enabled').checked;
```

`createDefaultModel(modelId)` 新增：

```javascript
enabled: true,
```

### 3.5 `src/extension.ts`

Chat 模型选择弹窗实际数据源为 `postModelsSnapshot()`。

当前过滤：

```typescript
for (const provider of configManager.listProviders()) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
        if (model.isUserSelectable === false) continue;
        ...
    }
}
```

修改为：

```typescript
for (const provider of configManager.listProviders()) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
        if (model.enabled === false) continue;
        if (model.isUserSelectable === false) continue;
        ...
    }
}
```

同样修改以下函数：

- `postChatModelOptions()`
- `postChatExpertModelOptions()`
- `postChatPlanModelOptions()`
- `postChatReviewModelOptions()`
- `postModelsSnapshot()`

选择校验也要禁止选择禁用模型：

- `selectChatModel(providerId, modelId)`
- `handleModelsApplyPair(normal, expert, plan, review)`

推荐新增本地 helper：

```typescript
function findSelectableChatModel(providerId: string, modelId: string): { provider: ProviderConfigWithoutSecrets; model: ModelConfig } | null {
    if (!configManager) return null;
    const provider = configManager.getProvider(providerId);
    const model = provider?.models.find((item) => item.modelId === modelId);
    if (!provider || !model) return null;
    if (provider.enabled === false) return null;
    if (model.enabled === false) return null;
    if (model.isUserSelectable === false) return null;
    return { provider, model };
}
```

### 3.6 `src/chat/protocol.ts`

现有 Chat 协议消息类型：

- 扩展到 Webview：`model/options`、`expert/model/options`、`plan/model/options`、`review/model/options`、`models/snapshot`
- Webview 到扩展：`model/select`、`expert/model/select`、`plan/model/select`、`review/model/select`、`models/applyPair`

本次不需新增消息类型，但需明确 `models/snapshot` 中 `normalModels`、`expertModels`、`planModels`、`reviewModels` 均只包含满足以下条件的模型：

```
provider.enabled !== false && model.enabled !== false && model.isUserSelectable !== false
```

### 3.7 `media/chat/main.js` 和 `media/chat/index.html`

Chat 弹窗 HTML 已存在：

- `[data-role="model-picker"]`
- `[data-role="model-picker-normal-select"]`
- `[data-role="model-picker-expert-select"]`
- `[data-role="model-picker-plan-select"]`
- `[data-role="model-picker-review-select"]`

前端渲染函数已存在：

- `renderModelPickerNormalList()`
- `renderModelPickerExpertList()`
- `renderModelPickerPlanList()`
- `renderModelPickerReviewList()`
- `openModelPicker()`
- `submitModelPicker()`

这些函数只消费 `composerState.*ModelOptions`，无需自行判断 `enabled`。模型过滤应在后端 `postModelsSnapshot()` 完成。

### 3.8 `package.nls*.json`

如设置页新增 `enableModel` 文案，需在以下文件补充：

- `package.nls.json`
- `package.nls.zh-cn.json`

如果 `media/configView.js` 的 i18n 是内联对象，也需要在对应 translation object 中补充 `enableModel`。

---

## 4. 精确前后端协议变更

### 4.1 设置页：模型开关更新

不新增 message，复用既有协议。

**Webview -> Extension：**

```json
{
    "type": "saveProviders",
    "payload": "<ProviderConfigWithoutSecrets[]>"
}
```

其中模型包含新增字段 `enabled: boolean`。

**Extension 处理链：**
`src/views/configView.ts` → `handleMessage('saveProviders')` → `ConfigManager.replaceProviders()` → `normalizeModel()` 填充 `enabled` 默认值 → `manager.onDidChange()` → `postState()`

**Extension -> Webview：**

```json
{
    "type": "state",
    "payload": { "providers": "<...>", "..." : "..." }
}
```

其中 `payload.providers[].models[].enabled` 用于设置页重新渲染 switch 状态。

### 4.2 Chat 页：刷新模型弹窗列表

不新增 message，修改 `models/snapshot` 语义为"已过滤启用模型"。

**Extension -> Webview：**

```json
{
    "type": "models/snapshot",
    "normalModels": "<ChatModelOption[]>",
    "expertModels": "<ChatModelOption[]>",
    "planModels": "<ChatModelOption[]>",
    "reviewModels": "<ChatModelOption[]>",
    "currentNormal": "<{ providerId, modelId } | null>",
    "currentExpert": "<ChatExpertModelSelection>",
    "currentPlan": "<ChatRoutedModelSelection>",
    "currentReview": "<ChatRoutedModelSelection>"
}
```

字段语义补充：
- 四个 model 数组只包含启用 provider 下启用且可选的模型。
- 若当前已选模型后来被禁用，列表中不再包含该模型，下一次提交必须禁止继续提交禁用模型。

**Webview -> Extension：**

```json
{
    "type": "models/applyPair",
    "normal": "<{ providerId, modelId } | null>",
    "expert": "<{ providerId, modelId } | null>",
    "plan": "<{ providerId, modelId } | null>",
    "review": "<{ providerId, modelId } | null>"
}
```

后端 `handleModelsApplyPair()` 必须重新校验三个条件，避免旧前端或手工 postMessage 选择禁用模型。

---

## 5. 启动 fetch guard 精确方案

### 5.1 当前已确认拉取入口

模型 fetch 的实际调用链：

```
media/configView.js
  fetchProviderModels(providerId)
    -> post('fetchProviderModels', { providerId })

src/views/configView.ts
  ConfigWebviewController.handleMessage()
    case 'fetchProviderModels'
      -> this.fetchProviderModels(message.payload.providerId)

src/views/configView.ts
  ConfigWebviewController.fetchProviderModels(providerId)
    -> fetchModels(...)

src/modelFetcher.ts
  fetchModels(input)
    -> GET {baseUrl}/models
```

**精确 guard 插入点：** `src/views/configView.ts` 的 `ConfigWebviewController.fetchProviderModels(providerId)`，在 `getProviderWithSecret(providerId)` 之后、`fetchModels()` 之前。

### 5.2 启动自动拉取的处理要求

当前代码中 `autoFetchModels` 字段存在于：

- `src/types.ts` 的 `ProviderConfigWithoutSecrets.autoFetchModels`
- `src/configManager.ts` 的 `normalizeProvider()`
- `media/configView.js` 的 provider 表单和按钮逻辑

若实际存在或后续新增启动自动拉取逻辑，应统一遵守：

```typescript
for (const provider of configManager.listProviders()) {
    if (provider.enabled === false) continue;
    if (provider.autoFetchModels === false) continue;
    await fetchProviderModels(provider.id);
}
```

### 5.3 回归测试断言

目标：禁用 provider 时不触发网络 fetch。

```typescript
// mock fetchModels
// 构造 disabled provider
const disabledProvider = {
    id: 'disabled-provider',
    enabled: false,
    autoFetchModels: true,
    baseUrl: 'https://example.test',
    apiType: 'openai-compatible',
    authMode: 'api_key',
    apiKey: 'secret',
    customHeaders: [],
    models: [],
};

// 触发
await controller.handleMessage({
    type: 'fetchProviderModels',
    payload: { providerId: 'disabled-provider' }
});

// 断言
expect(fetchModels).not.toHaveBeenCalled();
expect(manager.replaceProviderModels).not.toHaveBeenCalled();
```

---

## 6. 代码实现步骤

### Step 1：扩展模型数据结构

- `src/types.ts`：`ModelConfig` 新增 `enabled?: boolean`
- `src/configManager.ts`：`normalizeModel()` 补 `enabled: model.enabled !== false`；`replaceProviderModels()` 保留旧模型 enabled；可选新增 `isModelEnabled()` helper

### Step 2：设置页增加模型开关

- `media/configView.js`：
  - `renderModels(provider)` 增加模型 enabled switch
  - `bindEvents()` 给 `.js-model-enabled` 绑定 `toggleModel(providerId, modelId)`
  - `renderModelModal()` 增加 `model-enabled` checkbox
  - `saveModelFromModal()` 保存 `model.enabled`
  - `createDefaultModel()` 默认 `enabled: true`
  - i18n 增加 `enableModel` 文案

### Step 3：后端过滤 Chat 模型列表

- `src/extension.ts`：在 `postChatModelOptions()`、`postChatExpertModelOptions()`、`postChatPlanModelOptions()`、`postChatReviewModelOptions()`、`postModelsSnapshot()` 中统一加入 `if (model.enabled === false) continue;`
- 推荐抽 helper：`isSelectableModel(provider, model)`

### Step 4：后端阻止禁用模型被提交选择

- `src/extension.ts`：`selectChatModel()` 和 `handleModelsApplyPair()` 增加 enabled + selectable 校验

### Step 5：修复禁用 provider fetch bug

- `src/views/configView.ts`：在 `fetchProviderModels()` 中 `fetchModels()` 调用前加入 `provider.enabled === false` guard

### Step 6：协议文档与类型注释更新

- `src/chat/protocol.ts`：在 `models/snapshot` 注释中说明列表已过滤禁用 provider/model

---

## 7. 前后端交互流程

### 7.1 设置页切换模型开关

```
User toggles model switch
  -> toggleModel(providerId, modelId)
  -> mutate providers[].models[].enabled
  -> post('saveProviders', providers)

src/views/configView.ts
  -> handleMessage('saveProviders')
  -> ConfigManager.replaceProviders()
  -> normalizeModel() fills enabled default
  -> postState()

media/configView.js
  -> receives state → rerender provider/model table
```

### 7.2 Chat 打开模型选择弹窗

```
Extension calls postModelsSnapshot()
  -> listProviders() → skip disabled providers
  -> skip model.enabled === false
  -> skip model.isUserSelectable === false
  -> postMessage({ type: 'models/snapshot', ...filteredModels })

media/chat/main.js
  -> update composerState.*ModelOptions
  -> openModelPicker() → render picker lists
  -> user only sees enabled models
```

### 7.3 Chat 提交模型选择

```
media/chat/main.js
  -> submitModelPicker()
  -> post({ type: 'models/applyPair', normal, expert, plan, review })

src/extension.ts
  -> handleModelsApplyPair()
  -> validate selected model still enabled + selectable
  -> save selections → postModelsSnapshot() → restartChatCliPair()
```

### 7.4 禁用 provider 后拉取模型

```
media/configView.js
  -> post('fetchProviderModels', { providerId })

src/views/configView.ts
  -> fetchProviderModels(providerId)
  -> if provider.enabled === false: toast('已跳过模型拉取') + return
  -> otherwise fetchModels()
```

---

## 8. 验证与测试策略

### 8.1 单元测试

**ConfigManager normalize：**
- 旧模型无 `enabled` 字段时，`normalizeModel()` 输出 `enabled: true`
- 模型显式 `enabled: false` 时保持 false
- `replaceProviderModels()` 刷新同名模型时保留原 `enabled: false`

**Chat 模型过滤（真值表）：**

| provider.enabled | model.enabled | model.isUserSelectable | 出现在 snapshot |
|---|---|---|---|
| true | true | true | 是 |
| false | true | true | 否 |
| true | false | true | 否 |
| true | true | false | 否 |

**选择校验：**
- `selectChatModel()` 选择 disabled model 抛错
- `handleModelsApplyPair()` 提交 disabled model 抛错或忽略并提示

### 8.2 fetch guard 回归测试

禁用 provider 时不触发 `fetchModels()` 调用，断言：

```typescript
expect(fetchModels).not.toHaveBeenCalled();
expect(manager.replaceProviderModels).not.toHaveBeenCalled();
```

### 8.3 前端手工验证

1. 设置页禁用单个模型 → Chat 弹窗中该模型不可见
2. 重新启用模型 → Chat 弹窗恢复可见
3. 禁用 provider 后点击"拉取模型" → 提示"已跳过模型拉取"，无网络请求
4. 拉取模型列表刷新后 → 被禁用的同名模型仍保持禁用状态

---

## 9. 风险与权衡

### 9.1 `enabled` 与 `isUserSelectable` 语义重叠

- `enabled=false`：模型整体禁用，不可作为新选择
- `isUserSelectable=false`：模型仍可保留为配置项，但不出现在 Chat 选择弹窗
- Chat 可见必须同时满足两者

### 9.2 刷新模型列表覆盖本地开关

`fetchModels()` 返回的新模型没有 `enabled` 字段，通过 `replaceProviderModels()` 按 `modelId` 合并旧模型的 `enabled` 解决，新增模型默认启用。

### 9.3 当前已选模型被禁用

最小实现：禁止后续在弹窗中选择该模型。更严格实现：保存 providers 时检测并清空。本次至少实现后端提交校验。

### 9.4 启动自动 fetch 路径不明显

当前仓库未发现除 `ConfigWebviewController.fetchProviderModels()` 外的 `fetchModels()` 调用。若用户反馈的"启动时 fetch"来自隐藏路径，需全局搜索 `fetchModels(` 并加 guard。

---

## 10. 完成判定

1. `ModelConfig` 支持 `enabled` 字段，旧配置默认启用
2. 设置页模型列表和编辑弹窗可切换模型启用状态
3. Chat 模型选择弹窗只展示启用 provider 下启用且可选的模型
4. 后端拒绝选择禁用模型
5. `ConfigWebviewController.fetchProviderModels()` 在 `fetchModels()` 前检查 `provider.enabled === false` 并跳过
6. 测试覆盖：默认值、列表过滤、选择校验、fetch guard 回归
