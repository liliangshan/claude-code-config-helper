/** @file Non-executing HTML-to-text extraction for bounded HTTP responses; no browser or resource fetching. */
import { Parser } from 'htmlparser2';

/** HTML response metadata keeps extraction distinct from the original wire representation. */
export interface HtmlTextResult { text: string; title?: string }

const ignoredElements = new Set(['head', 'script', 'style', 'template', 'noscript', 'svg', 'canvas', 'iframe', 'object']);
const blockElements = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul']);

/** Trust explicit MIME types; sniff only a missing type so JSON/plain-text code samples remain unchanged. */
export function isHtmlResponse(contentType: string, body: string): boolean {
    const mime = contentType.split(';', 1)[0].trim().toLowerCase();
    return mime === 'text/html' || mime === 'application/xhtml+xml'
        || (!mime && /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(body));
}

/** Decode HTML using a declared charset where available; unsupported charset labels fall back to UTF-8. */
export function decodeHtmlResponse(bytes: Uint8Array, contentType: string): string {
    const charset = /\bcharset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || 'utf-8';
    try { return new TextDecoder(charset).decode(bytes); }
    catch { return new TextDecoder('utf-8').decode(bytes); }
}

/** Extract static readable text, suppressing non-content/explicitly hidden subtrees and preserving block boundaries. */
export function htmlToText(html: string): HtmlTextResult {
    const parts: string[] = [], titles: string[] = [];
    const stack: Array<{ name: string; hidden: boolean; pre: boolean; title: boolean }> = [];
    let last = '', pendingSpace = false;
    /** Append visible text without merging neighboring words or executing markup decoded from entities. */
    const appendText = (text: string, pre: boolean): void => {
        if (!text) return;
        if (pre) {
            pendingSpace = false; parts.push(text); last = text.slice(-1); return;
        }
        const normalized = text.replace(/[\t\n\r\f ]+/g, ' ');
        const core = normalized.trim();
        if (!core) { if (normalized) pendingSpace = true; return; }
        if ((pendingSpace || normalized.startsWith(' ')) && last && !/\s/.test(last)) parts.push(' ');
        parts.push(core); last = core.slice(-1); pendingSpace = normalized.endsWith(' ');
    };
    /** Add a boundary only when visible text precedes it; block tags do not produce empty-page noise. */
    const lineBreak = (): void => {
        pendingSpace = false;
        if (last && last !== '\n') { parts.push('\n'); last = '\n'; }
    };
    const parser = new Parser({
        onopentag(name, attributes) {
            const parent = stack[stack.length - 1];
            const explicitlyHidden = Object.prototype.hasOwnProperty.call(attributes, 'hidden')
                || attributes['aria-hidden']?.toLowerCase() === 'true'
                || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(attributes.style ?? '');
            const title = name === 'title' && !explicitlyHidden && stack.every(frame => frame.name === 'html' || frame.name === 'head');
            const hidden = !!parent?.hidden || ignoredElements.has(name) || explicitlyHidden || name === 'title';
            const pre = name === 'pre' || !!parent?.pre;
            stack.push({ name, hidden, pre, title });
            if (hidden) return;
            if (blockElements.has(name)) lineBreak();
            if (name === 'li') appendText('- ', false);
            if (name === 'td' || name === 'th') pendingSpace = true;
            if (name === 'img' && attributes.alt) appendText(attributes.alt, pre);
        },
        ontext(text) {
            const frame = stack[stack.length - 1];
            if (frame?.title) { titles.push(text); return; }
            if (!frame?.hidden) appendText(text, !!frame?.pre);
        },
        onclosetag(name) {
            const frame = stack.pop();
            if (!frame?.hidden && blockElements.has(name)) lineBreak();
            if (!frame?.hidden && (name === 'td' || name === 'th')) pendingSpace = true;
        }
    }, { decodeEntities: true });
    parser.end(html);
    const title = titles.join('').replace(/\s+/g, ' ').trim();
    return { text: parts.join('').trim(), ...(title ? { title } : {}) };
}
