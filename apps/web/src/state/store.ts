import { create } from 'zustand'
import type { AgentFigure, AgentInfo, AgentProfile, AgentStatus } from '@after-office/shared'
import { FIXED_SPOTS, spotById, type SpotKind, type Vec2 } from '../scene/layout'

export type HairStyle =
  | 'short' | 'buzz' | 'curly' | 'mullet' | 'bun' | 'fluffy' | 'wolf' | 'spiky'
  | 'long' | 'bob' | 'ponytail' | 'buns' | 'pigtails' | 'curtain' | 'high-pony'
export type Hat = 'none' | 'beanie' | 'cap' | 'cap-back' | 'bucket' | 'headphones' | 'beret' | 'visor' | 'bandana' | 'cat-ears' | 'clips'
export type Eyewear = 'none' | 'round' | 'square' | 'shades' | 'y2k' | 'sport' | 'heart'
export type Neckwear = 'none' | 'chain' | 'pendant' | 'scarf' | 'choker' | 'lanyard'
/** what's over the shirt */
export type Top = 'tee' | 'graphic' | 'hoodie' | 'jacket' | 'vest'
export type Ear = 'none' | 'stud' | 'hoops' | 'airpods'
export type Bag = 'none' | 'backpack' | 'crossbody'

export interface Look {
  shirt: string
  pants: string
  skin: string
  hair: string
  hairStyle: HairStyle
  hat: Hat
  /** beanie / cap / bucket hat / headphones colour */
  hatColor: string
  eyewear: Eyewear
  neckwear: Neckwear
  top: Top
  /** the jacket / vest / hoodie strings / print colour */
  accent: string
  ear: Ear
  bag: Bag
  /** bag colour */
  bagColor: string
  shoes: string
  /** body style: a skirt and girls' hairstyles for 'woman' */
  figure: AgentFigure
  /** what it was drawn from (the agent's style number, or its desk): the same one gives the same look */
  seed: number
}

export interface OfficeAgent extends AgentInfo {
  desk: number
  look: Look
  /** The spot this agent is heading to / sitting at. */
  spotId: string
  /** Where the character first appears (entrance for newcomers, its spot on first load). */
  spawn?: Vec2
  /** Just created: drives into the parking lot, then walks in. */
  arriving?: boolean
  /** Offline for a moment (e.g. restarting with a new model): stays at its desk instead of leaving right away. */
  lingering?: boolean
  /** Bumped each time the agent comes back after leaving: a fresh scene character (see Office.tsx) */
  gen?: number
  profile: AgentProfile
}

/** How long an agent may be offline before it walks out (a restart takes a few seconds). */
const OFFLINE_GRACE_MS = 10_000
/** Just finished at the desk: sit back there this long before wandering off to the cat, pool, sofa or pantry. */
const DESK_WIND_DOWN_MS = 20_000

const atDesk = (status: AgentStatus) => status === 'working' || status === 'waiting'

const ROLES = ['Backend engineer', 'Frontend engineer', 'DevOps / infra', 'Tech writer', 'QA engineer', 'Full-stack engineer']

export function defaultProfile(name: string, i: number): AgentProfile {
  const role = pick(ROLES, i)
  return {
    role,
    model: 'claude-sonnet-5',
    permissionMode: 'acceptEdits',
    claudeMd: `# ${name}

You are **${name}**, the ${role.toLowerCase()} on this team.

## How to work
- Read the relevant code before changing it.
- Keep changes small and focused; one concern per commit.
- Run the tests before you say something is done.

## Conventions
- TypeScript strict mode, no \`any\`.
- Prefer existing helpers over new dependencies.
`,
    skills: [
      {
        id: 'skill-review',
        name: 'code-review',
        description: 'Review a diff for bugs, missing tests and risky changes.',
        body: '1. Read the full diff.\n2. Flag correctness issues first, then style.\n3. Suggest concrete fixes.',
        enabled: true,
      },
    ],
  }
}

const SHIRTS = ['#e8795b', '#5b8def', '#57b894', '#e3b341', '#a879e0', '#e06c9f', '#4fb3c9', '#8f9aa8', '#d9824b']
/**
 * Initial avatars: each shirt colour's own strong version (not darkened, which turns orange brown). Light ones get a
 * dark letter; the grey one becomes black.
 */
const AVATAR: Record<string, { background: string; color: string }> = {
  '#e8795b': { background: '#f2541b', color: '#fff' },
  '#5b8def': { background: '#2563eb', color: '#fff' },
  '#57b894': { background: '#0f9d63', color: '#fff' },
  '#e3b341': { background: '#f5b914', color: '#151515' },
  '#a879e0': { background: '#8b3fe6', color: '#fff' },
  '#e06c9f': { background: '#e11d74', color: '#fff' },
  '#4fb3c9': { background: '#0891b2', color: '#fff' },
  '#8f9aa8': { background: '#151515', color: '#fff' },
  '#d9824b': { background: '#f07a0f', color: '#fff' },
}
/** Background and letter colour for an agent's initial avatar. */
export const avatarStyle = (shirt: string) => AVATAR[shirt] ?? { background: shirt, color: '#fff' }

// light to warm tan: no dark skin tones (the owner's choice)
const SKINS = ['#f7dcc6', '#f2d0b1', '#eec39f', '#e8b690', '#e0ac85', '#f5e1d0']
// natural colours and dyed ones (pastels, bubblegum, mint, silver…)
const HAIRS = ['#2b211c', '#5a3a22', '#c9a15a', '#1c1c24', '#8a3b24', '#d9d4cc', '#e98bb8', '#7aa7e8', '#b18be0', '#f0d98a', '#ff8fb3', '#8fe3cf', '#f6b26b', '#c3c7d6', '#ff6b6b']
const PANTS = ['#3a3f4b', '#2f4a6b', '#4b3a2f', '#35423a', '#1f1f24', '#6b5a48', '#8aa0b8', '#c7bba4', '#8a7f5a', '#b8c4d9']
const HAT_COLORS = ['#1f1f24', '#e8795b', '#f0d98a', '#57b894', '#5b8def', '#e06c9f', '#f5f5f3', '#a879e0', '#ffb3c7', '#b5e48c', '#a0c4ff', '#ffd6a5']
// jackets, vests, prints
const ACCENTS = ['#1f1f24', '#f5f5f3', '#2f4a6b', '#b5e48c', '#ffb3c7', '#a0c4ff', '#ffd6a5', '#c7bba4', '#e8795b', '#8a7f5a']
const SHOES = ['#f5f5f3', '#f5f5f3', '#2a2d36', '#e8795b', '#5b8def', '#ffb3c7', '#b5e48c', '#f0d98a']
const MAN_HAIR: HairStyle[] = ['short', 'buzz', 'curly', 'mullet', 'bun', 'fluffy', 'wolf', 'spiky']
const WOMAN_HAIR: HairStyle[] = ['long', 'bob', 'ponytail', 'buns', 'pigtails', 'curtain', 'high-pony', 'wolf']
// 'none' twice: not everyone wears something
const HATS: Hat[] = ['none', 'none', 'beanie', 'cap', 'cap-back', 'bucket', 'headphones', 'beret', 'visor', 'bandana', 'cat-ears', 'clips']
const EYEWEAR: Eyewear[] = ['none', 'none', 'round', 'square', 'shades', 'y2k', 'sport', 'heart']
const NECKWEAR: Neckwear[] = ['none', 'none', 'chain', 'pendant', 'scarf', 'choker', 'lanyard']
const TOPS: Top[] = ['tee', 'graphic', 'hoodie', 'hoodie', 'jacket', 'vest']
const EARS: Ear[] = ['none', 'none', 'stud', 'hoops', 'airpods']
const BAGS: Bag[] = ['none', 'none', 'none', 'backpack', 'crossbody']
const NAMES = ['Atlas', 'Nova', 'Orion', 'Lyra', 'Vega', 'Sol', 'Rigel', 'Iris', 'Juno', 'Kai', 'Mira', 'Pax']

const pick = <T,>(arr: readonly T[], i: number) => arr[i % arr.length]

/** Small seeded random numbers (mulberry32): the same seed always gives the same look. */
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A character's look. New agents get a random `style` from the server; older ones (and the demo) are drawn from their
 * desk. The figure (never guessed from the name) only decides which hairstyles and whether there's a skirt.
 */
export function makeLook(desk: number, style?: number, figure?: AgentFigure): Look {
  const seed = style ?? desk * 7919 + 17
  const r = seeded(seed)
  const one = <T,>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)]
  const fig: AgentFigure = figure ?? (desk % 2 ? 'woman' : 'man')
  const hairStyle = one(fig === 'woman' ? WOMAN_HAIR : MAN_HAIR)
  // hats don't sit on buns (or a high ponytail); a bucket hat over pigtails still works
  const hat = hairStyle === 'bun' || hairStyle === 'buns' || hairStyle === 'high-pony' ? one(['none', 'none', 'headphones', 'clips'] as Hat[]) : one(HATS)
  return {
    // desk-based colours keep old agents' shirts (and avatar initials) as they were
    shirt: style === undefined ? pick(SHIRTS, desk) : one(SHIRTS),
    skin: one(SKINS),
    hair: one(HAIRS),
    pants: one(PANTS),
    hairStyle,
    hat,
    hatColor: one(HAT_COLORS),
    eyewear: one(EYEWEAR),
    neckwear: one(NECKWEAR),
    // drawn last: what's above stays as it was for existing agents wherever its list didn't change
    top: one(TOPS),
    accent: one(ACCENTS),
    ear: one(EARS),
    bag: one(BAGS),
    bagColor: one(HAT_COLORS),
    shoes: one(SHOES),
    figure: fig,
    seed,
  }
}

/** Choose where an agent should be for a given status, avoiding spots other agents hold. */
function assignSpot(agent: Pick<OfficeAgent, 'id' | 'desk'>, status: AgentStatus, agents: OfficeAgent[]): string {
  const desk = `desk-${agent.desk}`
  if (status === 'working' || status === 'waiting' || status === 'offline') return desk
  const taken = new Set(agents.filter((a) => a.id !== agent.id).map((a) => a.spotId))
  const free = (kind: SpotKind) => FIXED_SPOTS.filter((s) => s.kind === kind && !taken.has(s.id))

  if (status === 'meeting') return free('meeting')[0]?.id ?? desk

  // idle → pet the cat, shoot some pool, watch TV on the sofa, or grab a snack in the pantry
  const current = agents.find((a) => a.id === agent.id)?.spotId
  if (current && /^(cat|pool|sofa|pantry)/.test(current)) return current
  const options = [
    ...free('cat').map((s) => ({ s, w: 4 })),
    ...free('billiards').map((s) => ({ s, w: 4 })),
    ...free('sofa').map((s) => ({ s, w: 1.5 })),
    ...free('pantry').map((s) => ({ s, w: 1.5 })),
  ]
  if (!options.length) return desk
  let r = Math.random() * options.reduce((sum, o) => sum + o.w, 0)
  for (const o of options) if ((r -= o.w) <= 0) return o.s.id
  return options[0].s.id
}

export type DataSource = 'demo' | 'live'

const SOURCE_KEY = 'after-office:source'
function loadSource(): DataSource {
  try {
    return localStorage.getItem(SOURCE_KEY) === 'demo' ? 'demo' : 'live'
  } catch {
    return 'live'
  }
}

interface OfficeStore {
  /** "live" = real Claude Code sessions from the server; "demo" = the built-in simulation. */
  source: DataSource
  setSource: (s: DataSource) => void
  /** Replace everything with the server's agents (SSE snapshot). Online agents appear at their spots. */
  setLiveAgents: (list: AgentInfo[]) => void
  /** Apply one server update: new agents drive in, agents going offline drive away. */
  upsertLiveAgent: (info: AgentInfo) => void
  agents: OfficeAgent[]
  /** Removed agents still walking out to their vehicle; dropped by finishDeparture. */
  departing: OfficeAgent[]
  finishDeparture: (id: string) => void
  /** Called after the offline grace period: start the leaving animation if the agent is still offline. */
  leaveIfStillOffline: (id: string) => void
  /** After the wind-down at the desk: go to an idle spot if the agent is still idle there. */
  leaveDeskIfStillIdle: (id: string) => void
  selectedId: string | null
  simOn: boolean
  setStatus: (id: string, status: AgentStatus, patch?: Partial<AgentInfo>) => void
  updateAgent: (id: string, patch: Partial<Pick<OfficeAgent, 'name' | 'cwd' | 'tmuxSession' | 'profile'>>) => void
  profileId: string | null
  openProfile: (id: string | null) => void
  addAgent: (info?: Partial<AgentInfo>) => void
  removeAgent: (id: string) => void
  startMeeting: (ids: string[]) => void
  select: (id: string | null) => void
  toggleSim: () => void
}

let seq = 0

function createAgent(agents: OfficeAgent[], info: Partial<AgentInfo>, atSpot: boolean): OfficeAgent {
  const used = new Set(agents.map((a) => a.desk))
  let desk = 0
  while (used.has(desk)) desk++
  const i = seq++
  const id = info.id ?? `agent-${i}`
  const status = info.status ?? 'working'
  const base = { id, desk }
  const spotId = assignSpot(base, status, agents)
  const spot = spotById(spotId)
  // names cycle through NAMES; add a number once they repeat so names and tmux sessions stay unique
  const lap = Math.floor(i / NAMES.length)
  const name = lap ? `${pick(NAMES, i)} ${lap + 1}` : pick(NAMES, i)
  return {
    name,
    tmuxSession: `cc-${name.toLowerCase().replace(/\s+/g, '-')}`,
    updatedAt: Date.now(),
    ...info,
    id,
    status,
    desk,
    look: makeLook(i),
    profile: defaultProfile(info.name ?? name, i),
    spotId,
    spawn: atSpot ? [spot.x, spot.z] : undefined,
    arriving: !atSpot,
  }
}

const INITIAL: Partial<AgentInfo>[] = [
  { status: 'working', task: 'Refactor auth middleware', tool: 'Edit' },
  { status: 'working', task: 'Build settings page', tool: 'Write' },
  { status: 'waiting', task: 'Allow `bun run migrate`?', tool: 'Bash' },
  { status: 'idle' },
  { status: 'idle' },
  { status: 'meeting', task: 'Sprint sync' },
  { status: 'meeting', task: 'Sprint sync' },
]

const demoAgents = () => {
  seq = 0
  return INITIAL.reduce<OfficeAgent[]>((list, info) => [...list, createAgent(list, info, true)], [])
}

/** Its look from the server's style + figure; the previous object is kept when nothing changed (no scene rebuild). */
function lookFor(desk: number, info: AgentInfo, prev?: Look): Look {
  const seed = info.style ?? desk * 7919 + 17
  const figure = info.figure ?? prev?.figure
  if (prev && prev.seed === seed && prev.figure === (figure ?? prev.figure)) return prev
  return makeLook(desk, info.style, figure)
}

/** Server AgentInfo → scene agent. Look and desk are stable per desk index, so reloads look the same. */
function fromLive(info: AgentInfo, all: OfficeAgent[], prev?: OfficeAgent, atSpot = false): OfficeAgent {
  const desk = info.desk ?? prev?.desk ?? 0
  const base = { id: info.id, desk }
  const spotId = prev && prev.status === info.status ? prev.spotId : assignSpot(base, info.status, all)
  const spot = spotById(spotId)
  return {
    ...info,
    desk,
    look: lookFor(desk, info, prev?.look),
    profile: prev?.profile ?? { ...defaultProfile(info.name, desk), role: info.role ?? '' },
    spotId,
    spawn: atSpot ? [spot.x, spot.z] : prev?.spawn,
    arriving: prev ? prev.arriving : !atSpot,
    lingering: prev?.lingering,
    gen: prev?.gen,
  }
}

export const useOffice = create<OfficeStore>((set, get) => ({
  source: loadSource(),
  agents: loadSource() === 'demo' ? demoAgents() : [],

  setSource: (source) => {
    try {
      localStorage.setItem(SOURCE_KEY, source)
    } catch {
      // storage unavailable
    }
    set({ source, agents: source === 'demo' ? demoAgents() : [], departing: [], selectedId: null, profileId: null })
  },

  setLiveAgents: (list) =>
    set(({ agents }) => {
      // a fresh snapshot (first connect or a reconnect): agents already on screen keep their place
      const next: OfficeAgent[] = []
      for (const info of list) {
        const prev = agents.find((a) => a.id === info.id)
        next.push(prev ? fromLive(info, next, prev) : fromLive(info, next, undefined, true))
      }
      return { agents: next, departing: [] }
    }),

  upsertLiveAgent: (info) =>
    set(({ agents, departing }) => {
      const prev = agents.find((a) => a.id === info.id)
      if (!prev) return { agents: [...agents, fromLive(info, agents)] }
      const wentOffline = prev.status !== 'offline' && info.status === 'offline'
      const cameBack = prev.status === 'offline' && info.status !== 'offline'
      let updated = fromLive(info, agents, prev)
      if (wentOffline) {
        // don't leave yet: a restart comes back within seconds. Leave only if it stays offline.
        updated = { ...updated, lingering: true, spotId: prev.spotId }
        setTimeout(() => useOffice.getState().leaveIfStillOffline(info.id), OFFLINE_GRACE_MS)
      } else if (cameBack && prev.lingering) {
        // back before leaving: carry on where it was
        updated = { ...updated, lingering: false }
      } else if (cameBack) {
        // back after it left: drive in again (the scene only renders agents that aren't offline, so this remounts)
        updated = { ...updated, lingering: false, arriving: true, spawn: undefined, spotId: assignSpot(updated, info.status, agents), gen: (prev.gen ?? 0) + 1 }
      } else if (prev.lingering) {
        updated = { ...updated, lingering: true, spotId: prev.spotId }
      } else if (atDesk(prev.status) && info.status === 'idle') {
        // done: stay at the desk (leaning back) for a moment, then wander off
        updated = { ...updated, spotId: prev.spotId }
        setTimeout(() => useOffice.getState().leaveDeskIfStillIdle(info.id), DESK_WIND_DOWN_MS)
      }
      return {
        agents: agents.map((a) => (a.id === info.id ? updated : a)),
        departing: cameBack ? departing.filter((d) => d.id !== prev.id) : departing,
      }
    }),

  leaveDeskIfStillIdle: (id) =>
    set(({ agents }) => {
      const a = agents.find((x) => x.id === id)
      if (!a || a.status !== 'idle' || a.spotId !== `desk-${a.desk}`) return {}
      return { agents: agents.map((x) => (x.id === id ? { ...x, spotId: assignSpot(x, 'idle', agents) } : x)) }
    }),

  leaveIfStillOffline: (id) =>
    set(({ agents, departing }) => {
      const a = agents.find((x) => x.id === id)
      if (!a || a.status !== 'offline' || !a.lingering) return {}
      // play the leaving animation with a copy while the panel keeps listing the agent
      return {
        agents: agents.map((x) => (x.id === id ? { ...x, lingering: false } : x)),
        departing: [...departing.filter((d) => d.id !== id), { ...a, lingering: false }],
      }
    }),

  selectedId: null,
  simOn: true,
  profileId: null,

  updateAgent: (id, patch) => set(({ agents }) => ({ agents: agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
  openProfile: (profileId) => set({ profileId }),

  setStatus: (id, status, patch) =>
    set(({ agents }) => ({
      agents: agents.map((a) => {
        if (a.id !== id) return a
        // same wind-down at the desk as live agents (demo mode)
        const windDown = atDesk(a.status) && status === 'idle'
        if (windDown) setTimeout(() => useOffice.getState().leaveDeskIfStillIdle(id), DESK_WIND_DOWN_MS)
        return { ...a, ...patch, status, spotId: windDown ? a.spotId : assignSpot(a, status, agents), updatedAt: Date.now() }
      }),
    })),

  addAgent: (info = {}) => {
    // departing agents still own their desk/parking slot until they've driven off
    const a = createAgent([...get().agents, ...get().departing], info, false)
    set(({ agents }) => ({ agents: [...agents, a] }))
  },

  removeAgent: (id) =>
    set(({ agents, departing, selectedId, profileId }) => {
      const gone = agents.find((a) => a.id === id)
      return {
        agents: agents.filter((a) => a.id !== id),
        // keep rendering it until it has walked out and driven off
        departing: gone ? [...departing, gone] : departing,
        selectedId: selectedId === id ? null : selectedId,
        profileId: profileId === id ? null : profileId,
      }
    }),
  departing: [],
  finishDeparture: (id) => set(({ departing }) => ({ departing: departing.filter((a) => a.id !== id) })),

  startMeeting: (ids) => {
    for (const id of ids) get().setStatus(id, 'meeting', { task: 'Sync meeting', tool: undefined })
  },

  select: (selectedId) => set({ selectedId }),
  toggleSim: () => set(({ simOn }) => ({ simOn: !simOn })),
}))


if (import.meta.env.DEV) Object.assign(window, { __store: useOffice })
