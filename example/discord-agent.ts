/**
 * Minimal example: give a Mastra agent a Discord bot.
 *
 * Prerequisites (Discord has no programmatic app creation — one app, many guilds):
 *   1. Create an application in the Discord Developer Portal
 *      (https://discord.com/developers/applications).
 *   2. Add a Bot and copy its **token** (`DISCORD_BOT_TOKEN`).
 *   3. Copy the app's **Public Key** (`DISCORD_PUBLIC_KEY`) and **Application ID**
 *      (`DISCORD_APPLICATION_ID`) from the General Information page.
 *   4. Set the **Interactions Endpoint URL** to `${baseUrl}/discord/events/<webhookId>`
 *      once you have the webhookId from `connect()` (Discord will send a signed
 *      PING to verify it — the adapter answers with a PONG automatically).
 *   5. A public HTTPS URL (a tunnel like `cloudflared` works in dev).
 *
 * Run (from a project that has @mastra/core, @mastra/discord and a model provider):
 *   DISCORD_BOT_TOKEN=... DISCORD_PUBLIC_KEY=... DISCORD_APPLICATION_ID=... \
 *   MASTRA_SERVER_BASE_URL=https://your-tunnel.example.com \
 *     tsx example/discord-agent.ts
 *
 * Open the printed invite URL, pick a server, and authorize. The bot goes live in
 * that guild on its first interaction; slash-command registration, Ed25519
 * verification, the Gateway (DMs/@mentions), typing keepalive and reply streaming
 * are all handled by the provider + adapter.
 */
import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { anthropic } from '@ai-sdk/anthropic'
import { DiscordProvider } from '@mastra/discord'

const supportAgent = new Agent({
  id: 'support',
  name: 'support',
  instructions: 'You are a concise, friendly support agent. Answer in plain language.',
  model: anthropic('claude-opus-4-8'),
})

// One app serves every guild. Credentials are read from the DISCORD_* env vars
// (or pass them via `app: { botToken, publicKey, applicationId }`), and are
// persisted once to Mastra's channels storage.
const discord = new DiscordProvider({
  // Omit to auto-detect from the Mastra server config.
  baseUrl: process.env.MASTRA_SERVER_BASE_URL,
  // Persist installs in production (Postgres/libSQL). Defaults to Mastra's
  // channels storage when available, else in-memory (dev only).
})

export const mastra = new Mastra({
  agents: { support: supportAgent },
  channels: { discord },
})

// Connect the agent. In an app this is usually triggered from the editor UI or an
// admin route; here we do it inline for illustration.
async function main() {
  const result = await discord.connect('support', {
    // Optional: if the bot is already in this guild, connect binds immediately
    // and registers its commands. Otherwise you get an invite URL.
    guildId: process.env.DISCORD_GUILD_ID,
    // Defaults to a single `/help` command when omitted.
    commands: ['/help', { name: 'ask', description: 'Ask a question' }],
  })

  if (result.type === 'oauth') {
    // Discord "install" is a bot invite — open this URL and pick a server.
    console.log('Invite the bot:', result.authorizationUrl)
  } else {
    console.log('Bound immediately:', result) // { type: 'immediate', installationId: '...' }
  }
  console.log('installations:', await discord.listInstallations())
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
