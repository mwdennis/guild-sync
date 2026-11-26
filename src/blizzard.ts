import { config, env, slugify } from './config.js';
import type { LinkStatus } from './db.js';

const OAUTH_HOST = 'https://oauth.battle.net';
const apiHost = () => `https://${config.guild.region}.api.blizzard.com`;
const ns = () => config.blizzard.profileNamespace;

export const BNET_REDIRECT_URI = () => `${env.baseUrl}/auth/bnet/callback`;

// ---------- OAuth (user) ----------

export function bnetAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.bnetClientId,
    redirect_uri: BNET_REDIRECT_URI(),
    response_type: 'code',
    scope: 'openid wow.profile',
    state,
  });
  return `${OAUTH_HOST}/authorize?${params}`;
}

function basicAuth(): string {
  return 'Basic ' + Buffer.from(`${env.bnetClientId}:${env.bnetClientSecret}`).toString('base64');
}

export async function exchangeBnetCode(code: string): Promise<string> {
  const res = await fetch(`${OAUTH_HOST}/token`, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: BNET_REDIRECT_URI() }),
  });
  if (!res.ok) throw new Error(`Battle.net token exchange failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

export async function getBnetUser(userToken: string): Promise<{ id: string; battletag: string | null }> {
  const res = await fetch(`${OAUTH_HOST}/userinfo`, { headers: { Authorization: `Bearer ${userToken}` } });
  if (!res.ok) throw new Error(`Battle.net userinfo failed: ${res.status}`);
  const body = (await res.json()) as { id: number | string; sub?: string; battletag?: string };
  return { id: String(body.id ?? body.sub), battletag: body.battletag ?? null };
}

// ---------- OAuth (app / client credentials) ----------

let appToken: { token: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string> {
  if (appToken && appToken.expiresAt > Date.now() + 60_000) return appToken.token;
  const res = await fetch(`${OAUTH_HOST}/token`, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Battle.net client-credentials token failed: ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  appToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return appToken.token;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number };

async function apiGet<T>(pathname: string, token: string): Promise<ApiResult<T>> {
  const url = new URL(apiHost() + pathname);
  url.searchParams.set('namespace', ns());
  url.searchParams.set('locale', config.blizzard.locale);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 0 };
  }
}


// ---------- Account characters ----------
//
// WoW: Forever identifies characters by first name + surname rather than by realm. A character
// from /profile/user/wow looks like:
//   { name: "Peyter", surname: "Elder", id: 2615288, level: 14,
//     character: { href: ".../profile/wow/character/peyter-elder?namespace=profile-forever-us" },
//     protected_character: { href: ".../protected-character/6934-2615288?..." }, ... }
// There is no `realm` object; the number before the dash in protected_character is a realm id.
// Retail-style characters (with `realm`) are still handled.

export interface Character {
  id: number;
  name: string;
  surname: string;
  /** "Peyter Elder" (Forever) or "Peyter" (retail-style). */
  displayName: string;
  /** API path of the character profile, e.g. /profile/wow/character/peyter-elder */
  profilePath: string;
  /** Realm slug if Blizzard sent one, otherwise the realm id from protected_character, otherwise "forever". */
  realmSlug: string;
  /** Human-readable realm name, or '' when Forever doesn't give one. */
  realmName: string;
  level: number;
  className: string;
  raceName: string;
  faction: string;
}

type Named = { name?: string | Record<string, string>; slug?: string; id?: number } | undefined;
type Link = { href?: string } | undefined;

interface RawCharacter {
  id?: number;
  name?: string;
  surname?: string;
  level?: number;
  realm?: Named;
  playable_class?: Named;
  playable_race?: Named;
  faction?: Named;
  character?: Link & RawCharacter;
  protected_character?: Link;
}

interface AccountProfile {
  wow_accounts?: Array<{ characters?: RawCharacter[] }>;
}

/** Blizzard returns localized names as a string (with ?locale=) or as { en_US: "...", ... } without it. */
function nameOf(n: Named): string {
  if (!n?.name) return '';
  return typeof n.name === 'string' ? n.name : (n.name[config.blizzard.locale] ?? Object.values(n.name)[0] ?? '');
}

/** "https://us.api.blizzard.com/profile/wow/character/peyter-elder?namespace=…" → "/profile/wow/character/peyter-elder" */
function pathOf(href: string | undefined): string {
  if (!href) return '';
  try {
    return new URL(href).pathname;
  } catch {
    return '';
  }
}

function lower(s: string): string {
  return encodeURIComponent(s.toLowerCase());
}

/** Turns one raw Blizzard character into our Character, or null if it can't be used. */
export function parseCharacter(raw: RawCharacter): Character | null {
  // Older/other responses may nest the summary inside `character`; Forever puts only an href there.
  const c: RawCharacter = raw.character?.name ? raw.character : raw;
  if (!c.id || !c.name) return null;

  const surname = c.surname ?? raw.surname ?? '';
  const realmFromProtected = /protected-character\/(\d+)-\d+/.exec(raw.protected_character?.href ?? '')?.[1];
  const realmSlug = c.realm?.slug || (nameOf(c.realm) ? slugify(nameOf(c.realm)) : '') || realmFromProtected || 'forever';

  const profilePath =
    pathOf(raw.character?.href) ||
    (surname
      ? `/profile/wow/character/${lower(`${c.name}-${surname}`)}`
      : `/profile/wow/character/${realmSlug}/${lower(c.name)}`);

  return {
    id: c.id,
    name: c.name,
    surname,
    displayName: surname ? `${c.name} ${surname}` : c.name,
    profilePath,
    realmSlug,
    realmName: nameOf(c.realm),
    level: c.level ?? 0,
    className: nameOf(c.playable_class),
    raceName: nameOf(c.playable_race),
    faction: nameOf(c.faction),
  };
}

let loggedShape = false;

const onGuildRealm = (c: { realmSlug: string }) => !!config.guild.realmSlug && c.realmSlug === config.guild.realmSlug;

/** Lists every WoW: Forever character on the signed-in Battle.net account. */
export async function getAccountCharacters(userToken: string): Promise<Character[]> {
  const res = await apiGet<AccountProfile>('/profile/user/wow', userToken);
  if (!res.ok) {
    // 404 here means the account has no characters in this namespace.
    if (res.status === 404) return [];
    throw new Error(`Could not load characters from Battle.net (HTTP ${res.status}).`);
  }
  const chars: Character[] = [];
  const skipped: RawCharacter[] = [];
  for (const account of res.data.wow_accounts ?? []) {
    for (const raw of account.characters ?? []) {
      const parsed = parseCharacter(raw);
      if (parsed) chars.push(parsed);
      else skipped.push(raw);
    }
  }

  // Log the real response shape (no tokens) so format changes are easy to diagnose.
  if (skipped.length || !loggedShape || process.env.DEBUG_BNET) {
    loggedShape = true;
    const sample = res.data.wow_accounts?.[0]?.characters?.[0];
    console.log(
      `[bnet] ${chars.length} characters parsed, ${skipped.length} skipped. Sample character from Blizzard:`,
      JSON.stringify(skipped[0] ?? sample ?? res.data).slice(0, 1500),
    );
  }
  const only = config.blizzard.onlyRealms;
  const filtered = only.length ? chars.filter((c) => only.includes(c.realmSlug)) : chars;
  // Characters on the guild's realm first (when one is configured), then highest level.
  return filtered.sort(
    (a, b) => Number(onGuildRealm(b)) - Number(onGuildRealm(a)) || b.level - a.level || a.name.localeCompare(b.name),
  );
}

// ---------- Guild roster (rank source) ----------

interface RosterResponse {
  members?: Array<{ character: { id: number }; rank: number }>;
}

/**
 * Where the roster lives. Forever drops realms from character URLs, so guilds probably follow suit.
 * Until Blizzard confirms, we try (in order): a guild URL learned from a member's character profile,
 * then /data/wow/guild/{realm}/{guild} if a realm is configured, then /data/wow/guild/{guild}.
 */
let discoveredGuildPath: string | null = null;

function rosterCandidates(): string[] {
  const guild = lower(slugify(config.guild.name));
  const paths: string[] = [];
  if (discoveredGuildPath) paths.push(discoveredGuildPath);
  if (config.guild.realmSlug) paths.push(`/data/wow/guild/${config.guild.realmSlug}/${guild}`);
  paths.push(`/data/wow/guild/${guild}`);
  return [...new Set(paths)].map((p) => `${p}/roster`);
}

let rosterCache: { at: number; result: ApiResult<Map<number, number>> } | null = null;
const ROSTER_TTL_MS = 5 * 60_000;

/** Map of character id → rank index, or a failure if Blizzard isn't serving the roster yet. */
export async function getGuildRoster(force = false): Promise<ApiResult<Map<number, number>>> {
  if (!force && rosterCache && Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache.result;
  const token = await getAppToken();
  let result: ApiResult<Map<number, number>> = { ok: false, status: 0 };
  for (const path of rosterCandidates()) {
    const res = await apiGet<RosterResponse>(path, token);
    if (res.ok) {
      result = { ok: true, data: new Map((res.data.members ?? []).map((m) => [m.character.id, m.rank])) };
      break;
    }
    result = res;
  }
  rosterCache = { at: Date.now(), result };
  return result;
}

// ---------- Character profile (membership fallback) ----------

interface CharacterGuild {
  name: string;
  key?: { href?: string };
  realm?: { slug?: string };
}

async function getCharacterGuild(profilePath: string): Promise<ApiResult<CharacterGuild | null>> {
  const token = await getAppToken();
  const res = await apiGet<{ guild?: CharacterGuild }>(profilePath, token);
  return res.ok ? { ok: true, data: res.data.guild ?? null } : res;
}

// ---------- Membership check ----------

export interface MembershipResult {
  status: LinkStatus;
  rank: number | null;
  /** True when Blizzard gave a definitive answer we should trust over any officer override. */
  authoritative: boolean;
  detail: string;
}

/**
 * 1. Guild roster  → membership + rank (authoritative).
 * 2. Character profile → membership only; rank left for an officer to confirm.
 * 3. Neither endpoint live → pending; an officer can /verify manually.
 */
export async function checkMembership(c: { id: number; profilePath: string }): Promise<MembershipResult> {
  const roster = await getGuildRoster();
  if (roster.ok) {
    const rank = roster.data.get(c.id);
    return rank === undefined
      ? { status: 'not_member', rank: null, authoritative: true, detail: 'Not on the guild roster.' }
      : { status: 'member', rank, authoritative: true, detail: 'Found on the guild roster.' };
  }

  const profile = await getCharacterGuild(c.profilePath);
  if (profile.ok) {
    const g = profile.data;
    const sameName = !!g && slugify(g.name) === slugify(config.guild.name);
    const realmOk = !g?.realm?.slug || !config.guild.realmSlug || g.realm.slug === config.guild.realmSlug;
    const inGuild = sameName && realmOk;

    // Learn the guild's real API address from a member's profile and try the roster there right away.
    const guildPath = pathOf(g?.key?.href);
    if (inGuild && guildPath && guildPath !== discoveredGuildPath) {
      discoveredGuildPath = guildPath;
      console.log(`[bnet] Learned guild API path: ${guildPath}`);
      const retry = await getGuildRoster(true);
      if (retry.ok) return checkMembership(c);
    }

    return inGuild
      ? { status: 'member', rank: null, authoritative: false, detail: 'In the guild; rank awaiting officer confirmation.' }
      : { status: 'not_member', rank: null, authoritative: true, detail: 'Character profile shows a different guild or none.' };
  }

  return {
    status: 'pending',
    rank: null,
    authoritative: false,
    detail: `Blizzard isn't serving guild data for Forever yet (roster HTTP ${roster.status}, character HTTP ${profile.status}). An officer can verify you in Discord.`,
  };
}
