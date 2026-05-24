/**
 * @file expertMcpServer 单元测试。
 *
 * 覆盖范围：
 * 1. `initialize` 返回正确的 protocolVersion / capabilities / serverInfo；
 * 2. `tools/list` 返回 ask_expert 工具且 schema 字段齐全；
 * 3. `tools/call` 正确路由到注入的 handler，未注入时使用 stub；
 * 4. `tools/call` 校验工具名 / 必填参数；
 * 5. 未 initialize 直接调 tools/list 应返回 INVALID_REQUEST；
 * 6. `ping` 总是返回空对象；
 * 7. 未知方法返回 METHOD_NOT_FOUND；
 * 8. 通知（无 id）不返回响应；非法 JSON-RPC 消息返回 INVALID_REQUEST。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    ASK_EXPERT_TOOL_DEFINITION,
    EXPERT_MCP_SERVER_CAPABILITIES,
    EXPERT_MCP_SERVER_INFO,
    ExpertMcpServer,
    JSON_RPC_INVALID_PARAMS,
    JSON_RPC_INVALID_REQUEST,
    JSON_RPC_METHOD_NOT_FOUND,
    MCP_PROTOCOL_VERSION
} from '../expertMcpServer';
import type { JsonRpcErrorResponse, JsonRpcSuccessResponse } from '../expertMcpServer';
import { EXPERT_TOOL_NAME } from '../expertConstants';

/**
 * 简化的「跑一轮 initialize 完成握手」工具函数。
 *
 * @param server 待初始化的 server。
 */
async function performInitialize(server: ExpertMcpServer): Promise<void> {
    const resp = await server.dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.0.1' }
        }
    });
    assert.ok(resp, 'initialize 必须返回响应');
    assert.ok('result' in resp, 'initialize 不应返回 error');
    await server.dispatch({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
    });
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

test('initialize 返回 protocolVersion / capabilities / serverInfo', async () => {
    const server = new ExpertMcpServer();
    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'c', version: '1' }
        }
    })) as JsonRpcSuccessResponse;

    assert.equal(resp.jsonrpc, '2.0');
    assert.equal(resp.id, 10);
    const result = resp.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.deepEqual(result.capabilities, EXPERT_MCP_SERVER_CAPABILITIES);
    assert.deepEqual(result.serverInfo, EXPERT_MCP_SERVER_INFO);
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

test('tools/list 返回 ask_expert 工具', async () => {
    const server = new ExpertMcpServer();
    await performInitialize(server);

    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
    })) as JsonRpcSuccessResponse;

    const result = resp.result as { tools: typeof ASK_EXPERT_TOOL_DEFINITION[] };
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, EXPERT_TOOL_NAME);
    assert.ok(result.tools[0].description.length > 0);
    assert.equal(result.tools[0].inputSchema.type, 'object');
    assert.deepEqual(result.tools[0].inputSchema.required, ['question']);
    assert.ok(result.tools[0].inputSchema.properties.question);
});

test('tools/list 在未 initialize 时返回 INVALID_REQUEST', async () => {
    const server = new ExpertMcpServer();
    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list'
    })) as JsonRpcErrorResponse;

    assert.equal(resp.error.code, JSON_RPC_INVALID_REQUEST);
    assert.match(resp.error.message, /initialize/i);
});

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

test('tools/call 默认 stub 实现：返回包含 question 摘要的占位结论', async () => {
    const server = new ExpertMcpServer();
    await performInitialize(server);

    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
            name: EXPERT_TOOL_NAME,
            arguments: { question: 'Why is the sky blue?' }
        }
    })) as JsonRpcSuccessResponse;

    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    // 占位 stub 文案已从「Phase 3 placeholder」更新为「No relay env detected」，
    // 仍保留 `[Expert mode stub]` 前缀作为稳定锚点。
    assert.match(result.content[0].text, /Expert mode stub/);
    assert.match(result.content[0].text, /Why is the sky blue\?/);
    assert.equal(result.isError, false);
});

test('tools/call 注入的 handler 会被调用，参数透传正确', async () => {
    let receivedArgs: unknown;
    const server = new ExpertMcpServer({
        askExpertHandler: async (args) => {
            receivedArgs = args;
            return { finalAnswer: '专家结论：测试通过', isError: false };
        }
    });
    await performInitialize(server);

    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
            name: EXPERT_TOOL_NAME,
            arguments: {
                question: 'how should we refactor?',
                context: 'optional ctx',
                goal: 'plan',
                constraints: 'read-only'
            }
        }
    })) as JsonRpcSuccessResponse;

    const result = resp.result as { content: Array<{ text: string }> };
    assert.equal(result.content[0].text, '专家结论：测试通过');
    assert.deepEqual(receivedArgs, {
        question: 'how should we refactor?',
        context: 'optional ctx',
        goal: 'plan',
        constraints: 'read-only'
    });
});

test('tools/call 缺少 question 参数返回 INVALID_PARAMS', async () => {
    const server = new ExpertMcpServer();
    await performInitialize(server);
    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: EXPERT_TOOL_NAME, arguments: {} }
    })) as JsonRpcErrorResponse;
    assert.equal(resp.error.code, JSON_RPC_INVALID_PARAMS);
    assert.match(resp.error.message, /question/);
});

test('tools/call question 为空白字符串返回 INVALID_PARAMS', async () => {
    const server = new ExpertMcpServer();
    await performInitialize(server);
    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: EXPERT_TOOL_NAME, arguments: { question: '   ' } }
    })) as JsonRpcErrorResponse;
    assert.equal(resp.error.code, JSON_RPC_INVALID_PARAMS);
});

test('tools/call 调用未知工具返回 METHOD_NOT_FOUND', async () => {
    const server = new ExpertMcpServer();
    await performInitialize(server);
    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: { x: 1 } }
    })) as JsonRpcErrorResponse;
    assert.equal(resp.error.code, JSON_RPC_METHOD_NOT_FOUND);
});

test('tools/call handler 抛错时返回 INTERNAL_ERROR', async () => {
    const server = new ExpertMcpServer({
        askExpertHandler: async () => {
            throw new Error('boom');
        }
    });
    await performInitialize(server);
    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: EXPERT_TOOL_NAME, arguments: { question: 'hi' } }
    })) as JsonRpcErrorResponse;
    assert.ok('error' in resp);
    assert.match(resp.error.message, /boom/);
});

// ---------------------------------------------------------------------------
// 其它方法
// ---------------------------------------------------------------------------

test('ping 总是返回空对象', async () => {
    const server = new ExpertMcpServer();
    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 100,
        method: 'ping'
    })) as JsonRpcSuccessResponse;
    assert.deepEqual(resp.result, {});
});

test('未知方法返回 METHOD_NOT_FOUND', async () => {
    const server = new ExpertMcpServer();
    await performInitialize(server);
    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 101,
        method: 'resources/list'
    })) as JsonRpcErrorResponse;
    assert.equal(resp.error.code, JSON_RPC_METHOD_NOT_FOUND);
});

// ---------------------------------------------------------------------------
// 通知与非法消息
// ---------------------------------------------------------------------------

test('通知（无 id）不返回响应', async () => {
    const server = new ExpertMcpServer();
    const resp = await server.dispatch({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
    });
    assert.equal(resp, null);
});

test('非 JSON-RPC 2.0 消息返回 INVALID_REQUEST', async () => {
    const server = new ExpertMcpServer();
    const resp = (await server.dispatch({
        // 缺 jsonrpc 字段
        id: 1,
        method: 'tools/list'
    })) as JsonRpcErrorResponse;
    assert.equal(resp.error.code, JSON_RPC_INVALID_REQUEST);
});

test('缺 method 字段返回 INVALID_REQUEST', async () => {
    const server = new ExpertMcpServer();
    const resp = (await server.dispatch({
        jsonrpc: '2.0',
        id: 2
    } as Record<string, unknown>)) as JsonRpcErrorResponse;
    assert.equal(resp.error.code, JSON_RPC_INVALID_REQUEST);
});
