/**
 * @file `.LLSOAI/task-flow.json` 持久化存储。
 *
 * 负责：
 * 1. 按工作区根定位 `.LLSOAI/task-flow.json` 文件（无工作区则回退到 `~/.LLSOAI/`）；
 * 2. 原子写（tmp + rename），避免半截 JSON；
 * 3. 反序列化时做防御校验，损坏文件一律当成 null，不阻塞启动；
 * 4. 读写失败仅 Logger.warn，绝不抛出影响主流程。
 *
 * 设计见 TASK_FLOW_PERSISTENCE_PLAN.md。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { Logger } from '../logger';
import type { LlsTaskSnapshot, LlsTaskWorkflow } from './types';

/** 落盘目录名（位于工作区根或用户主目录下）。 */
const STORE_DIR_NAME = '.LLSOAI';

/** 落盘文件名。 */
const STORE_FILE_NAME = 'task-flow.json';

/** 当前 schema 版本。 */
const SCHEMA_VERSION = 1;

/** 持久化文件顶层结构。 */
export interface PersistedTaskFlow {
    /** schema 版本，便于将来迁移。 */
    version: number;
    /** 落盘时间（ISO 8601 字符串）。 */
    savedAt: string;
    /** 业务快照。 */
    snapshot: LlsTaskSnapshot;
}

/**
 * `.LLSOAI/task-flow.json` 文件存储。
 *
 * 轻量持久化层，仅负责读写单个任务流快照文件。所有 IO 异常都被吞掉，只写扩展日志，
 * 绝不影响主流程或阻塞启动。
 */
export class TaskFlowStore {
    /**
     * 从磁盘读回任务流快照。
     *
     * 文件不存在 / 解析失败 / 版本不符 / 结构非法时一律返回 null（损坏文件不阻塞启动）。
     *
     * @returns 持久化的任务流快照；无有效数据时返回 null。
     */
    public async load(): Promise<LlsTaskSnapshot | null> {
        try {
            const filePath = await this.resolveFilePath();
            const text = await fs.readFile(filePath, 'utf-8').catch(() => undefined);
            if (text === undefined) return null;
            const parsed = JSON.parse(text) as Partial<PersistedTaskFlow>;
            if (!parsed || typeof parsed !== 'object') return null;
            if (parsed.version !== SCHEMA_VERSION) return null;
            const snapshot = parsed.snapshot;
            if (!snapshot || typeof snapshot !== 'object') return null;
            const workflow = snapshot.workflow;
            if (!workflow || !Array.isArray(workflow.tasks)) return null;
            return {
                workflow: this.normalizeWorkflow(workflow),
                planningDocumentPath: typeof snapshot.planningDocumentPath === 'string'
                    ? snapshot.planningDocumentPath
                    : undefined,
                originalUserPrompt: typeof snapshot.originalUserPrompt === 'string'
                    ? snapshot.originalUserPrompt
                    : undefined,
                lastError: typeof snapshot.lastError === 'string' ? snapshot.lastError : undefined,
                updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : Date.now()
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[llsTask.store] 加载 task-flow.json 失败：${message}`);
            return null;
        }
    }

    /**
     * 原子写入任务流快照到磁盘。
     *
     * @param snapshot 当前任务流快照。
     */
    public async save(snapshot: LlsTaskSnapshot): Promise<void> {
        try {
            const filePath = await this.resolveFilePath();
            const payload: PersistedTaskFlow = {
                version: SCHEMA_VERSION,
                savedAt: new Date().toISOString(),
                snapshot
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
            Logger.warn(`[llsTask.store] 写入 task-flow.json 失败：${message}`);
        }
    }

    /**
     * 删除任务流持久化文件（忽略文件不存在）。
     */
    public async clear(): Promise<void> {
        try {
            const filePath = await this.resolveFilePath();
            await fs.rm(filePath, { force: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[llsTask.store] 删除 task-flow.json 失败：${message}`);
        }
    }

    /**
     * 把磁盘读回的 workflow 规范化为合法结构，过滤非法 task。
     *
     * @param raw 原始解析 workflow。
     * @returns 规范化 workflow。
     */
    private normalizeWorkflow(raw: LlsTaskWorkflow): LlsTaskWorkflow {
        const tasks = raw.tasks
            .filter((task) => task && typeof task === 'object')
            .map((task, index) => ({
                id: String(task.id ?? index + 1),
                title: String(task.title ?? `Task ${index + 1}`),
                description: String(task.description ?? ''),
                status: task.status
            }));
        return {
            title: String(raw.title ?? ''),
            summary: String(raw.summary ?? ''),
            tasks
        };
    }

    /**
     * 解析 `.LLSOAI/task-flow.json` 的绝对路径，必要时创建父目录。
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
