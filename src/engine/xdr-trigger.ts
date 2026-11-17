/**
 * Puts the page in HDR (EDR) mode so a WebGL canvas's RGBA16F drawing buffer shows above SDR white.
 *
 * Chrome (156) has drawingBufferStorage(RGBA16F) on WebGL but no drawingBufferToneMapping, and on
 * its own shows such a canvas clipped to white. Once the page holds HDR content of the kind Chrome
 * recognises — a WebGPU canvas configured rgba16float with toneMapping {mode: 'extended'} — it shows
 * the WebGL float buffer in extended range too. So a 2×2 px WebGPU canvas, cleared to black once,
 * sits in a corner and the frame itself stays on the WebGL canvas.
 *
 * Experimental: this rests on how Chrome composites, not on a spec; should it change, the lights
 * are drawn plain white again, nothing breaks.
 *
 * WebGPU types are not in TypeScript's DOM lib: the few calls used here are typed loosely.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Gpu = any;

export class XdrTrigger {
  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: Gpu,
    private readonly device: Gpu,
  ) {}

  /** null where WebGPU or its extended tone mapping is missing */
  static async create(): Promise<XdrTrigger | null> {
    const gpu = (navigator as Gpu).gpu;
    if (!gpu) return null;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      canvas.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 2px; height: 2px; pointer-events: none;';
      const ctx = canvas.getContext('webgpu') as Gpu;
      if (!ctx) return null;
      ctx.configure({ device, format: 'rgba16float', alphaMode: 'opaque', toneMapping: { mode: 'extended' } });
      if (ctx.getConfiguration?.()?.toneMapping?.mode !== 'extended') {
        ctx.unconfigure();
        device.destroy();
        return null;
      }
      const enc = device.createCommandEncoder();
      enc.beginRenderPass({
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      }).end();
      device.queue.submit([enc.finish()]);
      document.body.appendChild(canvas);
      return new XdrTrigger(canvas, ctx, device);
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.ctx.unconfigure();
    this.device.destroy();
    this.canvas.remove();
  }
}
