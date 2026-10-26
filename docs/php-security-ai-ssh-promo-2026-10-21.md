# 如何让 AI 帮你修复 PHP 漏洞 CVE-2026-109618、CVE-2026-109619？Claude Code Config Helper + mcp-server-ssh 实用指南

PHP 安全补丁已发布，运行 PHP 网站的用户请尽快检查并更新。

2026 年 10 月 21 日，PHP 官方发布安全公告：**CVE-2026-109618、CVE-2026-109619** 两个严重漏洞可能导致未经身份验证的远程代码执行，涉及 PHP-FPM、Apache mod_php、php-cgi、FrankenPHP、LiteSpeed 等处理 Web 请求的 PHP 环境。

本次官方修复版本为：**PHP 8.5.12、8.4.27、8.3.36、8.2.35**。使用发行版软件包的用户，也应核对厂商是否已回移安全补丁，不能只看上游版本号。

官方公告：https://www.php.net/archive/2026.php#2026-10-21-5

知道要升级，却不确定服务器装了哪个 PHP、网站实际使用哪个版本、应该怎么更新？这类工作，可以让 AI 协助完成。

通过 **Claude Code Config Helper（LLS CCAI）** 和 **@liangshanli/mcp-server-ssh**，你可以让 AI 从“给一份升级教程”，进一步走到“检查真实服务器、提出修复方案，经你确认后执行，再验证结果”。

## 一、安装 VS Code 插件

打开 VS Code，点击左侧的**扩展**图标，或按 `Ctrl+Shift+X`（macOS 为 `Cmd+Shift+X`），在扩展商店搜索：

**Claude Code Config Helper**

找到发布者为 **liliangshan** 的扩展，点击**安装**。

安装后，打开扩展入口，按引导配置本地 **Claude Code CLI**、模型服务和 API Key，再打开内置聊天。插件需要可用的 CLI 和模型服务，不是安装后就自带免费模型。

**这个插件不只是聊天窗口：**它提供模型配置、内置浏览器工具和 CC 任务流，方便 AI 读取官方公告、整理处理方案，并在同一工作区逐步推进任务。

项目地址：https://github.com/liliangshan/claude-code-config-helper

## 二、安装 SSH MCP，让 AI 能连接你的服务器

在运行 VS Code 和 Claude CLI 的本地环境准备 **Node.js 20 或更高版本**，打开终端执行：

```bash
npm install -g @liangshanli/mcp-server-ssh
```

安装后可检查命令是否可用：

```bash
mcp-server-ssh --version
```

这个 MCP 支持 Windows、macOS、Linux，无需本地额外安装 PuTTY、WSL 或 SCP。它通过 SSH 连接远端服务器，提供命令执行和 SFTP 单文件上传、下载能力，命令结果包含输出、错误和退出状态。

**MCP 装在本地，PHP 更新发生在远端服务器，两者不要混淆。**远端服务器需要开放可访问的 SSH 服务；文件传输还需要 SFTP 子系统。

项目地址：https://github.com/liliangshan/mcp-server-ssh

npm 地址：https://www.npmjs.com/package/@liangshanli/mcp-server-ssh

## 三、不想手写配置？把下面的提示词交给 AI

先用 VS Code 打开准备使用的项目文件夹，再把下面这段发到插件的聊天窗口。替换其中的项目名称、服务器地址、SSH 账号和密码即可。

这里使用 `npx` 启动 MCP，并采用密码认证。将配置中的提示文字替换为自己的连接信息，**不要把填写了真实密码的配置提交到代码仓库或用于公开分享。**

### 安装与配置提示词

> 请帮我在本地安装并配置 SSH MCP，供当前工作区的 Claude Code 使用。
>
> 1. 先检查 Node.js 和 npm 是否可用，Node.js 需为 20 或更高版本。若不满足，说明原因并停止安装。
> 2. 检查 `mcp-server-ssh` 是否已安装；未安装时执行 `npm install -g @liangshanli/mcp-server-ssh`。如已安装，先报告版本，不擅自升级。安装后用 `mcp-server-ssh --version` 验证。
> 3. 在当前工作区根目录创建或更新 `.mcp.json`，配置内容见下方。如果文件已存在，先读取它，仅合并 `mcpServers.ssh-server`，保留其他 MCP 和配置；同名配置有冲突时先询问我，不要覆盖整个文件。
> 4. 检查 `.gitignore`，按需加入根目录 `/.mcp.json`，保留已有内容。如果该文件已被 Git 跟踪，请提醒我，不要擅自修改 Git 索引。
> 5. 检查 JSON 格式和占位符。尚未填写真实信息时不要尝试连接。不要读取、展示或上传私钥内容，也不要把私钥口令写进聊天。
> 6. 完成后告诉我如何重新启动当前聊天的 Claude CLI 以加载配置，并按客户端提示批准工作区 MCP。此阶段只安装和配置本地工具，不执行任何远程命令。
>
> `.mcp.json` 使用以下结构：

```json
{
  "mcpServers": {
    "ssh-server": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@liangshanli/mcp-server-ssh"
      ],
      "env": {
        "PROJECT_NAME": "填写项目名称或服务器标识",
        "SSH_HOST": "填写服务器IP或域名",
        "SSH_PORT": "22",
        "SSH_USERNAME": "填写SSH登录账号",
        "SSH_PASSWORD": "填写SSH登录密码",
        "SSH_SKIP_HOST_VERIFICATION": "true",
        "SSH_COMMAND_TIMEOUT_MS": "300000"
      }
    }
  }
}
```

配置说明：

- `.mcp.json` 放在**工作区根目录**，不是 `.vscode/mcp.json`；两者格式和加载方式不同。
- `PROJECT_NAME` 是用于区分服务器的标识；`SSH_HOST`、`SSH_USERNAME`、`SSH_PASSWORD` 分别填写服务器地址、登录账号和密码，建议使用最小权限账号。
- `SSH_COMMAND_TIMEOUT_MS` 为 `300000`，表示命令超时上限为 5 分钟；超时断开不保证远程进程已停止，重试前需要检查实际状态。
- 此示例按简便连接方式设置 `SSH_SKIP_HOST_VERIFICATION=true`，会跳过主机身份校验，存在中间人攻击风险。生产环境建议删除该项，改为设置从可信控制台或管理员处取得的 `SSH_HOST_FINGERPRINT`。
- `npx -y` 会在需要时下载并启动该包，不依赖前面全局安装的命令；正式使用可固定已验证的包版本。
- 如果重启 CLI 后找不到 `npx`，让 AI 检查 Node.js/npm 是否在 VS Code 的 PATH 中。Windows 客户端如无法直接启动 `npx`，可按 MCP README 使用 `cmd /c npx` 方式。
- 如果当前启用了 `strictMcpConfig`，CLI 可能不读取项目 `.mcp.json`。让 AI 检查并说明原因，经你确认后再将同一服务配置合并到 `claudeCodeConfigHelper.chat.mcpServers`，不要静默修改权限或严格模式。

配置保存后，点击扩展聊天界面右上角的**“重新启动”**按钮，重启 Claude CLI，让 MCP 配置生效。重启后，可以先让 AI 调用 `ssh_test_connection` 测试连接和认证；只有启用主机指纹校验时，该测试才会同时校验服务器身份。连接成功后，再进行服务器检查。

## 四、让 AI 检查 PHP 漏洞，并给出修复方案

把下面这段发给 AI：

> 请通过浏览器读取 PHP 官方安全公告：https://www.php.net/archive/2026.php#2026-10-21-5
>
> 仅通过 `ssh-server` MCP 检查我拥有并授权操作的这台服务器，判断是否需要针对 CVE-2026-109618、CVE-2026-109619 更新 PHP。
>
> 先做只读检查：识别操作系统、PHP 安装来源、完整包版本、网站实际使用的 PHP 服务、必要扩展，以及是否有多版本、Docker 或面板管理。不要只根据 `php -v` 判断，发行版回移补丁需要核对厂商公告。
>
> 根据实际环境给出修复方案，包含目标版本或补丁依据、兼容性检查、备份方式、维护窗口、服务重启和恢复方案。将检查结果与计划写入工作区的 `php-security-update-plan.md`。
>
> 检查完成后，同时在该文档中写明升级前需要提前备份的内容，包括相关 PHP 和 Web 服务配置、网站文件、业务数据库，以及适用的容器或服务器快照；根据实际环境列出备份范围、建议方式、保存位置、恢复验证方法和需人工完成的事项。此阶段只编写备份说明，不执行备份；提醒我完成并验证备份后，再进行升级。
>
> 本阶段不要安装更新、替换软件源、修改服务器配置或重启服务；方案完成后等我确认。不要运行攻击性 PoC，也不要输出凭据或敏感业务数据。

这样，AI 拿到的不是一个模糊的“升级 PHP”任务，而是明确的公告、目标服务器和检查范围。

## 五、确认后执行，最后看真实结果

审核计划、确认备份和维护窗口后，再告诉 AI：

> 请按我确认的 `php-security-update-plan.md` 协助修复，只操作 `ssh-server` 对应服务器。
>
> 每次安装升级、修改配置、覆盖文件或重启服务前，先展示具体操作与影响，得到我明确确认后再执行，不擅自换源或跨 PHP 分支升级。
>
> 根据命令返回结果判断是否成功。遇到失败、超时或断线，先核查实际状态，不盲目重试；需要交互式 sudo 或人工输入密码时停止并说明。
>
> 完成后核对实际 Web PHP 服务是否运行修复构建、旧工作进程是否退出、扩展与日志是否正常，并协助检查我批准的网站页面。最后输出执行报告，列明已完成、失败、跳过和未验证的项目，不把临时缓解或仅页面正常写成漏洞已修复。

步骤较多时，可以把计划文件加入聊天上下文，使用插件的 **CC 任务流**组织进度；任务流不代替变更审批和结果验收。

**Claude Code Config Helper 让 AI 看懂问题、组织步骤，SSH MCP 让 AI 在授权范围内操作真实环境。你保留关键决定，AI 协助把事情做完。**

PHP 安全更新只是一个例子。服务器环境检查、日志排查、部署验证，也可以用这套组合从“问 AI 怎么做”，走向“让 AI 协助执行并验证”。

打开 VS Code 扩展商店，搜索 **Claude Code Config Helper**，再安装 **@liangshanli/mcp-server-ssh**，从自己测试服务器的一次只读检查开始。

> 提醒：只操作自己拥有或已获授权的服务器，优先使用最小权限账号，保留工具审批。SSH MCP 不是只读沙箱，也不自带备份、自动回滚或补丁检测功能；工具输出可能交给所选模型服务处理。生产升级请先测试、备份并安排维护窗口。

---

# How Can AI Help You Fix PHP Vulnerabilities CVE-2026-109618 and CVE-2026-109619? A Practical Guide to Claude Code Config Helper + mcp-server-ssh

PHP security patches are now available. If you run PHP websites, check your environments and update promptly.

On October 21, 2026, the PHP project published a security advisory for **CVE-2026-109618 and CVE-2026-109619**, two critical vulnerabilities that can allow unauthenticated remote code execution. They affect PHP installations serving web requests, including PHP-FPM, Apache mod_php, php-cgi, FrankenPHP, and LiteSpeed.

The upstream releases fixing these vulnerabilities are **PHP 8.5.12, 8.4.27, 8.3.36, and 8.2.35**. If you use distribution packages, also check whether your vendor has backported the patches—do not rely on the upstream version number alone.

Official advisory: https://www.php.net/archive/2026.php#2026-10-21-5

You know you need to update, but which PHP installation is on your server? Which version actually serves your website? What is the right upgrade procedure? AI can help you work through these questions.

With **Claude Code Config Helper (LLS CCAI)** and **@liangshanli/mcp-server-ssh**, AI can go beyond giving you an upgrade tutorial: it can inspect your actual server, propose a remediation plan, execute approved changes, and help verify the results.

## 1. Install the VS Code Extension

Open VS Code and click the **Extensions** icon on the left, or press `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS). Search the Extensions Marketplace for:

**Claude Code Config Helper**

Find the extension published by **liliangshan** and click **Install**.

After installation, open the extension and follow its setup guidance to configure your local **Claude Code CLI**, model provider, and API key. Then open the built-in chat. The extension requires a working CLI and model service; installing it does not include a free model.

**This extension is more than a chat window:** it provides model configuration, built-in browser tools, and CC Task Flow, helping AI read official advisories, organize a plan, and work through tasks within the same workspace.

Project: https://github.com/liliangshan/claude-code-config-helper

## 2. Install SSH MCP to Let AI Connect to Your Server

Make sure **Node.js 20 or later** is available in the local environment running VS Code and Claude CLI. Open a terminal and run:

```bash
npm install -g @liangshanli/mcp-server-ssh
```

After installation, check that the command is available:

```bash
mcp-server-ssh --version
```

This MCP server supports Windows, macOS, and Linux without requiring additional local installations of PuTTY, WSL, or SCP. It connects to remote servers over SSH and provides command execution and single-file SFTP uploads and downloads. Command results include output, errors, and exit status.

**The MCP server runs locally; PHP updates take place on the remote server. These are separate environments.** The remote server must provide a reachable SSH service, and file transfers also require its SFTP subsystem.

Project: https://github.com/liliangshan/mcp-server-ssh

npm: https://www.npmjs.com/package/@liangshanli/mcp-server-ssh

## 3. Prefer Not to Write the Configuration Yourself? Give AI This Prompt

First, open your project folder in VS Code. Then send the following prompt in the extension's chat. Replace the project name, server address, SSH username, and password with your own values.

This example uses `npx` to launch the MCP server with password authentication. Replace the placeholders with your connection details, and **never commit or publicly share a configuration containing a real password**.

### Installation and Configuration Prompt

> Please install and configure SSH MCP locally for Claude Code in the current workspace.
>
> 1. Check that Node.js and npm are available. Node.js must be version 20 or later. If the requirements are not met, explain why and stop the installation.
> 2. Check whether `mcp-server-ssh` is already installed. If not, run `npm install -g @liangshanli/mcp-server-ssh`. If it is installed, report the version without upgrading it on your own. Verify the installation with `mcp-server-ssh --version`.
> 3. Create or update `.mcp.json` in the current workspace root using the configuration below. If the file already exists, read it first and merge only `mcpServers.ssh-server`, preserving all other MCP entries and settings. Ask me before resolving a conflicting entry with the same name; do not overwrite the entire file.
> 4. Check `.gitignore` and add the root-level `/.mcp.json` entry if needed, preserving existing content. If the file is already tracked by Git, notify me without changing the Git index on your own.
> 5. Validate the JSON and check for unfilled placeholders. Do not attempt a connection until real connection details are provided. Do not read, display, or upload private key contents, or include private key passphrases in chat.
> 6. When finished, explain how to restart the current chat's Claude CLI to load the configuration and approve the workspace MCP server when prompted by the client. At this stage, only install and configure local tools; do not execute any remote commands.
>
> Use the following structure for `.mcp.json`:

```json
{
  "mcpServers": {
    "ssh-server": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@liangshanli/mcp-server-ssh"
      ],
      "env": {
        "PROJECT_NAME": "ENTER_PROJECT_NAME_OR_SERVER_LABEL",
        "SSH_HOST": "ENTER_SERVER_IP_OR_HOSTNAME",
        "SSH_PORT": "22",
        "SSH_USERNAME": "ENTER_SSH_USERNAME",
        "SSH_PASSWORD": "ENTER_SSH_PASSWORD",
        "SSH_SKIP_HOST_VERIFICATION": "true",
        "SSH_COMMAND_TIMEOUT_MS": "300000"
      }
    }
  }
}
```

Configuration notes:

- Place `.mcp.json` in the **workspace root**, not in `.vscode/mcp.json`. These files use different formats and loading mechanisms.
- `PROJECT_NAME` is a label for identifying the server. Set `SSH_HOST`, `SSH_USERNAME`, and `SSH_PASSWORD` to your server address, login username, and password. Prefer a least-privileged account.
- `SSH_COMMAND_TIMEOUT_MS` is set to `300000`, giving commands a five-minute timeout limit. Disconnecting on timeout does not guarantee that the remote process has stopped; check its actual state before retrying.
- For a simpler connection setup, this example sets `SSH_SKIP_HOST_VERIFICATION=true`. This skips server identity verification and introduces a man-in-the-middle attack risk. For production, remove this setting and configure `SSH_HOST_FINGERPRINT` using a fingerprint obtained from a trusted server console or administrator.
- `npx -y` downloads and launches the package when needed; it does not depend on the globally installed command above. For regular use, consider pinning a verified package version.
- If the CLI cannot find `npx` after restarting, ask AI to check whether Node.js/npm are on VS Code's PATH. If a Windows client cannot launch `npx` directly, follow the MCP README's `cmd /c npx` approach.
- If `strictMcpConfig` is enabled, the CLI may not load the project's `.mcp.json`. Ask AI to investigate and explain. With your approval, it can merge the same server entry into `claudeCodeConfigHelper.chat.mcpServers`; it must not silently change permissions or strict mode.

After saving the configuration, click the **Restart** button in the **upper-right corner of the extension's chat interface** to restart Claude CLI and activate the MCP configuration. Then ask AI to call `ssh_test_connection` to test connectivity and authentication. This test verifies the server's identity only when host fingerprint verification is enabled. Once the connection succeeds, proceed with server checks.

## 4. Ask AI to Check the PHP Vulnerabilities and Propose a Remediation Plan

Send AI the following prompt:

> Please use the browser to read the official PHP security advisory: https://www.php.net/archive/2026.php#2026-10-21-5
>
> Use only the `ssh-server` MCP entry to inspect this server, which I own and authorize you to access, and determine whether PHP needs updating to address CVE-2026-109618 and CVE-2026-109619.
>
> Start with read-only checks: identify the operating system, PHP installation source, full package versions, the PHP service actually serving the website, required extensions, and whether multiple PHP versions, Docker, or a hosting control panel are involved. Do not rely solely on `php -v`; check vendor advisories for distribution-backported patches.
>
> Propose a remediation plan based on the actual environment, covering the target version or patch evidence, compatibility checks, backup methods, a maintenance window, service restarts, and a recovery plan. Write the findings and plan to `php-security-update-plan.md` in the workspace.
>
> After the inspection, also document what must be backed up before upgrading, including relevant PHP and web server configurations, website files, application databases, and container or server snapshots where applicable. Based on the environment, specify the backup scope, recommended methods, storage locations, restoration verification methods, and any steps requiring manual action. At this stage, document the backup requirements only; do not perform backups. Remind me to complete and verify the backups before proceeding with the upgrade.
>
> Do not install updates, switch package repositories, modify server configurations, or restart services at this stage. Wait for my approval after completing the plan. Do not run offensive proof-of-concept exploits or expose credentials or sensitive business data.

This gives AI more than a vague request to “upgrade PHP”: it provides a specific advisory, target server, and inspection scope.

## 5. Execute Only After Approval, Then Verify the Actual Results

After reviewing the plan and confirming the backups and maintenance window, tell AI:

> Please help carry out the remediation according to the `php-security-update-plan.md` I approved. Operate only on the server configured under `ssh-server`.
>
> Before each installation or upgrade, configuration change, file overwrite, or service restart, show the exact action and its impact, and obtain my explicit approval before proceeding. Do not switch package repositories or upgrade across PHP branches on your own.
>
> Judge success based on the command results. If a command fails, times out, or disconnects, check the actual state before retrying. If interactive sudo or manual password entry is required, stop and explain.
>
> Afterward, verify that the PHP service actually serving web requests is running a patched build, that old worker processes have exited, and that extensions and logs are healthy. Help check the website pages I approve. Finally, provide an execution report listing completed, failed, skipped, and unverified items. Do not describe temporary mitigations or working pages alone as proof that the vulnerabilities are fixed.

For longer procedures, add the plan file to the chat context and use the extension's **CC Task Flow** to organize progress. Task Flow does not replace change approval or acceptance checks.

**Claude Code Config Helper helps AI understand the issue and organize the steps. SSH MCP lets AI operate on real environments within your authorization. You keep control of key decisions; AI helps get the work done.**

PHP security updates are just one example. You can use the same combination for server environment checks, log investigation, and deployment verification—moving from “ask AI how to do it” to “let AI help execute and verify it.”

Open the VS Code Extensions Marketplace, search for **Claude Code Config Helper**, and install **@liangshanli/mcp-server-ssh**. Start with a read-only inspection of your own test server.

> Reminder: Operate only on servers you own or are authorized to access. Prefer least-privileged accounts and keep tool approvals enabled. SSH MCP is not a read-only sandbox and does not include built-in backups, automatic rollback, or patch detection. Tool output may be processed by your selected model provider. Before production upgrades, test, back up, and schedule a maintenance window.

