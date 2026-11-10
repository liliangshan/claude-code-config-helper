/** @file Conservative UTF-8 SVG validation; output stays local and opens only in a text editor. */
import { Parser } from 'htmlparser2';
import { ImageError } from './types';

const tags = new Set(['svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern']);
const attributes = new Set(('id xmlns xmlns:xlink viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d points transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity color style font-family font-size font-weight font-style text-anchor dominant-baseline dx dy rotate textLength lengthAdjust gradientUnits gradientTransform offset stop-color stop-opacity spreadMethod patternUnits patternContentUnits patternTransform preserveAspectRatio clip-path clip-rule mask maskUnits maskContentUnits href xlink:href').split(' '));

/** Reject unmatched XML closing tags that a tolerant HTML parser would otherwise silently ignore. */
function validateSvgNesting(source: string): void {
    const body = source.replace(/^<\?xml\s[^?]*\?>\s*/, '');
    const stack: string[] = [];
    const tokens = /<\/?([A-Za-z][\w:.-]*)(?:[^<>"']|"[^"<>]*"|'[^'<>]*')*>/g;
    let end = 0;
    for (const match of body.matchAll(tokens)) {
        if (body.slice(end, match.index).includes('<')) throw new ImageError('IMAGE_SVG_UNSAFE');
        const token = match[0], name = match[1];
        if (token.startsWith('</')) {
            if (!/^<\/[A-Za-z][\w:.-]*\s*>$/.test(token) || stack.pop() !== name) throw new ImageError('IMAGE_SVG_UNSAFE');
        } else if (!token.endsWith('/>')) stack.push(name);
        end = match.index! + token.length;
    }
    if (stack.length || body.slice(end).includes('<')) throw new ImageError('IMAGE_SVG_UNSAFE');
}

/**
 * Validate a self-contained static SVG without rewriting its bytes or evaluating XML/CSS.
 * A deliberately narrow allowlist rejects active tags, DTDs, scripts, external resources and malformed nesting.
 * @param bytes Complete bounded provider output; partial signatures are not sufficient for SVG.
 * @returns Nothing when accepted; otherwise a stable format/security error without provider text.
 */
export function validateSvg(bytes: Buffer): void {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ImageError('IMAGE_FORMAT_UNSUPPORTED'); }
    const source = text.replace(/^﻿/, '').trim();
    if (!/^(?:<\?xml\s[^?]*\?>\s*)?<svg(?=[\s/>])/.test(source)) throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
    if (/<!|\b(?:javascript|vbscript|data|https?|file):/i.test(source.replace(/https?:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink)/g, ''))
        || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(source)) throw new ImageError('IMAGE_SVG_UNSAFE');
    validateSvgNesting(source);
    const stack: string[] = []; let roots = 0;
    const seenAttributes = new Set<string>();
    const parser = new Parser({
        /** Require XML quoting and unique attributes; HTML-style recovery must not admit ambiguous SVG. */
        onopentagname() { seenAttributes.clear(); },
        /** Reject duplicate, unquoted or valueless XML attributes before parser normalization drops them. */
        onattribute(name, _value, quote) {
            if ((quote !== '"' && quote !== "'") || seenAttributes.has(name)) throw new ImageError('IMAGE_SVG_UNSAFE');
            seenAttributes.add(name);
        },
        /** Validate exact SVG tag and namespace names without permitting embedded HTML or active elements. */
        onopentag(name, attrs) {
            if (!tags.has(name) || (stack.length === 0 && (name !== 'svg' || ++roots !== 1))) throw new ImageError('IMAGE_SVG_UNSAFE');
            if (name === 'svg' && attrs.xmlns !== undefined && attrs.xmlns !== 'http://www.w3.org/2000/svg') throw new ImageError('IMAGE_SVG_UNSAFE');
            if (attrs['xmlns:xlink'] !== undefined && attrs['xmlns:xlink'] !== 'http://www.w3.org/1999/xlink') throw new ImageError('IMAGE_SVG_UNSAFE');
            for (const [key, value] of Object.entries(attrs)) {
                if (!attributes.has(key) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\\]/.test(value)) throw new ImageError('IMAGE_SVG_UNSAFE');
                if (['href', 'xlink:href'].includes(key) && !/^#[A-Za-z_][\w:.-]*$/.test(value)) throw new ImageError('IMAGE_SVG_UNSAFE');
                if (key === 'style' && /@|\/\*|expression\s*\(|(?:javascript|vbscript|data|https?|file):/i.test(value)) throw new ImageError('IMAGE_SVG_UNSAFE');
                if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z_][\w:.-]*\)$/.test(value.trim())) throw new ImageError('IMAGE_SVG_UNSAFE');
            }
            stack.push(name);
        },
        /** Self-closing syntax is valid; inferred closures from malformed XML or end-of-input are not. */
        onclosetag(name, implied) {
            if (stack.pop() !== name || (implied && !source.slice(parser.startIndex, parser.endIndex + 1).endsWith('/>'))) throw new ImageError('IMAGE_SVG_UNSAFE');
        },
        /** Only whitespace may surround the single document root. */
        ontext(value) { if (!stack.length && value.trim()) throw new ImageError('IMAGE_SVG_UNSAFE'); },
        /** Allow only the standard XML declaration, never stylesheets, DTD or entity instructions. */
        onprocessinginstruction(name) { if (name !== '?xml' || roots > 0) throw new ImageError('IMAGE_SVG_UNSAFE'); }
    }, { xmlMode: true, decodeEntities: true });
    parser.end(source);
    if (roots !== 1 || stack.length) throw new ImageError('IMAGE_SVG_UNSAFE');
}
