/**
 * @file 用户级专家触发前缀识别工具。
 *
 * 按需专家方案下，用户可通过两种前缀强制走专家：
 * 1. `@llsExpert <question>`（兼容旧 muscle-memory）
 * 2. `/expert <question>`（推荐写法）
 *
 * 本模块只提供纯函数（无 vscode 依赖），便于单元测试。
 *
 * 不再提供 `containsExpertHandoff`——按需专家方案下不再做 dispatcher 输出
 * 文本路由切换，避免代码片段 / 引用日志中的 `@llsExpert` 误触发。
 */

/** 用户输入开头的 `@llsExpert` 前缀正则（吃掉紧随的空白）。 */
const AT_EXPERT_PREFIX_PATTERN = /^@llsExpert\b\s*/i;

/** 用户输入开头的 `/expert` 前缀正则（吃掉紧随的空白）。 */
const SLASH_EXPERT_PREFIX_PATTERN = /^\/expert\b\s*/i;

/**
 * 判断用户输入是否以 `@llsExpert` 或 `/expert` 开头。
 *
 * 仅匹配字符串开头（允许前置 trim），避免用户在正文中提到该前缀时被误判。
 *
 * @param text 用户输入原文。
 * @returns 是否触发用户强制专家路由。
 */
export function startsWithExpertPrefix(text: string): boolean {
    const trimmed = text.trim();
    return AT_EXPERT_PREFIX_PATTERN.test(trimmed) || SLASH_EXPERT_PREFIX_PATTERN.test(trimmed);
}

/**
 * 剥除用户输入开头的专家触发前缀（`@llsExpert` 或 `/expert`）。
 *
 * 仅剥除开头位置的前缀，文本中其它位置的同名 token 保留。同时对输入做 trim。
 *
 * @param text 用户输入原文。
 * @returns 已剥除前缀的文本；若开头没有前缀则返回 trim 后的原文。
 */
export function stripExpertPrefix(text: string): string {
    const trimmed = text.trim();
    return trimmed
        .replace(AT_EXPERT_PREFIX_PATTERN, '')
        .replace(SLASH_EXPERT_PREFIX_PATTERN, '');
}
