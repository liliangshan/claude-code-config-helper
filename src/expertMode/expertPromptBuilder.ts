/**
 * @file 构造专家初始消息（system + first user）。
 *
 * 专家 CLI 是**全新 session**，不携带主对话历史。它启动后收到的首条 user
 * 消息必须自包含全部信息，且 system prompt 中必须明确：
 *
 * 1. 它不知道主对话上下文，question 字段就是它能看到的全部背景；
 * 2. **禁止再次调用 `ask_expert`**（即使有兜底过滤，prompt 层提示更礼貌）；
 * 3. 给出单条最终结论，结尾追加 "I have completed the task. Please verify my work."。
 *
 * 详见 `EXPERT_MODE_DESIGN.md` §6.3 + §16。
 */

import { EXPERT_TOOL_NAME } from './expertConstants';
import type { AskExpertArgs } from './expertMcpServer';

/**
 * 构造给专家的首条 user 消息文本。
 *
 * 该文本会被作为 stream-json `{type:"user", message:{role:"user", content:"<text>"}}`
 * 写入专家 CLI stdin。专家不会看到主对话历史，只会看到这里组装出的字符串。
 *
 * @param args 主模型通过 ask_expert 传过来的参数。
 * @returns 拼装好的首条 user 消息文本。
 */
export function buildExpertInitialUserMessage(args: AskExpertArgs): string {
    const lines: string[] = [];

    // 强调「自包含」语义，避免专家产生「我看不到上下文」之类的元回答。
    lines.push('You are an independent expert agent invoked by the main assistant.');
    lines.push('');
    lines.push('Important rules:');
    lines.push('1. You DO NOT see the main conversation history. The information below is ALL you have.');
    lines.push(`2. You MUST NOT call the \`${EXPERT_TOOL_NAME}\` tool yourself. Do not delegate further.`);
    lines.push('3. Produce ONE final conclusion. End your final message with exactly:');
    lines.push('   "I have completed the task. Please verify my work."');
    lines.push('');

    if (args.goal) {
        lines.push(`# Goal`);
        lines.push(args.goal);
        lines.push('');
    }

    if (args.constraints) {
        lines.push(`# Constraints`);
        lines.push(args.constraints);
        lines.push('');
    }

    lines.push(`# Task`);
    lines.push(args.question);

    return lines.join('\n');
}

/**
 * 构造给专家 CLI 的 `--append-system-prompt` 文本片段。
 *
 * 这段会被 Claude CLI 追加到默认 system prompt 的末尾，作为「最高优先级
 * 行为指令」。它的作用与 {@link buildExpertInitialUserMessage} 的 user
 * 头部有重叠——这是有意为之的双重保险，因为有些模型只严格遵循 system，
 * 有些只严格遵循 user。
 *
 * 注意：这里只输出**追加段**，不应包含完整的 Claude system prompt。
 * 调用方负责通过 CLI `--append-system-prompt` 参数注入。
 */
export function buildExpertAppendedSystemPrompt(): string {
    return [
        '## Expert mode',
        '',
        'You are running as a sub-agent invoked via the `ask_expert` MCP tool. You DO NOT',
        'have access to the main conversation history. Treat the user message you receive',
        'as the complete and self-contained task description.',
        '',
        `You MUST NOT invoke the \`${EXPERT_TOOL_NAME}\` tool. Recursive delegation is forbidden.`,
        '',
        'Produce a single final answer. End your last message with exactly the sentence:',
        '"I have completed the task. Please verify my work."'
    ].join('\n');
}
