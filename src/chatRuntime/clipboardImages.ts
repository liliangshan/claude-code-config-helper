/** @file 读取用户粘贴 HTML 中的图片；不带浏览器凭据，限制大小、时间和地址范围。 */
import * as http from 'node:http';
import * as https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** 与普通附件保持一致的单图上限。 */
export const CLIPBOARD_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** 图片读取结果，仅允许能作为聊天图片发送的光栅格式。 */
export interface ClipboardImage {
    bytes: Buffer;
    mime: string;
    extension: string;
}

/**
 * 判断下载目标是否为公网地址，拒绝回环、内网、链路本地和特殊地址。
 * @param address DNS 返回的 IP；仅支持原生 IPv4 和公网 IPv6。
 * @returns 是否允许建立连接。
 */
export function isPublicImageAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
            || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
    }
    if (isIP(address) !== 6) return false;
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    // 限制为 global-unicast，并排除 IPv4 转换/隧道及文档地址。
    return /^[23]/.test(normalized) && !normalized.startsWith('2001:') && !normalized.startsWith('2002:') && !normalized.startsWith('3fff:');
}

/**
 * 按文件签名校验图片，拒绝伪装为 image/* 的 HTML、脚本或 SVG。
 * @param bytes 已完整读取的文件。
 * @returns 可上传的图片及真实 MIME/后缀。
 */
export function validateClipboardImage(bytes: Buffer): ClipboardImage {
    if (bytes.length === 0 || bytes.length > CLIPBOARD_IMAGE_MAX_BYTES) throw new Error('Clipboard image is empty or exceeds 20 MiB');
    let type: [string, string] | undefined;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) type = ['image/png', '.png'];
    else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) type = ['image/jpeg', '.jpg'];
    else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) type = ['image/gif', '.gif'];
    else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') type = ['image/webp', '.webp'];
    else if (bytes.subarray(0, 2).toString() === 'BM') type = ['image/bmp', '.bmp'];
    else if (bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))) type = ['image/tiff', '.tiff'];
    if (!type) throw new Error('Unsupported clipboard image format');
    return { bytes, mime: type[0], extension: type[1] };
}

/**
 * 读取剪贴板图片：内嵌 data URL 直接解码，公网 HTTP(S) 最多跟随三次重定向。
 * @param source HTML img 来源；禁止 file/blob/携带用户密码的地址。
 * @returns 经签名校验的图片；不发送 Cookie、Authorization 或 Referer。
 */
export async function readClipboardImage(source: string): Promise<ClipboardImage> {
    if (typeof source !== 'string' || source.length > Math.ceil(CLIPBOARD_IMAGE_MAX_BYTES * 4 / 3) + 128) throw new Error('Invalid clipboard image source');
    if (/^data:/i.test(source)) {
        const match = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|tiff);base64,([a-z0-9+/]*={0,2})$/i.exec(source);
        if (!match) throw new Error('Unsupported clipboard data URL');
        return validateClipboardImage(Buffer.from(match[1], 'base64'));
    }
    const deadline = Date.now() + 15000;
    let url: URL;
    try { url = new URL(source); } catch { throw new Error('Invalid clipboard image URL'); }
    for (let redirects = 0; redirects <= 3; redirects += 1) {
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw new Error('Unsupported clipboard image URL');
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        if (isIP(hostname) && !isPublicImageAddress(hostname)) throw new Error('Private clipboard image addresses are not allowed');
        const result = await requestImage(url, deadline);
        if (result.bytes) return validateClipboardImage(result.bytes);
        if (!result.location || redirects === 3) throw new Error('Too many image redirects');
        let next: URL;
        try { next = new URL(result.location, url); } catch { throw new Error('Invalid image redirect'); }
        if (url.protocol === 'https:' && next.protocol === 'http:') throw new Error('Insecure image redirect');
        url = next;
    }
    throw new Error('Clipboard image download failed');
}

/**
 * 下载单跳图片并在连接时校验 DNS，固定解析后的地址以避免重绑定到内网。
 * @param url 经过协议和凭据检查的 URL。
 * @param deadline 整个下载链路的截止时间。
 * @returns 原始字节或待再次校验的重定向地址。
 */
async function requestImage(url: URL, deadline: number): Promise<{ bytes?: Buffer; location?: string }> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Clipboard image download timed out');
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const chunks: Buffer[] = [];
        let size = 0;
        const req = transport.get(url, {
            agent: false,
            headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/tiff', 'Accept-Encoding': 'identity' },
            lookup: (hostname, options, callback) => {
                void lookup(hostname, { all: true }).then(addresses => {
                    if (addresses.length === 0 || addresses.some(item => !isPublicImageAddress(item.address))) throw new Error('Private clipboard image addresses are not allowed');
                    if (options.all) callback(null, addresses);
                    else callback(null, addresses[0].address, addresses[0].family);
                }).catch(() => callback(new Error('Clipboard image address is unavailable or blocked'), '', 4));
            }
        }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
                clearTimeout(timer);
                const location = res.headers.location;
                res.destroy();
                resolve({ location });
                return;
            }
            if (res.statusCode !== 200 || !res.headers['content-type']?.toLowerCase().startsWith('image/') || Number(res.headers['content-length'] ?? 0) > CLIPBOARD_IMAGE_MAX_BYTES) {
                clearTimeout(timer);
                res.destroy();
                reject(new Error('Clipboard image response rejected'));
                return;
            }
            res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > CLIPBOARD_IMAGE_MAX_BYTES) req.destroy(new Error('Clipboard image exceeds 20 MiB'));
                else chunks.push(chunk);
            });
            res.on('end', () => { clearTimeout(timer); resolve({ bytes: Buffer.concat(chunks) }); });
            res.on('error', () => { clearTimeout(timer); reject(new Error('Clipboard image stream failed')); });
            res.on('aborted', () => { clearTimeout(timer); reject(new Error('Clipboard image stream aborted')); });
        });
        const timer = setTimeout(() => req.destroy(new Error('Clipboard image download timed out')), remaining);
        req.on('error', () => { clearTimeout(timer); reject(new Error('Clipboard image download failed')); });
    });
}
