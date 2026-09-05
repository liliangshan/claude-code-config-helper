/**
 * @file Relay 转发调试记录器。
 *
 * 把每次 `/v1/messages` 转发请求中的 messages 聚合落盘到工作区的 `.LLSOAI/` 目录，
 * 便于排查上下文重复、任务流控制提示注入等问题。
 *
 * - 当存在 VS Code 工作区时：写入第一个工作区根目录下的 `.LLSOAI/`；
 * - 无工作区（例如纯欢迎页）时：写入 OS 临时目录下的 `claude-code-relay-llsoai/`。
 *
 * 文件名格式：`<yyyy-MM-dd>.jsonl`（JSON Lines 追加写）；同一天内容相同的 message 不重复追加。
 * 默认关闭，需显式开启 `claudeCodeConfigHelper.relay.debugRecord`。
 *
 * 所有 IO 异常都被吞掉，仅写入扩展日志，绝不影响主转发流程。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { Logger } from '../logger';

/** 落盘目录名（位于工作区根或临时目录下）。 */
const DEBUG_DIR_NAME = '.LLSOAI';

/** 上游错误快照最多保留的文件个数，超出时删除最早的。 */
const MAX_ERROR_SNAPSHOTS = 20;

/** 临时目录回退时使用的子目录名。 */
const TMP_FALLBACK_DIR_NAME = 'claude-code-relay-llsoai';

/**
 * 单次转发要落盘的请求/响应快照。
 */
export interface DebugRecordEntry {
    /** 提供商 ID，用于文件名分组。 */
    providerId: string;
    /** 目标 modelId。 */
    modelId: string;
    /** 上游 URL（含 path / query）。 */
    upstreamUrl: string;
    /** HTTP method，固定为 POST。 */
    method: string;
    /** 已脱敏的请求头。 */
    requestHeaders: Record<string, string>;
    /** 改写后的请求体字符串（已替换 model 字段）。 */
    requestBody: string;
    /** 实际发往上游的请求体；协议转换适配器可用于保存 OpenAI/Responses payload。 */
    upstreamRequestBody?: string;
    /** 实际发往上游的请求头；协议转换适配器可用于保存 OpenAI/Responses headers。 */
    upstreamRequestHeaders?: Record<string, string>;
    /** 上游响应状态码。 */
    responseStatus: number | undefined;
    /** 上游响应头。 */
    responseHeaders: Record<string, string | string[] | undefined>;
    /** 上游响应体（流式时为聚合后的全部 chunk）。 */
    responseBody: string;
    /** 实际上游原始响应体；协议转换适配器可用于保存转换前的响应。 */
    upstreamResponseBody?: string;
    /** 请求开始时间（毫秒）。 */
    startedAt: number;
    /** 请求结束时间（毫秒）。 */
    endedAt: number;
    /** 错误信息（若有）。 */
    error?: string;
}

/**
 * 转发调试记录器。
 *
 * 单例风格，全部状态都在实例内；适配器在每次请求开始时调用
 * {@link DebugRecorder.record} 即可。
 */
export class DebugRecorder {
    /**
     * 当天已落盘的 messages 去重 key 缓存：日期 -> key 集合。
     *
     * 旧实现每条请求都要「读整个当天文件 + 重建集合」，文件越大越慢（O(n²)）。
     * 改为进程内缓存后，同一天只在首次命中时读一次盘。
     */
    private readonly dailyKeys = new Map<string, Set<string>>();

    /**
     * @param isEnabled 调试落盘开关，默认关闭；由 ConfigManager 注入以便随配置实时生效。
     */
    public constructor(private readonly isEnabled: () => boolean = () => false) {}

    /**
     * 兼容旧调用的空实现：不再把出站请求 body 落盘为 `test-<时间戳>.json`。
     *
     * 该调试落盘仅用于排查偶发 400 等问题，正式使用时会在 `.LLSOAI/` 里堆积大量
     * 单请求文件，故移除写盘逻辑，仅保留方法签名以兼容现有调用点。
     *
     * @param bodyText 已注入工具、即将发送到上游的请求体文本。
     */
    public async recordRequestBody(bodyText: string): Promise<void> {
        void bodyText;
    }

    /**
     * 上游返回非 2xx 时，把「实际发出的请求体 + 上游响应」成对落盘到
     * `.LLSOAI/error-<状态码>-<时间戳>.json`，用于定位 400（如缓存断点 ttl 混用）
     * 等错误对应的确切出站请求，避免被后续请求覆盖、且不依赖二次复现。
     *
     * 排障必需，因此**不受** `relay.debugRecord` 开关控制；改为两条硬约束防止无限膨胀：
     * 目录内最多保留 {@link MAX_ERROR_SNAPSHOTS} 个快照，且请求体只保留定位问题
     * 真正需要的字段（model / system / 工具名 / 最后两条 messages）。
     *
     * @param status 上游 HTTP 状态码。
     * @param requestBody 实际发送到上游的请求体文本。
     * @param responseBody 上游返回的响应体文本。
     */
    public async recordUpstreamError(
        status: number,
        requestBody: string,
        responseBody: string
    ): Promise<void> {
        try {
            const dir = await this.resolveDir();
            await this.pruneErrorSnapshots(dir);
            const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const filePath = path.join(dir, `error-${status}-${stamp}.json`);
            const payload = {
                status,
                response: responseBody,
                request: this.summarizeErrorRequest(requestBody)
            };
            await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`写入 Relay 上游错误快照失败：${message}`);
        }
    }

    /**
     * 把一次转发请求中的 messages 追加写入 `.LLSOAI/yyyy-MM-dd.jsonl`。
     *
     * 三点与旧实现的差异：
     * 1. 受 {@link isEnabled} 开关控制，默认关闭，不再无条件产生磁盘写入；
     * 2. 去重集合改为进程内按天缓存，只在当天首次调用时读一次盘；
     * 3. 落盘改为 JSON Lines 追加写，不再每次整文件重写。
     *
     * 该方法不会抛出异常，所有 IO 错误都降级为日志。
     *
     * @param entry 转发快照。
     */
    public async record(entry: DebugRecordEntry): Promise<void> {
        if (!this.isEnabled()) return;
        try {
            const messages = this.stripImageBlocks(this.extractRequestMessages(entry.requestBody));
            if (messages.length === 0) {
                return;
            }
            const dir = await this.resolveDir();
            const dateText = this.formatDate(entry.startedAt);
            const filePath = path.join(dir, `${dateText}.jsonl`);
            const knownKeys = await this.ensureDailyKeys(filePath, dateText);

            const lines: string[] = [];
            for (const message of messages) {
                const key = this.stableStringify(message);
                if (knownKeys.has(key)) continue;
                knownKeys.add(key);
                lines.push(JSON.stringify({ date: dateText, message }));
            }
            if (lines.length === 0) {
                return;
            }
            await fs.appendFile(filePath, `${lines.join('\n')}\n`, 'utf-8');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`写入 Relay 调试 messages 失败：${message}`);
        }
    }

    /**
    * 兼容旧调用的空实现：不再保存单次转发的请求阶段快照。
    *
    * 为避免落盘完整 request body，现在只保留 {@link record} 的 messages 聚合文件。
     *
     * @param entry 转发快照。
     */
    public async recordRequestSnapshot(entry: DebugRecordEntry): Promise<void> {
        void entry;
    }

    /**
     * 兼容旧调用的空实现：不再保存转换后的 OpenAI Chat 请求独立快照。
     *
     * 为避免落盘完整 OpenAI request body，现在不再生成 `*-chat.json` 文件。
     *
     * @param entry 转发快照。
     */
    public async recordOpenAIChatRequestSnapshot(entry: DebugRecordEntry): Promise<void> {
        void entry;
    }

    /**
     * 兼容旧调用的空实现：不再保存单次转发的响应阶段快照。
     *
     * 为避免落盘完整 response body，现在只保留 {@link record} 的 messages 聚合文件。
     *
     * @param entry 转发快照。
     */
    public async recordResponseSnapshot(entry: DebugRecordEntry): Promise<void> {
        void entry;
    }

    /**
     * 解析 `.LLSOAI` 目录的绝对路径，必要时创建目录。
     *
     * @returns 可写入的目录绝对路径。
     */
    private async resolveDir(): Promise<string> {
        const root = this.resolveRoot();
        const dir = path.join(root, DEBUG_DIR_NAME);
        await fs.mkdir(dir, { recursive: true });
        return dir;
    }

    /**
     * 决定调试目录所在的根目录。
     *
     * 优先使用第一个 VS Code 工作区根；无工作区时回退到 OS 临时目录下的
     * 专用子目录。
     *
     * @returns 根目录绝对路径。
     */
    private resolveRoot(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.fsPath;
        }
        return path.join(os.tmpdir(), TMP_FALLBACK_DIR_NAME);
    }

    /**
     * 把时间戳格式化为按天聚合的文件名前缀。
     *
     * @param time 时间戳毫秒值。
     * @returns yyyy-MM-dd 日期字符串。
     */
    private formatDate(time: number): string {
        const d = new Date(time);
        const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    /**
     * 删除超出上限的历史错误快照，保证写入新快照后目录内不超过 MAX_ERROR_SNAPSHOTS 个。
     *
     * 文件名形如 `error-<status>-<epochMs>-<rand>.json`，按其中的时间戳排序即时间序。
     *
     * @param dir 调试目录。
     */
    private async pruneErrorSnapshots(dir: string): Promise<void> {
        try {
            const names = (await fs.readdir(dir)).filter(
                (name) => name.startsWith('error-') && name.endsWith('.json')
            );
            // 为即将写入的这一个留出位置，因此上限按 MAX_ERROR_SNAPSHOTS - 1 计算。
            const overflow = names.length - (MAX_ERROR_SNAPSHOTS - 1);
            if (overflow <= 0) return;
            const stampOf = (name: string): number => Number(name.split('-')[2]) || 0;
            const oldest = names.sort((a, b) => stampOf(a) - stampOf(b)).slice(0, overflow);
            await Promise.all(oldest.map((name) => fs.rm(path.join(dir, name), { force: true })));
        } catch (err) {
            Logger.warn(`清理 Relay 错误快照失败：${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * 把出站请求体压缩成排障够用的最小快照。
     *
     * 完整请求体常含整段会话历史与 base64 图片，单个文件可到数 MB；定位 400 类问题
     * 实际只需要模型、system、工具名与最后两条 messages。
     *
     * @param requestBody 原始请求体文本。
     * @returns 瘦身后的对象；解析失败时原样返回字符串。
     */
    private summarizeErrorRequest(requestBody: string): unknown {
        try {
            const parsed = JSON.parse(requestBody) as {
                model?: unknown;
                system?: unknown;
                tools?: Array<{ name?: unknown }>;
                messages?: unknown[];
            };
            const messages = Array.isArray(parsed.messages) ? parsed.messages.slice(-2) : [];
            return {
                model: parsed.model,
                system: parsed.system,
                tools: Array.isArray(parsed.tools) ? parsed.tools.map((tool) => tool?.name) : undefined,
                messages: this.stripImageBlocks(messages)
            };
        } catch {
            // 保底：解析失败时按原始字符串落盘。
            return requestBody;
        }
    }

    /**
     * 取当天的去重 key 集合，缺失时从已有 jsonl 文件恢复一次。
     *
     * 只在进程内当天首次调用时读盘；后续调用直接命中内存缓存，避免逐请求全量读文件。
     *
     * @param filePath jsonl 文件路径。
     * @param dateText 日期字符串，作为缓存键。
     * @returns 当天已落盘 message 的 key 集合（可直接写入）。
     */
    private async ensureDailyKeys(filePath: string, dateText: string): Promise<Set<string>> {
        const cached = this.dailyKeys.get(dateText);
        if (cached) return cached;

        const keys = new Set<string>();
        try {
            const text = await fs.readFile(filePath, 'utf-8');
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line) as { message?: unknown };
                    keys.add(this.stableStringify(parsed.message));
                } catch {
                    // 单行损坏不影响其余记录，跳过即可。
                }
            }
        } catch (err) {
            const code = (err as { code?: unknown }).code;
            if (code !== 'ENOENT') {
                Logger.warn(`读取 Relay 调试 messages 失败，将从空集合重建：${err instanceof Error ? err.message : String(err)}`);
            }
        }
        // 只保留当天一份缓存，跨天后旧集合没有价值，直接丢弃避免常驻内存增长。
        this.dailyKeys.clear();
        this.dailyKeys.set(dateText, keys);
        return keys;
    }

    /**
     * 把 messages 里的 image block 替换为体积占位，避免 base64 图片撑爆调试文件。
     *
     * @param messages 原始 messages。
     * @returns 图片已剥离的深拷贝。
     */
    private stripImageBlocks(messages: unknown[]): unknown[] {
        const strip = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(strip);
            if (!value || typeof value !== 'object') return value;
            const obj = value as Record<string, unknown>;
            if (obj.type === 'image') {
                const source = obj.source as { data?: unknown } | undefined;
                const bytes = typeof source?.data === 'string' ? source.data.length : 0;
                return { type: 'image', omitted: true, bytes };
            }
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(obj)) out[key] = strip(obj[key]);
            return out;
        };
        return messages.map(strip);
    }

    /**
     * 从 Anthropic 请求体中提取 messages 数组。
     *
     * @param text 原始请求体文本。
     * @returns 请求里的 messages；不存在或解析失败时返回空数组。
     */
    private extractRequestMessages(text: string): unknown[] {
        try {
            const parsed = JSON.parse(text) as { messages?: unknown };
            return Array.isArray(parsed.messages) ? parsed.messages : [];
        } catch {
            return [];
        }
    }

    /**
     * 稳定序列化 JSON 值，用于按内容去重。
     *
     * @param value 待序列化值。
     * @returns 字段排序后的 JSON 字符串。
     */
    private stableStringify(value: unknown): string {
        return JSON.stringify(this.sortJsonValue(value));
    }

    /**
     * 递归排序对象字段，保证同内容去重不受字段顺序影响。
     *
     * @param value 待排序 JSON 值。
     * @returns 字段已排序的 JSON 值。
     */
    private sortJsonValue(value: unknown): unknown {
        if (Array.isArray(value)) return value.map((item) => this.sortJsonValue(item));
        if (!value || typeof value !== 'object') return value;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = this.sortJsonValue((value as Record<string, unknown>)[key]);
        }
        return out;
    }
}
