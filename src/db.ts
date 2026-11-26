import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config.js';

fs.mkdirSync(path.dirname(path.resolve(env.databasePath)), { recursive: true });
const db = new Database(env.databasePath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    discord_id      TEXT PRIMARY KEY,
    discord_name    TEXT NOT NULL,
    bnet_id         TEXT NOT NULL,
    battletag       TEXT,
    character_id    INTEGER NOT NULL,
    character_name  TEXT NOT NULL,
    realm_slug      TEXT NOT NULL,
    realm_name      TEXT NOT NULL,
    class_name      TEXT,
    level           INTEGER,
    -- 'member' | 'not_member' | 'pending' (API could not tell yet)
    status          TEXT NOT NULL,
    rank            INTEGER,
    -- 'api' (Blizzard roster) | 'officer' (set by /verify) | NULL
    rank_source     TEXT,
    verified_by     TEXT,
    last_checked_at TEXT NOT NULL,
    linked_at       TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS links_character ON links (realm_slug, character_id);
`);

// Added for WoW: Forever, where characters are addressed by name-surname instead of realm/name.
const columns = (db.prepare('PRAGMA table_info(links)').all() as Array<{ name: string }>).map((c) => c.name);
if (!columns.includes('profile_path')) db.exec('ALTER TABLE links ADD COLUMN profile_path TEXT');

export type LinkStatus = 'member' | 'not_member' | 'pending';

export interface LinkRow {
  discord_id: string;
  discord_name: string;
  bnet_id: string;
  battletag: string | null;
  character_id: number;
  character_name: string;
  /** Blizzard API path of the character profile, e.g. /profile/wow/character/peyter-elder */
  profile_path: string | null;
  realm_slug: string;
  realm_name: string;
  class_name: string | null;
  level: number | null;
  status: LinkStatus;
  rank: number | null;
  rank_source: 'api' | 'officer' | null;
  verified_by: string | null;
  last_checked_at: string;
  linked_at: string;
}

const now = () => new Date().toISOString();

export function getLink(discordId: string): LinkRow | undefined {
  return db.prepare('SELECT * FROM links WHERE discord_id = ?').get(discordId) as LinkRow | undefined;
}

export function getLinkByCharacter(realmSlug: string, characterId: number): LinkRow | undefined {
  return db
    .prepare('SELECT * FROM links WHERE realm_slug = ? AND character_id = ?')
    .get(realmSlug, characterId) as LinkRow | undefined;
}

export function allLinks(): LinkRow[] {
  return db.prepare('SELECT * FROM links').all() as LinkRow[];
}

export function upsertLink(row: Omit<LinkRow, 'last_checked_at' | 'linked_at'>): void {
  db.prepare(
    `INSERT INTO links (discord_id, discord_name, bnet_id, battletag, character_id, character_name, profile_path, realm_slug,
        realm_name, class_name, level, status, rank, rank_source, verified_by, last_checked_at, linked_at)
     VALUES (@discord_id, @discord_name, @bnet_id, @battletag, @character_id, @character_name, @profile_path, @realm_slug,
        @realm_name, @class_name, @level, @status, @rank, @rank_source, @verified_by, @ts, @ts)
     ON CONFLICT (discord_id) DO UPDATE SET
        discord_name = excluded.discord_name, bnet_id = excluded.bnet_id, battletag = excluded.battletag,
        character_id = excluded.character_id, character_name = excluded.character_name,
        profile_path = excluded.profile_path,
        realm_slug = excluded.realm_slug, realm_name = excluded.realm_name, class_name = excluded.class_name,
        level = excluded.level, status = excluded.status, rank = excluded.rank,
        rank_source = excluded.rank_source, verified_by = excluded.verified_by,
        last_checked_at = excluded.last_checked_at, linked_at = excluded.linked_at`,
  ).run({ ...row, ts: now() });
}

export function updateMembership(
  discordId: string,
  fields: Pick<LinkRow, 'status' | 'rank' | 'rank_source' | 'verified_by'>,
): void {
  db.prepare(
    `UPDATE links SET status = @status, rank = @rank, rank_source = @rank_source, verified_by = @verified_by,
        last_checked_at = @ts WHERE discord_id = @discord_id`,
  ).run({ ...fields, discord_id: discordId, ts: now() });
}

export function touchChecked(discordId: string): void {
  db.prepare('UPDATE links SET last_checked_at = ? WHERE discord_id = ?').run(now(), discordId);
}

export function deleteLink(discordId: string): void {
  db.prepare('DELETE FROM links WHERE discord_id = ?').run(discordId);
}
