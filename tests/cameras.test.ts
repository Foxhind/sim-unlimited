import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { CameraRig, CAMERA_MODES } from '../src/flight/cameras';
import { FlightModel } from '../src/flight/model';
import { SU27 } from '../src/flight/aircraft';
import type { Input } from '../src/engine/input';

describe('outside cameras stay above the ground', () => {
  it('an orbit dragged below the aircraft stops above the runway it stands on', () => {
    const m = new FlightModel(SU27);
    vec3.set(m.pos, 0, 579.2, 0);
    const rig = new CameraRig();
    rig.groundAt = () => 576.8;
    rig.setMode('orbit', m);
    // drag the view down as far as it goes
    const input = { consumeMouse: () => [0, -2000], consumeWheel: () => 0 } as unknown as Input;
    rig.update(m, 0.016, input, vec3.create());
    expect(rig.orbitPitch).toBeLessThan(-1);
    expect(rig.pos[1]).toBeGreaterThanOrEqual(576.8 + 1.5 - 1e-3);
  });

  it('every outside view keeps the clearance, the cockpit is left alone', () => {
    const m = new FlightModel(SU27);
    vec3.set(m.pos, 0, 101, 0);
    const input = { consumeMouse: () => [0, 0], consumeWheel: () => 0 } as unknown as Input;
    for (const mode of CAMERA_MODES) {
      if (mode === 'cockpit' || mode === 'tower') continue;
      const rig = new CameraRig();
      rig.groundAt = () => 200;
      rig.setMode(mode, m);
      rig.update(m, 0.016, input, vec3.create());
      expect(rig.pos[1], mode).toBeGreaterThanOrEqual(201.5 - 1e-3);
    }
  });
});
