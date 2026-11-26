import { config, env } from './config.js';
import { client, startBot } from './bot/client.js';
import { commandDefinitions, registerHandlers } from './bot/commands.js';
import { resyncAll, startScheduler } from './sync.js';
import { createServer } from './web/server.js';

registerHandlers();
await startBot();

// Register slash commands on the configured server (instant; refreshes /verify rank choices from config.json).
await client.application!.commands.set(commandDefinitions, config.discord.serverId);
console.log(`[bot] Registered ${commandDefinitions.length} slash commands`);

createServer().listen(env.port, () => console.log(`[web] Listening on :${env.port} (${env.baseUrl})`));

startScheduler();
void resyncAll().catch((e) => console.error('[sync] initial resync failed', e));

const shutdown = () => {
  console.log('Shutting down');
  void client.destroy().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
