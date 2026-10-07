/**
 * The photo side of a run (§17, §24): the picture the card carried beside the
 * live one the camera just took, drawn as the check the method performs.
 *
 * Two frames with a beam sweeping each while the run is going, and a bridge
 * between them — dashed and moving while the check runs, solid and ticked once
 * it has an answer. A method with only the live photo gets the portrait alone
 * in the oval, still swept, because there is nothing on this run to compare it
 * to and inventing a second picture would be a claim §13 forbids.
 *
 * The pictures are the artefact handles the session already holds; nothing
 * here asks the server anything new.
 */
export function PhotoMatchArt({
  cardSrc,
  faceSrc,
  checking,
}: {
  /** The card's own picture — absent for a method that does not read the card. */
  readonly cardSrc: string | null
  /** The picture the current-face capture returned. */
  readonly faceSrc: string | null
  /** True while the run is still going, so the beams keep sweeping. */
  readonly checking: boolean
}) {
  if (faceSrc === null && cardSrc === null) return null

  return (
    <figure className="verify-art">
      <div className="verify-art__pair">
        {cardSrc !== null ? (
          <span className="verify-art__frame">
            <img alt="Photo on your ID card" src={cardSrc} />
            <span aria-hidden="true" className="verify-art__beam" />
          </span>
        ) : null}
        {cardSrc !== null && faceSrc !== null ? (
          <span
            aria-hidden="true"
            className={`verify-art__bridge${checking ? '' : ' verify-art__bridge--done'}`}
          />
        ) : null}
        {faceSrc !== null ? (
          <span className="verify-art__frame verify-art__frame--oval">
            <img alt="Your live photo" src={faceSrc} />
            <span aria-hidden="true" className="verify-art__beam" />
          </span>
        ) : null}
      </div>
      <figcaption className="text-ink-subtle text-center text-xs">
        {checking
          ? cardSrc !== null
            ? 'Comparing your live photo with the one on your card…'
            : 'Reading your live photo…'
          : cardSrc !== null
            ? 'Both photos were part of this check.'
            : 'Your live photo was part of this check.'}
      </figcaption>
    </figure>
  )
}

/**
 * The liveness side: the clip itself, framed, with the same sweep so the
 * preview column reads as one composition rather than a player dropped in.
 */
export function LivenessArt({ src }: { readonly src: string | null }) {
  return (
    <figure className="verify-art">
      <span className="verify-art__frame verify-art__frame--wide">
        {src !== null ? (
          <video aria-label="Liveness recording" controls playsInline src={src} />
        ) : (
          <span className="text-ink-subtle verify-art__missing" role="status">
            No recording is attached to this session.
          </span>
        )}
        <span aria-hidden="true" className="verify-art__beam" />
      </span>
      <figcaption className="text-ink-subtle text-center text-xs">
        The three-second recording this method asked for.
      </figcaption>
    </figure>
  )
}
