/** Frame-rate independent damping toward an angle, taking the short way around. */
export function dampAngle(from: number, to: number, lambda: number, dt: number) {
  let diff = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI
  if (diff < -Math.PI) diff += Math.PI * 2
  return from + diff * (1 - Math.exp(-lambda * dt))
}
