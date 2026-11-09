import { createProgram, must, uniformMap, type Uniforms } from './gl';

const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
uniform vec2 uScreen;
void main() {
  vec2 ndc = (aPos / uScreen) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

const LINE_FS = `#version 300 es
precision highp float;
uniform uint uIndex;
out uint oIndex;
void main() {
  oIndex = uIndex;
}
`;

const MAX_VERTS = 8192;

/** Screen-space vector batches (HUD lines, arcs, reticles) in device pixels. */
export class VectorRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Uniforms;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private verts = new Float32Array(MAX_VERTS * 2);
  private count = 0;
  private batchIndex = -1;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = createProgram(gl, LINE_VS, LINE_FS);
    this.u = uniformMap(gl, this.prog, ['uScreen', 'uIndex']);
    this.vao = must(gl.createVertexArray(), 'vector VAO');
    gl.bindVertexArray(this.vao);
    this.vbo = must(gl.createBuffer(), 'vector buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
  }

  private push(x: number, y: number): void {
    if (this.count >= MAX_VERTS) this.flush();
    this.verts[this.count * 2] = x;
    this.verts[this.count * 2 + 1] = y;
    this.count++;
  }

  private begin(index: number): void {
    if (this.batchIndex !== index) this.flush();
    this.batchIndex = index;
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, index: number): void {
    this.begin(index);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;
    const px = (-dy / len) * width * 0.5;
    const py = (dx / len) * width * 0.5;
    this.push(x0 + px, y0 + py);
    this.push(x1 + px, y1 + py);
    this.push(x1 - px, y1 - py);
    this.push(x0 + px, y0 + py);
    this.push(x1 - px, y1 - py);
    this.push(x0 - px, y0 - py);
  }

  polyline(points: [number, number][], width: number, index: number, close = false): void {
    for (let i = 0; i < points.length - 1; i++) {
      this.line(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], width, index);
    }
    if (close && points.length > 2) {
      const a = points[points.length - 1];
      const b = points[0];
      this.line(a[0], a[1], b[0], b[1], width, index);
    }
  }

  circle(cx: number, cy: number, r: number, width: number, index: number, segments = 24): void {
    const pts: [number, number][] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    this.polyline(pts, width, index, true);
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, width: number, index: number, segments = 16): void {
    const pts: [number, number][] = [];
    for (let i = 0; i <= segments; i++) {
      const a = a0 + ((a1 - a0) * i) / segments;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    this.polyline(pts, width, index);
  }

  rect(x: number, y: number, w: number, h: number, width: number, index: number): void {
    this.polyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], width, index, true);
  }

  fillRect(x: number, y: number, w: number, h: number, index: number): void {
    this.begin(index);
    this.push(x, y);
    this.push(x + w, y);
    this.push(x + w, y + h);
    this.push(x, y);
    this.push(x + w, y + h);
    this.push(x, y + h);
  }

  flush(): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniform1ui(this.u.uIndex, this.batchIndex);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts, 0, this.count * 2);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.bindVertexArray(null);
    this.count = 0;
  }

  setScreenSize(w: number, h: number): void {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uScreen, w, h);
  }
}