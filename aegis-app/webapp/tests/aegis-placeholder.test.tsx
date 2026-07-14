import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AegisPlaceholder } from '../src/features/aegis/AegisPlaceholder'

test('Aegis placeholder renders product name and Telegram runtime status', () => {
  const html = renderToStaticMarkup(React.createElement(AegisPlaceholder))
  expect(html).toContain('Aegis')
  expect(html).toContain('Telegram runtime')
  // Outside Telegram there is no injected WebApp, so it must report unavailability.
  expect(html).toContain('Not running inside Telegram')
})
