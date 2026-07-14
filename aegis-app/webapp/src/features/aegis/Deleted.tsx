import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'

import { aegisApi, canQuery, type DeletedItem } from './api'

function formatTime(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function DeletedRow({ item }: { item: DeletedItem }) {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>
            <Typography variant="bodySm">{item.peerLabel ?? `Chat ${item.tgChatId}`}</Typography>
          </CardTitle>
          <Badge variant="outline">Deleted</Badge>
        </div>
        <CardDescription>Deleted {formatTime(item.detectedAt)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {item.archived ? (
          <Typography variant="body" wrap="break">
            {item.savedText ?? (item.hasMedia ? '(media — saved copy in archive)' : '(no text content)')}
          </Typography>
        ) : (
          <Typography variant="bodySm" tone="muted">
            Content was not in your archive (message predates monitoring).
          </Typography>
        )}
        {item.hasMedia ? (
          <Badge variant="secondary" className="w-fit">
            has media
          </Badge>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function Deleted() {
  const enabled = canQuery()
  const deleted = useQuery({ queryKey: ['aegis', 'deleted'], queryFn: () => aegisApi.deleted(), enabled })

  return (
    <section className="mx-auto grid w-full max-w-3xl gap-6 px-5 py-10">
      <div className="flex items-center justify-between gap-3">
        <Typography variant="h1">Deleted messages</Typography>
        <Button asChild variant="outline" size="sm">
          <Link to="/aegis/dashboard">Dashboard</Link>
        </Button>
      </div>

      {!enabled ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Open inside Telegram</CardTitle>
            <CardDescription>Open the Mini App from the bot to load your saved messages.</CardDescription>
          </CardHeader>
        </Card>
      ) : deleted.isLoading ? (
        <Card size="sm">
          <CardHeader className="flex-row items-center gap-3">
            <Spinner />
            <CardDescription>Loading…</CardDescription>
          </CardHeader>
        </Card>
      ) : deleted.isError || !deleted.data ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Could not load</CardTitle>
            <CardDescription>
              {deleted.error ? (deleted.error as Error).message : 'No data'}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : deleted.data.items.length === 0 ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Nothing deleted yet</CardTitle>
            <CardDescription>Deleted messages from your monitored chats will appear here.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3">
          {deleted.data.items.map((item) => (
            <DeletedRow key={`${item.tgChatId}:${item.tgMessageId}`} item={item} />
          ))}
        </div>
      )}
    </section>
  )
}
