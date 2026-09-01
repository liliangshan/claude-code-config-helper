/** @file 项目级 Chat CLI session_id 持久化。 */

import * as fs from 'fs/promises';
import * as path from 'path';

/** LLS OAI 项目状态目录名。 */
const SESSION_DIR_NAME = '.LLSOAI';

/**
 * 普通任务模型 CLI 的 session 元数据文件名。
 *
 * 沿用旧文件名作为 normal CLI 的 session 持久化目标，既保持向后兼容
 * （旧版本 .LLSOAI/chat-session.json 直接被识别为 normal session），
 * 也避免老用户重启 VS Code 后因文件名变更导致 normal 会话丢失。
 *
 * 任务流路由（taskFlow）复用 normal CLI 进程，因此共用本文件。
 */
const SESSION_FILE_NAME_NORMAL = 'chat-session.json';

/**
 * `ChatCliSessionStore` 操作的 CLI 角色。
 *
 * - `'normal'`：普通任务模型 CLI（常驻）
 * - `'taskFlow'`：任务流路由，复用 normal CLI，与会话文件共用 normal 一档
 */
export type ChatCliSessionKind = 'normal' | 'taskFlow';

/** 保存到项目 .LLSOAI 目录的 CLI session 元数据。 */
interface StoredCliSession {
    /** 元数据结构版本号。 */
    version: 1;
    /** Claude CLI 返回的 session_id。 */
    sessionId: string;
    /** session 所属 CLI 工作目录。 */
    cwd: string;
    /** 最近一次更新时间戳。 */
    updatedAt: number;
}

/**
 * 读写项目目录 `.LLSOAI/chat-session*.json` 中的 CLI session_id。
 *
 * 该类不参与 VS Code workspaceState，只把 Claude CLI 协议层的 session_id
 * 保存在 CLI 当前工作目录下，便于下次启动同一项目时恢复原会话。
 *
 * `kind` 参数区分不同路由各自的 session 文件；normal 与 taskFlow 共用
 * `chat-session.json`（taskFlow 复用 normal CLI 进程）。
 */
export class ChatCliSessionStore {
    /**
     * 读取指定工作目录保存的 session_id。
     *
     * @param cwd CLI 子进程工作目录。
     * @param kind 目标 CLI 角色，默认 `'normal'`。
     * @returns 存在且合法时返回 session_id，否则返回 undefined。
     */
    public async readSessionId(cwd: string, kind: ChatCliSessionKind = 'normal'): Promise<string | undefined> {
        try {
            const raw = await fs.readFile(this.resolveSessionFile(cwd), 'utf8');
            const parsed = JSON.parse(raw) as Partial<StoredCliSession>;
            if (parsed.version !== 1 || typeof parsed.sessionId !== 'string') return undefined;
            const sessionId = parsed.sessionId.trim();
            return sessionId || undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * 保存 CLI init 事件返回的 session_id。
     *
     * @param cwd CLI 子进程工作目录。
     * @param sessionId Claude CLI 返回的 session_id。
     * @param kind 目标 CLI 角色，默认 `'normal'`。
     */
    public async writeSessionId(cwd: string, sessionId: string, kind: ChatCliSessionKind = 'normal'): Promise<void> {
        const normalizedSessionId = sessionId.trim();
        if (!normalizedSessionId) return;
        const dir = this.resolveSessionDir(cwd);
        await fs.mkdir(dir, { recursive: true });
        const payload: StoredCliSession = {
            version: 1,
            sessionId: normalizedSessionId,
            cwd,
            updatedAt: Date.now()
        };
        await fs.writeFile(this.resolveSessionFile(cwd), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }

    /**
     * 删除指定工作目录保存的 session_id 文件。
     *
     * 由 Chat 「清空」操作调用：清空当前会话上下文意味着不再 --resume 旧 CLI session，
     * 必须先抹掉磁盘上的 sessionId，再让 startChatCliFromCurrentConfig 以全新 session 启动。
     * 文件不存在时静默忽略，其它 IO 错误向上抛由调用方决定如何降级。
     *
     * @param cwd CLI 子进程工作目录。
     * @param kind 目标 CLI 角色，默认 `'normal'`。
     */
    public async clearSessionId(cwd: string, kind: ChatCliSessionKind = 'normal'): Promise<void> {
        try {
            await fs.unlink(this.resolveSessionFile(cwd));
        } catch (err: unknown) {
            if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') return;
            throw err;
        }
    }

    /**
     * 解析项目级 LLS OAI 状态目录路径。
     *
     * @param cwd CLI 子进程工作目录。
     * @returns `.LLSOAI` 目录绝对���径。
     */
    private resolveSessionDir(cwd: string): string {
        return path.join(cwd, SESSION_DIR_NAME);
    }

    /**
     * 解析项目级 CLI session 元数据文件路径。
     *
     * normal 与 taskFlow 共用同一文件（taskFlow 复用 normal CLI 进程）。
     *
     * @param cwd CLI 子进程工作目录。
     * @returns `chat-session.json` 文件绝对路径。
     */
    private resolveSessionFile(cwd: string): string {
        return path.join(this.resolveSessionDir(cwd), SESSION_FILE_NAME_NORMAL);
    }
}