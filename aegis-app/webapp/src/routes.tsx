import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'

import { AegisPlaceholder } from './features/aegis/AegisPlaceholder'
import { Dashboard } from './features/aegis/Dashboard'
import { Deleted } from './features/aegis/Deleted'
import { AppPage, HomePage, RootLayout } from './pages'

const rootRoute = createRootRoute({
  component: RootLayout,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
})

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  component: AppPage,
})

const aegisRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/aegis',
  component: AegisPlaceholder,
})

const aegisDashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/aegis/dashboard',
  component: Dashboard,
})

const aegisDeletedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/aegis/deleted',
  component: Deleted,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  appRoute,
  aegisRoute,
  aegisDashboardRoute,
  aegisDeletedRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
