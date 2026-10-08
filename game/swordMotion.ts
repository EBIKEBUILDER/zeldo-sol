/** One front-facing sweep shared by the physical blade and its light trail.
 * Simulation angles start east (cos/sin); Babylon yaw starts north (sin/cos).
 */
export function getSwordSweep(facing: number, progress: number) {
  const t = Math.max(0, Math.min(1, progress));
  const localAngle = -1.25 + t * 2.6;
  const angle = Math.PI / 2 - facing + localAngle;
  const advance = t * .15;
  const gripRadius = .375;
  const tipRadius = 1.18;
  const offset = (radius: number) => ({
    x: Math.sin(angle) * radius + Math.cos(facing) * advance,
    z: Math.cos(angle) * radius + Math.sin(facing) * advance,
  });
  const localOffset = (radius: number) => ({
    x: Math.sin(localAngle) * radius,
    z: Math.cos(localAngle) * radius + advance,
  });
  return {
    angle, localAngle, advance,
    grip: offset(gripRadius), tip: offset(tipRadius),
    localGrip: localOffset(gripRadius), localTip: localOffset(tipRadius),
  };
}
