/**
 * VAOs whose meshes are drawn by their element buffer (weld.ts: a welded triangle list): a mesh's
 * `first` and `vertexCount` are then of the index, the same numbers as the list's. Kept by the VAO,
 * so every mesh on it (a building core, a structure kind's run, the terrain's near faces) is drawn
 * alike (renderer drawMesh). Its own module: the tile managers mark theirs, and one of them is also
 * read by the workers (chunks), which must not load the renderer.
 */
const indexedVaos = new WeakSet<WebGLVertexArrayObject>();

export function markIndexed(vao: WebGLVertexArrayObject): void {
  indexedVaos.add(vao);
}

export function isIndexed(vao: WebGLVertexArrayObject): boolean {
  return indexedVaos.has(vao);
}

/**
 * `index` (Uint32, a corner a vertex) as the bound VAO's element buffer, the VAO marked indexed;
 * returns the buffer (null for an empty index: the VAO stays a triangle list)
 */
export function bindIndex(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject, index: ArrayBuffer | undefined): WebGLBuffer | null {
  if (!index || index.byteLength === 0) return null;
  const ib = gl.createBuffer();
  if (!ib) throw new Error('WebGL: element buffer');
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
  markIndexed(vao);
  return ib;
}
