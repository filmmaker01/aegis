import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Typography } from '@/components/ui/typography'

import { aegisApi, canQuery } from './api'

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <Typography variant="h2">{value}</Typography>
        </CardTitle>
        <CardDescription>{label}</CardDescription>
      </CardHeader>
    </Card>
  )
}

export function Dashboard() {
  const enabled = canQuery()
  const overview = useQuery({ queryKey: ['aegis', 'overview'], queryFn: aegisApi.overview, enabled })

  return (
    <section className="mx-auto grid w-full max-w-3xl gap-6 px-5 py-10">
      <div className="flex items-center justify-between gap-3">
        <Typography variant="h1">Dashboard</Typography>
        <Button asChild variant="outline" size="sm">
          <Link to="/aegis/deleted">Deleted</Link>
        </Button>
      </div>

      {!enabled ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Open inside Telegram</CardTitle>
            <CardDescription>
              This dashboard needs Telegram initData to load your archive. Open the Mini App from the
              bot.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : overview.isLoading ? (
        <Card size="sm">
          <CardHeader className="flex-row items-center gap-3">
            <Spinner />
            <CardDescription>Loading your archive…</CardDescription>
          </CardHeader>
        </Card>
      ) : overview.isError || !overview.data ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Could not load</CardTitle>
            <CardDescription>
              {overview.error ? (overview.error as Error).message : 'No data'}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Badge variant="outline" className="w-fit">
            {overview.data.connections} connection{overview.data.connections === 1 ? '' : 's'}
          </Badge>
          <div className="grid gap-4 sm:grid-cols-2">
            <Stat label="Messages archived" value={overview.data.messages} />
            <Stat label="Deleted caught" value={overview.data.deleted} />
            <Stat label="Edited tracked" value={overview.data.edited} />
            <Stat label="Chats" value={overview.data.chats} />
          </div>
        </>
      )}
    </section>
  )
}
