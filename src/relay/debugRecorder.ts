/**
 * @file Relay 转发调试记录器。
 *
 * 把每次 `/v1/messages` 转发请求中的 messages 聚合落盘到工作区的 `.LLSOAI/` 目录，
 * 便于排查上下文重复、任务流控制提示注入等问题。
 *
 * - 当存在 VS Code 工作区时：写入第一个工作区根目录下的 `.LLSOAI/`；
 * - 无工作区（例如纯欢迎页）时：写入 OS 临时目录下的 `claude-code-relay-llsoai/`。
 *
 * 文件名格式：`<yyyy-MM-dd>.json`；同一天只保存一份，messages 内容相同则不重复追加。
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

/** 临时目录回退时使用的子目录名。 */
const TMP_FALLBACK_DIR_NAME = 'claude-code-relay-llsoai';

/** 按天聚合保存的 messages 调试日志结构。 */
interface DailyMessagesRecord {
    /** 日志日期，格式 yyyy-MM-dd。 */
    date: string;
    /** 去重后的 messages 列表。 */
    messages: unknown[];
}

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
     * 把最终请求 body 覆盖写入 `.LLSOAI/test.json`。
     *
     * @param bodyText 已注入工具、即将发送到上游的请求体文本。
     */
    public async recordRequestBody(bodyText: string): Promise<void> {
        try {
            const dir = await this.resolveDir();
            const filePath = path.join(dir, 'test.json');
            const formatted = this.formatJsonText(bodyText);
            await fs.writeFile(filePath, `${formatted}\n`, 'utf-8');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`写入 Relay 请求 body 失败：${message}`);
        }
    }

    /**
     * 把一次转发请求中的 messages 追加写入 `.LLSOAI/yyyy-MM-dd.json`。
     *
     * 该方法不会抛出异常，所有 IO 错误都降级为日志。
     *
     * @param entry 转发快照。
     */
    public async record(entry: DebugRecordEntry): Promise<void> {
        try {
            const dir = await this.resolveDir();
            const dateText = this.formatDate(entry.startedAt);
            const fileName = `${dateText}.json`;
            const filePath = path.join(dir, fileName);
            const messages = this.extractRequestMessages(entry.requestBody);
            if (messages.length === 0) {
                return;
            }
            const record = await this.readDailyMessagesRecord(filePath, dateText);
            const existingKeys = new Set(record.messages.map((message) => this.stableStringify(message)));
            let appended = 0;
            for (const message of messages) {
                const key = this.stableStringify(message);
                if (existingKeys.has(key)) continue;
                existingKeys.add(key);
                record.messages.push(message);
                appended += 1;
            }
            if (appended === 0) {
                return;
            }
            await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
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
     * 读取当天 messages 聚合文件。
     *
     * @param filePath 聚合文件路径。
     * @param dateText 日期字符串。
     * @returns 可追加的当天记录。
     */
    private async readDailyMessagesRecord(filePath: string, dateText: string): Promise<DailyMessagesRecord> {
        try {
            const text = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(text) as Partial<DailyMessagesRecord>;
            return {
                date: typeof parsed.date === 'string' ? parsed.date : dateText,
                messages: Array.isArray(parsed.messages) ? parsed.messages : []
            };
        } catch (err) {
            const code = (err as { code?: unknown }).code;
            if (code !== 'ENOENT') {
                Logger.warn(`读取 Relay 调试 messages 失败，将重建文件：${err instanceof Error ? err.message : String(err)}`);
            }
            return { date: dateText, messages: [] };
        }
    }

    /**
     * 把请求体文本格式化为 JSON。
     *
     * @param text 请求体文本。
     * @returns 可读性更好的 JSON 文本，解析失败时返回原文。
     */
    private formatJsonText(text: string): string {
        try {
            return JSON.stringify(JSON.parse(text), null, 2);
        } catch {
            return text;
        }
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
