import { describe, expect, it } from 'vitest';
import unsciiHex from '../assets/fonts/unscii-16.hex?raw';
import uaPatchHex from '../assets/fonts/unscii-16-ua-patch.hex?raw';
import { buildAtlas, GLYPH_H, GLYPH_W, parseHex } from '../src/engine/font';

describe('parseHex', () => {
  it('parses the full Unscii-16 font', () => {
    const font = parseHex(unsciiHex);
    expect(font.size).toBeGreaterThan(3000);
    for (const rows of font.values()) expect(rows.length).toBe(GLYPH_H);
    expect(font.has(0x41)).toBe(true); // A
    expect(font.has(0x413)).toBe(true); // Г
  });

  it('rejects malformed lines', () => {
    expect(() => parseHex('0041:00')).toThrow();
    expect(() => parseHex('garbage')).toThrow();
  });

  it('UA patch adds the four missing glyphs (Q38)', () => {
    const base = parseHex(unsciiHex);
    for (const code of [0x490, 0x491, 0x404, 0x454]) expect(base.has(code)).toBe(false);
    const merged = parseHex(unsciiHex + '\n' + uaPatchHex);
    for (const code of [0x490, 0x491, 0x404, 0x454]) {
      expect(merged.has(code)).toBe(true);
      expect(merged.get(code)!.length).toBe(GLYPH_H);
    }
    // Ґ derives from Г: same body, extra tick above the bar
    expect(merged.get(0x490)![1]).toBe(0x02);
    expect(merged.get(0x490)!.slice(2)).toEqual(merged.get(0x413)!.slice(2));
    // patch must not clobber anything else
    for (const [code, rows] of parseHex(unsciiHex)) {
      expect(merged.get(code)).toEqual(rows);
    }
  });

  it('patch glyphs are non-empty and 8 bits wide', () => {
    const patch = parseHex(uaPatchHex);
    for (const rows of patch.values()) {
      expect(rows.some((r) => r !== 0)).toBe(true);
      for (const r of rows) expect(r).toBeLessThanOrEqual(0xff);
    }
  });
});

describe('buildAtlas', () => {
  const font = parseHex(unsciiHex + '\n' + uaPatchHex);
  const atlas = buildAtlas(font);

  it('lays out every glyph on an 8×16 grid', () => {
    expect(atlas.origins.size).toBe(font.size);
    expect(atlas.width % GLYPH_W).toBe(0);
    expect(atlas.height % GLYPH_H).toBe(0);
    expect(atlas.data.length).toBe(atlas.width * atlas.height);
    for (const [x, y] of atlas.origins.values()) {
      expect(x % GLYPH_W).toBe(0);
      expect(y % GLYPH_H).toBe(0);
      expect(x + GLYPH_W).toBeLessThanOrEqual(atlas.width);
      expect(y + GLYPH_H).toBeLessThanOrEqual(atlas.height);
    }
  });

  it('rasterizes glyph bits into the atlas', () => {
    const [ox, oy] = atlas.origins.get(0x41)!; // 'A'
    let lit = 0;
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        if (atlas.data[(oy + y) * atlas.width + ox + x]) lit++;
      }
    }
    expect(lit).toBeGreaterThan(10);
  });

  it('blank glyphs stay blank', () => {
    const [ox, oy] = atlas.origins.get(0x20)!; // space
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        expect(atlas.data[(oy + y) * atlas.width + ox + x]).toBe(0);
      }
    }
  });
});