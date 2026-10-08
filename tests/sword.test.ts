import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { getSwordSweep } from '../game/swordMotion';

const close = (actual: number, expected: number, label: string) => {
  assert.ok(Math.abs(actual - expected) < 0.000002, `${label}: expected ${expected}, received ${actual}`);
};

for (let direction = 0; direction < 8; direction++) {
  const facing = direction * Math.PI / 4;
  test(`the sword mesh and light trail stay in front of the hero at heading ${direction * 45}°`, () => {
    for (const progress of [0, 0.15, 0.35, 0.5, 0.7, 0.85, 1]) {
      const sweep = getSwordSweep(facing, progress);
      const forward = { x: Math.cos(facing), z: Math.sin(facing) };
      assert.ok(sweep.tip.x * forward.x + sweep.tip.z * forward.z > 0, `The blade points behind the hero at swing progress ${progress}`);
      close(Math.hypot(sweep.tip.x - sweep.grip.x, sweep.tip.z - sweep.grip.z), 0.805, 'Blade length');

      // Match the real authored blade: its tip sits +.805 along local Y.
      // Babylon must pitch that forward, then yaw it along the light arc.
      const blade = Vector3.TransformNormal(new Vector3(0, 0.805, 0), Matrix.RotationYawPitchRoll(sweep.localAngle, Math.PI / 2, 0));
      close(sweep.localGrip.x + blade.x, sweep.localTip.x, 'Local blade/trail X');
      close(sweep.localGrip.z + blade.z, sweep.localTip.z, 'Local blade/trail Z');
      close(blade.y, 0, 'The swung blade stays horizontal');

      const worldTip = Vector3.TransformCoordinates(new Vector3(sweep.localTip.x, 0, sweep.localTip.z), Matrix.RotationY(Math.PI / 2 - facing));
      close(worldTip.x, sweep.tip.x, 'World blade/trail X');
      close(worldTip.z, sweep.tip.z, 'World blade/trail Z');
      close(Math.sin(sweep.angle) * 1.18 + forward.x * sweep.advance, worldTip.x, 'Light arc head X');
      close(Math.cos(sweep.angle) * 1.18 + forward.z * sweep.advance, worldTip.z, 'Light arc head Z');
    }
  });
}

test('sword progress stays at its endpoints when a render frame falls outside the swing', () => {
  assert.deepEqual(getSwordSweep(0, -1), getSwordSweep(0, 0));
  assert.deepEqual(getSwordSweep(0, 2), getSwordSweep(0, 1));
});
