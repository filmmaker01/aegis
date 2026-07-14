import type { DbClient } from '../../db'
import type { AppEnv } from '../../env'
import { AuthService } from './application/auth-service'
import type { Clock, LogoutCleanup, ProjectUser } from './application/ports'
import { toBaseUserDto } from './domain/user'
import { createPrismaAuthRepository } from './infrastructure/auth-repository'
import { signAccessToken, verifyAccessToken } from './infrastructure/access-tokens'
import { hashPassword, verifyPassword } from './infrastructure/passwords'
import { createRefreshToken, hashRefreshToken } from './infrastructure/refresh-tokens'
import { createRequireAuth, type AuthHttpEnv } from './transport/middleware'
import { createAuthRoutes } from './transport/routes'

type CreateAuthModuleOptions = {
  clock?: Clock
  db: DbClient
  env: AppEnv
  logoutCleanup?: LogoutCleanup
  projectUser?: ProjectUser
}

const systemClock: Clock = {
  now: () => new Date(),
}

const noLogoutCleanup: LogoutCleanup = () => undefined

export function createAuthModule({
  clock = systemClock,
  db,
  env,
  logoutCleanup = noLogoutCleanup,
  projectUser = toBaseUserDto,
}: CreateAuthModuleOptions) {
  const service = new AuthService({
    accessTokens: {
      sign: (payload) => signAccessToken(payload, env),
      verify: (token) => verifyAccessToken(token, env),
    },
    clock,
    logoutCleanup,
    passwords: {
      hash: hashPassword,
      verify: verifyPassword,
    },
    projectUser,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    refreshTokens: {
      create: createRefreshToken,
      hash: hashRefreshToken,
    },
    repository: createPrismaAuthRepository(db),
  })
  const requireAuth = createRequireAuth((accessToken) => service.authenticateAccessToken(accessToken))

  return {
    authenticateAccessToken: (accessToken: string | undefined) =>
      service.authenticateAccessToken(accessToken),
    requireAuth,
    routes: createAuthRoutes({ env, requireAuth, service }),
  }
}

export type { AuthHttpEnv }
export type { LogoutCleanup, ProjectUser } from './application/ports'
export type { AuthenticatedPrincipal } from './domain/user'
