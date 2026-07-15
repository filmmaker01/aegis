/**
 * Per-connection owner notification preferences. Backed by the
 * `notification_settings` table (Prisma) or the in-memory store (tests/dev).
 * All defaults are "on" so behaviour is unchanged until an owner opts out.
 */
export interface NotificationSettings {
  /** Send a card when a message is deleted. */
  notifyDeletions: boolean
  /** Send a card when a message is edited. */
  notifyEdits: boolean
  /** Re-send stored media on a deletion (vs. a text-only card). */
  notifyMedia: boolean
  /** Group a bulk delete into one card (vs. one card per message). */
  groupBatches: boolean
  /** tgChatIds to silence entirely (no deletion/edit notifications). */
  mutedChats: number[]
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  notifyDeletions: true,
  notifyEdits: true,
  notifyMedia: true,
  groupBatches: true,
  mutedChats: [],
}

export interface NotificationSettingsRepository {
  /** Current settings for a connection; defaults when none are stored yet. */
  getSettings(connectionId: string): Promise<NotificationSettings>
  /** Merge a partial patch and return the resulting settings. */
  updateSettings(
    connectionId: string,
    patch: Partial<NotificationSettings>,
  ): Promise<NotificationSettings>
}
