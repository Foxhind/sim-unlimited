import { createProgram, must, uniformMap, type Uniforms } from './gl';
import { FONT_FS, FONT_VS } from './shaders';
import { rampIndex, RAMP } from './palette';

export const GLYPH_W = 8;
export const GLYPH_H = 16;
const ATLAS_COLS = 64;
const FALLBACK = 0x3f; // '?'

export type BitmapFont = Map<number, Uint8Array>;

/**
 * Parses Unscii .hex lines: "00413:00007E60...". Later entries override earlier ones.
 * The file also contains 16px-wide glyphs (32 bytes); they are folded to 8px
 * by OR-ing adjacent pixel pairs, since UI text only uses the 8×16 cell.
 */
export function parseHex(text: string): BitmapFont {
  const font: BitmapFont = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) throw new Error(`Malformed hex line: ${trimmed}`);
    const code = parseInt(trimmed.slice(0, colon), 16);
    const data = trimmed.slice(colon + 1);
    const wide = data.length === GLYPH_H * 4;
    if (Number.isNaN(code) || (data.length !== GLYPH_H * 2 && !wide)) {
      throw new Error(`Malformed hex glyph: ${trimmed}`);
    }
    const rows = new Uint8Array(GLYPH_H);
    const bytesPerRow = wide ? 2 : 1;
    for (let i = 0; i < GLYPH_H; i++) {
      const b0 = parseInt(data.slice(i * bytesPerRow * 2, i * bytesPerRow * 2 + 2), 16);
      if (wide) {
        const b1 = parseInt(data.slice(i * 4 + 2, i * 4 + 4), 16);
        let folded = 0;
        for (let x = 0; x < 8; x++) {
          const bit = (src: number, p: number) => (p < 8 ? src & (0x80 >> p) : b1 & (0x80 >> (p - 8)));
          if (bit(b0, 2 * x) || bit(b0, 2 * x + 1)) folded |= 0x80 >> x;
        }
        rows[i] = folded;
      } else {
        rows[i] = b0;
      }
    }
    font.set(code, rows);
  }
  return font;
}

export interface FontAtlas {
  data: Uint8Array;
  width: number;
  height: number;
  /** codepoint → texel origin of its 8×16 glyph */
  origins: Map<number, [number, number]>;
}

export function buildAtlas(font: BitmapFont): FontAtlas {
  const codes = [...font.keys()].sort((a, b) => a - b);
  const rows = Math.ceil(codes.length / ATLAS_COLS);
  const width = ATLAS_COLS * GLYPH_W;
  const height = rows * GLYPH_H;
  const data = new Uint8Array(width * height);
  const origins = new Map<number, [number, number]>();
  codes.forEach((code, i) => {
    const ox = (i % ATLAS_COLS) * GLYPH_W;
    const oy = Math.floor(i / ATLAS_COLS) * GLYPH_H;
    origins.set(code, [ox, oy]);
    const glyph = font.get(code)!;
    for (let y = 0; y < GLYPH_H; y++) {
      const bits = glyph[y];
      for (let x = 0; x < GLYPH_W; x++) {
        if (bits & (0x80 >> x)) data[(oy + y) * width + ox + x] = 255;
      }
    }
  });
  return { data, width, height, origins };
}

const MAX_GLYPHS_PER_BATCH = 4096;
const FLOATS_PER_VERT = 4; // pos.xy, uv.xy
const VERTS_PER_GLYPH = 6;

export const HUD_GREEN = rampIndex(RAMP.HUD_GREEN, 13);
export const HUD_AMBER = rampIndex(RAMP.HUD_AMBER, 13);
export const HUD_WHITE = rampIndex(RAMP.EMISSIVE, 13);

export class FontRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Uniforms;
  private atlasTex: WebGLTexture;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private verts = new Float32Array(MAX_GLYPHS_PER_BATCH * VERTS_PER_GLYPH * FLOATS_PER_VERT);
  private glyphCount = 0;
  private batchIndex = -1;
  private atlas: FontAtlas;

  constructor(gl: WebGL2RenderingContext, font: BitmapFont) {
    this.gl = gl;
    this.atlas = buildAtlas(font);
    this.prog = createProgram(gl, FONT_VS, FONT_FS);
    this.u = uniformMap(gl, this.prog, ['uScreen', 'uAtlas', 'uIndex']);

    this.atlasTex = must(gl.createTexture(), 'font atlas');
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R8UI, this.atlas.width, this.atlas.height, 0,
      gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.atlas.data,
    );

    this.vao = must(gl.createVertexArray(), 'font VAO');
    gl.bindVertexArray(this.vao);
    this.vbo = must(gl.createBuffer(), 'font vertex buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, FLOATS_PER_VERT * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, FLOATS_PER_VERT * 4, 8);
    gl.bindVertexArray(null);
  }

  /** Coordinates and scale are in device pixels; scale must be a positive integer. */
  text(str: string, x: number, y: number, scale: number, index: number): void {
    if (this.batchIndex !== index) this.flush();
    this.batchIndex = index;
    const s = Math.max(1, Math.round(scale));
    let cx = Math.round(x);
    let cy = Math.round(y);
    for (const ch of str) {
      const code = ch.codePointAt(0)!;
      if (code === 10) {
        cx = Math.round(x);
        cy += GLYPH_H * s;
        continue;
      }
      if (this.glyphCount >= MAX_GLYPHS_PER_BATCH) this.flush();
      const origin = this.atlas.origins.get(code) ?? this.atlas.origins.get(FALLBACK)!;
      const w = GLYPH_W * s;
      const h = GLYPH_H * s;
      // UV span [origin, origin+size): fragment centers land on texel centers (see FONT_FS floor)
      const [u0, v0] = origin;
      const u1 = u0 + GLYPH_W;
      const v1 = v0 + GLYPH_H;
      const base = this.glyphCount * VERTS_PER_GLYPH * FLOATS_PER_VERT;
      const v = this.verts;
      const quad = [
        cx, cy, u0, v0,
        cx + w, cy, u1, v0,
        cx + w, cy + h, u1, v1,
        cx, cy, u0, v0,
        cx + w, cy + h, u1, v1,
        cx, cy + h, u0, v1,
      ];
      v.set(quad, base);
      this.glyphCount++;
      cx += w;
    }
  }

  flush(): void {
    if (this.glyphCount === 0) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniform1ui(this.u.uIndex, this.batchIndex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(this.u.uAtlas, 0);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts, 0, this.glyphCount * VERTS_PER_GLYPH * FLOATS_PER_VERT);
    gl.drawArrays(gl.TRIANGLES, 0, this.glyphCount * VERTS_PER_GLYPH);
    gl.bindVertexArray(null);
    this.glyphCount = 0;
  }

  setScreenSize(w: number, h: number): void {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uScreen, w, h);
  }

  measure(str: string, scale: number): number {
    let cols = 0;
    let max = 0;
    for (const ch of str) {
      if (ch === '\n') {
        max = Math.max(max, cols);
        cols = 0;
      } else {
        cols++;
      }
    }
    return Math.max(max, cols) * GLYPH_W * Math.max(1, Math.round(scale));
  }
}