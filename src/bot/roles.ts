import { DiscordAPIError, type GuildMember } from 'discord.js';
import { config } from '../config.js';
import type { LinkRow } from '../db.js';
import { getServer } from './client.js';

/** Every role this bot is allowed to add or remove. Roles outside this set are never touched. */
export function managedRoleIds(): Set<string> {
  const ids = new Set<string>(config.ranks.map((r) => r.roleId));
  if (config.discord.memberRoleId) ids.add(config.discord.memberRoleId);
  ids.delete('');
  return ids;
}

/** Roles a linked user should have, given their membership and rank. */
export function desiredRoleIds(link: LinkRow | null | undefined): Set<string> {
  const roles = new Set<string>();
  if (!link || link.status !== 'member') return roles;

  if (config.discord.memberRoleId) roles.add(config.discord.memberRoleId);
  if (link.rank === null) return roles;

  for (const r of config.ranks) {
    const match = config.rankRoleMode === 'cumulative' ? r.rank >= link.rank : r.rank === link.rank;
    if (match && r.roleId) roles.add(r.roleId);
  }
  return roles;
}

export type ApplyResult =
  | { ok: true; added: string[]; removed: string[] }
  | { ok: false; reason: 'not_in_server' | 'missing_permissions' | 'error'; message: string };

async function fetchMember(discordId: string): Promise<GuildMember | null> {
  const server = await getServer();
  try {
    return await server.members.fetch(discordId);
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === 10007) return null; // Unknown Member
    throw err;
  }
}

/** Brings a Discord member's managed roles in line with their link. Pass null to strip all managed roles. */
export async function applyRoles(discordId: string, link: LinkRow | null): Promise<ApplyResult> {
  try {
    const member = await fetchMember(discordId);
    if (!member) return { ok: false, reason: 'not_in_server', message: 'User is not in the Discord server.' };

    const managed = managedRoleIds();
    const desired = desiredRoleIds(link);
    const keepWhenNotMember = link?.status === 'not_member' && !config.sync.removeRolesWhenNotInGuild;

    const add = [...desired].filter((id) => !member.roles.cache.has(id));
    const remove = keepWhenNotMember
      ? []
      : [...member.roles.cache.keys()].filter((id) => managed.has(id) && !desired.has(id));

    if (add.length) await member.roles.add(add, 'Guild sync');
    if (remove.length) await member.roles.remove(remove, 'Guild sync');

    if (config.discord.setNickname && link?.status === 'member' && member.manageable) {
      if (member.nickname !== link.character_name) {
        await member.setNickname(link.character_name, 'Guild sync').catch(() => undefined);
      }
    }
    return { ok: true, added: add, removed: remove };
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === 50013) {
      return {
        ok: false,
        reason: 'missing_permissions',
        message: "The bot needs Manage Roles, and its role must sit above every role it hands out.",
      };
    }
    return { ok: false, reason: 'error', message: (err as Error).message };
  }
}
