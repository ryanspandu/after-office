import { createAvatar } from '@dicebear/core'
import * as notionists from '@dicebear/notionists'
import type { Look } from '../state/store'

// An agent's face in its avatar (lists, chat, profile): a DiceBear "Notionists" drawing (CC0, made here in the
// browser, nothing fetched), picked from its character's look so the two match: a woman's or a man's hair, glasses
// when the character wears them, a beard only on some men. The same look always gives the same face; the owner can
// pick another hair in its profile (Look.face).

type Hair = NonNullable<notionists.Options['hair']>[number]
const v = (n: number) => `variant${String(n).padStart(2, '0')}` as Hair
// long hair, ponytails, buns, a hijab
export const WOMAN = [2, 4, 8, 10, 23, 28, 36, 37, 39, 41, 45, 46, 47, 48, 58, 62, 63].map(v)
// short cuts
export const MAN = [1, 3, 5, 6, 7, 9, 12, 13, 15, 16, 17, 18, 19, 21, 22, 24, 25, 26, 27, 30, 31, 32, 33, 34, 35, 38, 42, 43, 44, 49, 50, 51, 52, 53, 54, 55, 56, 60].map(v)

const cache = new Map<string, string>()

type FaceLook = Pick<Look, 'figure' | 'seed' | 'eyewear' | 'face'>

/** Its hair: the owner's pick, else one of its figure's, from its look. */
export const hairOf = (look: FaceLook): Hair => {
  if (look.face) return look.face as Hair
  const hair = look.figure === 'woman' ? WOMAN : MAN
  return hair[Math.abs(look.seed) % hair.length]
}

function faceOf(look: FaceLook) {
  const hair = hairOf(look)
  const key = `${look.figure}:${look.seed}:${look.eyewear}:${hair}`
  let uri = cache.get(key)
  if (!uri) {
    const woman = look.figure === 'woman'
    uri = createAvatar(notionists, {
      seed: String(look.seed),
      hair: [hair],
      glassesProbability: look.eyewear === 'none' ? 0 : 100,
      beardProbability: woman ? 0 : 25,
      gestureProbability: 0,
      bodyIconProbability: 0,
      // the head fills the small square: drawn a little bigger, a little lower
      scale: 125,
      translateY: 8,
    }).toDataUri()
    cache.set(key, uri)
  }
  return uri
}

/** The face inside an `.avatar` (its background stays the agent's colour). */
export function AgentFace({ look }: { look: FaceLook }) {
  return <img className="avatar__face" src={faceOf(look)} alt="" draggable={false} />
}
