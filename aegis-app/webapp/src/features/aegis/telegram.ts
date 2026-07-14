/**
 * Minimal, dependency-free access to the Telegram Mini App runtime.
 *
 * This only *reads* what Telegram injects on `window.Telegram.WebApp`. It never
 * trusts these values for authorization — `initData` must be sent to the backend
 * and verified there with `verifyTelegramInitData` (HMAC). Client-side fields are
 * for UI only.
 */

export interface TelegramWebAppUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
  is_premium?: boolean
}

export interface TelegramWebApp {
  initData: string
  initDataUnsafe?: { user?: TelegramWebAppUser; auth_date?: number; hash?: string }
  version?: string
  platform?: string
  colorScheme?: 'light' | 'dark'
  ready: () => void
  expand: () => void
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null
  return window.Telegram?.WebApp ?? null
}

export interface TelegramContext {
  available: boolean
  platform?: string
  version?: string
  /** Raw initData string to send to the backend for verification. */
  initData: string
  /** UI-only user info (NOT verified). */
  user?: TelegramWebAppUser
}

export function readTelegramContext(): TelegramContext {
  const wa = getTelegramWebApp()
  if (!wa) return { available: false, initData: '' }
  return {
    available: true,
    platform: wa.platform,
    version: wa.version,
    initData: wa.initData ?? '',
    user: wa.initDataUnsafe?.user,
  }
}
