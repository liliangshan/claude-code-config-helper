/** @file Shared GIF parameter validation for admission, upstream payloads and persisted metadata. */
import { ImageError, type ImageAnimationOptions } from './types';

export const IMAGE_GIF_ENV = 'LLS_IMAGE_SUPPORTS_GIF';
export const IMAGE_CONFIG_REVISION_ENV = 'LLS_IMAGE_CONFIG_REVISION';

/**
 * Validate explicit GIF requests without silently converting static requests or accepting coerced numbers.
 * @param input Model arguments or previously normalized task metadata.
 * @param size Explicit request dimensions; GIF dimensions must be positive multiples of sixteen.
 * @param supportsGif Whether the selected image model has explicitly enabled GIF support.
 * @returns Empty static options or normalized GIF fields with documented frame defaults.
 */
export function imageAnimationOptions(input: ImageAnimationOptions | Record<string, unknown>, size: string, supportsGif: boolean): ImageAnimationOptions {
    const supplied = ['output_format', 'frame_count', 'frame_duration_ms'].some(key => Object.prototype.hasOwnProperty.call(input, key));
    if (!supplied) return {};
    if (!supportsGif) throw new ImageError('IMAGE_GIF_UNSUPPORTED');
    if (input.output_format !== 'gif') throw new ImageError('IMAGE_ARGUMENT_INVALID');
    if (!/^[1-9]\d{0,5}x[1-9]\d{0,5}$/.test(size) || size.split('x').some(value => Number(value) % 16 !== 0)) throw new ImageError('IMAGE_ARGUMENT_INVALID');
    const frameCount = input.frame_count === undefined ? 9 : input.frame_count;
    const frameDuration = input.frame_duration_ms === undefined ? 200 : input.frame_duration_ms;
    if (typeof frameCount !== 'number' || !Number.isInteger(frameCount) || frameCount < 2 || frameCount > 64
        || typeof frameDuration !== 'number' || !Number.isInteger(frameDuration) || frameDuration < 20 || frameDuration > 2000) throw new ImageError('IMAGE_ARGUMENT_INVALID');
    return { output_format: 'gif', frame_count: frameCount, frame_duration_ms: frameDuration };
}
