# Claude Code 配置助手扩展 — 方案文档

> 目标：写一个 VS Code 扩展，通过 **Webview 可视化面板** 管理用户全局 `settings.json`（macOS 路径：`~/Library/Application Support/Code/User/settings.json`）中和 Anthropic Claude Code 相关的环境变量配置，让用户能图形化地配置自定义 BaseURL / Token，并自动注入到 `claudeCode.environmentVariables` 中，实现"Claude Code 接口转发"。

---

## 零、参考项目

### 0.1 主要参考：`liliangshan.openapi-compatible-copilot`

- **本地源码路径**：`/Users/lls/wwwroot/liliangshan/vcode/liliangshan.openapi-compatible-copilot`
- **已安装版本路径**：`~/.vscode/extensions/liliangshan.openapi-compatible-copilot-3.0.2`
- **作用**：作者本人开发的另一个 VS Code 扩展，把 Copilot Chat 请求转发到任意 OpenAI 兼容后端。它通过实现 `vscode.LanguageModelChatProvider` 拦截 Copilot 的请求，再做协议转换。

#### 与本扩展的关系

| 维度 | `openapi-compatible-copilot` | 本扩展（claude-code-config-helper） |
|---|---|---|
| 目标对象 | GitHub Copilot Chat | Anthropic Claude Code |
| 接入方式 | 实现 `LanguageModelChatProvider` 拦截 | 写环境变量到 settings.json 让 SDK 转发 |
| 是否启 HTTP 服务 | 否（在扩展内直接转发） | 否（仅写配置） |
| 协议转换 | 内置 Anthropic↔OpenAI 转换 | 不做（由用户的上游服务负责） |
| 多 Provider/Profile 管理 | ✅ 有完整 UI | ✅ 借鉴其设计 |
| 远程通知、Expert 模式等高级功能 | ✅ 有 | ❌ 不需要 |

#### 可借鉴的具体模块（建议阅读对应源码以参考实现）

| 参考模块 | 文件路径 | 借鉴点 |
|---|---|---|
| 配置管理器 | `src/configManager.ts` | Provider/Model 的 CRUD、globalState 持久化、订阅变更通知模式 |
| Webview 视图基础结构 | `src/views/` | Webview 创建、消息通信模式、CSP/nonce 处理 |
| 状态栏 | `src/statusBar.ts` | 状态栏文本/图标动态更新、点击命令绑定 |
| Anthropic 协议转换 | `src/utils/anthropicConverter.ts` | 仅参考字段命名规范，本扩展不做协议转换 |
| 类型定义 | `src/types.ts` | Provider/Model/Profile 等类型组织方式 |
| 命令注册结构 | `src/extension.ts` | 激活函数组织、命令解构 |
| 扩展工程配置 | `package.json`、`tsconfig.json` | 构建脚本、依赖版本、贡献点写法直接对齐 |

#### 借鉴原则

- ✅ **借鉴架构和模式**（目录结构、消息通信、状态栏、配置管理思路）
- ✅ **直接对齐工程配置**（tsconfig、构建脚本、`.vscodeignore` 等）
- ❌ **不直接复制代码**（功能差异较大，硬复制会引入不需要的复杂度）
- ❌ **不依赖其 globalState**（两个扩展独立存储，避免耦合）

### 0.2 次要参考：`anthropic.claude-code` 官方扩展

- **本地路径**：`/Users/lls/wwwroot/liliangshan/vcode/anthropic.claude-code-2.1.144-darwin-arm64`
- **作用**：被本扩展配置的目标扩展。需要参考它的：
  - `package.json` 中 `claudeCode.environmentVariables` / `claudeCode.disableLoginPrompt` 设置项的 schema
  - `extension.js` 中对环境变量的消费逻辑（已分析，见本文档"背景"章节）
- **借鉴点**：仅作为协议参考，不复制任何代码。

---

## 一、背景与目标

### 1.1 背景

Anthropic 官方扩展 `anthropic.claude-code` 内部使用 Anthropic Node SDK 发起 API 请求，SDK 原生支持以下环境变量来定制请求目标：

| 变量 | 作用 |
|---|---|
| `ANTHROPIC_BASE_URL` | 自定义 API 基础地址 |
| `ANTHROPIC_AUTH_TOKEN` | Bearer 令牌（`Authorization: Bearer xxx`） |
| `ANTHROPIC_API_KEY` | 标准 API Key（`x-api-key` 头） |
| `ANTHROPIC_CUSTOM_HEADERS` | 自定义请求头（换行分隔的 `Key: Value`） |
| `CLAUDE_CODE_SKIP_AUTH_LOGIN` | 跳过 OAuth 登录，强制走 3p 鉴权 |

而 `claude-code` 扩展提供了 `claudeCode.environmentVariables` 设置项，会把所有键值对注入到 Claude Code 子进程的环境变量中。这就意味着：**只要把上面的变量写入这个设置项，即可让 Claude Code 把请求转发到任意兼容 Anthropic API 的端点。**

### 1.2 目标

写一个 VS Code 扩展，提供 **Webview 可视化面板**，专门用于管理用户全局 settings.json 中和 Claude Code 相关的两个关键配置项：

```jsonc
{
    "claudeCode.environmentVariables": [ /* ANTHROPIC_BASE_URL 等 */ ],
    "claudeCode.disableLoginPrompt": true
}
```

**不**启动 HTTP 中转服务，只做"配置写入器"，让用户能在图形界面里：

- 填写 BaseURL / Token / API Key / 自定义 Header
- 管理多套 Profile（开发/测试/生产）一键切换
- 一键开关
- 实时把配置写回 VS Code 用户 settings.json

### 1.3 非目标（不做）

- ❌ 不内置 HTTP 中转服务
- ❌ 不做 Anthropic ↔ OpenAI 协议转换
- ❌ 不做 Model 映射
- ❌ 不做请求日志/监控
- ❌ 不直接读写 settings.json 文件（用官方 API）

---

## 二、技术方案

### 2.1 写入方式（关键决策）

**采用 VS Code 官方 API：`vscode.workspace.getConfiguration('claudeCode').update(...)`，写到 `ConfigurationTarget.Global`。**

理由：

- ✅ 官方 API，自动写入用户全局 settings.json
- ✅ 自动处理 JSON 格式、注释保留、并发写入
- ✅ macOS / Windows / Linux 自动找正确路径，跨平台
- ❌ **不要** 直接读写 `~/Library/Application Support/Code/User/settings.json` 文件 —— 会破坏注释、有并发风险、不跨平台

### 2.2 配置数据模型

扩展内部维护一份**结构化配置**（存到自己的 `globalState`），渲染到 Webview，用户保存时**展开成扁平的环境变量数组**写入 Claude Code 配置。

```typescript
/** 扩展全局配置（存 globalState 的根对象） */
interface RouterConfig {
    activeProfileId: string | null;   // 当前激活的 Profile id，null 表示未激活
    profiles: Profile[];              // 多套配置
}

/** 单套 Profile 配置 */
interface Profile {
    id: string;                       // uuid
    name: string;                     // "DeepSeek 生产" / "本地中转" 等
    baseUrl: string;                  // -> ANTHROPIC_BASE_URL
    authMode: 'auth_token' | 'api_key' | 'none';
    // 注意：authToken / apiKey 不存这里，存 SecretStorage
    customHeaders: Array<{ key: string; value: string }>; // -> ANTHROPIC_CUSTOM_HEADERS
    skipAuthLogin: boolean;           // -> CLAUDE_CODE_SKIP_AUTH_LOGIN
    disableLoginPrompt: boolean;      // -> claudeCode.disableLoginPrompt
    extraEnvVars: Array<{ name: string; value: string }>; // 其他用户自定义变量
    createdAt: number;
    updatedAt: number;
}
```

### 2.3 写入逻辑（激活某个 Profile 时）

```
1. 读取当前 claudeCode.environmentVariables
2. 过滤掉本扩展管理的变量（带 __CLAUDE_ROUTER_MANAGED__ 标记的）
3. 把 Profile 的字段展开成新的环境变量条目
4. 合并 → workspace.getConfiguration('claudeCode')
        .update('environmentVariables', merged, Global)
5. 同步写 claudeCode.disableLoginPrompt
6. 提示用户：需重启 Claude Code 扩展窗口（或调用 workbench.action.reloadWindow）
```

**安全机制**：在数组中插入一个标识条目 `{ name: "__CLAUDE_ROUTER_MANAGED__", value: "<profileId>" }`，并在 globalState 里记录"本次写入了哪些 key"，下次切换时只清理本扩展写过的变量，**不影响用户手动加的其他变量**。

### 2.4 Webview 架构示意

```
┌─────────────────────────────────────────────────────┐
│  📦 Claude Code 配置中心                  [刷新]  [?] │
├─────────────────────────────────────────────────────┤
│  当前激活: ● DeepSeek 生产    [禁用] [切换 ▼]        │
├─────────────────────────────────────────────────────┤
│  Profile 列表                              [+ 新建]  │
│  ┌────────────────────┐  ┌────────────────────┐    │
│  │ ✓ DeepSeek 生产    │  │   本地中转         │    │
│  │   api.deepseek.com │  │   127.0.0.1:8080   │    │
│  │   [编辑][复制][删] │  │   [编辑][复制][删] │    │
│  └────────────────────┘  └────────────────────┘    │
├─────────────────────────────────────────────────────┤
│  编辑面板（选中 Profile 后显示）                     │
│  名称:    [DeepSeek 生产___________________]        │
│  BaseURL: [https://api.deepseek.com/anthropic]      │
│  鉴权方式: (●) AUTH_TOKEN  ( ) API_KEY  ( ) 无       │
│  Token:   [sk-xxxxxx_______________________] [显示] │
│  自定义请求头:                                       │
│    [X-Source     ] [vscode      ] [删]              │
│    [+ 添加]                                          │
│  额外环境变量:                                       │
│    [+ 添加]                                          │
│  ☑ 禁用 Claude Code 的 OAuth 登录提示                │
│  ☑ 跳过认证登录 (CLAUDE_CODE_SKIP_AUTH_LOGIN)        │
│                                                      │
│        [取消]  [保存草稿]  [保存并激活]              │
├─────────────────────────────────────────────────────┤
│  当前 settings.json 预览（只读）         [复制]      │
│  ┌──────────────────────────────────────────────┐  │
│  │  "claudeCode.environmentVariables": [...]    │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 2.5 Webview ↔ Extension 消息协议

#### Webview → Extension

| 命令 | 载荷 | 作用 |
|---|---|---|
| `init` | – | 请求初始数据（profiles + active + preview） |
| `saveProfile` | `Profile + 明文token/key` | 保存 profile（token 走 SecretStorage） |
| `deleteProfile` | `{ id }` | 删除 profile |
| `activateProfile` | `{ id }` | 激活某 profile，写 settings.json |
| `deactivate` | – | 取消激活（清除本扩展写过的环境变量） |
| `duplicateProfile` | `{ id }` | 复制 profile |
| `exportConfig` | `{ includeSecrets: boolean }` | 导出为 JSON |
| `importConfig` | `{ json: string }` | 从 JSON 导入 |
| `openSettingsJson` | – | 在编辑器打开 settings.json |
| `restartClaudeCode` | – | 触发 `workbench.action.reloadWindow` |
| `revealToken` | `{ id }` | 临时取出 token 显示（鉴权后） |

#### Extension → Webview

| 命令 | 载荷 | 作用 |
|---|---|---|
| `state` | `{ profiles, activeProfileId }` | 全量状态 |
| `previewSettings` | `{ environmentVariables, disableLoginPrompt }` | settings.json 中相关字段实时预览 |
| `toast` | `{ level, message }` | 提示消息（info/warn/error/success） |

### 2.6 安全：敏感信息存储

Token 和 API Key **不存 globalState**（globalState 明文），改用 `vscode.SecretStorage`：

```typescript
// 存
await context.secrets.store(`claudeRouter.token.${profileId}`, token);
// 读
const token = await context.secrets.get(`claudeRouter.token.${profileId}`);
// 删
await context.secrets.delete(`claudeRouter.token.${profileId}`);
```

profile 元信息（名称、BaseURL、header 等）存 globalState；token/apiKey 单独存 SecretStorage。

> **注意**：当 token 被写入 `claudeCode.environmentVariables` 后，它在 settings.json 中是**明文存储**的——这是 Claude Code 扩展的设计决定，本扩展无法改变。我们能做的是在"未激活"时确保 token 只存在于 SecretStorage 中。

---

## 三、项目结构

```
liliangshan-anthropic.claude-code/
├── PLAN.md                       # 本文件
├── package.json                  # 扩展清单
├── tsconfig.json
├── .vscodeignore
├── .gitignore
├── README.md
├── LICENSE
├── icon.png
├── src/
│   ├── extension.ts              # 入口、激活、命令注册
│   ├── configStore.ts            # 配置 CRUD + globalState 持久化
│   ├── secretStore.ts            # SecretStorage 封装（token/apiKey）
│   ├── settingsWriter.ts         # 写入 claudeCode.* 设置的核心逻辑
│   ├── profileManager.ts         # Profile 业务逻辑（激活/切换/合并）
│   ├── webview/
│   │   ├── panel.ts              # WebviewPanel 创建与生命周期
│   │   ├── messageHandler.ts     # 消息路由
│   │   └── html.ts               # HTML 模板生成（含 nonce/CSP）
│   ├── statusBar.ts              # 状态栏显示当前 Profile + 快捷切换
│   ├── commands.ts               # 所有命令注册
│   ├── logger.ts                 # 输出通道日志
│   ├── types.ts                  # 共享类型
│   └── constants.ts              # 常量（key 名、命令 ID、marker）
├── media/
│   ├── main.js                   # Webview 前端脚本（vanilla JS）
│   ├── main.css                  # 样式（用 VS Code 主题变量）
│   └── codicon.css               # VS Code 图标字体（可选）
└── resources/
    └── icon.svg
```

---

## 四、命令与贡献点

### 4.1 package.json 关键贡献

```jsonc
{
    "publisher": "liliangshan",
    "name": "claude-code-config-helper",
    "displayName": "Claude Code 配置助手",
    "version": "0.1.0",
    "engines": { "vscode": "^1.94.0" },
    "categories": ["Other"],
    "activationEvents": ["onStartupFinished"],
    "main": "./out/extension.js",
    "contributes": {
        "commands": [
            { "command": "claudeRouter.openPanel",        "title": "Claude Code 配置: 打开配置面板",   "icon": "$(settings-gear)" },
            { "command": "claudeRouter.quickPick",        "title": "Claude Code 配置: 快速切换 Profile" },
            { "command": "claudeRouter.deactivate",       "title": "Claude Code 配置: 禁用（清除环境变量）" },
            { "command": "claudeRouter.openSettingsJson", "title": "Claude Code 配置: 打开 settings.json" },
            { "command": "claudeRouter.reloadWindow",     "title": "Claude Code 配置: 重载窗口让配置生效" }
        ],
        "configuration": {
            "title": "Claude Code 配置助手",
            "properties": {
                "claudeCodeConfigHelper.showStatusBar": {
                    "type": "boolean", "default": true,
                    "description": "在状态栏显示当前激活的 Profile"
                },
                "claudeCodeConfigHelper.autoReloadWindow": {
                    "type": "boolean", "default": false,
                    "description": "切换 Profile 后自动重新加载窗口"
                },
                "claudeCodeConfigHelper.confirmBeforeWrite": {
                    "type": "boolean", "default": true,
                    "description": "写入 settings.json 前弹窗确认"
                }
            }
        },
        "menus": {
            "commandPalette": [
                { "command": "claudeRouter.openPanel" },
                { "command": "claudeRouter.quickPick" }
            ]
        }
    }
}
```

### 4.2 状态栏

```
🤖 Claude: DeepSeek 生产 ▼     ← 点击弹出 quickPick
🤖 Claude: 未激活               ← 未激活时
```

---

## 五、关键流程伪代码

### 5.1 激活 Profile

```typescript
/**
 * 激活指定的 Profile：把它的字段展开成环境变量数组写入用户 settings.json
 * @param profileId 要激活的 profile id
 */
async function activateProfile(profileId: string): Promise<void> {
    const profile = configStore.getProfile(profileId);
    if (!profile) throw new Error('Profile 不存在');

    // 1. 取出现有 environmentVariables
    const cfg = vscode.workspace.getConfiguration('claudeCode');
    const existing: EnvVar[] = cfg.get('environmentVariables') ?? [];

    // 2. 过滤掉本扩展管理的（通过 marker + 邻接关系识别）
    const userOwned = stripManagedVars(existing);

    // 3. 从 SecretStorage 取敏感字段
    const token = await secretStore.getToken(profileId);
    const apiKey = await secretStore.getApiKey(profileId);

    // 4. 构造新的 managed 部分
    const managed: EnvVar[] = [
        { name: MANAGED_MARKER, value: profileId },
        ...(profile.baseUrl
            ? [{ name: 'ANTHROPIC_BASE_URL', value: profile.baseUrl }] : []),
        ...(profile.authMode === 'auth_token' && token
            ? [{ name: 'ANTHROPIC_AUTH_TOKEN', value: token }] : []),
        ...(profile.authMode === 'api_key' && apiKey
            ? [{ name: 'ANTHROPIC_API_KEY', value: apiKey }] : []),
        ...(profile.customHeaders.length > 0
            ? [{
                name: 'ANTHROPIC_CUSTOM_HEADERS',
                value: profile.customHeaders.map(h => `${h.key}: ${h.value}`).join('\n')
              }] : []),
        ...(profile.skipAuthLogin
            ? [{ name: 'CLAUDE_CODE_SKIP_AUTH_LOGIN', value: '1' }] : []),
        ...profile.extraEnvVars.map(e => ({ name: e.name, value: e.value }))
    ];

    // 5. 合并写回
    await cfg.update(
        'environmentVariables',
        [...userOwned, ...managed],
        vscode.ConfigurationTarget.Global
    );
    await cfg.update(
        'disableLoginPrompt',
        profile.disableLoginPrompt,
        vscode.ConfigurationTarget.Global
    );

    // 6. 记录 active
    await configStore.setActiveProfileId(profileId);

    // 7. 提示重启 Claude Code
    promptReloadIfNeeded();
}
```

### 5.2 取消激活

```typescript
/**
 * 取消当前激活的 Profile：清除本扩展写过的所有环境变量
 */
async function deactivate(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('claudeCode');
    const existing: EnvVar[] = cfg.get('environmentVariables') ?? [];
    const userOwned = stripManagedVars(existing);
    await cfg.update(
        'environmentVariables',
        userOwned,
        vscode.ConfigurationTarget.Global
    );
    await configStore.setActiveProfileId(null);
}
```

### 5.3 stripManagedVars 实现策略

```typescript
/**
 * 从环境变量数组中剥离掉所有本扩展管理的条目。
 * 识别策略：
 *   1. 找到 __CLAUDE_ROUTER_MANAGED__ 标记
 *   2. 该标记及它后面所有连续的"已知 managed key"全部清除
 *   3. 兜底：即使没标记，也兜底清除所有 ANTHROPIC_* 与 CLAUDE_CODE_SKIP_AUTH_LOGIN
 *      （需要用户在设置里开启 aggressiveCleanup 才会触发这个兜底）
 */
function stripManagedVars(vars: EnvVar[]): EnvVar[] {
    // 简单版：只清理紧跟在 marker 后面的条目（保守做法）
    const result: EnvVar[] = [];
    let inManagedBlock = false;
    for (const v of vars) {
        if (v.name === MANAGED_MARKER) {
            inManagedBlock = true;
            continue;
        }
        if (inManagedBlock && MANAGED_KEYS.has(v.name)) {
            continue;
        }
        // 退出 managed 区域
        inManagedBlock = false;
        result.push(v);
    }
    return result;
}
```

---

## 六、Webview 安全（CSP / nonce）

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src ${cspSource} 'unsafe-inline';
               script-src 'nonce-${nonce}';
               img-src ${cspSource} data:;
               font-src ${cspSource};">
```

- 所有 `<script>` 必须带 `nonce="${nonce}"`
- 资源走 `webview.asWebviewUri()` 转换
- 不引入任何外部 CDN
- 启用 `enableScripts: true`，但 `localResourceRoots` 限制只能加载扩展目录下的文件

---

## 七、用户使用流程

```
1. 安装扩展
2. 命令面板 → "Claude Code 配置: 打开配置面板"
3. 点 [+ 新建 Profile] → 填 BaseURL / Token → [保存并激活]
4. 扩展自动写入 ~/Library/Application Support/Code/User/settings.json
5. 弹窗提示："已激活，是否立即重新加载窗口让 Claude Code 生效？" [是] [否]
6. 重载后 Claude Code 走自定义端点
```

---

## 八、Profile 切换的 UX 亮点

- **状态栏**：随时看到当前激活 Profile
- **命令面板快速切换**：`Cmd+Shift+P` → 输入 `claude` → 选 Profile
- **配置面板预览**：实时展示当前 settings.json 里相关字段长什么样
- **导入导出**：JSON 格式，方便备份/团队共享（敏感字段可选脱敏）
- **重载提示**：每次写入后右下角弹窗，点击即可重载窗口

---

## 九、范围

### ✅ 做

- 多 Profile 管理 CRUD
- Webview 可视化编辑
- 写入 VS Code 用户 settings.json（通过官方 API）
- Token 用 SecretStorage 保护
- 状态栏 + 快速切换
- 导入导出
- 一键重载窗口
- 实时 settings.json 预览

### ❌ 不做（独立方案/其他扩展处理）

- HTTP 中转服务
- 协议转换 Anthropic↔OpenAI
- Model 映射
- 请求日志/监控
- 直接读写 settings.json 文件（用 VS Code Configuration API）

---

## 十、开发里程碑

| 阶段 | 内容 | 占比 |
|---|---|---|
| **M1** | 项目脚手架 + 类型定义 + Profile CRUD + globalState/SecretStorage | 30% |
| **M2** | settings.json 写入逻辑（激活/取消/合并/marker 策略） | 15% |
| **M3** | Webview UI（HTML/CSS/JS + 消息通信 + CSP） | 35% |
| **M4** | 状态栏 + 命令面板 + 快速切换 | 10% |
| **M5** | 打磨：导入导出、提示重载、README 文档 | 10% |

---

## 十一、待确认事项

1. **publisher/name** — 用 `liliangshan.claude-code-config-helper` 还是别的？
2. **多 Profile** — 是否需要多套切换？还是只支持单套配置？（推荐：多套）
3. **Token 存储** — 是否用 SecretStorage？（推荐用，导出/团队共享时单独处理脱敏）
4. **写入策略** — 用 VS Code API 写 `ConfigurationTarget.Global`，**不直接操作文件**，对吗？
5. **状态栏 + 快速切换** — 是否要做？（推荐做）
6. **Webview 前端栈** — 纯 vanilla JS（推荐，零依赖、加载快），还是引入 Vue/React/Alpine？
7. **是否需要"自定义环境变量"扩展位** — 允许用户在 Profile 里添加任意 `name/value` 对（推荐做，灵活性高）
8. **激活后是否自动重载窗口** — 默认弹窗询问，可在设置里开启"总是自动重载"

---

## 十二、第一阶段方案（MVP）：只配置不转发

> **核心思路**：第一阶段 **不内置任何 HTTP 中转服务、不做任何协议转换**，只做 settings.json 的可视化配置写入器。把"转发"这件事完全交给用户的上游服务（Anthropic 兼容端点）来负责。这样可以最快验证可用性、最低实现成本上线。

### 12.1 范围定义

#### ✅ 第一阶段做

| 编号 | 功能 | 说明 |
|---|---|---|
| F1 | 单/多 Profile 管理 | 至少支持 1 套配置；推荐做多套但允许 MVP 只先做单套 |
| F2 | Webview 可视化编辑面板 | 唯一 UI 入口，使用 vanilla JS |
| F3 | 写入 `claudeCode.environmentVariables` | 通过官方 Configuration API |
| F4 | 写入 `claudeCode.disableLoginPrompt` | 同上 |
| F5 | Token / API Key 用 SecretStorage 保存 | 未激活时不写到 settings.json |
| F6 | 激活 / 取消激活 | 写入或清除本扩展管理的环境变量 |
| F7 | Marker 机制 | `__CLAUDE_ROUTER_MANAGED__` 标记本扩展写过的条目 |
| F8 | settings.json 实时预览 | Webview 右侧只读展示当前相关字段 |
| F9 | 一键重载窗口 | 调用 `workbench.action.reloadWindow` |
| F10 | 命令面板基础命令 | 打开面板 / 禁用 / 打开 settings.json |

#### ❌ 第一阶段不做（推迟到第二阶段）

| 编号 | 功能 | 推迟原因 |
|---|---|---|
| ND1 | 内置 HTTP 中转服务 | 工作量大，且不是第一性需求 |
| ND2 | Anthropic ↔ OpenAI 协议转换 | 复杂、易出错，独立 Phase 推进 |
| ND3 | 状态栏 + 快速切换 | 不影响核心使用，做完 MVP 再加 |
| ND4 | 导入 / 导出 JSON | 同上，属于增强能力 |
| ND5 | 多 Profile 快速切换 quickPick | 同上 |
| ND6 | 模型映射 / 模型管理 | 由上游服务负责，本扩展不感知 |
| ND7 | 请求日志 / 监控 | 不做转发就没有日志可言 |
| ND8 | 远程通知 / Expert 模式等 | 参考项目的高级功能，本扩展不需要 |

### 12.2 第一阶段最小项目结构

```
liliangshan-anthropic.claude-code/
├── PLAN.md
├── package.json
├── tsconfig.json
├── .vscodeignore
├── .gitignore
├── README.md
├── src/
│   ├── extension.ts          # 入口 + 命令注册（5 个命令）
│   ├── configStore.ts        # globalState CRUD（profiles + activeId）
│   ├── secretStore.ts        # SecretStorage 封装（token/apiKey）
│   ├── settingsWriter.ts     # 写入 claudeCode.* 的核心（activate/deactivate）
│   ├── profileManager.ts     # Profile 业务逻辑（薄层，组合上面三个）
│   ├── webview/
│   │   ├── panel.ts          # WebviewPanel 创建 + 消息路由
│   │   └── html.ts           # HTML 模板生成（含 nonce/CSP）
│   ├── types.ts              # 共享类型
│   ├── constants.ts          # 常量（marker、命令 id、storage key）
│   └── logger.ts             # 输出通道日志
└── media/
    ├── main.js               # Webview 前端（vanilla JS，无框架）
    └── main.css              # 用 VS Code 主题变量
```

> 相比完整方案的目录结构，第一阶段**不创建**：
> - `src/statusBar.ts`
> - `src/commands.ts`（命令直接写在 `extension.ts` 里，5 个不多）
> - `src/webview/messageHandler.ts`（合并进 `panel.ts`）
> - `resources/`（图标后期再加）

### 12.3 第一阶段命令列表（最小）

| 命令 ID | 标题 | 说明 |
|---|---|---|
| `claudeRouter.openPanel` | Claude Code 配置: 打开配置面板 | 主入口 |
| `claudeRouter.deactivate` | Claude Code 配置: 禁用（清除环境变量） | 一键关闭 |
| `claudeRouter.openSettingsJson` | Claude Code 配置: 打开 settings.json | 排查问题用 |
| `claudeRouter.reloadWindow` | Claude Code 配置: 重载窗口让配置生效 | 一键重启 |

> **不注册** `quickPick`（属于状态栏 + 切换功能，第二阶段做）。

### 12.4 第一阶段 Webview 简化布局

```
┌────────────────────────────────────────────────┐
│ 📦 Claude Code 配置助手                  [刷新] │
├────────────────────────────────────────────────┤
│ Profile 列表                         [+ 新建]   │
│ ┌────────────────────────────────────────────┐│
│ │ ✓ DeepSeek 生产 (api.deepseek.com)         ││
│ │   [编辑] [删除]                             ││
│ └────────────────────────────────────────────┘│
├────────────────────────────────────────────────┤
│ 编辑区（选中后展开）                            │
│   名称       [____________________________]    │
│   BaseURL    [____________________________]    │
│   鉴权方式   (●)AUTH_TOKEN ( )API_KEY ( )无     │
│   Token      [____________________] [显示]     │
│   自定义请求头                                  │
│      [Key] [Value] [删]                        │
│      [+ 添加]                                   │
│   额外环境变量                                  │
│      [Name] [Value] [删]                       │
│      [+ 添加]                                   │
│   ☑ 禁用 OAuth 登录提示                         │
│   ☑ 跳过认证登录                                │
│   [取消] [保存] [保存并激活]                    │
├────────────────────────────────────────────────┤
│ settings.json 预览（只读）             [复制]   │
│   { "claudeCode.environmentVariables": [...] } │
└────────────────────────────────────────────────┘
```

> 第一阶段 **去掉**："当前激活"独立顶部条、"复制 Profile"按钮（用"新建+手填"代替）、导入导出区。

### 12.5 第一阶段消息协议（精简）

#### Webview → Extension

| 命令 | 载荷 | 备注 |
|---|---|---|
| `init` | – | 初始拉取数据 |
| `saveProfile` | `Profile + plainToken?` | 保存（token 走 SecretStorage） |
| `deleteProfile` | `{ id }` | 删除 |
| `activateProfile` | `{ id }` | 激活并写 settings.json |
| `deactivate` | – | 清除环境变量 |
| `revealToken` | `{ id }` | 从 SecretStorage 取出明文回传（仅本次显示用） |
| `openSettingsJson` | – | 调用 VS Code 命令 |
| `reloadWindow` | – | 调用 VS Code 命令 |

#### Extension → Webview

| 命令 | 载荷 | 备注 |
|---|---|---|
| `state` | `{ profiles, activeProfileId }` | 全量推送 |
| `previewSettings` | `{ environmentVariables, disableLoginPrompt }` | 预览数据 |
| `toast` | `{ level, message }` | 提示 |
| `tokenRevealed` | `{ id, token }` | 一次性回传 token |

### 12.6 第一阶段开发顺序（建议）

| Step | 任务 | 产出 |
|---|---|---|
| S1 | `package.json` + `tsconfig.json` + `.vscodeignore` + 空 `extension.ts` | 项目可编译 |
| S2 | `types.ts` + `constants.ts` + `logger.ts` | 基础设施 |
| S3 | `configStore.ts`（profiles CRUD on globalState） | 数据层 |
| S4 | `secretStore.ts`（token/apiKey on SecretStorage） | 敏感数据层 |
| S5 | `settingsWriter.ts`（activate/deactivate + marker 策略） | 核心写入逻辑 |
| S6 | `profileManager.ts`（组合上述三层） | 业务门面 |
| S7 | `webview/html.ts` + `media/main.css` | 静态骨架 |
| S8 | `webview/panel.ts` + `media/main.js` + 消息通信 | 完整交互 |
| S9 | `extension.ts` 注册命令 + 激活逻辑 | 可运行 |
| S10 | 跑通端到端：新建 → 激活 → 看 settings.json 写入成功 → reload → Claude Code 走自定义端点 | 验收 |
| S11 | README + 截图 + 打包 vsix | 发布准备 |

### 12.7 第一阶段验收标准（Definition of Done）

1. ✅ 打开命令面板能找到"Claude Code 配置: 打开配置面板"
2. ✅ 面板能新建/编辑/删除/激活 Profile
3. ✅ 激活后查看 `~/Library/Application Support/Code/User/settings.json`，能看到正确的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 条目和 `__CLAUDE_ROUTER_MANAGED__` marker
4. ✅ 重载窗口后，Claude Code 实际请求走自定义端点（用上游服务日志验证）
5. ✅ 取消激活后，settings.json 中本扩展写过的字段被清除，**用户手加的其他变量不受影响**
6. ✅ Token 在未激活状态下，仅存在于 SecretStorage，settings.json 里没有
7. ✅ 切换不同 Profile，settings.json 中只保留当前激活的那一套
8. ✅ Webview CSP 严格，无外网请求，无 inline script（除带 nonce 外）
9. ✅ `vue-tsc` / `tsc --noEmit` 通过，无类型错误
10. ✅ README 写清楚使用步骤和典型上游服务配置示例（如 DeepSeek、Moonshot、自建中转）

### 12.8 第一阶段不解决但需在 README 提示的事项

- ⚠ Token 一旦激活，会以**明文**形式存在于 settings.json 中（Claude Code 扩展的设计决定，无法规避）
- ⚠ 切换 Profile 后必须**重载窗口**才会让 Claude Code 子进程读到新环境变量
- ⚠ 上游服务必须实现 Anthropic Messages API 协议（`POST /v1/messages` + SSE），不兼容时本扩展不负责转换
- ⚠ 如果用户在 settings.json 里手动改了本扩展写过的条目，下次激活时会被覆盖

### 12.9 与第二阶段的衔接

第一阶段做完后，第二阶段在**不破坏现有数据结构**的前提下增量加：

- 状态栏 + 快速切换（独立模块 `statusBar.ts`，订阅 `configStore` 变更）
- 导入 / 导出（新增两个 webview 消息 + UI 按钮）
- 内置 HTTP 中转服务（独立模块 `server/`，Profile 增加 `useBuiltinRouter` 字段，激活时 BaseURL 自动指向 `http://127.0.0.1:<port>`）
- 协议转换（HTTP 服务内部模块，独立于 Profile 配置）

> 第一阶段的数据模型 `Profile` 已经预留了扩展能力（自定义 envVars、自定义 Header），第二阶段只在其上加字段，不破坏兼容性。
