import { describe, expect, it } from 'vitest';
import { scenesToEvict } from '../src/lib/xr/anchorSlots';

describe('scenesToEvict', () => {
  it('drops nothing while the saved alignments fit', () => {
    expect(scenesToEvict({ a: 1, b: 2 }, 'a', 7)).toEqual([]);
    expect(scenesToEvict({}, 'a', 7)).toEqual([]);
  });

  it('drops the oldest first, as many as exceed the cap', () => {
    expect(scenesToEvict({ new: 30, old: 10, mid: 20 }, 'x', 1)).toEqual(['old', 'mid']);
  });

  it('never drops the scene about to start, even when it is the oldest', () => {
    expect(scenesToEvict({ current: 1, b: 2, c: 3 }, 'current', 2)).toEqual(['b']);
  });

  it('treats entries without a save time (0) as the oldest', () => {
    expect(scenesToEvict({ legacy: 0, a: 5, b: 6 }, 'a', 2)).toEqual(['legacy']);
  });
});
