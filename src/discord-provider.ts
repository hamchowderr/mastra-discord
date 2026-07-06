import { randomUUID } from 'node:crypto'
import type {
  ChannelAdapterConfig,
  ChannelConnectResult,
  ChannelInstallationInfo,
  ChannelPlatformInfo,
  ChannelProvider,
  StreamingConfig,
} from '@mastra/core/channels'
import type { Mastra } from '@mastra/core/mastra'
import type { ApiRoute } from '@mastra/core/server'
import { InMemoryChannelsStorage } from '@mastra/core/storage'
import type { ChannelsStorage } from '@mastra/core/storage'
import { buildInviteUrl, guildHealthCheck, validateApp } from './discord-client'
import { DiscordInstallStore, PLATFORM, toInstallationInfo } from './install-store'
import { DEFAULT_INVITE_PERMISSIONS, DEFAULT_INVITE_SCOPES, DISCORD_API_BASE_URL } from './types'
import type {
  DiscordAppConfig,
  DiscordConnectOptions,
  DiscordInstallation,
  DiscordProviderConfig,
} from './types'

/**
 * Resolve the per-adapter streaming/typing/tool-display config the provider
 * applies to the Discord entry in `AgentChannels.adapters` (consumed by the
 * route/adapter wiring in issue `mastra-discord-13x.3`). Discord has native
 * embeds + action-row buttons, so `toolDisplay` defaults to `'cards'` (unlike
 * Telegram's `'text'`); `streaming` post-and-edits the interaction followup.
 */
export function resolveDiscordAdapterConfig(
  config: Pick<DiscordProviderConfig, 'streaming' | 'typingStatus' | 'toolDisplay'>,
): { streaming: StreamingConfig; typingStatus: boolean; toolDisplay: ChannelAdapterConfig['toolDisplay'] } {
  return {
    streaming: config.streaming ?? true,
    typingStatus: config.typingStatus ?? true,
    toolDisplay: config.toolDisplay ?? 'cards',
  }
}

/**
 * Discord channel provider for Mastra — a {@link ChannelProvider} over
 * `@chat-adapter/discord`. The adapter handles the protocol (Ed25519 request
 * verification, PING/PONG, deferrals, embeds/buttons, the Gateway bridge,
 * post-and-edit streaming); this provider adds the lifecycle layer.
 *
 * **One app, many guilds.** Discord has no programmatic app creation, so a
 * single application's credentials (bot token / public key / application id) are
 * stored **once** and reused across every guild. "Installing" is a bot invite —
 * an OAuth2 authorize URL — not a token exchange, so `connect()` returns the
 * `oauth` variant. A guild is confirmed either eagerly (the bot is already a
 * member) or lazily off the first inbound interaction's authoritative `guild_id`
 * (see {@link activateGuild}).
 *
 * Implemented here (issue `mastra-discord-13x.2`): the app-config + guild-keyed
 * install store, `connect()`/`disconnect()`, and OAuth2 invite-URL generation.
 * Route mounting + adapter wiring lands in `mastra-discord-13x.3`; command
 * registration in `mastra-discord-13x.4`.
 *
 * @example
 * ```ts
 * const discord = new DiscordProvider({
 *   app: { botToken, publicKey, applicationId }, // or DISCORD_* env vars
 * })
 * const mastra = new Mastra({ agents: { myAgent }, channels: { discord } })
 * const res = await discord.connect('my-agent')   // → { type: 'oauth', authorizationUrl, installationId }
 * // Operator opens authorizationUrl, invites the bot; the guild activates on
 * // the first interaction.
 * ```
 */
export class DiscordProvider implements ChannelProvider {
  readonly id = PLATFORM

  #config: DiscordProviderConfig
  #mastra?: Mastra
  #store?: DiscordInstallStore
  /** Cached sync view of whether the app is configured (for {@link getInfo}). */
  #configured = false

  constructor(config: DiscordProviderConfig = {}) {
    this.#config = config
    // The app is "configured" as soon as credentials are resolvable (config/env),
    // even before the first connect persists them.
    this.#configured = this.#suppliedAppConfig() != null
  }

  /**
   * Called by Mastra when this channel is registered.
   * @internal
   */
  __attach(mastra: Mastra): void {
    if (this.#mastra && this.#mastra !== mastra) {
      this.#store = undefined
    }
    this.#mastra = mastra
  }

  /**
   * Interactions POST route. Route mounting (raw-body delegation to
   * `adapter.handleWebhook` + `gateway: true`) lands in `mastra-discord-13x.3`;
   * until then this provider manages no routes.
   */
  getRoutes(): ApiRoute[] {
    return []
  }

  /** Discovery metadata for the editor UI. */
  getInfo(): ChannelPlatformInfo {
    return {
      id: this.id,
      name: 'Discord',
      isConfigured: this.#configured,
      connectOptionsSchema: {
        type: 'object',
        properties: {
          guildId: {
            type: 'string',
            description:
              'Guild (server) to install into. If the bot is already a member, connect binds immediately; otherwise you receive an invite URL.',
          },
          name: {
            type: 'string',
            description: "Display name for the installation (defaults to the application's name).",
          },
          commands: {
            type: 'array',
            items: { type: 'string' },
            description: 'Slash command names to register for this agent.',
          },
        },
      },
    }
  }

  /**
   * Restore state from storage: mark the provider configured when an app config
   * or any active installation exists. Idempotent. (Adapter/Gateway restoration
   * lands in `mastra-discord-13x.3`.)
   */
  async initialize(): Promise<void> {
    const store = await this.#getStore()
    const hasApp = (await store.getAppConfig()) != null || this.#suppliedAppConfig() != null
    const hasActive = (await store.list()).some((i) => i.status === 'active')
    this.#configured = hasApp || hasActive
  }

  /**
   * Provide or clear the app credentials at runtime. An object merges/overrides
   * `botToken` / `publicKey` / `applicationId` (and is persisted on the next
   * `connect`); `null` clears the stored app config.
   */
  async configure(credentials: Partial<DiscordAppConfig> | null): Promise<void> {
    if (credentials === null) {
      const store = await this.#getStore()
      await store.deleteAppConfig()
      this.#config = { ...this.#config, app: undefined }
      this.#configured = false
      return
    }
    this.#config = { ...this.#config, app: { ...this.#config.app, ...credentials } }
    this.#configured = this.#suppliedAppConfig() != null || this.#configured
  }

  /**
   * Connect an agent to Discord.
   *
   * - Ensures the app config exists (stored, or supplied via provider config /
   *   `DISCORD_*` env and persisted once). Throws if none — Discord apps are
   *   created in the Developer Portal, not programmatically.
   * - Validates the bot token via `GET /applications/@me`.
   * - If `options.guildId` is given **and the bot is already in that guild**,
   *   binds immediately (`{ type: 'immediate' }`).
   * - Otherwise persists a pending install and returns the OAuth2 bot-invite URL
   *   (`{ type: 'oauth', authorizationUrl }`); the guild activates lazily on the
   *   first interaction.
   */
  async connect(agentId: string, options: DiscordConnectOptions = {}): Promise<ChannelConnectResult> {
    const store = await this.#getStore()
    const existing = await store.getByAgent(agentId)
    if (existing?.status === 'active') {
      throw new Error(
        `Agent "${agentId}" is already connected to Discord. Disconnect first to reconnect. ` +
          'To add another server, invite the bot with the existing URL — new guilds activate on first use.',
      )
    }

    const { app, persisted } = await this.#resolveAppConfig(store)
    // Validate the token before persisting supplied credentials — an invalid
    // token must leave no app config and no install behind.
    const identity = await validateApp(app.botToken, this.#apiBaseUrl())
    if (!persisted) await store.saveAppConfig(app)

    const installationId = existing?.id ?? randomUUID()
    const webhookId = existing?.webhookId ?? randomUUID()
    const displayName = options.name ?? identity.name
    const installedAt = existing?.installedAt ?? new Date()

    // Eager bind: the bot is already a member of the target guild.
    if (options.guildId && (await guildHealthCheck(app.botToken, options.guildId, this.#apiBaseUrl()))) {
      const installation: DiscordInstallation = {
        id: installationId,
        agentId,
        webhookId,
        status: 'active',
        guildIds: [options.guildId],
        displayName,
        installedAt,
      }
      // Command registration (guild-scoped + per-guild hashing): mastra-discord-13x.4.
      await store.save(installation)
      this.#configured = true
      await this.#config.onInstall?.(installation)
      return { type: 'immediate', installationId }
    }

    // Invite flow: persist pending, hand back the OAuth2 bot-invite URL.
    const pending: DiscordInstallation = {
      id: installationId,
      agentId,
      webhookId,
      status: 'pending',
      guildIds: existing?.guildIds ?? [],
      displayName,
      installedAt,
    }
    await store.save(pending)
    this.#configured = true
    const authorizationUrl = buildInviteUrl({
      applicationId: app.applicationId,
      permissions: options.permissions ?? this.#config.permissions ?? DEFAULT_INVITE_PERMISSIONS,
      scopes: DEFAULT_INVITE_SCOPES,
    })
    return { type: 'oauth', authorizationUrl, installationId }
  }

  /**
   * Confirm a guild off an inbound interaction's authoritative `guild_id` and
   * mark the installation active (lazy activation). Called by the interactions
   * route on first use (`mastra-discord-13x.3`). Returns the updated
   * installation, or `null` if the `webhookId` is unknown.
   */
  async activateGuild(webhookId: string, guildId: string): Promise<DiscordInstallation | null> {
    const store = await this.#getStore()
    const installation = await store.getByWebhookId(webhookId)
    if (!installation) return null

    const wasActive = installation.status === 'active'
    if (!installation.guildIds.includes(guildId)) installation.guildIds.push(guildId)
    installation.status = 'active'
    // Command registration for the newly-seen guild: mastra-discord-13x.4.
    await store.save(installation)
    this.#configured = true
    if (!wasActive) await this.#config.onInstall?.(installation)
    return installation
  }

  /**
   * Disconnect an agent from Discord: remove its installation row.
   *
   * **Limitation:** the Gateway loop is owned by core (it calls
   * `startGatewayListener` itself; there is no `stopGatewayListener`), so
   * disconnect cannot kill an in-flight gateway window — it lapses at the next
   * duration boundary. Contrast Telegram's clean `stopPolling()`.
   */
  async disconnect(agentId: string): Promise<void> {
    const store = await this.#getStore()
    const existing = await store.getByAgent(agentId)
    if (!existing) {
      throw new Error(`No Discord installation found for agent "${agentId}"`)
    }
    await store.deleteByAgent(agentId)
    this.#configured = (await store.getAppConfig()) != null || (await store.list()).some((i) => i.status === 'active')
  }

  /** List installations (public info only — no secrets). */
  async listInstallations(): Promise<ChannelInstallationInfo[]> {
    const store = await this.#getStore()
    const installations = await store.list()
    return installations.map(toInstallationInfo)
  }

  /** The full installation for an agent (no secrets live on it), or `null`. */
  async getInstallation(agentId: string): Promise<DiscordInstallation | null> {
    const store = await this.#getStore()
    return (await store.getByAgent(agentId)) ?? null
  }

  /** Whether the Discord app is configured (credentials resolvable). */
  isConfigured(): boolean {
    return this.#configured
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  #apiBaseUrl(): string {
    return this.#config.apiBaseUrl ?? DISCORD_API_BASE_URL
  }

  /** App credentials from provider config or `DISCORD_*` env, or `null` if incomplete. */
  #suppliedAppConfig(): DiscordAppConfig | null {
    const a = this.#config.app ?? {}
    const botToken = a.botToken ?? process.env.DISCORD_BOT_TOKEN
    const publicKey = a.publicKey ?? process.env.DISCORD_PUBLIC_KEY
    const applicationId = a.applicationId ?? process.env.DISCORD_APPLICATION_ID
    if (botToken && publicKey && applicationId) return { botToken, publicKey, applicationId }
    return null
  }

  /**
   * Resolve the app config: prefer the stored one, else the supplied credentials
   * (config / `DISCORD_*` env). `persisted` says whether it's already in storage,
   * so the caller can persist supplied credentials **once**, after validation.
   * Throws if neither is available.
   */
  async #resolveAppConfig(store: DiscordInstallStore): Promise<{ app: DiscordAppConfig; persisted: boolean }> {
    const stored = await store.getAppConfig()
    if (stored) return { app: stored, persisted: true }
    const supplied = this.#suppliedAppConfig()
    if (supplied) return { app: supplied, persisted: false }
    throw new Error(
      'Discord app is not configured. Provide botToken, publicKey, and applicationId via the provider `app` option, ' +
        'the DISCORD_BOT_TOKEN / DISCORD_PUBLIC_KEY / DISCORD_APPLICATION_ID env vars, or configure() — ' +
        'Discord applications are created in the Developer Portal, not programmatically.',
    )
  }

  async #getStore(): Promise<DiscordInstallStore> {
    if (this.#store) return this.#store
    const encryptionKey = this.#config.encryptionKey ?? process.env.MASTRA_ENCRYPTION_KEY
    this.#store = new DiscordInstallStore(await this.#resolveStorage(), encryptionKey)
    return this.#store
  }

  async #resolveStorage(): Promise<ChannelsStorage> {
    if (this.#config.storage) return this.#config.storage
    const mastraStore = this.#mastra?.getStorage()
    if (mastraStore) {
      try {
        await mastraStore.init()
        const channels = await mastraStore.getStore('channels')
        if (channels) return channels
      } catch {
        // Fall through to the in-memory store below.
      }
    }
    // No persistent storage available — fall back to in-memory. Installs won't
    // survive a restart; pass `storage` or configure Mastra storage in prod.
    return new InMemoryChannelsStorage()
  }
}
