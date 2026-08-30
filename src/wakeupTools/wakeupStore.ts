/**
 * @file `.LLSOAI/wakeups.json` 定时唤醒任务持久化存储。
 *
 * 负责：
 * 1. 按工作区根定位 `.LLSOAI/wakeups.json`（无工作区则回退到 `~/.LLSOAI/`）；
 * 2. 原子写（tmp + rename），避免半截 JSON；
 * 3. 反序列化时逐条防御校验，损坏条目直接丢弃，不阻塞启动；
 * 4. 读写失败仅 Logger.warn，绝不抛出影响主流程。
 *
 * 该文件顶层 import 了真实 `vscode`（resolveRoot 需要工作区信息），
 * 因此只能被扩展宿主侧引用，不可被 MCP 子进程入口链拉入。
 *
 * 设计见 docs/wakeup-mcp-tool-plan.md。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { Logger } from '../logger';

/** 落盘目录名（位于工作区根或用户主目录下）。 */
const STORE_DIR_NAME = '.LLSOAI';

/** 落盘文件名。 */
const STORE_FILE_NAME = 'wakeups.json';

/** 当前 schema 版本。 */
const SCHEMA_VERSION = 1;

/** 单个定时唤醒任务。 */
export interface WakeupJob {
    /** 任务 id（创建时生成的 UUID）。 */
    id: string;
    /** 到点时发送到聊天区的内容。 */
    prompt: string;
    /** 可选的一句话说明，仅用于列表展示与日志。 */
    reason?: string;
    /** 创建时间（ISO 8601 字符串）。 */
    createdAt: string;
    /** 绝对触发时间（ISO 8601 字符串；delaySeconds 已在 host 层折算）。 */
    fireAt: string;
    /** 循环间隔秒数；一次性任务为 undefined。 */
    intervalSeconds?: number;
    /** 剩余触发次数（含下一次）；缺省视为 1。 */
    remainingFires?: number;
    /** 已触发次数，用于唤醒内容里显示「第 n 次」。 */
    firedCount?: number;
}

/** 持久化文件顶层结构。 */
export interface PersistedWakeups {
    /** schema 版本，便于将来迁移。 */
    version: number;
    /** 落盘时间（ISO 8601 字符串）。 */
    savedAt: string;
    /** 尚未触发的唤醒任务列表。 */
    jobs: WakeupJob[];
}

/**
 * 校验一个反序列化出来的对象是否为合法 WakeupJob。
 *
 * 磁盘文件可能被手工编辑或被旧版本写坏，逐字段防御；`fireAt` 必须是可解析的
 * 时间字符串，否则调度器算出 NaN 延迟会立即触发。
 *
 * @param raw 反序列化得到的未知值。
 * @returns 合法时返回 true 并收窄类型。
 */
function isValidJob(raw: unknown): raw is WakeupJob {
    if (!raw || typeof raw !== 'object') return false;
    const job = raw as Record<string, unknown>;
    if (typeof job.id !== 'string' || !job.id) return false;
    if (typeof job.prompt !== 'string' || !job.prompt) return false;
    if (typeof job.createdAt !== 'string') return false;
    if (typeof job.fireAt !== 'string' || Number.isNaN(Date.parse(job.fireAt))) return false;
    if (job.reason !== undefined && typeof job.reason !== 'string') return false;
    if (job.intervalSeconds !== undefined && (typeof job.intervalSeconds !== 'number' || !Number.isFinite(job.intervalSeconds) || job.intervalSeconds <= 0)) return false;
    if (job.remainingFires !== undefined && (typeof job.remainingFires !== 'number' || !Number.isInteger(job.remainingFires) || job.remainingFires < 0)) return false;
    if (job.firedCount !== undefined && (typeof job.firedCount !== 'number' || !Number.isInteger(job.firedCount) || job.firedCount < 0)) return false;
    return true;
}

/** 按 `.LLSOAI/wakeups.json` 读写定时唤醒任务列表。 */
export class WakeupStore {
    /**
     * 写操作串行化队列。
     *
     * add / remove 都是「读-改-写」，并发执行会互相覆盖（后写的基于过期快照）。
     * 所有变更都挂到这条 promise 链上顺序执行。
     */
    private queue: Promise<unknown> = Promise.resolve();

    /**
     * 从磁盘读回全部唤醒任务。
     *
     * 文件不存在 / 解析失败 / 版本不符时返回空数组；单条损坏只丢弃该条。
     *
     * @returns 唤醒任务列表；无有效数据时为空数组。
     */
    public async load(): Promise<WakeupJob[]> {
        try {
            const filePath = await this.resolveFilePath();
            const text = await fs.readFile(filePath, 'utf-8').catch(() => undefined);
            if (text === undefined) return [];
            const parsed = JSON.parse(text) as Partial<PersistedWakeups>;
            if (!parsed || typeof parsed !== 'object') return [];
            if (parsed.version !== SCHEMA_VERSION) return [];
            if (!Array.isArray(parsed.jobs)) return [];
            return parsed.jobs.filter(isValidJob);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[wakeupStore] 加载 wakeups.json 失败：${message}`);
            return [];
        }
    }

    /**
     * 原子写入全部唤醒任务。
     *
     * @param jobs 待落盘的任务列表。
     */
    public async saveAll(jobs: WakeupJob[]): Promise<void> {
        try {
            const filePath = await this.resolveFilePath();
            const payload: PersistedWakeups = {
                version: SCHEMA_VERSION,
                savedAt: new Date().toISOString(),
                jobs
            };
            const tmpPath = `${filePath}.tmp`;
            const body = `${JSON.stringify(payload, null, 2)}\n`;
            const handle = await fs.open(tmpPath, 'w');
            try {
                await handle.writeFile(body, 'utf-8');
                await handle.sync();
            } finally {
                await handle.close();
            }
            await fs.rename(tmpPath, filePath);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[wakeupStore] 写入 wakeups.json 失败：${message}`);
        }
    }

    /**
     * 追加一个唤醒任务（同 id 覆盖）。
     *
     * @param job 待写入的任务。
     */
    public async add(job: WakeupJob): Promise<void> {
        await this.enqueue(async () => {
            const jobs = await this.load();
            await this.saveAll([...jobs.filter((item) => item.id !== job.id), job]);
        });
    }

    /**
     * 按 id 删除一个唤醒任务。
     *
     * @param id 任务 id。
     * @returns 是否确实删除了一条记录。
     */
    public async remove(id: string): Promise<boolean> {
        return this.enqueue(async () => {
            const jobs = await this.load();
            const next = jobs.filter((item) => item.id !== id);
            if (next.length === jobs.length) return false;
            await this.saveAll(next);
            return true;
        });
    }

    /**
     * 把一次读-改-写操作挂到串行队列尾部。
     *
     * 队列只保证顺序，不传播异常：任一操作失败都不应阻断后续写入。
     *
     * @param operation 待串行执行的操作。
     * @returns 该操作的返回值。
     */
    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation, operation);
        this.queue = result.catch(() => undefined);
        return result;
    }

    /**
     * 解析 `.LLSOAI/wakeups.json` 的绝对路径，必要时创建父目录。
     *
     * @returns 文件绝对路径。
     */
    private async resolveFilePath(): Promise<string> {
        const dir = path.join(this.resolveRoot(), STORE_DIR_NAME);
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
