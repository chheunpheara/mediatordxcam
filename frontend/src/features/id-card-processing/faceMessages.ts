/**
 * §12's user-facing sentences for face detection, quoted verbatim.
 *
 * Kept out of the component file so this is a plain module, and so the wording is
 * assertable in one place. These three sentences are the requirement: a reworded
 * status would still pass a test that only looked for "no face".
 */

export const FACE_MESSAGES = {
  noFace: "We couldn't detect a face on this ID Card.",
  multiple: 'Multiple faces were detected. Please upload a valid ID Card image.',
  poorQuality: 'The face image is unclear. Please upload a clearer ID Card.',
} as const

export type FaceMessageKey = keyof typeof FACE_MESSAGES
