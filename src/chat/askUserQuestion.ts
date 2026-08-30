/**
 * @file AskUserQuestion 授权通道的纯逻辑工具函数。
 *
 * 从 extension.ts 抽出，便于单元测试：解析 CLI 发来的提问输入、
 * 把用户答案合并回 updatedInput（CLI 按 answers/annotations 约定打包 tool_result）。
 */

import type { AskUserQuestionItem } from './protocol';

/**
 * 从 AskUserQuestion 授权请求的原始 input 中解析出结构化问题列表。
 *
 * 数据来自 CLI，宽松校验：仅保留 question 非空、options 为数组且每项含
 * label 的条目；非法结构返回空数组（调用方回退到通用授权框）。
 *
 * @param input control_request 的工具输入。
 * @returns 规范化后的问题列表。
 */
export function parseAskUserQuestions(input: unknown): AskUserQuestionItem[] {
    if (!input || typeof input !== 'object') return [];
    const rawQuestions = (input as { questions?: unknown }).questions;
    if (!Array.isArray(rawQuestions)) return [];
    const items: AskUserQuestionItem[] = [];
    for (const raw of rawQuestions) {
        if (!raw || typeof raw !== 'object') continue;
        const q = raw as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown };
        if (typeof q.question !== 'string' || !q.question.trim()) continue;
        const options = Array.isArray(q.options)
            ? q.options
                  .filter((opt): opt is { label: string; description?: string } =>
                      Boolean(opt) && typeof (opt as { label?: unknown }).label === 'string')
                  .map((opt) => ({
                      label: opt.label,
                      description: typeof opt.description === 'string' ? opt.description : undefined
                  }))
            : [];
        if (options.length === 0) continue;
        items.push({
            question: q.question,
            header: typeof q.header === 'string' ? q.header : undefined,
            multiSelect: q.multiSelect === true,
            options
        });
    }
    return items;
}

/**
 * 把用户答案合并进原始工具输入，生成写回 CLI 的 updatedInput。
 *
 * CLI 约定：`answers` 为「问题文本 → 选项文本」映射；补充说明写入
 * `annotations[问题文本].notes`（挂到第一个问题上）。
 *
 * @param baseInput 授权请求携带的原始工具输入。
 * @param answers   用户选择的答案映射。
 * @param notes     可选补充说明。
 * @returns 合并后的 updatedInput。
 */
export function buildAskUserUpdatedInput(
    baseInput: unknown,
    answers: Record<string, string>,
    notes?: string
): Record<string, unknown> {
    const base = baseInput && typeof baseInput === 'object'
        ? baseInput as Record<string, unknown>
        : {};
    const updatedInput: Record<string, unknown> = { ...base, answers };
    const trimmed = (notes ?? '').trim();
    if (trimmed) {
        const firstQuestion = Object.keys(answers)[0];
        if (firstQuestion) {
            updatedInput.annotations = { [firstQuestion]: { notes: trimmed } };
        }
    }
    return updatedInput;
}
