import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Typography } from '@/components/ui/typography'

import { readTelegramContext } from './telegram'

/**
 * Aegis Mini App placeholder.
 *
 * Foundation only: shows the product intent and whether the app is running
 * inside Telegram. No message data, storage, auth, or product features yet.
 */
export function AegisPlaceholder() {
  const tg = readTelegramContext()

  return (
    <section className="mx-auto grid w-full max-w-3xl gap-8 px-5 py-12">
      <div className="grid gap-4">
        <Badge variant="outline" className="w-fit">
          Aegis · foundation
        </Badge>
        <Typography variant="h1">Aegis</Typography>
        <Typography className="max-w-2xl" tone="muted">
          Official Telegram Business Bot and Mini App. It saves new messages, records edits,
          and shows the saved copy after a message is deleted — using only the official
          Telegram Bot API, Business Connections, and Mini Apps.
        </Typography>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Telegram runtime</CardTitle>
          <CardDescription>
            {tg.available
              ? `Running inside Telegram (${tg.platform ?? 'unknown'} · v${tg.version ?? '?'}).`
              : 'Not running inside Telegram — open this app from the bot to get initData.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Typography variant="bodySm" tone="muted">
            initData present: {tg.initData ? 'yes' : 'no'}
          </Typography>
          {tg.user ? (
            <Typography variant="bodySm" tone="muted">
              Hello, {tg.user.first_name ?? tg.user.username ?? `user ${tg.user.id}`} (UI only —
              identity is verified server-side).
            </Typography>
          ) : null}
        </CardContent>
      </Card>
    </section>
  )
}
