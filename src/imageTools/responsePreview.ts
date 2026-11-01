/** @file Bounded, redacted response excerpts for image failures; never retain full provider payloads. */
import type { ImageResponsePreview } from './types';

export const IMAGE_ERROR_PREVIEW_LIMIT = 500;
export const IMAGE_ERROR_CAPTURE_BYTES = 64 * 1024;

/**
 * Redact credentials, inline image data and URL query strings before retaining at most 500 characters.
 * @param body A bounded response prefix, not a request payload.
 * @param status The received HTTP status code.
 * @param secrets Known request-header secrets to remove even when echoed without a field name.
 * @param incomplete Whether the captured prefix ended before the full response body.
 * @returns A safe diagnostic excerpt, including explicit truncation and HTTP status metadata.
 */
export function imageResponsePreview(body: string, status: number, secrets: string[] = [], incomplete = false): ImageResponsePreview {
    let text = body;
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
        text = text.split(secret).join('[REDACTED]');
        const escaped = JSON.stringify(secret).slice(1, -1);
        if (escaped !== secret) text = text.split(escaped).join('[REDACTED]');
    }
    text = text
        .replace(/data:[^\s"'<>]*;base64,[a-z\d+/=_-]*/gi, '[IMAGE DATA REDACTED]')
        .replace(/(["'](?:b64_json|image|image_url)["']\s*:\s*)"[^"\r\n]*(?:"|$)/gi, '$1"[IMAGE DATA REDACTED]"')
        .replace(/\b(?:Bearer|Basic)\s+[a-z\d._~+/=-]+/gi, '[AUTH REDACTED]')
        .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie|set-cookie|x-api-key)["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;}]+)/gi, '$1"[REDACTED]"')
        .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
            try { const url = new URL(value); url.username = ''; url.password = ''; if (url.search) url.search = '?REDACTED'; url.hash = ''; return url.toString(); }
            catch { return '[URL REDACTED]'; }
        })
        .replace(/[a-z\d+/=_-]{128,}/gi, '[LONG DATA REDACTED]')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    const characters = Array.from(text);
    return { status, body: characters.slice(0, IMAGE_ERROR_PREVIEW_LIMIT).join(''), truncated: incomplete || characters.length > IMAGE_ERROR_PREVIEW_LIMIT };
}

/**
 * Validate and re-sanitize a diagnostic restored from task storage or native chat history.
 * @param value Untrusted optional preview metadata.
 * @returns A bounded preview, or undefined when the shape/status is invalid.
 */
export function parseImageResponsePreview(value: unknown): ImageResponsePreview | undefined {
    const preview = value as ImageResponsePreview | undefined;
    if (!preview || !Number.isInteger(preview.status) || preview.status < 100 || preview.status > 599 || typeof preview.body !== 'string') return undefined;
    const bounded = preview.body.slice(0, IMAGE_ERROR_CAPTURE_BYTES);
    return imageResponsePreview(bounded, preview.status, [], preview.truncated === true || bounded.length !== preview.body.length);
}
