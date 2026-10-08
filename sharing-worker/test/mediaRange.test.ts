import { describe, expect, it } from 'vitest';
import { MEDIA_CACHE_WINDOW_BYTES, mediaCacheWindow } from '../src/cache/mediaCache';
import { boundedMediaRange } from '../src/viewer/routes';

const W = MEDIA_CACHE_WINDOW_BYTES;

describe('media windows', () => {
  it('aligns every byte to a fixed window, the last one cut at the asset end', () => {
    expect(mediaCacheWindow(0, 3 * W)).toEqual({ start: 0, end: W - 1 });
    expect(mediaCacheWindow(W + 17, 3 * W)).toEqual({ start: W, end: 2 * W - 1 });
    expect(mediaCacheWindow(2 * W + 5, 2 * W + 10)).toEqual({ start: 2 * W, end: 2 * W + 9 });
  });

  it('serves an open-ended request up to the end of its window', () => {
    expect(boundedMediaRange(null, 3 * W)).toEqual({ start: 0, end: W - 1 });
    expect(boundedMediaRange({ start: W, end: 3 * W - 1 }, 3 * W)).toEqual({ start: W, end: 2 * W - 1 });
  });

  it('cuts a mid-window seek at the window boundary so the next request starts aligned', () => {
    expect(boundedMediaRange({ start: W + 100, end: 3 * W - 1 }, 3 * W)).toEqual({ start: W + 100, end: 2 * W - 1 });
  });

  it('never serves more than was asked for', () => {
    expect(boundedMediaRange({ start: 10, end: 20 }, 3 * W)).toEqual({ start: 10, end: 20 });
  });
});
