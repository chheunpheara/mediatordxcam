/**
 * The idle graphic on the customer monitor (§6).
 *
 * It replaces the old welcome sentence in the middle of the white screen: the
 * same vertical oval the camera fills later, drawn empty. Rings breathe
 * outward, a line sweeps down it and a soft glow sits where a face will go, so
 * a monitor left standing between checks reads as "waiting for a face" rather
 * than as a blank page.
 *
 * The greeting it stands in for is the accessible name, so a screen-reader
 * user still hears "Welcome"; everything inside it is decorative. Nothing here
 * is interactive, and every animation stops under `prefers-reduced-motion`
 * (§32).
 */
export function LivenessArt() {
  return (
    <div className="liveness-art" role="img" aria-label="Welcome">
      <span aria-hidden="true" className="liveness-art__glow" />
      <span aria-hidden="true" className="liveness-art__ring" />
      <span aria-hidden="true" className="liveness-art__ring liveness-art__ring--late" />
      <span aria-hidden="true" className="liveness-art__scan" />
      <span aria-hidden="true" className="liveness-art__guide" />
    </div>
  )
}
