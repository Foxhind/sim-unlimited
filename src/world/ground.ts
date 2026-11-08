import { must } from '../engine/gl';
import type { Mesh } from '../engine/renderer';
import { RAMP } from '../engine/palette';

export const GROUND_SIZE = 40960; // meters; height field is periodic over this span
const CELL = 256;
const N = GROUND_SIZE / CELL;
const TAU = Math.PI * 2;

/** Periodic over GROUND_SIZE so snapped re-offsets tile seamlessly (floating-origin preview). */
export function groundHeight(x: number, z: number): number {
  const u = (TAU * x) / GROUND_SIZE;
  const v = (TAU * z) / GROUND_SIZE;
  return (
    28 * Math.sin(2 * u) * Math.cos(3 * v) +
    16 * Math.sin(5 * u + 1.3) * Math.sin(4 * v + 0.7) +
    8 * Math.cos(9 * u + 2.1) * Math.cos(7 * v)
  );
}

function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

export interface GroundMesh extends Mesh {
  buffers: WebGLBuffer[];
}

export function createGroundMesh(gl: WebGL2RenderingContext): GroundMesh {
  const tris = N * N * 2;
  const vertCount = tris * 3;
  const floats = new Float32Array(vertCount * 6);
  const ramps = new Uint8Array(vertCount);
  let fi = 0;
  let ri = 0;

  const emit = (x: number, y: number, z: number, nx: number, ny: number, nz: number, ramp: number) => {
    floats[fi++] = x;
    floats[fi++] = y;
    floats[fi++] = z;
    floats[fi++] = nx;
    floats[fi++] = ny;
    floats[fi++] = nz;
    ramps[ri++] = ramp;
  };

  const half = GROUND_SIZE / 2;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x0 = ix * CELL - half;
      const z0 = iz * CELL - half;
      const x1 = x0 + CELL;
      const z1 = z0 + CELL;
      const h00 = groundHeight(x0, z0);
      const h10 = groundHeight(x1, z0);
      const h01 = groundHeight(x0, z1);
      const h11 = groundHeight(x1, z1);
      const ramp = hash2(ix, iz) < 0.14 ? RAMP.FIELD : RAMP.GRASS;

      // two triangles per cell, flat normal per triangle
      const trisDef = [
        [x0, h00, z0, x1, h10, z0, x1, h11, z1],
        [x0, h00, z0, x1, h11, z1, x0, h01, z1],
      ];
      for (const t of trisDef) {
        const ax = t[3] - t[0], ay = t[4] - t[1], az = t[5] - t[2];
        const bx = t[6] - t[0], by = t[7] - t[1], bz = t[8] - t[2];
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        emit(t[0], t[1], t[2], nx, ny, nz, ramp);
        emit(t[3], t[4], t[5], nx, ny, nz, ramp);
        emit(t[6], t[7], t[8], nx, ny, nz, ramp);
      }
    }
  }

  const vao = must(gl.createVertexArray(), 'ground VAO');
  gl.bindVertexArray(vao);
  const fbo = must(gl.createBuffer(), 'ground vertices');
  gl.bindBuffer(gl.ARRAY_BUFFER, fbo);
  gl.bufferData(gl.ARRAY_BUFFER, floats, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  const rbo = must(gl.createBuffer(), 'ground ramps');
  gl.bindBuffer(gl.ARRAY_BUFFER, rbo);
  gl.bufferData(gl.ARRAY_BUFFER, ramps, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, 1, 0);
  gl.bindVertexArray(null);

  return { vao, vertexCount: vertCount, buffers: [fbo, rbo] };
}