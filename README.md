# @mastra/discord

Discord channel wrapper for Mastra — a `ChannelProvider` (`@mastra/core/channels`) over **`@chat-adapter/discord@4.32`**, to parity with `@mastra/slack`. Greenfield (`@mastra/discord@1.0.0` is a dead `@mastra/core@0.1.0` stub — don't extend it).

- **Verified build spec:** Obsidian vault → `1. Projects/Mastra Channel Wrappers/Mastra Channels Contribution — Discord & Telegram Wrappers.md`
- **Umbrella project:** `1. Projects/Mastra Channel Wrappers/Mastra Channel Wrappers.md`
- **Tracking:** beads — run `bd ready`. Epic `mastra-discord-13x`.

**Shape:** one-app-many-guilds (no programmatic app creation). Ed25519 + PING handled by the adapter; Gateway reconnection by `@mastra/core` (`AgentChannels.startGatewayLoop`, `gateway: true`). The wrapper owns: OAuth2 bot-invite `connect()`, guild-keyed install store, guild/global command registration, and deferred-follow-up streaming.
