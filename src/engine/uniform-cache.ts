/**
 * A cache of uniform values on a WebGL2 context: a uniform set to the value its location already
 * holds is not set again. A uniform is program state, kept across useProgram, and each location
 * belongs to one program, so the last value set at a location is the value it holds.
 *
 * Why: the world is drawn in over a thousand calls a frame over a town, each setting some forty
 * uniforms that are the same for the whole frame (view, light, fog, shadows...): 1.2 million WebGL
 * calls a second, the main thread's frame bound by them (central Moscow: 28 ms of JS a frame).
 *
 * The cache wraps the context's own uniform setters, so every caller goes through it and none can
 * leave it stale. A setter called with an offset or a length (the WebGL2 array forms) is passed on
 * and forgets its location's value.
 */

type Setter = (this: WebGL2RenderingContext, loc: WebGLUniformLocation | null, ...args: unknown[]) => void;

const SCALARS = ['uniform1f', 'uniform2f', 'uniform3f', 'uniform4f', 'uniform1i', 'uniform2i', 'uniform3i', 'uniform4i', 'uniform1ui', 'uniform2ui', 'uniform3ui', 'uniform4ui'] as const;
const VECTORS = ['uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv', 'uniform1iv', 'uniform2iv', 'uniform3iv', 'uniform4iv', 'uniform1uiv', 'uniform2uiv', 'uniform3uiv', 'uniform4uiv'] as const;
const MATRICES = ['uniformMatrix2fv', 'uniformMatrix3fv', 'uniformMatrix4fv'] as const;

const installed = new WeakSet<WebGL2RenderingContext>();

/** the values held: what was last set at each location (a copy of an array) */
export function installUniformCache(gl: WebGL2RenderingContext): void {
  if (installed.has(gl)) return;
  installed.add(gl);
  const held = new WeakMap<WebGLUniformLocation, number[]>();
  const same = (loc: WebGLUniformLocation, v: ArrayLike<number>): boolean => {
    const h = held.get(loc);
    if (!h || h.length !== v.length) return false;
    for (let i = 0; i < v.length; i++) if (h[i] !== v[i] && !(h[i] !== h[i] && v[i] !== v[i])) return false;
    return true;
  };
  const keep = (loc: WebGLUniformLocation, v: ArrayLike<number>): void => {
    const h = held.get(loc);
    if (h && h.length === v.length) for (let i = 0; i < v.length; i++) h[i] = v[i];
    else held.set(loc, Array.from(v));
  };
  const ctx = gl as unknown as Record<string, Setter>;
  for (const name of SCALARS) {
    const set = ctx[name].bind(gl);
    ctx[name] = function (loc, ...args) {
      if (!loc) return;
      const v = args as number[];
      if (same(loc, v)) return;
      keep(loc, v);
      set(loc, ...args);
    };
  }
  for (const name of VECTORS) {
    const set = ctx[name].bind(gl);
    ctx[name] = function (loc, data, ...rest) {
      if (!loc) return;
      if (rest.length) { held.delete(loc); set(loc, data, ...rest); return; }
      const v = data as ArrayLike<number>;
      if (same(loc, v)) return;
      keep(loc, v);
      set(loc, data);
    };
  }
  for (const name of MATRICES) {
    const set = ctx[name].bind(gl);
    ctx[name] = function (loc, transpose, data, ...rest) {
      if (!loc) return;
      if (rest.length || transpose) { held.delete(loc); set(loc, transpose, data, ...rest); return; }
      const v = data as ArrayLike<number>;
      if (same(loc, v)) return;
      keep(loc, v);
      set(loc, transpose, data);
    };
  }
}
