/**
 * Triangle lists welded into indexed meshes: vertices whose every attribute is the same bit for bit
 * are one (a normal: the same to NORMAL_Q), the triangles kept in their order. A range of the list
 * (the first n vertices of a mesh: a building's core, the terrain's near faces, a structure kind's
 * run) is the same range of the index; every triangle's vertices carry what they did (its normal to
 * within 1/NORMAL_Q).
 *
 * Why: the world's frame over a town is bound by its vertices, and a triangle list runs the vertex
 * shader three times a triangle. Faces are flat, a normal a triangle, so neighbours on one plane
 * differed in their normal's last bits and did not share their corners (central Moscow: the drape
 * welds ×2.7, roads ×1.8, buildings ×1.8).
 */

/** a normal's components are compared rounded to 1/NORMAL_Q (a light change far below a colour's step) */
export const NORMAL_Q = 65536;

export interface WeldStream {
  /** `size` words a vertex (Float32 or Uint32: compared as bits) */
  data: Float32Array | Uint32Array;
  size: number;
  /** words 3..5 of each vertex are a unit normal (interleaved position + normal: compared to NORMAL_Q) */
  normal?: boolean;
}

export interface Welded {
  /** a vertex a corner, in the list's order */
  index: Uint32Array;
  /** each stream's vertices, one each (the first of those welded together), in the streams' types */
  streams: (Float32Array | Uint32Array)[];
  /** vertices kept */
  unique: number;
}

/**
 * The list of `count` vertices in `streams` welded. A stream whose length is not count × size (an
 * absent optional one: no depth levels) is passed on as it is.
 */
export function weld(count: number, streams: WeldStream[]): Welded {
  const used = streams.map((s) => s.size > 0 && s.data.length === count * s.size);
  const words = streams.map((s) => new Uint32Array(s.data.buffer, s.data.byteOffset, s.data.length));
  const floats = streams.map((s) => (s.normal ? new Float32Array(s.data.buffer, s.data.byteOffset, s.data.length) : undefined));
  let K = 0;
  for (let s = 0; s < streams.length; s++) if (used[s]) K += streams[s].size;
  const index = new Uint32Array(count);
  const key = new Int32Array(K);
  // the kept vertices' keys, K words each, grown as needed
  let keys = new Int32Array(Math.max(16, Math.ceil(count / 2)) * K);
  let cap = 1;
  while (cap < count * 2) cap <<= 1;
  const table = new Int32Array(cap); // a kept vertex + 1, or 0
  const out = streams.map((s, i) => (used[i] ? new Uint32Array(count * s.size) : undefined));
  let unique = 0;
  for (let v = 0; v < count; v++) {
    let k = 0;
    for (let s = 0; s < streams.length; s++) {
      if (!used[s]) continue;
      const n = streams[s].size, w = words[s], f = floats[s], o = v * n;
      for (let i = 0; i < n; i++) key[k++] = f && i >= 3 && i < 6 ? Math.round(f[o + i] * NORMAL_Q) | 0 : w[o + i] | 0;
    }
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < K; i++) h = Math.imul(h ^ key[i], 0x01000193);
    h ^= h >>> 15;
    let slot = h & (cap - 1);
    let id = -1;
    for (;;) {
      const e = table[slot];
      if (e === 0) break;
      const base = (e - 1) * K;
      let same = true;
      for (let i = 0; i < K; i++) if (keys[base + i] !== key[i]) { same = false; break; }
      if (same) { id = e - 1; break; }
      slot = (slot + 1) & (cap - 1);
    }
    if (id < 0) {
      id = unique++;
      table[slot] = id + 1;
      if ((id + 1) * K > keys.length) {
        const grown = new Int32Array(keys.length * 2);
        grown.set(keys);
        keys = grown;
      }
      keys.set(key, id * K);
      for (let s = 0; s < streams.length; s++) {
        if (!used[s]) continue;
        const n = streams[s].size;
        out[s]!.set(words[s].subarray(v * n, v * n + n), id * n);
      }
    }
    index[v] = id;
  }
  return {
    index,
    unique,
    streams: streams.map((s, i) => {
      if (!used[i]) return s.data;
      const bits = out[i]!.slice(0, unique * s.size);
      return s.data instanceof Float32Array ? new Float32Array(bits.buffer) : bits;
    }),
  };
}

/** a welded stream back to the list (tests, and a list wanted again) */
export function unweld<T extends Float32Array | Uint32Array>(data: T, size: number, index: Uint32Array): T {
  const out = new (data.constructor as { new (n: number): T })(index.length * size);
  for (let v = 0; v < index.length; v++) for (let i = 0; i < size; i++) out[v * size + i] = data[index[v] * size + i];
  return out;
}
