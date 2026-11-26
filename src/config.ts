import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

export interface RankMapping {
  /** In-game rank index. 0 = Guild Master, 1 = next rank down, and so on. */
  rank: number;
  /** Label shown on the website and in Discord messages. */
  name: string;
  /** Discord role granted for this rank. */
  roleId: string;
}

export interface AppConfig {
  guild: { name: string; realmSlug: string; region: string };
  blizzard: { profileNamespace: string; locale: string; onlyRealms: string[] };
  discord: {
    serverId: string;
    memberRoleId: string;
    officerRoleIds: string[];
    logChannelId: string;
    setNickname: boolean;
  };
  ranks: RankMapping[];
  /** "exact": only the role for your rank. "cumulative": your rank's role plus every lower rank's role. */
  rankRoleMode: 'exact' | 'cumulative';
  sync: { intervalMinutes: number; removeRolesWhenNotInGuild: boolean };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

export const env = {
  baseUrl: (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  port: Number(process.env.PORT ?? 3000),
  sessionSecret: requireEnv('SESSION_SECRET'),
  discordClientId: requireEnv('DISCORD_CLIENT_ID'),
  discordClientSecret: requireEnv('DISCORD_CLIENT_SECRET'),
  discordBotToken: requireEnv('DISCORD_BOT_TOKEN'),
  bnetClientId: requireEnv('BNET_CLIENT_ID'),
  bnetClientSecret: requireEnv('BNET_CLIENT_SECRET'),
  databasePath: process.env.DATABASE_PATH ?? './data/guild-sync.db',
  configPath: process.env.CONFIG_PATH ?? './config.json',
};

function loadConfig(): AppConfig {
  const file = path.resolve(env.configPath);
  if (!fs.existsSync(file)) {
    throw new Error(`Config file not found at ${file}. Copy config.example.json to config.json and fill it in.`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as AppConfig;

  raw.guild.region = raw.guild.region.toLowerCase();
  raw.guild.realmSlug = (raw.guild.realmSlug ?? '').toLowerCase();
  raw.blizzard.profileNamespace ||= `profile-forever-${raw.guild.region}`;
  raw.blizzard.locale ||= 'en_US';
  raw.blizzard.onlyRealms = (raw.blizzard.onlyRealms ?? []).map((r) => r.toLowerCase());
  raw.discord.officerRoleIds ??= [];
  raw.rankRoleMode ??= 'exact';
  raw.sync ??= { intervalMinutes: 360, removeRolesWhenNotInGuild: true };

  const seen = new Set<number>();
  for (const r of raw.ranks) {
    if (!Number.isInteger(r.rank) || r.rank < 0 || r.rank > 9) {
      throw new Error(`config.ranks: rank must be an integer 0-9 (got ${r.rank})`);
    }
    if (seen.has(r.rank)) throw new Error(`config.ranks: rank ${r.rank} is listed twice`);
    seen.add(r.rank);
  }
  raw.ranks.sort((a, b) => a.rank - b.rank);
  return raw;
}

export const config = loadConfig();

export function rankName(rank: number | null | undefined): string {
  if (rank === null || rank === undefined) return 'Unknown rank';
  return config.ranks.find((r) => r.rank === rank)?.name ?? `Rank ${rank}`;
}

/** Guild names become slugs the same way Blizzard builds them: lowercase, spaces to hyphens. */
export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/['’]/g, '').replace(/\s+/g, '-');
}
