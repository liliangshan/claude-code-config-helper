/** @file 浏览器 MCP 子进程到扩展宿主的 HTTP bridge。 */

import * as http from 'http';

import { BrowserToolHost, type BrowserCommandExecutor, type BrowserEnvironment, type BrowserToolResult } from './browserToolHost';
import { type BrowserToolName } from './tools';

export const BROWSER_TOOL_HTTP_PATH = '/llsccai/browser-tool';
export const BROWSER_TOOL_RELAY_PORT_ENV = 'LLS_BROWSER_TOOL_RELAY_PORT';

const MAX_BODY_BYTES = 1024 * 1024;

export interface BrowserToolHttpRequestBody {
    name: BrowserToolName;
    arguments?: Record<string, unknown>;
}

export class BrowserHttpCommandExecutor implements BrowserCommandExecutor {
    public constructor(private readonly port: number) {}

    public async executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T> {
        return await postJson<T>(this.port, { command, args });
    }
}

export function createBrowserHttpHost(port: number): BrowserToolHost {
    return new BrowserToolHost({
        commands: new BrowserHttpCommandExecutor(port),
        env: { uiKind: 1 as BrowserEnvironment['uiKind'] }
    });
}

export function createBrowserToolRelayHandler(host = new BrowserToolHost()) {
    return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
        const path = (req.url ?? '').split('?', 1)[0];
        if (path !== BROWSER_TOOL_HTTP_PATH) {
            return false;
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            writeJson(res, 405, { error: 'method_not_allowed' });
            return true;
        }
        try {
            const rawBody = await readRequestBody(req);
            const body = JSON.parse(rawBody) as { command?: unknown; args?: unknown };
            const command = typeof body.command === 'string' ? body.command : '';
            const args = Array.isArray(body.args) ? body.args : [];
            if (!command) {
                writeJson(res, 400, { error: 'command_required' });
                return true;
            }
            const result = await executeHostCommand(host, command, args);
            writeJson(res, 200, result);
        } catch (err) {
            writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
    };
}

async function executeHostCommand(host: BrowserToolHost, command: string, args: unknown[]): Promise<unknown> {
    const toolCall = mapCommandToToolCall(command, args);
    const result = await host.execute(toolCall.name, toolCall.arguments);
    if (result.isError) {
        throw new Error(result.content[0]?.type === 'text' ? result.content[0].text : 'Browser tool failed.');
    }
    const content = result.content[0];
    if (!content) return null;
    if (content.type === 'image') return content;
    try {
        return JSON.parse(content.text);
    } catch {
        return content.text;
    }
}

function mapCommandToToolCall(command: string, args: unknown[]): BrowserToolHttpRequestBody {
    switch (command) {
        case 'openBrowserPage':
            return { name: 'browser_open', arguments: { url: args[0] } };
        case 'navigatePage':
            return { name: 'browser_navigate', arguments: { url: args[0] } };
        case 'readPage':
            return { name: 'browser_get_content', arguments: {} };
        case 'screenshotPage':
            return { name: 'browser_screenshot', arguments: {} };
        case 'runPlaywrightCode':
            return { name: 'browser_eval', arguments: { script: args[0] } };
        default:
            throw new Error(`Unknown browser command: ${command}`);
    }
}

function postJson<T>(port: number, body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: BROWSER_TOOL_HTTP_PATH,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if ((res.statusCode ?? 500) >= 400) {
                    reject(new Error(data || `HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data) as T);
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.setEncoding('utf-8');
        req.on('data', (chunk: string) => {
            size += Buffer.byteLength(chunk);
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Browser tool request body is too large.'));
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}
