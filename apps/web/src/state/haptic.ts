/** A short buzz where the phone can (Android); nothing elsewhere (iOS has no web vibration). */
export function haptic(ms = 8) {
  try {
    if (window.matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(ms)
  } catch {
    // not allowed (e.g. before the first touch): fine
  }
}
