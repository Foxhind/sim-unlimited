/**
 * The collision ground of a tile (ground-tile.ts), built off the main thread: the surface under a
 * town's roads takes tens of milliseconds, and nine tiles load at once.
 */
import { RetryableError } from '../engine/queue';
import type { Tile } from '../world/geodesy';
import { buildGroundTile, type GroundTile } from '../world/ground-tile';

export interface GroundRequest { id: number; tile: Tile }
export type GroundResponse = { id: number; ground: GroundTile } | { id: number; error: string; retryable: boolean };

interface WorkerScope {
  onmessage: ((e: MessageEvent<GroundRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = async (e: MessageEvent<GroundRequest>) => {
  const { id, tile } = e.data;
  try {
    const ground = await buildGroundTile(tile);
    const res: GroundResponse = { id, ground };
    ctx.postMessage(res, [ground.vx.buffer, ground.vy.buffer, ground.vh.buffer, ground.tris.buffer]);
  } catch (err) {
    const res: GroundResponse = { id, error: err instanceof Error ? err.message : String(err), retryable: err instanceof RetryableError };
    ctx.postMessage(res);
  }
};
