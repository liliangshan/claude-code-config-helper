# LLS CCAI 多语言（i18n）独立方案

本文档用于规划 **LLS CCAI** 设置页的多语言能力。用户已明确要求：**不用共享，采用全新的**。因此本方案不再复用 LLS OAI 的 `openapicopilot.language`，而是为 LLS CCAI 新增独立语言配置。

> 文档版本：v2  
> 日期：2026-05-21  
> 状态：独立配置方案（待实施）  
> 约束：本文档只规划方案，不修改应用代码。

---

## 1. 结论

LLS CCAI 使用自己的语言配置项：

```jsonc
"claudeCodeConfigHelper.language": "auto"
```

不再读写：

```jsonc
"openapicopilot.language"
```

这样可以保证：

- LLS CCAI 与 LLS OAI 的语言设置互不影响。
- VS Code Settings UI 中不会因为两个扩展都贡献同一个 `openapicopilot.language` 而出现重复描述。
- LLS CCAI 后续可独立演进语言、文案、默认行为和翻译范围。

---

## 2. 背景

当前 LLS CCAI 已经具备 `package.nls.json` / `package.nls.zh-cn.json`，可覆盖 VS Code manifest 层面的文案，例如：

- 扩展显示名；
- 扩展描述；
- 命令标题；
- Activity Bar 容器标题；
- Webview 视图标题；
- 配置项描述。

但设置页 Webview 内部仍是硬编码文案，主要集中在：

- `media/configView.js`
  - 页面标题；
  - 页面副标题；
  - toolbar 按钮；
  - Claude Code Relay 设置卡片；
  - Provider 管理卡片；
  - 表单 label / placeholder；
  - toast 文案；
  - confirm 文案。
- `src/views/configView.ts`
  - Webview 后端 toast；
  - relay 状态文本；
  - 拉取模型、导入导出等提示。
- `src/views/sharedSettingsView.ts`
  - 共享提示词 / 任务流设置面板的 HTML 文案；
  - 保存成功 / 错误提示。

因此需要新增 Webview 运行时 i18n 能力。

---

## 3. 与参考扩展 LLS OAI 的关系

参考扩展 `liliangshan.openapi-compatible-copilot` 的多语言机制可以借鉴，但不共享配置。

### 3.1 借鉴内容

可以借鉴：

- 支持语言集合；
- `auto` 根据 `vscode.env.language` 解析实际语言；
- Webview 前端使用 `translations` 字典；
- `t(key)` 缺失回落英文；
- `applyI18n()` 扫描 `data-i18n*` 属性；
- Webview 与扩展宿主通过消息同步语言状态；
- 监听配置变化后刷新 Webview。

### 3.2 不借鉴内容

不再使用：

- `openapicopilot.language`；
- `getConfiguredLanguage()` / `getResolvedLanguage()` 这组面向 LLS OAI 命名的方法；
- `updateLanguageSettings` 这类与参考扩展完全同名的消息协议。

LLS CCAI 使用自己的命名：

- 配置项：`claudeCodeConfigHelper.language`；
- 方法：`getConfiguredUiLanguage()` / `getResolvedUiLanguage()` / `updateUiLanguage()`；
- 前端消息：`updateUiLanguage`。

---

## 4. 配置项设计

### 4.1 package.json 新增配置

在 `package.json` 的 `contributes.configuration.properties` 中新增：

```jsonc
"claudeCodeConfigHelper.language": {
  "type": "string",
  "enum": [
    "auto",
    "en",
    "zh-cn",
    "zh-tw",
    "ko",
    "ja",
    "fr",
    "de"
  ],
  "default": "auto",
  "description": "%configuration.language.description%",
  "scope": "application"
}
```

### 4.2 nls 描述

`package.nls.json`：

```jsonc
"configuration.language.description": "Display language for the LLS CCAI settings UI. Auto follows the VS Code display language."
```

`package.nls.zh-cn.json`：

```jsonc
"configuration.language.description": "LLS CCAI 设置界面的显示语言。Auto 会跟随 VS Code 显示语言。"
```

### 4.3 作用域

推荐使用：

```jsonc
"scope": "application"
```

理由：

- UI 语言属于用户偏好，不应随工作区变化；
- 与 VS Code 的显示语言偏好语义一致；
- 用户在一个工作区切换语言后，所有工作区中的 LLS CCAI 都保持一致。

---

## 5. 语言集合与 auto 解析

### 5.1 可配置语言

```ts
export type AppLanguage =
    | 'auto'
    | 'en'
    | 'zh-cn'
    | 'zh-tw'
    | 'ko'
    | 'ja'
    | 'fr'
    | 'de';

export type ResolvedAppLanguage = Exclude<AppLanguage, 'auto'>;
```

### 5.2 实际生效语言

```ts
const SUPPORTED_APP_LANGUAGES: readonly ResolvedAppLanguage[] = [
    'en',
    'zh-cn',
    'zh-tw',
    'ko',
    'ja',
    'fr',
    'de'
];
```

### 5.3 auto 解析规则

当配置为 `auto` 时，根据 `vscode.env.language` 解析：

| VS Code locale 前缀 | 解析结果 |
| --- | --- |
| `zh-tw` / `zh-hk` / `zh-mo` / `zh-hant` | `zh-tw` |
| `zh` | `zh-cn` |
| `ko` | `ko` |
| `ja` | `ja` |
| `fr` | `fr` |
| `de` | `de` |
| 其它 | `en` |

---

## 6. TypeScript 类型改造

文件：`src/types.ts`

### 6.1 新增语言类型

```ts
/** UI 可选语言，auto 表示跟随 VS Code 显示语言。 */
export type AppLanguage = 'auto' | 'en' | 'zh-cn' | 'zh-tw' | 'ko' | 'ja' | 'fr' | 'de';

/** 实际生效的 UI 语言，不包含 auto。 */
export type ResolvedAppLanguage = Exclude<AppLanguage, 'auto'>;
```

### 6.2 扩展 ConfigViewState

```ts
export interface ConfigViewState {
    providers: ProviderConfigWithoutSecrets[];
    currentModel: CurrentModelSelection | null;
    relay: RelayServerConfig;
    relayStatusText: string;

    /** 用户配置的 UI 语言，可能为 auto。 */
    configuredLanguage: AppLanguage;

    /** 解析后实际生效的 UI 语言。 */
    resolvedLanguage: ResolvedAppLanguage;
}
```

### 6.3 扩展 WebviewMessage

```ts
| { type: 'updateUiLanguage'; payload: AppLanguage }
```

### 6.4 ExtensionMessage 不必新增独立 language 消息

首版推荐直接通过现有 state 消息返回：

```ts
| { type: 'state'; payload: ConfigViewState }
```

即前端收到 `state` 后读取：

```js
state.configuredLanguage
state.resolvedLanguage
```

---

## 7. ConfigManager 改造

文件：`src/configManager.ts`

### 7.1 新增常量

```ts
/** LLS CCAI 自有配置命名空间。 */
const CCAI_NAMESPACE = 'claudeCodeConfigHelper';

/** LLS CCAI 自有语言配置字段：claudeCodeConfigHelper.language。 */
const CCAI_LANGUAGE_KEY = 'language';

/** LLS CCAI 支持的实际 UI 语言集合。 */
const SUPPORTED_APP_LANGUAGES: readonly ResolvedAppLanguage[] = ['en', 'zh-cn', 'zh-tw', 'ko', 'ja', 'fr', 'de'];
```

### 7.2 新增方法

```ts
/**
 * 读取用户配置的 LLS CCAI UI 语言。
 *
 * 该方法只读取 claudeCodeConfigHelper.language，
 * 不读取 openapicopilot.language，确保与 LLS OAI 完全隔离。
 */
public getConfiguredUiLanguage(): AppLanguage {
    const value = vscode.workspace
        .getConfiguration(CCAI_NAMESPACE)
        .get<AppLanguage>(CCAI_LANGUAGE_KEY, 'auto');
    return value === 'auto' || SUPPORTED_APP_LANGUAGES.includes(value as ResolvedAppLanguage)
        ? value
        : 'auto';
}

/**
 * 解析当前实际生效的 LLS CCAI UI 语言。
 *
 * 用户选择具体语言时直接返回该语言；
 * 用户选择 auto 时根据 vscode.env.language 解析。
 */
public getResolvedUiLanguage(): ResolvedAppLanguage {
    const configured = this.getConfiguredUiLanguage();
    if (configured !== 'auto') return configured;
    return this.resolveVsCodeLanguage(vscode.env.language);
}

/**
 * 写入 LLS CCAI 自有 UI 语言配置。
 *
 * 只写 claudeCodeConfigHelper.language 的全局值，
 * 不写 openapicopilot.language。
 */
public async updateUiLanguage(language: AppLanguage): Promise<void> {
    const normalized = language === 'auto' || SUPPORTED_APP_LANGUAGES.includes(language as ResolvedAppLanguage)
        ? language
        : 'auto';
    await vscode.workspace
        .getConfiguration(CCAI_NAMESPACE)
        .update(CCAI_LANGUAGE_KEY, normalized, vscode.ConfigurationTarget.Global);
    this.changeEmitter.fire();
}

/**
 * 将 VS Code locale 解析为 LLS CCAI 支持的 UI 语言。
 */
private resolveVsCodeLanguage(language: string | undefined): ResolvedAppLanguage {
    const normalized = (language || '').toLowerCase();
    if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized.startsWith('zh-mo') || normalized.startsWith('zh-hant')) return 'zh-tw';
    if (normalized.startsWith('zh')) return 'zh-cn';
    if (normalized.startsWith('ko')) return 'ko';
    if (normalized.startsWith('ja')) return 'ja';
    if (normalized.startsWith('fr')) return 'fr';
    if (normalized.startsWith('de')) return 'de';
    return 'en';
}
```

### 7.3 getState 追加语言字段

```ts
public getState(): ConfigViewState {
    return {
        providers: this.listProviders(),
        currentModel: this.getCurrentModel(),
        relay: this.getRelayConfig(),
        relayStatusText: '本地中转服务尚未启动',
        configuredLanguage: this.getConfiguredUiLanguage(),
        resolvedLanguage: this.getResolvedUiLanguage()
    };
}
```

---

## 8. 配置变更监听

文件：`src/extension.ts`

需要监听 LLS CCAI 自有语言配置：

```ts
context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('claudeCodeConfigHelper.language')) {
            configManager?.notifyChanged();
        }
    })
);
```

如果不新增 `notifyChanged()`，也可以在 `ConfigManager` 中提供：

```ts
/** 主动通知配置状态已变化，供外部配置监听触发 Webview 刷新。 */
public notifyChanged(): void {
    this.changeEmitter.fire();
}
```

---

## 9. Webview 后端改造

文件：`src/views/configView.ts`

### 9.1 处理前端语言更新消息

```ts
case 'updateUiLanguage':
    await this.manager.updateUiLanguage(message.payload);
    this.postState();
    return;
```

### 9.2 HTML lang 初始值

可以保持固定：

```html
<html lang="zh-CN">
```

也可以由前端 `applyI18n()` 在运行时更新：

```js
document.documentElement.lang = currentLanguage;
```

推荐后者，避免后端 HTML 字符串复杂化。

---

## 10. Webview 前端改造

文件：`media/configView.js`

### 10.1 新增语言状态

```js
/** 用户配置的语言，auto 表示跟随 VS Code。 */
let configuredLanguage = 'auto';

/** 当前实际生效语言。 */
let currentLanguage = 'en';
```

### 10.2 新增翻译字典

首版至少包括：

```js
const translations = {
    en: {
        appTitle: 'LLS CCAI Setting',
        appSubtitle: 'Manage Claude Code relay, upstream providers, models, prompts and task flow settings.',
        languageLabel: 'Language',
        languageAuto: 'Auto (VS Code)',
        languageEnglish: 'English',
        languageChinese: '简体中文',
        languageTraditionalChinese: '繁體中文',
        languageKorean: '한국어',
        languageJapanese: '日本語',
        languageFrench: 'Français',
        languageGerman: 'Deutsch',
        import: 'Import',
        export: 'Export',
        globalPromptTask: 'Global Prompt / Task Flow',
        workspacePrompt: 'Workspace Prompt',
        openSettingsJson: 'Open settings.json',
        relaySetting: 'Claude Code Relay Setting',
        relayDescription: 'Current model, port and environment variables are synced to Claude Code runtime configuration.',
        currentModel: 'Current Model',
        notSelected: 'Not selected',
        relayStatus: 'Relay Status',
        port: 'Port',
        autoStartRelay: 'Auto-start local relay when extension activates',
        extraEnvVars: 'Extra environment variables (NAME=VALUE per line)',
        apply: 'Apply',
        writeClaudeCodeSettings: 'Write Claude Code Settings',
        providerManagement: 'Provider Management',
        providerDescription: 'Configure upstream providers and models for Claude Code Relay.',
        newProvider: '+ New Provider',
        noProviders: 'No providers yet. Click “New Provider” to start.'
    },
    'zh-cn': {
        appTitle: 'LLS CCAI Setting',
        appSubtitle: '管理 Claude Code 本地中转、上游提供商、模型、提示词与任务流设置。',
        languageLabel: '语言',
        languageAuto: '跟随 VS Code',
        languageEnglish: 'English',
        languageChinese: '简体中文',
        languageTraditionalChinese: '繁體中文',
        languageKorean: '한국어',
        languageJapanese: '日本語',
        languageFrench: 'Français',
        languageGerman: 'Deutsch',
        import: '导入',
        export: '导出',
        globalPromptTask: '全局提示词/任务流',
        workspacePrompt: '工作区提示词',
        openSettingsJson: '打开 settings.json',
        relaySetting: 'Claude Code Relay Setting',
        relayDescription: '当前模型、端口和环境变量会同步到 Claude Code 运行配置。',
        currentModel: '当前使用模型',
        notSelected: '未选择',
        relayStatus: '中转服务状态',
        port: '端口',
        autoStartRelay: '扩展启动时自动启动本地中转',
        extraEnvVars: '额外环境变量（每行 NAME=VALUE）',
        apply: '应用',
        writeClaudeCodeSettings: '一键写入 Claude Code 配置',
        providerManagement: 'Provider Management',
        providerDescription: '配置可供 Claude Code Relay 使用的上游提供商与模型。',
        newProvider: '+ 新建提供商',
        noProviders: '暂无提供商，点击“新建提供商”开始。'
    }
};

translations['zh-tw'] = { ...translations.en };
translations.ko = { ...translations.en };
translations.ja = { ...translations.en };
translations.fr = { ...translations.en };
translations.de = { ...translations.en };
```

### 10.3 新增翻译工具函数

```js
/** 读取翻译文案，缺失时回落英文，再回落 key 本身。 */
function t(key) {
    return translations[currentLanguage]?.[key] || translations.en[key] || key;
}

/** 对当前 DOM 应用 i18n 文案。 */
function applyI18n() {
    document.documentElement.lang = currentLanguage;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.setAttribute('title', t(el.dataset.i18nTitle));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
        el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
    });
}
```

### 10.4 renderHeader 增加语言下拉

```html
<section class="header">
    <div>
        <h1 data-i18n="appTitle">LLS CCAI Setting</h1>
        <p data-i18n="appSubtitle">管理 Claude Code 本地中转、上游提供商、模型、提示词与任务流设置。</p>
        <div class="language-row">
            <label for="language-select" data-i18n="languageLabel">语言</label>
            <select id="language-select" class="language-select" data-i18n-aria-label="languageLabel">
                <option value="auto" data-i18n="languageAuto">跟随 VS Code</option>
                <option value="en" data-i18n="languageEnglish">English</option>
                <option value="zh-cn" data-i18n="languageChinese">简体中文</option>
                <option value="zh-tw" data-i18n="languageTraditionalChinese">繁體中文</option>
                <option value="ko" data-i18n="languageKorean">한국어</option>
                <option value="ja" data-i18n="languageJapanese">日本語</option>
                <option value="fr" data-i18n="languageFrench">Français</option>
                <option value="de" data-i18n="languageGerman">Deutsch</option>
            </select>
        </div>
    </div>
    <div class="toolbar">
        <button id="btn-import" class="secondary" data-i18n="import">导入</button>
        <button id="btn-export" class="secondary" data-i18n="export">导出</button>
        <button id="btn-open-global-shared" class="secondary" data-i18n="globalPromptTask">全局提示词/任务流</button>
        <button id="btn-open-workspace-shared" class="secondary" data-i18n="workspacePrompt">工作区提示词</button>
        <button id="btn-open-settings" class="secondary" data-i18n="openSettingsJson">打开 settings.json</button>
    </div>
</section>
```

### 10.5 绑定下拉事件

```js
byId('language-select', (el) => {
    el.value = configuredLanguage;
    el.addEventListener('change', () => {
        configuredLanguage = el.value || 'auto';
        post('updateUiLanguage', configuredLanguage);
    });
});
```

### 10.6 state 消息中同步语言

```js
case 'state':
    state = message.payload;
    configuredLanguage = state.configuredLanguage || 'auto';
    currentLanguage = state.resolvedLanguage || 'en';
    render();
    applyI18n();
    break;
```

---

## 11. CSS 样式

文件：`media/configView.css`

```css
.language-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
}

.language-row label {
    margin: 0;
    white-space: nowrap;
}

.language-select {
    width: auto;
    min-width: 150px;
}
```

---

## 12. 首版翻译范围

首版只覆盖设置页顶部和主要卡片，避免一次性改动过大。

| key | en | zh-cn |
| --- | --- | --- |
| appTitle | LLS CCAI Setting | LLS CCAI Setting |
| appSubtitle | Manage Claude Code relay, upstream providers, models, prompts and task flow settings. | 管理 Claude Code 本地中转、上游提供商、模型、提示词与任务流设置。 |
| languageLabel | Language | 语言 |
| languageAuto | Auto (VS Code) | 跟随 VS Code |
| import | Import | 导入 |
| export | Export | 导出 |
| globalPromptTask | Global Prompt / Task Flow | 全局提示词/任务流 |
| workspacePrompt | Workspace Prompt | 工作区提示词 |
| openSettingsJson | Open settings.json | 打开 settings.json |
| relaySetting | Claude Code Relay Setting | Claude Code Relay Setting |
| relayDescription | Current model, port and environment variables are synced to Claude Code runtime configuration. | 当前模型、端口和环境变量会同步到 Claude Code 运行配置。 |
| currentModel | Current Model | 当前使用模型 |
| notSelected | Not selected | 未选择 |
| relayStatus | Relay Status | 中转服务状态 |
| port | Port | 端口 |
| autoStartRelay | Auto-start local relay when extension activates | 扩展启动时自动启动本地中转 |
| extraEnvVars | Extra environment variables (NAME=VALUE per line) | 额外环境变量（每行 NAME=VALUE） |
| apply | Apply | 应用 |
| writeClaudeCodeSettings | Write Claude Code Settings | 一键写入 Claude Code 配置 |
| providerManagement | Provider Management | Provider Management |
| providerDescription | Configure upstream providers and models for Claude Code Relay. | 配置可供 Claude Code Relay 使用的上游提供商与模型。 |
| newProvider | + New Provider | + 新建提供商 |
| noProviders | No providers yet. Click “New Provider” to start. | 暂无提供商，点击“新建提供商”开始。 |

其它语言首版可回落英文：

```js
translations['zh-tw'] = { ...translations.en };
translations.ko = { ...translations.en };
translations.ja = { ...translations.en };
translations.fr = { ...translations.en };
translations.de = { ...translations.en };
```

---

## 13. 与共享设置的边界

语言配置和 LLS CCAI 的任务流模型配置都不共享；目前只有系统提示词继续保持与 LLS OAI 共享：

- `openapicopilot.systemPrompt`

LLS CCAI 自己独立使用：

- `claudeCodeConfigHelper.language`
- `claudeCodeConfigHelper.llsTask.providerId`
- `claudeCodeConfigHelper.llsTask.modelId`

也就是说：

| 配置 | 是否共享 LLS OAI |
| --- | --- |
| 系统提示词 | 是 |
| 任务流 provider/model | 否 |
| UI 语言 | 否 |

这符合用户最新要求：**语言不用共享，采用全新的；全局设置中任务流模型也不要共享 LLS OAI 的，使用 CCAI 独立字段。**

---

## 14. 验收标准

实施后需要满足：

- [ ] `package.json` 中出现 `claudeCodeConfigHelper.language` 配置项。
- [ ] `package.nls.json` 和 `package.nls.zh-cn.json` 有语言配置描述。
- [ ] 设置页标题下方出现语言下拉框。
- [ ] 默认值为 `auto`。
- [ ] 切换 `en` 后页面核心文案变为英文。
- [ ] 切换 `zh-cn` 后页面核心文案变为中文。
- [ ] 设置写入的是 `claudeCodeConfigHelper.language`。
- [ ] 不读取、不写入 `openapicopilot.language`。
- [ ] 外部修改 `claudeCodeConfigHelper.language` 后，Webview 自动刷新。
- [ ] 其它语言缺翻译时回落英文，无空白文案。
- [ ] `npm run typecheck` 通过。
- [ ] `npm run compile` 通过。

---

## 15. 实施顺序

推荐按以下顺序实施：

1. 更新 `package.json` / `package.nls*.json`，新增 `claudeCodeConfigHelper.language`。
2. 更新 `src/types.ts`，新增 `AppLanguage` / `ResolvedAppLanguage`，扩展 `ConfigViewState` 与 `WebviewMessage`。
3. 更新 `src/configManager.ts`，新增 `getConfiguredUiLanguage()` / `getResolvedUiLanguage()` / `updateUiLanguage()`。
4. 更新 `src/extension.ts`，监听 `claudeCodeConfigHelper.language` 配置变化。
5. 更新 `src/views/configView.ts`，处理 `updateUiLanguage` 消息。
6. 更新 `media/configView.js`，增加 translations / t / applyI18n / language-select。
7. 更新 `media/configView.css`，增加语言下拉样式。
8. 执行 `npm run typecheck && npm run compile`。
9. 手动验证语言切换流程。

---

## 16. 后续扩展

首版完成后，可以继续扩展：

- 翻译 Provider / Model 编辑弹窗全部字段；
- 翻译 confirm / toast 文案；
- 翻译 `src/views/sharedSettingsView.ts`；
- 翻译状态栏 tooltip；
- 补全 `zh-tw` / `ko` / `ja` / `fr` / `de` 原生翻译；
- 将 `translations` 抽离为单独文件，避免 `configView.js` 过长。

---

## 17. 最终决策记录

用户最新决策：

> 不用共享，采用全新的。

因此本方案最终采用：

```jsonc
"claudeCodeConfigHelper.language"
```

并明确禁止语言功能读写：

```jsonc
"openapicopilot.language"
```
