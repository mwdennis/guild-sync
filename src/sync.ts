import { checkMembership, getGuildRoster, type Character, type MembershipResult } from './blizzard.js';
import { config, rankName } from './config.js';
import {
  allLinks,
  deleteLink,
  getLink,
  getLinkByCharacter,
  touchChecked,
  updateMembership,
  upsertLink,
  type LinkRow,
} from './db.js';
import { logToChannel } from './bot/client.js';
import { applyRoles, type ApplyResult } from './bot/roles.js';

type Membership = Pick<LinkRow, 'status' | 'rank' | 'rank_source' | 'verified_by'>;

/**
 * Combines a fresh Blizzard result with what we already know.
 * - A definitive Blizzard answer (roster, or a profile showing another guild) always wins.
 * - "In guild, rank unknown" keeps an officer-set rank if there is one.
 * - "Blizzard can't tell" keeps the previous state, so an API outage never strips roles.
 */
function merge(existing: LinkRow | undefined, result: MembershipResult): Membership {
  if (result.authoritative) {
    return {
      status: result.status,
      rank: result.rank,
      rank_source: result.status === 'member' ? 'api' : null,
      verified_by: null,
    };
  }
  if (result.status === 'member') {
    const officerRank = existing?.rank_source === 'officer' ? existing.rank : null;
    return {
      status: 'member',
      rank: officerRank,
      rank_source: officerRank === null ? null : 'officer',
      verified_by: officerRank === null ? null : existing!.verified_by,
    };
  }
  if (existing && existing.status !== 'pending') {
    return { status: existing.status, rank: existing.rank, rank_source: existing.rank_source, verified_by: existing.verified_by };
  }
  return { status: 'pending', rank: null, rank_source: null, verified_by: null };
}

export function describe(link: LinkRow): string {
  const who = link.realm_name ? `${link.character_name}-${link.realm_name}` : link.character_name;
  switch (link.status) {
    case 'member':
      return link.rank === null
        ? `${who}: guild member, rank awaiting officer confirmation`
        : `${who}: ${rankName(link.rank)}${link.rank_source === 'officer' ? ' (officer-verified)' : ''}`;
    case 'not_member':
      return `${who}: not in ${config.guild.name}`;
    default:
      return `${who}: pending verification`;
  }
}

export interface LinkOutcome {
  link: LinkRow;
  detail: string;
  roles: ApplyResult;
}

/** Called by the website after the user picks a character. */
export async function linkCharacter(input: {
  discordId: string;
  discordName: string;
  bnetId: string;
  battletag: string | null;
  character: Character;
}): Promise<LinkOutcome> {
  const { character: c } = input;

  // A character can belong to one Discord account. Battle.net ownership was just proven, so move it.
  const previousOwner = getLinkByCharacter(c.realmSlug, c.id);
  if (previousOwner && previousOwner.discord_id !== input.discordId) {
    deleteLink(previousOwner.discord_id);
    await applyRoles(previousOwner.discord_id, null);
    await logToChannel(`🔁 ${c.displayName} moved from <@${previousOwner.discord_id}> to <@${input.discordId}>.`);
  }

  const existing = getLink(input.discordId);
  const sameCharacter = existing?.character_id === c.id && existing.realm_slug === c.realmSlug;
  const result = await checkMembership(c);
  const membership = merge(sameCharacter ? existing : undefined, result);

  upsertLink({
    discord_id: input.discordId,
    discord_name: input.discordName,
    bnet_id: input.bnetId,
    battletag: input.battletag,
    character_id: c.id,
    character_name: c.displayName,
    profile_path: c.profilePath,
    realm_slug: c.realmSlug,
    realm_name: c.realmName,
    class_name: c.className,
    level: c.level,
    ...membership,
  });
  const link = getLink(input.discordId)!;
  const roles = await applyRoles(input.discordId, link);

  await logToChannel(
    `🔗 <@${input.discordId}> linked **${describe(link)}**` +
      (link.status === 'pending' ? ' — officers can confirm with `/verify`.' : ''),
  );
  return { link, detail: result.detail, roles };
}

/** Officer override from Discord. rank = null means "in the guild, no rank role". */
export async function officerVerify(discordId: string, rank: number | null, officer: string): Promise<LinkOutcome | null> {
  const existing = getLink(discordId);
  if (!existing) return null;
  updateMembership(discordId, { status: 'member', rank, rank_source: rank === null ? null : 'officer', verified_by: officer });
  const link = getLink(discordId)!;
  const roles = await applyRoles(discordId, link);
  await logToChannel(`✅ ${officer} verified <@${discordId}> as **${describe(link)}**.`);
  return { link, detail: 'Verified by an officer.', roles };
}

export async function officerReject(discordId: string, officer: string): Promise<LinkOutcome | null> {
  const existing = getLink(discordId);
  if (!existing) return null;
  updateMembership(discordId, { status: 'not_member', rank: null, rank_source: null, verified_by: officer });
  const link = getLink(discordId)!;
  const roles = await applyRoles(discordId, link);
  await logToChannel(`⛔ ${officer} marked <@${discordId}> as not in the guild.`);
  return { link, detail: 'Marked not in guild by an officer.', roles };
}

export async function unlink(discordId: string): Promise<boolean> {
  const existing = getLink(discordId);
  if (!existing) return false;
  deleteLink(discordId);
  await applyRoles(discordId, null);
  await logToChannel(`🔓 <@${discordId}> unlinked ${existing.character_name}.`);
  return true;
}

/** Re-checks one linked user against Blizzard and re-applies roles. */
export async function resyncOne(discordId: string): Promise<LinkOutcome | null> {
  const existing = getLink(discordId);
  if (!existing) return null;
  const profilePath =
    existing.profile_path ??
    `/profile/wow/character/${existing.realm_slug}/${encodeURIComponent(existing.character_name.toLowerCase())}`;
  const result = await checkMembership({ id: existing.character_id, profilePath });
  const membership = merge(existing, result);
  updateMembership(discordId, membership);
  const link = getLink(discordId)!;

  if (existing.status !== link.status || existing.rank !== link.rank) {
    await logToChannel(`🔄 <@${discordId}> changed: ${describe(existing)} → ${describe(link)}`);
  }
  const roles = await applyRoles(discordId, link);
  return { link, detail: result.detail, roles };
}

let running = false;

export async function resyncAll(): Promise<{ checked: number; changed: number; rosterLive: boolean }> {
  if (running) return { checked: 0, changed: 0, rosterLive: false };
  running = true;
  try {
    const roster = await getGuildRoster(true);
    let changed = 0;
    const links = allLinks();
    for (const before of links) {
      const outcome = await resyncOne(before.discord_id).catch((err) => {
        console.warn(`[sync] ${before.discord_id}:`, (err as Error).message);
        touchChecked(before.discord_id);
        return null;
      });
      if (outcome && (outcome.link.status !== before.status || outcome.link.rank !== before.rank)) changed++;
      await new Promise((r) => setTimeout(r, 250)); // stay well under Discord + Blizzard rate limits
    }
    console.log(`[sync] Checked ${links.length}, changed ${changed}, roster ${roster.ok ? 'live' : `unavailable (${roster.status})`}`);
    return { checked: links.length, changed, rosterLive: roster.ok };
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  const minutes = Math.max(15, config.sync.intervalMinutes);
  setInterval(() => void resyncAll().catch((e) => console.error('[sync]', e)), minutes * 60_000);
  console.log(`[sync] Full resync every ${minutes} minutes`);
}
