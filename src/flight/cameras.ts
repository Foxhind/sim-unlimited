import { mat3, mat4, vec3 } from 'gl-matrix';
import type { Input } from '../engine/input';
import type { FlightModel } from './model';

export type CameraMode = 'cockpit' | 'orbit' | 'chase' | 'flyby' | 'tower' | 'target';
export const CAMERA_MODES: CameraMode[] = ['cockpit', 'orbit', 'chase', 'flyby', 'tower', 'target'];

const UP = vec3.fromValues(0, 1, 0);

export class CameraRig {
  mode: CameraMode = 'cockpit';
  readonly pos = vec3.create();
  readonly view = mat4.create();
  orbitYaw = 0.6;
  orbitPitch = 0.25;
  orbitDist = 45;
  private chasePos = vec3.create();
  private anchor = vec3.create();
  private anchorSet = false;
  private target = vec3.create();
  private rot = mat3.create();
  private tmp = vec3.create();

  setMode(mode: CameraMode, model: FlightModel): void {
    this.mode = mode;
    this.anchorSet = false;
    vec3.copy(this.chasePos, this.chaseTarget(model));
  }

  private basis(model: FlightModel): void {
    mat3.fromQuat(this.rot, model.quat);
  }

  private bodyDir(model: FlightModel, x: number, y: number, z: number, out: vec3): vec3 {
    this.basis(model);
    return vec3.transformMat3(out, vec3.fromValues(x, y, z), this.rot);
  }

  private chaseTarget(model: FlightModel): vec3 {
    const out = vec3.clone(model.pos);
    vec3.scaleAndAdd(out, out, this.bodyDir(model, 0, 0, 1, this.tmp), 38);
    vec3.scaleAndAdd(out, out, this.bodyDir(model, 0, 1, 0, this.tmp), 9);
    return out;
  }

  update(model: FlightModel, dt: number, input: Input, towerPos: vec3): void {
    const [mdx, mdy] = input.consumeMouse();
    const wheel = input.consumeWheel();
    const fwd = this.bodyDir(model, 0, 0, -1, vec3.create());
    const up = this.bodyDir(model, 0, 1, 0, vec3.create());

    switch (this.mode) {
      case 'cockpit': {
        vec3.copy(this.pos, model.pos);
        vec3.scaleAndAdd(this.pos, this.pos, up, 1.1);
        vec3.scaleAndAdd(this.pos, this.pos, fwd, 5.5);
        vec3.add(this.target, this.pos, fwd);
        mat4.lookAt(this.view, this.pos, this.target, up);
        return;
      }
      case 'orbit': {
        this.orbitYaw += mdx * 0.005;
        this.orbitPitch = Math.max(-1.4, Math.min(1.4, this.orbitPitch + mdy * 0.005));
        this.orbitDist = Math.max(15, Math.min(300, this.orbitDist * (1 + wheel * 0.001)));
        const cp = Math.cos(this.orbitPitch);
        vec3.set(
          this.pos,
          model.pos[0] + Math.sin(this.orbitYaw) * cp * this.orbitDist,
          model.pos[1] + Math.sin(this.orbitPitch) * this.orbitDist,
          model.pos[2] + Math.cos(this.orbitYaw) * cp * this.orbitDist,
        );
        mat4.lookAt(this.view, this.pos, model.pos, UP);
        return;
      }
      case 'chase': {
        const goal = this.chaseTarget(model);
        vec3.lerp(this.chasePos, this.chasePos, goal, Math.min(1, 4 * dt));
        vec3.copy(this.pos, this.chasePos);
        vec3.scaleAndAdd(this.target, model.pos, fwd, 20);
        mat4.lookAt(this.view, this.pos, this.target, UP);
        return;
      }
      case 'flyby': {
        // camera parks ahead on the flight path; the jet roars past, then it repositions
        if (!this.anchorSet || vec3.dist(this.anchor, model.pos) < 25) {
          vec3.copy(this.anchor, model.pos);
          vec3.scaleAndAdd(this.anchor, this.anchor, fwd, 220);
          vec3.scaleAndAdd(this.anchor, this.anchor, up, 4);
          this.anchorSet = true;
        }
        vec3.copy(this.pos, this.anchor);
        mat4.lookAt(this.view, this.pos, model.pos, UP);
        return;
      }
      case 'tower': {
        vec3.copy(this.pos, towerPos);
        this.pos[1] += 25;
        mat4.lookAt(this.view, this.pos, model.pos, UP);
        return;
      }
      case 'target': {
        // slow cinematic auto-orbit
        this.orbitYaw += dt * 0.15;
        const d = 70;
        vec3.set(
          this.pos,
          model.pos[0] + Math.sin(this.orbitYaw) * d,
          model.pos[1] + 18,
          model.pos[2] + Math.cos(this.orbitYaw) * d,
        );
        mat4.lookAt(this.view, this.pos, model.pos, UP);
        return;
      }
    }
  }
}