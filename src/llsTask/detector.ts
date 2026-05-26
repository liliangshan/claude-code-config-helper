/** @file @llsccai-task 触发检测工具。 */

/** @llsccai-task 触发词匹配正则，大小写不敏感并要求单词边界。 */
const LLS_CCAI_TASK_TRIGGER_RE = /(^|\s)@llsccai-task(?=\s|$)/i;

/** @llsccai-task 触发词全局替换正则，用于提取规划正文。 */
const LLS_CCAI_TASK_TRIGGER_GLOBAL_RE = /(^|\s)@llsccai-task(?=\s|$)/gi;

/** Claude Code 注入的 IDE 已打开文件标签匹配正则。 */
const IDE_OPENED_FILE_RE = /<ide_opened_file>\s*The user opened the file\s+(.+?)\s+in the IDE\.[\s\S]*?<\/ide_opened_file>/i;

/** 默认启动提示中要求用户替换的占位文案特征。 */
const DEFAULT_START_PROMPT_MARKERS: readonly string[] = [
    'please open a markdown planning document',
    '请先在 ide 中打开',
    '請先在 ide 中開啟',
    'ide에서 markdown 계획 문서를 열거나',
    'ide で markdown 計画ドキュメントを開くか',
    'ouvrez un document de planification markdown',
    'öffnen sie ein markdown-planungsdokument',
    'delete this sentence and use your own prompt',
    '删除这段使用自己的提示词',
    '刪除此句並使用自己的提示詞',
    '직접 프롬프트를 입력하세요',
    '独自のプロンプトを入力してください',
    'utilisez votre propre prompt',
    'verwenden Sie Ihren eigenen Prompt'
];

/** Anthropic 文本块的最小结构。 */
interface AnthropicTextBlockLike {
    /** content block 类型。 */
    type?: unknown;
    /** 文本块内容。 */
    text?: unknown;
}

/** Anthropic 消息的最小结构。 */
interface AnthropicMessageLike {
    /** 消息角色。 */
    role?: unknown;
    /** 消息内容，可能是字符串或 content block 数组。 */
    content?: unknown;
}

/**
 * 从 Anthropic messages 中提取最后一条 user 消息的纯文本。
 *
 * 兼容 Claude/Anthropic 的两种 content 形态：字符串 content 与 array-of-blocks content。
 * 仅扫描最后一条 `role === 'user'` 的消息，避免历史消息中的触发词重复生效。
 *
 * @param messages Anthropic messages 数组。
 * @returns 最后一条 user 消息中的文本内容；不存在时返回空字符串。
 */
export function extractLastUserText(messages: unknown): string {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i] as AnthropicMessageLike | undefined;
        if (!message || message.role !== 'user') continue;
        const { content } = message;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .filter((block: AnthropicTextBlockLike) => block?.type === 'text' && typeof block.text === 'string')
                .map((block: AnthropicTextBlockLike) => block.text as string)
                .join('\n');
        }
        return '';
    }
    return '';
}

/**
 * 判断 Anthropic messages 是否触发 LLS CCAI 任务流。
 *
 * 触发词大小写不敏感，且只允许最后一条 user 消息触发。
 *
 * @param messages Anthropic messages 数组。
 * @returns 是否包含合法 `@llsccai-task` 触发词。
 */
export function isLlsCcaiTaskTriggered(messages: unknown): boolean {
    return LLS_CCAI_TASK_TRIGGER_RE.test(extractLastUserText(messages));
}

/**
 * 从最后一条 user 消息中去掉触发词并提取规划文本。
 *
 * @param messages Anthropic messages 数组。
 * @returns 去除 `@llsccai-task` 后的规划正文。
 */
export function extractPlanningText(messages: unknown): string {
    return extractLastUserText(messages).replace(LLS_CCAI_TASK_TRIGGER_GLOBAL_RE, ' ').trim();
}

/**
 * 从最后一条 user 消息中提取 Claude Code 注入的 IDE 已打开文件路径。
 *
 * Claude Code 会在用户打开文件后附加 `<ide_opened_file>...` 文本块，
 * 任务流默认启动提示依赖该信息判断用户是否已打开方案文档。
 *
 * @param messages Anthropic messages 数组。
 * @returns 已打开文件路径；不存在时返回空字符串。
 */
export function extractIdeOpenedFilePath(messages: unknown): string {
    const match = IDE_OPENED_FILE_RE.exec(extractLastUserText(messages));
    return match?.[1]?.trim() ?? '';
}

/**
 * 从最后一条 user 消息提取"用户在 @llsccai-task 后输入的原始提示词"。
 *
 * 与 {@link extractPlanningText} 不同：本函数会进一步剥离 Claude Code
 * 注入的 `<ide_opened_file>...` 标签整块，避免把"IDE 自动告诉模型用户
 * 打开了哪个文件"的环境信息当作用户原始需求保存下来；同时若用户没改
 * 默认占位文本（{@link isDefaultStartPrompt} 命中），返回空字符串，
 * 表示"没有可用的手输需求"。
 *
 * 输出供 service 持久化为 snapshot.originalUserPrompt，让后续自动续推
 * 和 system 规则注入都能反复展示给模型，避免多轮续推后丢失原始意图。
 *
 * @param messages Anthropic messages 数组。
 * @returns 干净的用户原始提示词；无可用内容时返回空字符串。
 */
export function extractOriginalUserPrompt(messages: unknown): string {
    const planning = extractPlanningText(messages)
        .replace(IDE_OPENED_FILE_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!planning) return '';
    if (isDefaultStartPrompt(planning)) return '';
    return planning;
}

/**
 * 判断触发提示是否仍是扩展提供的默认占位提示。
 *
 * @param planningText 已去掉 `@llsccai-task` 的规划文本。
 * @returns 如果用户没有删除/修改默认提示词则返回 true。
 */
export function isDefaultStartPrompt(planningText: string): boolean {
    const normalized = planningText.trim().toLowerCase();
    if (!normalized) return true;
    return DEFAULT_START_PROMPT_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()));
}

/**
 * 判断一个路径是否指向 Markdown 方案文档。
 *
 * @param filePath 待判断的文件路径。
 * @returns 文件扩展名是否为 `.md` 或 `.markdown`。
 */
export function isMarkdownPlanningFile(filePath: string): boolean {
    return /\.(md|markdown)$/i.test(filePath.trim());
}
