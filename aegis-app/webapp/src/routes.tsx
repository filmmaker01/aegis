import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'

import { AegisPlaceholder } from './features/aegis/AegisPlaceholder'
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

const routeTree = rootRoute.addChildren([indexRoute, appRoute, aegisRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
