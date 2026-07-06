# @mastra/discord

## Unreleased

Initial release — a Mastra `ChannelProvider` over Vercel's Chat SDK Discord
adapter (`@chat-adapter/discord`), to parity with `@mastra/slack`.

### Features

- **`DiscordProvider`** implementing `ChannelProvider` — `connect()` (an OAuth2
  bot-invite URL, or an immediate bind when the bot is already in the target
  guild), `disconnect()`, `initialize()`, `configure()`, `getInfo()`,
  `listInstallations()`, `getInstallation()`, `isConfigured()`, `getAdapter()`,
  and `activateGuild()` for lazy per-guild activation.
- **One app, many guilds** — app credentials (bot token / public key /
  application id) stored once; a two-tier, guild-keyed install store with no
  per-install token. Optional AES-256-GCM encryption at rest for the bot token.
- **Interactions route** — a mounted `POST /discord/events/:webhookId` that
  passes the raw request bytes to `adapter.handleWebhook` (Ed25519 verification +
  PING/PONG handled by the adapter); guilds activate lazily off the first
  interaction's authoritative `guild_id`.
- **Gateway** — `gateway: true` (default) lets `@mastra/core` own the DM/mention
  reconnection loop; set `false` for interactions-only serverless deployments.
- **Command registration** — guild (`PUT …/guilds/{id}/commands`) or global
  (`PUT …/commands`), with a per-scope version hash that skips unchanged sets
  (200 creates/day/guild aware).
- **Streaming replies** — post-and-edit on the interaction followup, with a
  typing indicator; `toolDisplay` defaults to `'cards'` (native embeds/buttons).
- **Dual ESM + CJS build** — the ESM-only adapter is bundled into the `.cjs` so
  both `import` and `require('@mastra/discord')` work.
