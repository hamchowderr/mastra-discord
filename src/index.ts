export { DiscordProvider, resolveDiscordAdapterConfig } from './discord-provider'
export { DiscordInstallStore, toInstallationInfo, PLATFORM } from './install-store'
export { validateApp, guildHealthCheck, buildInviteUrl, discordRequest } from './discord-client'
export type { DiscordApplication, BuildInviteUrlOptions } from './discord-client'
export { DEFAULT_COMMANDS, normalizeCommands } from './commands'
export { encrypt, decrypt, isEncrypted } from './crypto'
export {
  DISCORD_API_BASE_URL,
  DISCORD_OAUTH_AUTHORIZE_URL,
  DISCORD_PERMISSIONS,
  DEFAULT_INVITE_PERMISSIONS,
  DEFAULT_INVITE_SCOPES,
} from './types'
export type {
  DiscordProviderConfig,
  DiscordConnectOptions,
  DiscordInstallation,
  DiscordAppConfig,
  DiscordCommand,
  DiscordCommandInput,
} from './types'

// Note: the underlying adapter (`createDiscordAdapter`/`DiscordAdapter`) is
// re-exported alongside route mounting + the dual ESM/CJS build in issue
// `mastra-discord-13x.3`, where the adapter is first wired.
