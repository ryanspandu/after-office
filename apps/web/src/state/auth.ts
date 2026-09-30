import { create } from 'zustand'

// Browser side of the server session (HttpOnly cookie). We only ever learn *who* is signed in.
// Signing in takes the password, then a 6-digit code from the authenticator app (two-factor). Until two-factor is set
// up, the password only lets you set it up ('setup-2fa').

type Status = 'checking' | 'signed-out' | 'needs-code' | 'setup-2fa' | 'signed-in'

export interface TwoFactorInfo {
  enrolled: boolean
  enrolledAt?: number
  recoveryLeft?: number
}

interface AuthStore {
  status: Status
  user: string | null
  /** the owner's picture (address), or null: their initial is shown */
  avatar: string | null
  twoFactor: TwoFactorInfo | null
  /** between the password and the code */
  ticket: string | null
  check: () => Promise<void>
  login: (username: string, password: string, remember: boolean) => Promise<string | null>
  /** the second step: the app's code, or a recovery code */
  submitCode: (input: { code?: string; recovery?: string }) => Promise<string | null>
  /** back to the password (e.g. the code step took too long) */
  restart: () => void
  logout: () => Promise<void>
  /** Call when any API request comes back 401 (session expired). */
  expire: () => void
}

const tooMany = (body: { retryAfter?: number }) => `Too many attempts. Try again in ${Math.ceil((body.retryAfter ?? 60) / 60)} min.`

export const useAuth = create<AuthStore>((set, get) => ({
  status: 'checking',
  user: null,
  avatar: null,
  twoFactor: null,
  ticket: null,

  check: async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' })
      if (!res.ok) return set({ status: 'signed-out', user: null })
      const body = (await res.json()) as { user: string; avatar?: string | null; needs2fa?: string; twoFactor?: TwoFactorInfo }
      set({ status: body.needs2fa === 'setup' ? 'setup-2fa' : 'signed-in', user: body.user, avatar: body.avatar ?? null, twoFactor: body.twoFactor ?? null })
    } catch {
      set({ status: 'signed-out', user: null })
    }
  },

  login: async (username, password, remember) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, remember }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 429 && body.retryAfter) return tooMany(body)
        return body.error ?? 'Sign in failed.'
      }
      if (body.needCode) set({ status: 'needs-code', ticket: body.ticket })
      else if (body.needs2fa === 'setup') set({ status: 'setup-2fa', user: body.user })
      else set({ status: 'signed-in', user: body.user })
      return null
    } catch {
      return 'Can’t reach the server.'
    }
  },

  submitCode: async (input) => {
    try {
      const res = await fetch('/api/auth/login/code', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: get().ticket, ...input }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (body.restart) set({ status: 'signed-out', ticket: null })
        if (res.status === 429 && body.retryAfter) return tooMany(body)
        return body.error ?? 'Sign in failed.'
      }
      set({ ticket: null })
      await get().check()
      return null
    } catch {
      return 'Can’t reach the server.'
    }
  },

  restart: () => set({ status: 'signed-out', ticket: null }),

  logout: async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
    set({ status: 'signed-out', user: null, twoFactor: null, ticket: null })
  },

  expire: () => set({ status: 'signed-out', user: null, twoFactor: null, ticket: null }),
}))

/** fetch() for our API: same-origin cookies, JSON bodies, and a 401 sends you back to the login page. */
export async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    // every write says application/json, even without a body (DELETE, bare POST): the server requires it as CSRF defence
    headers: { ...(init?.method && init.method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  })
  if (res.status === 401) useAuth.getState().expire()
  // signed in with the password only (two-factor not set up yet): straight to the setup
  if (res.status === 403 && useAuth.getState().status === 'signed-in') {
    const body = await res
      .clone()
      .json()
      .catch(() => null)
    if (body?.needs2fa === 'setup') useAuth.setState({ status: 'setup-2fa' })
  }
  return res
}
