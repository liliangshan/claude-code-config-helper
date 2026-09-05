/**
 * @file `.LLSOAI/token-count.json` 持久化存储。
 *
 * 负责：
 * 1. 按工作区根定位 `.LLSOAI/token-count.json` 文件（无工作区则回退到 `~/.LLSOAI/`）；
 * 2. 原子写（tmp + rename）+ 200ms 防抖，避免高频请求把 SSD 打爆；
 * 3. mtime 比对，避免覆盖用户手工编辑或外部工具写入的内容；
 * 4. 写盘失败仅 Logger.warn，绝不阻塞主转发流程。
 *
 * 数据 schema 见 .LLSOAI/token-budget.md § 2。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { Logger } from '../../logger';

/** 落盘目录名（位于工作区根或用户主目录下）。 */
const STORE_DIR_NAME = '.LLSOAI';

/** 落盘文件名。 */
const STORE_FILE_NAME = 'token-count.json';

/** 当前 schema 版本。 */
const SCHEMA_VERSION = 1;

/** 写盘防抖窗口（毫秒）。 */
const WRITE_DEBOUNCE_MS = 200;

/** history 滚动窗口大小。 */
const HISTORY_MAX = 50;

/** `compact.archivedSessionIds` 最大保留数。 */
const ARCHIVED_SESSION_MAX = 10;

/** 会话桶保留上限；超出后按 lastUpdated 淘汰最旧的。 */
const MAX_SESSIONS = 200;

/** 会话桶最长保留天数，超期直接丢弃。 */
const MAX_SESSION_AGE_DAYS = 30;

/** 单会话桶里的"current"快照。 */
export interface CurrentUsage {
    /** 输入 token 数（来自上游 usage 或 estimator）。 */
    inputTokens: number;
    /** 输出 token 数。 */
    outputTokens: number;
    /** 缓存写入 token。 */
    cacheCreationInputTokens: number;
    /** 缓存读取 token。 */
    cacheReadInputTokens: number;
    /** 用于阈值判定：普通输入 + 缓存写入 + 缓存读取。 */
    totalInputForBudget: number;
}

/** 压缩状态。 */
export interface CompactState {
    /** 是否有压缩任务在途。 */
    inProgress: boolean;
    /** 上次触发时间（ISO 8601 字符串），从未触发为 null。 */
    lastTriggeredAt: string | null;
    /** 上次触发时的 totalInputForBudget。 */
    lastTriggeredAtInput: number | null;
    /** 累计触发次数（含失败）。 */
    triggerCount: number;
    /** 上次结果。 */
    lastOutcome: 'success' | 'failed' | null;
    /** 上次失败错误。 */
    lastError: string | null;
    /** 最近一次摘要前 500 字。 */
    lastSummary: string | null;
    /** 上次压缩前 totalInputForBudget。 */
    lastBeforeTokens: number | null;
    /** 上次压缩后新 session 首轮 totalInputForBudget。 */
    lastAfterTokens: number | null;
    /** 已归档旧 sessionId（最多 ARCHIVED_SESSION_MAX 条）。 */
    archivedSessionIds: string[];
}

/** 单条 history 记录。 */
export interface UsageHistoryEntry {
    /** ISO 8601 时间。 */
    ts: string;
    /** 入账阶段：估算（请求侧）或权威（响应侧）。 */
    phase: 'request' | 'response';
    /** 数据来源。 */
    source: 'api' | 'estimated';
    /** request 阶段的估算增量。 */
    deltaInput?: number;
    /** response 阶段的 input token。 */
    inputTokens?: number;
    /** response 阶段的 output token。 */
    outputTokens?: number;
}

/** 单 session 桶。 */
export interface SessionUsage {
    /** CLI session_id。 */
    sessionId: string;
    /** 提供商 id。 */
    providerId: string;
    /** 模型 id（不含 providerId 前缀）。 */
    modelId: string;
    /** `<providerId>/<modelId>` 拼接，便于人眼检索。 */
    modelKey: string;
    /** 模型上下文上限。 */
    contextLimit: number;
    /** 触发阈值 = contextLimit - 50000。 */
    threshold: number;
    /** 最近一次更新时间（ISO 8601）。 */
    lastUpdated: string;
    /** 最近一次数据来源。 */
    lastSource: 'api' | 'estimated';
    /** 当前轮快照（覆盖、不累加）。 */
    current: CurrentUsage;
    /** 压缩状态。 */
    compact: CompactState;
    /** 滚动历史窗口。 */
    history: UsageHistoryEntry[];
}

/** 顶层文件结构。 */
export interface TokenCountFile {
    /** schema 版本，固定 1。 */
    version: number;
    /** 文件级最近更新时间。 */
    lastUpdated: string;
    /** 按 sessionId 分桶。 */
    sessions: Record<string, SessionUsage>;
}

/**
 * 创建一份默认的空 SessionUsage 桶。
 *
 * @param sessionId    会话 id。
 * @param providerId   提供商 id。
 * @param modelId      模型 id。
 * @param contextLimit 上下文上限。
 * @returns 初始化好的 SessionUsage 实例。
 */
export function createEmptySession(
    sessionId: string,
    providerId: string,
    modelId: string,
    contextLimit: number
): SessionUsage {
    const now = new Date().toISOString();
    return {
        sessionId,
        providerId,
        modelId,
        modelKey: `${providerId}/${modelId}`,
        contextLimit,
        threshold: Math.max(0, contextLimit - 50000),
        lastUpdated: now,
        lastSource: 'estimated',
        current: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalInputForBudget: 0
        },
        compact: {
            inProgress: false,
            lastTriggeredAt: null,
            lastTriggeredAtInput: null,
            triggerCount: 0,
            lastOutcome: null,
            lastError: null,
            lastSummary: null,
            lastBeforeTokens: null,
            lastAfterTokens: null,
            archivedSessionIds: []
        },
        history: []
    };
}

/**
 * `.LLSOAI/token-count.json` 文件存储。
 *
 * 内存中维护完整 {@link TokenCountFile}，写盘走 200ms 防抖；读取走"首次按需加载"。
 * 所有 IO 异常都被吞掉，只写扩展日志。
 */
export class TokenCountStore {
    /** 内存里的最新文件副本。 */
    private file: TokenCountFile = {
        version: SCHEMA_VERSION,
        lastUpdated: new Date().toISOString(),
        sessions: {}
    };

    /** 是否已经从磁盘加载过。 */
    private loaded = false;

    /** 防抖定时器句柄。 */
    private writeTimer: NodeJS.Timeout | undefined;

    /** 上次磁盘 mtime，用于检测外部覆盖。 */
    private lastDiskMtimeMs: number | undefined;

    /** 是否标记销毁。 */
    private disposed = false;

    /**
     * 同步取所有 session（内存视图）。
     *
     * @returns sessionId → SessionUsage 映射的浅拷贝。
     */
    public getAllSessions(): Record<string, SessionUsage> {
        return { ...this.file.sessions };
    }

    /**
     * 按 sessionId 读取一份桶；不存在返回 undefined。
     *
     * @param sessionId 会话 id。
     * @returns SessionUsage 引用（同一对象，调用方可直接 mutate 后调 {@link saveSession}）。
     */
    public getSession(sessionId: string): SessionUsage | undefined {
        return this.file.sessions[sessionId];
    }

    /**
     * 写入一份 SessionUsage 桶并触发防抖落盘。
     *
     * @param session 已修改的桶。
     */
    public saveSession(session: SessionUsage): void {
        if (this.disposed) return;
        session.lastUpdated = new Date().toISOString();
        this.file.sessions[session.sessionId] = session;
        this.file.lastUpdated = session.lastUpdated;
        this.scheduleWrite();
    }

    /**
     * 把旧 session 归档：从 sessions 中移除，但 sessionId 记入下一个新桶的
     * `compact.archivedSessionIds`（由调用方在创建新桶时写入）。
     *
     * 这里只负责删除旧桶并写盘。
     *
     * @param sessionId 待归档的旧 session id。
     */
    public archiveSession(sessionId: string): void {
        if (this.disposed) return;
        if (!this.file.sessions[sessionId]) return;
        delete this.file.sessions[sessionId];
        this.file.lastUpdated = new Date().toISOString();
        this.scheduleWrite();
    }

    /**
     * 把一条 history 记录追加到指定 session（自动裁剪到 HISTORY_MAX 条）。
     *
     * @param sessionId 会话 id。
     * @param entry     历史条目。
     */
    public appendHistory(sessionId: string, entry: UsageHistoryEntry): void {
        const session = this.file.sessions[sessionId];
        if (!session) return;
        session.history.push(entry);
        if (session.history.length > HISTORY_MAX) {
            session.history.splice(0, session.history.length - HISTORY_MAX);
        }
        this.saveSession(session);
    }

    /**
     * 把一个 sessionId 加入指定 session 的归档列表（截断到 ARCHIVED_SESSION_MAX）。
     *
     * @param sessionId 新 session id。
     * @param archived  待归档的旧 session id。
     */
    public pushArchivedSessionId(sessionId: string, archived: string): void {
        const session = this.file.sessions[sessionId];
        if (!session) return;
        session.compact.archivedSessionIds.unshift(archived);
        if (session.compact.archivedSessionIds.length > ARCHIVED_SESSION_MAX) {
            session.compact.archivedSessionIds.length = ARCHIVED_SESSION_MAX;
        }
        this.saveSession(session);
    }

    /**
     * 从磁盘加载文件到内存（仅首次调用生效）。
     *
     * @returns 加载完成的 Promise；任何错误都被吞掉。
     */
    public async load(): Promise<void> {
        if (this.loaded || this.disposed) return;
        this.loaded = true;
        try {
            const filePath = await this.resolveFilePath();
            const stat = await fs.stat(filePath).catch(() => undefined);
            if (!stat) return;
            this.lastDiskMtimeMs = stat.mtimeMs;
            const text = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(text) as Partial<TokenCountFile>;
            if (parsed && typeof parsed === 'object') {
                this.file = {
                    version: typeof parsed.version === 'number' ? parsed.version : SCHEMA_VERSION,
                    lastUpdated: typeof parsed.lastUpdated === 'string'
                        ? parsed.lastUpdated
                        : new Date().toISOString(),
                    sessions: parsed.sessions && typeof parsed.sessions === 'object'
                        ? (parsed.sessions as Record<string, SessionUsage>)
                        : {}
                };
                // 加载即裁剪：历史文件里可能已经堆了成千上万个过期桶。
                this.pruneSessions();
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget.store] 加载 token-count.json 失败：${message}`);
        }
    }

    /**
     * 立即刷盘并停止后续防抖；用于 dispose 时清场。
     */
    public async dispose(): Promise<void> {
        this.disposed = true;
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = undefined;
        }
        await this.flushNow();
    }

    /**
     * 按 200ms 防抖触发写盘。
     */
    private scheduleWrite(): void {
        if (this.disposed) return;
        if (this.writeTimer) clearTimeout(this.writeTimer);
        this.writeTimer = setTimeout(() => {
            this.writeTimer = undefined;
            void this.flushNow();
        }, WRITE_DEBOUNCE_MS);
    }

    /**
     * 立即原子写文件。
     */
    private async flushNow(): Promise<void> {
        try {
            const filePath = await this.resolveFilePath();
            // mtime 比对：若磁盘文件比内存新，先重新合并，再写。
            try {
                const stat = await fs.stat(filePath);
                if (this.lastDiskMtimeMs !== undefined && stat.mtimeMs > this.lastDiskMtimeMs) {
                    Logger.warn('[tokenBudget.store] 检测到 token-count.json 被外部修改，合并后再写。');
                    await this.mergeDiskInto(filePath);
                }
            } catch {
                // 文件可能不存在，忽略。
            }
            // 序列化前裁剪，保证落盘文件本身不会无限增长。
            this.pruneSessions();
            const tmpPath = `${filePath}.tmp`;
            const body = `${JSON.stringify(this.file, null, 2)}\n`;
            const handle = await fs.open(tmpPath, 'w');
            try {
                await handle.writeFile(body, 'utf-8');
                await handle.sync();
            } finally {
                await handle.close();
            }
            await fs.rename(tmpPath, filePath);
            const stat = await fs.stat(filePath);
            this.lastDiskMtimeMs = stat.mtimeMs;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget.store] 写入 token-count.json 失败：${message}`);
        }
    }

    /**
     * 淘汰过期与超量的会话桶。
     *
     * token-count.json 过去只增不减：每个新会话一个桶，长期使用后文件会涨到几 MB，
     * 而每次刷盘都要整文件序列化。这里按 lastUpdated 做两级裁剪，只改内存，
     * 随下一次 flushNow 落盘。
     */
    private pruneSessions(): void {
        const cutoff = Date.now() - MAX_SESSION_AGE_DAYS * 86_400_000;
        const entries = Object.entries(this.file.sessions)
            .filter(([, session]) => {
                const time = Date.parse(session?.lastUpdated ?? '');
                // lastUpdated 缺失或不可解析的桶按「无法判断新鲜度」保留，交给数量上限处理。
                return Number.isNaN(time) || time >= cutoff;
            })
            .sort((a, b) => (Date.parse(b[1]?.lastUpdated ?? '') || 0) - (Date.parse(a[1]?.lastUpdated ?? '') || 0))
            .slice(0, MAX_SESSIONS);
        this.file.sessions = Object.fromEntries(entries);
    }

    /**
     * 把磁盘文件内容合并进内存（外部修改后调用）。
     *
     * 策略：磁盘里有、内存里没有的 sessionId 直接吸纳；其余以内存为准。
     *
     * @param filePath 文件路径。
     */
    private async mergeDiskInto(filePath: string): Promise<void> {
        try {
            const text = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(text) as Partial<TokenCountFile>;
            if (!parsed || typeof parsed !== 'object') return;
            const remoteSessions = parsed.sessions && typeof parsed.sessions === 'object'
                ? (parsed.sessions as Record<string, SessionUsage>)
                : {};
            for (const [id, session] of Object.entries(remoteSessions)) {
                if (!this.file.sessions[id]) {
                    this.file.sessions[id] = session;
                }
            }
            // 合并可能重新引入过期桶，合并后再裁一次。
            this.pruneSessions();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget.store] 合并磁盘 token-count.json 失败：${message}`);
        }
    }

    /**
     * 解析 `.LLSOAI/token-count.json` 的绝对路径，必要时创建父目录。
     *
     * @returns 文件绝对路径。
     */
    private async resolveFilePath(): Promise<string> {
        const root = this.resolveRoot();
        const dir = path.join(root, STORE_DIR_NAME);
        await fs.mkdir(dir, { recursive: true });
        return path.join(dir, STORE_FILE_NAME);
    }

    /**
     * 决定 `.LLSOAI/` 所在的根目录。
     *
     * 优先 VS Code 工作区根；无工作区时回退到 `os.homedir()`。
     *
     * @returns 根目录绝对路径。
     */
    private resolveRoot(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) return folders[0].uri.fsPath;
        return os.homedir();
    }
}
