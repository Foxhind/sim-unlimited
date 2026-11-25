import { describe, expect, it } from 'vitest';
import { installUniformCache } from '../src/engine/uniform-cache';

/** a context whose setters only record what reaches them */
function fakeGl() {
  const calls: string[] = [];
  const rec = (name: string) => (loc: { id: string } | null, ...args: unknown[]) => {
    calls.push(`${name} ${loc?.id} ${args.map((a) => (ArrayBuffer.isView(a) ? `[${Array.from(a as Float32Array)}]` : String(a))).join(' ')}`);
  };
  const gl: Record<string, unknown> = {};
  for (const n of ['uniform1f', 'uniform2f', 'uniform3f', 'uniform4f', 'uniform1i', 'uniform2i', 'uniform3i', 'uniform4i', 'uniform1ui', 'uniform2ui', 'uniform3ui', 'uniform4ui',
    'uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv', 'uniform1iv', 'uniform2iv', 'uniform3iv', 'uniform4iv', 'uniform1uiv', 'uniform2uiv', 'uniform3uiv', 'uniform4uiv',
    'uniformMatrix2fv', 'uniformMatrix3fv', 'uniformMatrix4fv']) gl[n] = rec(n);
  installUniformCache(gl as unknown as WebGL2RenderingContext);
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

describe('the uniform cache', () => {
  const a = { id: 'a' } as unknown as WebGLUniformLocation, b = { id: 'b' } as unknown as WebGLUniformLocation;

  it('passes a value on once while it stays the same, per location', () => {
    const { gl, calls } = fakeGl();
    gl.uniform1f(a, 2); gl.uniform1f(a, 2); gl.uniform1f(b, 2); gl.uniform1f(a, 3); gl.uniform1f(a, 3); gl.uniform1f(a, 2);
    expect(calls).toEqual(['uniform1f a 2', 'uniform1f b 2', 'uniform1f a 3', 'uniform1f a 2']);
  });

  it('compares an array by its values: the same array changed in place is set again', () => {
    const { gl, calls } = fakeGl();
    const v = new Float32Array([1, 2, 3]);
    gl.uniform3fv(a, v); gl.uniform3fv(a, new Float32Array([1, 2, 3]));
    v[1] = 5;
    gl.uniform3fv(a, v);
    expect(calls).toEqual(['uniform3fv a [1,2,3]', 'uniform3fv a [1,5,3]']);
  });

  it('matrices alike; a transposed or offset form passes on and forgets the value', () => {
    const { gl, calls } = fakeGl();
    const m = new Float32Array(16).fill(1);
    gl.uniformMatrix4fv(a, false, m); gl.uniformMatrix4fv(a, false, m);
    gl.uniform4fv(b, new Float32Array([1, 2, 3, 4, 5]), 1, 4);
    gl.uniform4fv(b, new Float32Array([2, 3, 4, 5]));
    gl.uniform4fv(b, new Float32Array([2, 3, 4, 5]));
    expect(calls.map((c) => c.split(' ')[0] + ' ' + c.split(' ')[1])).toEqual(['uniformMatrix4fv a', 'uniform4fv b', 'uniform4fv b']);
  });

  it('a null location sets nothing; NaN held equals NaN; an integer setter is cached too', () => {
    const { gl, calls } = fakeGl();
    gl.uniform1f(null, 1);
    gl.uniform1f(a, NaN); gl.uniform1f(a, NaN);
    gl.uniform1i(b, 4); gl.uniform1i(b, 4);
    expect(calls).toEqual(['uniform1f a NaN', 'uniform1i b 4']);
  });

  it('installs once on a context', () => {
    const { gl, calls } = fakeGl();
    installUniformCache(gl);
    gl.uniform1f(a, 1); gl.uniform1f(a, 1);
    expect(calls).toEqual(['uniform1f a 1']);
  });
});
