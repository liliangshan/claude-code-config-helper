/**
 * @file 一套 MCP 桥的静态声明（descriptor）。
 *
 * 注入（cliConfig）、日志（mcpInjectionLog）、HTTP relay 与 stdio server 四处
 * 此前各自散落同一批常量，这里收敛为单一数据源。
 *
 * 约束：本目录下的文件会被 MCP 子进程加载，禁止静态 import 宿主模块
 * （尤其是 `vscode`），只允许 Node 内置模块与 `import type`。
 */

import type { McpToolSchema } from './types';

/** 一套 MCP 桥的全部静态声明，注入 / 日志 / bridge / server 四处共用同一份。 */
export interface McpBridgeDescriptor<TName extends string = string> {
    /** Claude CLI mcpServers 字典中的 server 名，如 'llsccaiVscode'。 */
    serverName: string;
    /** initialize 响应里上报的 server 标识，如 'llsccai-vscode'。 */
    serverInfoName: string;
    /** 启动期日志里的人读名称，如 'VS Code'。 */
    displayName: string;
    /** 扩展宿主 relay 暴露的 HTTP 路径，如 '/llsccai/vscode-tool'。 */
    httpPath: string;
    /** 向子进程传递 relay 端口的环境变量名，如 'LLS_VSCODE_TOOL_RELAY_PORT'。 */
    relayPortEnv: string;
    /**
     * 子进程入口模块路径，作为 `require.resolve` 的入参。
     *
     * 相对路径以调用 require.resolve 的模块（chat/cli/cliConfig.ts）为基准，
     * 不是以本 descriptor 所在文件为基准。
     */
    entryModule: string;
    /** 子进程入口模块导出的启动函数名，如 'startVscodeMcpServer'。 */
    entryStarter: string;
    /** tools/list 返回的工具全集。 */
    schemas: readonly McpToolSchema<TName>[];
    /** 未接通 relay 时回给模型的说明文案，随 isError 一起返回。 */
    unavailableMessage: string;
    /** 请求体超过 MAX_BODY_BYTES 时抛出的错误文案。 */
    bodyTooLargeMessage: string;
}
