/** @file 浏览器 MCP 工具常量与 schema。 */

import { createToolNameGuard, type McpToolSchema } from '../mcpKit/types';

/** browser MCP server 在 Claude CLI mcpServers 注册时使用的 server 名。 */
export const BROWSER_MCP_SERVER_NAME = 'llsccaiBrowser' as const;

/** Claude CLI 暴露给主模型时看到的完整工具名前缀。 */
export const BROWSER_FULL_TOOL_PREFIX = `mcp__${BROWSER_MCP_SERVER_NAME}__` as const;

/** 底层调用的 VS Code 内置 Language Model 浏览器工具名（snake_case，实测）。 */
export const LM_BROWSER_TOOLS = {
    open: 'open_browser_page',
    navigate: 'navigate_page',
    read: 'read_page',
    screenshot: 'screenshot_page',
    eval: 'run_playwright_code'
} as const;

/** 工具裸名（未加 mcp__<server>__ 前缀）。 */
export type BrowserToolName =
    | 'browser_open'
    | 'browser_navigate'
    | 'browser_get_content'
    | 'browser_screenshot'
    | 'browser_console'
    | 'browser_eval';

/** tools/list 返回的工具定义全集，不按 VS Code 版本裁剪。 */
export const BROWSER_TOOL_SCHEMAS: readonly McpToolSchema<BrowserToolName>[] = [
    {
        name: 'browser_open',
        description: 'Open a URL in the VS Code integrated browser (desktop only).',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL to open.' },
                forceNew: {
                    type: 'boolean',
                    description: 'Force a new page even if a similar one is already open.'
                }
            },
            required: ['url']
        }
    },
    {
        name: 'browser_navigate',
        description: 'Navigate the current integrated browser page to a URL.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL to navigate to.' }
            },
            required: ['url']
        }
    },
    {
        name: 'browser_get_content',
        description: 'Read the DOM / text content of the current integrated browser page.',
        inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'browser_screenshot',
        description: 'Capture a screenshot of the current integrated browser page. Returns an image.',
        inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'browser_console',
        description: 'Read console errors/warnings from the current integrated browser page.',
        inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'browser_eval',
        description:
            'Run arbitrary Playwright/JS code in the integrated browser. ' +
            'Full Playwright API is available, e.g. await page.evaluate(() => document.title). ' +
            'Returns the JSON-serialized result.',
        inputSchema: {
            type: 'object',
            properties: {
                script: { type: 'string', description: 'Playwright/page JS to execute.' }
            },
            required: ['script']
        }
    }
] as const;

/** 判断输入是否为受支持的浏览器工具名。 */
export const isBrowserToolName = createToolNameGuard(BROWSER_TOOL_SCHEMAS);
