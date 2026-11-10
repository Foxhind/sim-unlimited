import { mat4, vec3 } from 'gl-matrix';
import type { Input } from './input';
import { DEPTH_FAR } from './shaders';

const BASE_SPEED = 60; // m/s
const BOOST = 10;
const LOOK_RATE = 1.4; // rad/s keyboard
const MOUSE_RATE = 0.003; // rad/px

export class FreeCamera {
  readonly pos = vec3.fromValues(0, 300, 0);
  yaw = 0; // 0 = looking north (-Z)
  pitch = -0.1;
  speedScale = 1;
  readonly view = mat4.create();
  readonly proj = mat4.create();
  private target = vec3.create();

  update(dt: number, input: Input): void {
    const [mdx, mdy] = input.consumeMouse();
    this.yaw += mdx * MOUSE_RATE;
    this.pitch -= mdy * MOUSE_RATE;
    if (input.down('ArrowLeft')) this.yaw -= LOOK_RATE * dt;
    if (input.down('ArrowRight')) this.yaw += LOOK_RATE * dt;
    if (input.down('ArrowUp')) this.pitch += LOOK_RATE * dt;
    if (input.down('ArrowDown')) this.pitch -= LOOK_RATE * dt;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));

    const speed = BASE_SPEED * this.speedScale * (input.down('ShiftLeft') || input.down('ShiftRight') ? BOOST : 1);
    const cp = Math.cos(this.pitch);
    const forward = vec3.fromValues(Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    const right = vec3.fromValues(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const move = vec3.create();
    if (input.down('KeyW')) vec3.add(move, move, forward);
    if (input.down('KeyS')) vec3.sub(move, move, forward);
    if (input.down('KeyD')) vec3.add(move, move, right);
    if (input.down('KeyA')) vec3.sub(move, move, right);
    if (input.down('KeyR')) move[1] += 1;
    if (input.down('KeyF')) move[1] -= 1;
    if (vec3.length(move) > 0) {
      vec3.normalize(move, move);
      vec3.scaleAndAdd(this.pos, this.pos, move, speed * dt);
    }

    vec3.add(this.target, this.pos, forward);
    mat4.lookAt(this.view, this.pos, this.target, vec3.fromValues(0, 1, 0));
  }

  setAspect(width: number, height: number): void {
    mat4.perspective(this.proj, (60 * Math.PI) / 180, width / height, 0.5, DEPTH_FAR);
  }
}