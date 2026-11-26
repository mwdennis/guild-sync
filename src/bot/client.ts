import { Client, Events, GatewayIntentBits, type Guild, type TextChannel } from 'discord.js';
import { config, env } from '../config.js';

export const client = new Client({
  // GuildMembers is a privileged intent: enable "Server Members Intent" in the Developer Portal.
  // It lets the bot apply roles automatically when a linked user joins the server later.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

let readyResolve: () => void;
export const ready = new Promise<void>((r) => (readyResolve = r));

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
  readyResolve();
});

export async function startBot(): Promise<void> {
  await client.login(env.discordBotToken);
  await ready;
}

export async function getServer(): Promise<Guild> {
  await ready;
  return client.guilds.fetch(config.discord.serverId);
}

export async function logToChannel(message: string): Promise<void> {
  if (!config.discord.logChannelId) return;
  try {
    const channel = await client.channels.fetch(config.discord.logChannelId);
    if (channel?.isTextBased()) await (channel as TextChannel).send({ content: message, allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn('[bot] Could not post to log channel:', (err as Error).message);
  }
}
