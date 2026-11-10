/** @file Host-free image output capabilities, default selection and format-specific request validation. */
import { ImageError, type ImageAnimationOptions, type ImageFormatCapabilities, type ImageOutputFormat } from './types';
import { imageAnimationOptions } from './animation';

export const IMAGE_FORMATS_ENV = 'LLS_IMAGE_OUTPUT_FORMATS';
const capabilityKeys = { png: 'supportsPng', jpg: 'supportsJpg', gif: 'supportsGif', svg: 'supportsSvg' } as const;

/** List enabled formats deterministically, retaining boolean GIF capability compatibility for legacy callers. */
export function enabledImageFormats(capabilities: ImageFormatCapabilities | boolean): ImageOutputFormat[] {
    const flags = typeof capabilities === 'boolean'
        ? { supportsPng: true, supportsJpg: false, supportsGif: capabilities, supportsSvg: false } : capabilities;
    return (Object.keys(capabilityKeys) as ImageOutputFormat[]).filter(format => flags[capabilityKeys[format]]);
}

/** Prefer PNG, then an enabled static alternative; never choose GIF implicitly for an ordinary image request. */
export function defaultImageFormat(capabilities: ImageFormatCapabilities | boolean): ImageOutputFormat | undefined {
    const enabled = enabledImageFormats(capabilities);
    return (['png', 'jpg', 'svg'] as const).find(format => enabled.includes(format));
}

/** Parse only public capability tokens from MCP environment, failing closed to PNG on malformed input. */
export function imageFormatsFromEnvironment(env: NodeJS.ProcessEnv): ImageFormatCapabilities {
    const value = env[IMAGE_FORMATS_ENV];
    const formats = value === undefined ? ['png', ...(env.LLS_IMAGE_SUPPORTS_GIF === '1' ? ['gif'] : [])] : value.split(',');
    const valid = formats.length > 0 && formats.every(format => Object.prototype.hasOwnProperty.call(capabilityKeys, format));
    const enabled = valid ? formats : ['png'];
    return { supportsPng: enabled.includes('png'), supportsJpg: enabled.includes('jpg'), supportsGif: enabled.includes('gif'), supportsSvg: enabled.includes('svg') };
}

/**
 * Validate one requested output format before billing; static requests never acquire animation fields.
 * @param input Untrusted model arguments or an immutable accepted submission.
 * @param size Explicit image dimensions; GIF adds its existing alignment and frame checks.
 * @param capabilities Current settings or frozen execution capabilities.
 * @returns An explicit enabled format and, only for GIF, normalized animation fields.
 */
export function imageOutputOptions(input: ImageAnimationOptions | Record<string, unknown>, size: string, capabilities: ImageFormatCapabilities): ImageAnimationOptions {
    const format = input.output_format === undefined ? defaultImageFormat(capabilities) : input.output_format;
    if (typeof format !== 'string' || !Object.prototype.hasOwnProperty.call(capabilityKeys, format)) throw new ImageError('IMAGE_ARGUMENT_INVALID');
    if (!enabledImageFormats(capabilities).includes(format as ImageOutputFormat)) {
        throw new ImageError(format === 'gif' ? 'IMAGE_GIF_UNSUPPORTED' : 'IMAGE_FORMAT_DISABLED');
    }
    if (format === 'gif') return imageAnimationOptions(input, size, true);
    if (Object.prototype.hasOwnProperty.call(input, 'frame_count') || Object.prototype.hasOwnProperty.call(input, 'frame_duration_ms')) throw new ImageError('IMAGE_ARGUMENT_INVALID');
    return { output_format: format as ImageOutputFormat };
}

/** Preserve old no-format records while validating explicitly saved static/GIF metadata independent of current toggles. */
export function restoredImageOutputOptions(input: ImageAnimationOptions, size: string): ImageAnimationOptions {
    if (input.output_format === undefined && input.frame_count === undefined && input.frame_duration_ms === undefined) return {};
    return imageOutputOptions(input, size, { supportsPng: true, supportsJpg: true, supportsGif: true, supportsSvg: true });
}
