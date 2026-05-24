/** @file 项目级 Chat CLI session_id 持久化。 */

import * as fs from 'fs/promises';
import * as path from 'path';

/** LLS OAI 项目状态目录名。 */
const SESSION_DIR_NAME = '.LLSOAI';

/** CLI session 元数据文件名。 */
const SESSION_FILE_NAME = 'chat-session.json';

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
 * 读写项目目录 `.LLSOAI/chat-session.json` 中的 CLI session_id。
 *
 * 该类不参与 VS Code workspaceState，只把 Claude CLI 协议层的 session_id
 * 保存在 CLI 当前工作目录下，便于下次启动同一项目时恢复原会话。
 */
export class ChatCliSessionStore {
    /**
     * 读取指定工作目录保存的 session_id。
     *
     * @param cwd CLI 子进程工作目录。
     * @returns 存在且合法时返回 session_id，否则返回 undefined。
     */
    public async readSessionId(cwd: string): Promise<string | undefined> {
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
     */
    public async writeSessionId(cwd: string, sessionId: string): Promise<void> {
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
     * 用于扩展启动 / 重载时主动放弃旧 CLI session：避免出现 CLI 端用
     * `--resume` 拉回旧上下文、扩展端 LlsTaskService 内存却已经清空 workflow
     * 的脱节状态（症状是模型只回 "Workflow created" 文本但不再调用 create
     * 工具，导致任务流卡住、工具不被实际调用）。
     *
     * 文件不存在时静默忽略。
     *
     * @param cwd CLI 子进程工作目录。
     */
    public async clearSessionId(cwd: string): Promise<void> {
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
     * @returns `.LLSOAI` 目录绝对路径。
     */
    private resolveSessionDir(cwd: string): string {
        return path.join(cwd, SESSION_DIR_NAME);
    }

    /**
     * 解析项目级 CLI session 元数据文件路径。
     *
     * @param cwd CLI 子进程工作目录。
     * @returns `chat-session.json` 文件绝对路径。
     */
    private resolveSessionFile(cwd: string): string {
        return path.join(this.resolveSessionDir(cwd), SESSION_FILE_NAME);
    }
}