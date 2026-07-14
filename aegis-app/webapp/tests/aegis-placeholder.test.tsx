import { expect, test } from 'bun:test'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AegisPlaceholder } from '../src/features/aegis/AegisPlaceholder'

// The placeholder uses <Link>, so it must render inside a router context.
async function renderInRouter() {
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: AegisPlaceholder })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(React.createElement(RouterProvider, { router }))
}

test('Aegis placeholder renders product name and Telegram runtime status', async () => {
  const html = await renderInRouter()
  expect(html).toContain('Aegis')
  expect(html).toContain('Telegram runtime')
  // Outside Telegram there is no injected WebApp, so it must report unavailability.
  expect(html).toContain('Not running inside Telegram')
})
