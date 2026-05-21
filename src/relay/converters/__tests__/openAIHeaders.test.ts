/**
 * @file OpenAI-compatible 请求头构建工具轻量测试。
 */

import * as assert from 'assert';

import type { ProviderConfig } from '../../../types';
import { buildOpenAIForwardHeaders, describeOpenAIAuthHeaders } from '../../openAIHeaders';

/** 单个测试用例。 */
interface TestCase {
    /** 测试名称。 */
    name: string;
    /** 测试函数。 */
    run: () => void;
}

/** 请求头测试用例集合。 */
const tests: TestCase[] = [
    {
        name: 'api_key 会转换为 OpenAI Bearer Authorization，并剥离下游鉴权头',
        run: () => {
            const headers = buildOpenAIForwardHeaders(provider({ authMode: 'api_key', apiKey: 'sk-provider' }), {
                authorization: 'Bearer downstream',
                'x-api-key': 'downstream-key',
                accept: 'application/json'
            });
            assert.strictEqual(headers.authorization, 'Bearer sk-provider');
            assert.strictEqual(headers['x-api-key'], undefined);
            assert.strictEqual(headers.accept, 'application/json');
        }
    },
    {
        name: 'auth_token 同样会转换为 OpenAI Bearer Authorization',
        run: () => {
            const headers = buildOpenAIForwardHeaders(provider({ authMode: 'auth_token', apiKey: 'token-provider' }), {});
            assert.strictEqual(headers.authorization, 'Bearer token-provider');
        }
    },
    {
        name: 'none 不会自动添加 Authorization',
        run: () => {
            const headers = buildOpenAIForwardHeaders(provider({ authMode: 'none', apiKey: 'sk-provider' }), {});
            assert.strictEqual(headers.authorization, undefined);
        }
    },
    {
        name: '自定义 Authorization 优先于默认 Bearer 逻辑',
        run: () => {
            const headers = buildOpenAIForwardHeaders(provider({
                authMode: 'api_key',
                apiKey: 'sk-provider',
                customHeaders: [{ key: 'Authorization', value: 'Bearer custom' }]
            }), {});
            assert.strictEqual(headers.authorization, 'Bearer custom');
        }
    },
    {
        name: '鉴权诊断可识别 provider-secret 来源',
        run: () => {
            const p = provider({ authMode: 'api_key', apiKey: 'sk-provider' });
            const headers = buildOpenAIForwardHeaders(p, {});
            assert.deepStrictEqual(describeOpenAIAuthHeaders(p, headers), {
                authMode: 'api_key',
                hasProviderSecret: true,
                hasAuthorizationHeader: true,
                hasXApiKeyHeader: false,
                authorizationSource: 'provider-secret'
            });
        }
    },
    {
        name: '鉴权诊断可识别 missing-secret',
        run: () => {
            const p = provider({ authMode: 'api_key', apiKey: '' });
            const headers = buildOpenAIForwardHeaders(p, {});
            assert.strictEqual(describeOpenAIAuthHeaders(p, headers).authorizationSource, 'missing-secret');
        }
    },
    {
        name: '鉴权诊断可识别 auth-disabled',
        run: () => {
            const p = provider({ authMode: 'none', apiKey: 'sk-provider' });
            const headers = buildOpenAIForwardHeaders(p, {});
            assert.strictEqual(describeOpenAIAuthHeaders(p, headers).authorizationSource, 'auth-disabled');
        }
    },
    {
        name: '鉴权诊断可识别 custom-headers 来源',
        run: () => {
            const p = provider({ authMode: 'api_key', apiKey: 'sk-provider', customHeaders: [{ key: 'Authorization', value: 'Bearer custom' }] });
            const headers = buildOpenAIForwardHeaders(p, {});
            assert.strictEqual(describeOpenAIAuthHeaders(p, headers).authorizationSource, 'custom-headers');
        }
    }
];

/**
 * 构造测试用 provider 配置。
 *
 * @param overrides 覆盖字段。
 * @returns ProviderConfig。
 */
function provider(overrides: Partial<ProviderConfig>): ProviderConfig {
    return {
        id: 'p',
        name: 'Provider',
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiType: 'openai-compatible',
        models: [],
        enabled: true,
        autoFetchModels: false,
        createdAt: 0,
        updatedAt: 0,
        authMode: 'api_key',
        customHeaders: [],
        apiKey: '',
        ...overrides
    };
}

/** 执行所有测试。 */
function main(): void {
    for (const test of tests) {
        test.run();
        // eslint-disable-next-line no-console
        console.log(`✓ ${test.name}`);
    }
}

main();
