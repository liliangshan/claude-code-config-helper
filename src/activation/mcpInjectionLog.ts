/**
 * MCP server 注入状态与 VS Code MCP 工具数量的启动期日志。
 *
 * 拆分自 extension.ts：把「CLI 启动前把三个内置 MCP server（浏览器 / VS Code /
 * 定时唤醒）的注入结果写进日志」以及「枚举 vscode.lm.tools 中的 MCP 工具数量」
 * 这两类纯排查用途的日志函数收敛到一个模块。
 *
 * 依赖方向：本模块只依赖 logger 与各 tools 模块的常量，不被其它模块反向引用。
 */
import * as vscode from 'vscode';

import type { ChatCliConfig } from '../chat/cli/types';
import { Logger } from '../logger';
import type { McpBridgeDescriptor } from '../mcpKit/registry';

/**
 * 记录某套内置 MCP server 的注入状态，便于排查工具在模型侧缺失的问题。
 *
 * @param config 即将用于启动 CLI 的配置。
 * @param descriptor 该套桥的静态声明，提供 server 名、relay 环境变量与入口模块。
 */
export function logMcpInjection(config: ChatCliConfig, descriptor: McpBridgeDescriptor): void {
    const { serverName, displayName, relayPortEnv } = descriptor;
    const server = config.mcpServers?.[serverName];
    if (!server) {
        Logger.info(`${displayName} MCP 注入状态：disabled`);
        return;
    }
    const entryName = descriptor.entryModule.split('/').pop() ?? '';
    Logger.info(`${displayName} MCP 注入状态：` + JSON.stringify({
        serverName,
        type: server.type,
        command: server.command || '',
        argsCount: Array.isArray(server.args) ? server.args.length : 0,
        hasEntrypointScript: Array.isArray(server.args) && server.args[0] === '-e' && typeof server.args[1] === 'string' && server.args[1].includes(entryName),
        relayPort: server.env?.[relayPortEnv] || '',
        toolPrefix: `mcp__${serverName}__`
    }));
}

/**
 * 在启动 Chat CLI 之前枚举当前 VS Code 注册的 MCP 工具数量并写入日志。
 *
 * VS Code 稳定 API `vscode.lm.tools` 返回 `LanguageModelToolInformation[]`，
 * 字段包括 `name / description / inputSchema / tags`。MCP 注册的工具通常带有
 * `mcp` 标签或名称以 `mcp_` 前缀开头（不同 VS Code 版本/扩展可能略有差异），
 * 这里把两种识别条件都纳入；为避免输出日志过长，不再打印工具明细。
 *
 * 本函数仅记录日志，不阻塞 CLI 启动，所有异常都会被吞掉并降级为一条 warn。
 */
export function logMcpToolsBeforeCliStart(): void {
    try {
        const lm = (vscode as unknown as { lm?: { tools?: ReadonlyArray<vscode.LanguageModelToolInformation> } }).lm;
        const allTools = lm?.tools;
        if (!allTools || !Array.isArray(allTools)) {
            Logger.warn('启动 Chat CLI 前枚举 MCP 工具：vscode.lm.tools 不可用');
            return;
        }
        const mcpTools = allTools.filter((tool) => {
            const tags = Array.isArray(tool.tags) ? tool.tags.map((tag: unknown) => String(tag).toLowerCase()) : [];
            if (tags.includes('mcp')) return true;
            if (typeof tool.name === 'string' && tool.name.toLowerCase().startsWith('mcp_')) return true;
            return false;
        });
        Logger.info(`启动 Chat CLI 前枚举到 MCP 工具：count=${mcpTools.length}/${allTools.length}`);
    } catch (error) {
        Logger.warn('启动 Chat CLI 前枚举 MCP 工具失败：' + (error instanceof Error ? error.message : String(error)));
    }
}
