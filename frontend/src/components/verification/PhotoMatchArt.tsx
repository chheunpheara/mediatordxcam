/**
 * The photo side of a run (§17, §24): the picture the card carried beside the
 * live one the camera just took, drawn as the check the method performs.
 *
 * Two frames with a beam sweeping each while the run is going, and a bridge
 * between them — dashed and moving while the check runs, solid and green once
 * the two were found to match, and a red cross between them when they were
 * not (§32: the cross is an icon *and* the caption says so, so the meaning
 * does not rest on colour). The cross renders on the answer alone, even if one
 * of the pictures is missing, so a failed comparison is never a silent row.
 * A method with only the live photo gets the portrait alone in the oval, still
 * swept, because there is nothing on this run to compare it to and inventing a
 * second picture would be a claim §13 forbids.
 *
 * The pictures are the artefact handles the session already holds; nothing
 * here asks the server anything new.
 */
export function PhotoMatchArt({
  cardSrc,
  faceSrc,
  checking,
  matched,
}: {
  /** The card's own picture — absent for a method that does not read the card. */
  readonly cardSrc: string | null
  /** The picture the current-face capture returned. */
  readonly faceSrc: string | null
  /** True while the run is still going, so the beams keep sweeping. */
  readonly checking: boolean
  /** What the run said about the two pictures: null while nothing has asked. */
  readonly matched: boolean | null
}) {
  if (faceSrc === null && cardSrc === null) return null

  // A cross is an answer, so a run in flight goes back to the bridge: the old
  // outcome must not stand over the pictures while the new one is coming.
  const compares = cardSrc !== null && faceSrc !== null
  const failed = !checking && matched === false

  return (
    <figure className="verify-art">
      <div className="verify-art__pair">
        {cardSrc !== null ? (
          <span className="verify-art__frame">
            <img alt="Photo on your ID card" src={cardSrc} />
            <span aria-hidden="true" className="verify-art__beam" />
          </span>
        ) : null}
        {failed ? (
          <span aria-label="The photos do not match" className="verify-art__cross" role="img">
            <svg
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={3}
              viewBox="0 0 24 24"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </span>
        ) : compares ? (
          <span
            aria-hidden="true"
            className={`verify-art__bridge${
              matched === true
                ? ' verify-art__bridge--done'
                : checking
                  ? ''
                  : ' verify-art__bridge--idle'
            }`}
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
        {failed
          ? compares
            ? 'These two photos did not match.'
            : 'This photo did not match.'
          : checking
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
