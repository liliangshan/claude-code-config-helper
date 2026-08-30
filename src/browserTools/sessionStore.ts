/** @file 内置浏览器登录态快照的持久化存储（SecretStorage），不含任何 CDP 逻辑。 */

import { Logger } from '../logger';

/** SecretStorage 中单个 origin 快照的 key 前缀。 */
const KEY_PREFIX = 'llsccai.browserSession.';

/** origin 索引 key；SecretStorage 无 list API，需自维护。 */
const INDEX_KEY = `${KEY_PREFIX}__index`;

/** CDP cookie 中需要持久化并可回灌的字段子集。 */
export interface BrowserCookie {
    /** cookie 名。 */
    name: string;
    /** cookie 值。 */
    value: string;
    /** 生效域名，可能以 `.` 开头表示包含子域。 */
    domain: string;
    /** 生效路径。 */
    path: string;
    /** 是否仅 HTTPS 传输。 */
    secure: boolean;
    /** 是否禁止脚本读取。 */
    httpOnly: boolean;
    /** 过期时间（Unix 秒）；缺省表示会话级 cookie。 */
    expires?: number;
    /** SameSite 策略。 */
    sameSite?: 'Strict' | 'Lax' | 'None';
}

/** 单个 origin 的浏览器会话快照。 */
export interface BrowserSessionSnapshot {
    /** 快照所属 origin，如 https://console.xingchiyun.com。 */
    origin: string;
    /** 保存时间 ISO 字符串。 */
    savedAt: string;
    /** 该浏览器上下文中的全部 cookie。 */
    cookies: BrowserCookie[];
    /** localStorage 键值对。 */
    localStorage: [string, string][];
    /** sessionStorage 键值对。 */
    sessionStorage: [string, string][];
}

/** 读写 SecretStorage 的最小接口，便于单测替身。 */
export interface SecretStorageLike {
    /** 读取一个 key。 */
    get(key: string): Thenable<string | undefined>;
    /** 写入一个 key。 */
    store(key: string, value: string): Thenable<void>;
    /** 删除一个 key。 */
    delete(key: string): Thenable<void>;
}

/** 提取 URL 的 origin；非 http(s)（about:blank、chrome-error 等）返回 undefined。 */
export function toOrigin(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return undefined;
        }
        return parsed.origin;
    } catch {
        return undefined;
    }
}

/** 把 CDP 原始 cookie 裁剪为可回灌字段，丢弃 size/priority/sourcePort 等只读字段。 */
export function sanitizeCookies(raw: readonly unknown[]): BrowserCookie[] {
    const result: BrowserCookie[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const c = item as Record<string, unknown>;
        if (typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') {
            continue;
        }
        const cookie: BrowserCookie = {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: typeof c.path === 'string' ? c.path : '/',
            secure: c.secure === true,
            httpOnly: c.httpOnly === true
        };
        if (typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0) {
            cookie.expires = c.expires;
        }
        if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') {
            cookie.sameSite = c.sameSite;
        }
        result.push(cookie);
    }
    return result;
}

/** 判断 cookie 是否已过期；无 expires 的会话级 cookie 视为未过期。 */
export function isExpired(cookie: BrowserCookie, nowMs: number): boolean {
    return typeof cookie.expires === 'number' && cookie.expires * 1000 <= nowMs;
}

/** 按 origin 在 SecretStorage 中存取浏览器会话快照。 */
export class BrowserSessionStore {
    /** 创建存储实例。 */
    public constructor(private readonly secrets: SecretStorageLike) {}

    /** 读取指定 origin 的快照；不存在或解析失败返回 undefined。 */
    public async load(origin: string): Promise<BrowserSessionSnapshot | undefined> {
        const raw = await this.secrets.get(KEY_PREFIX + origin);
        if (!raw) {
            return undefined;
        }
        try {
            return JSON.parse(raw) as BrowserSessionSnapshot;
        } catch (err) {
            Logger.warn(`浏览器会话快照解析失败，已忽略：${origin}`, err);
            return undefined;
        }
    }

    /** 写入快照并把 origin 登记进索引。 */
    public async save(snapshot: BrowserSessionSnapshot): Promise<void> {
        await this.secrets.store(KEY_PREFIX + snapshot.origin, JSON.stringify(snapshot));
        const origins = await this.readIndex();
        if (!origins.includes(snapshot.origin)) {
            await this.writeIndex([...origins, snapshot.origin]);
        }
    }

    /** 删除指定 origin 的快照并从索引移除。 */
    public async delete(origin: string): Promise<void> {
        await this.secrets.delete(KEY_PREFIX + origin);
        const origins = await this.readIndex();
        if (origins.includes(origin)) {
            await this.writeIndex(origins.filter((item) => item !== origin));
        }
    }

    /** 列出已存快照的全部 origin。 */
    public async listOrigins(): Promise<string[]> {
        return this.readIndex();
    }

    /** 读取 origin 索引；损坏时返回空数组。 */
    private async readIndex(): Promise<string[]> {
        const raw = await this.secrets.get(INDEX_KEY);
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw) as unknown;
            return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
        } catch (err) {
            Logger.warn('浏览器会话索引解析失败，按空索引处理。', err);
            return [];
        }
    }

    /** 覆盖写入 origin 索引。 */
    private async writeIndex(origins: string[]): Promise<void> {
        await this.secrets.store(INDEX_KEY, JSON.stringify(origins));
    }
}
