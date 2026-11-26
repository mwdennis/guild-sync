/**
 * Checks which Blizzard endpoints answer for WoW: Forever, using your app credentials.
 *   npm run probe                      → guild + roster lookups
 *   npm run probe -- <name-surname>   → also a single Forever character, e.g. peyter-elder
 *   npm run probe -- --roster         → also list every member with the rank number Blizzard reports
 * Run it every so often after launch; when the roster shows ✅, ranks sync automatically.
 */
import { config, env, slugify } from './config.js';

const region = config.guild.region;
const host = `https://${region}.api.blizzard.com`;

const tokenRes = await fetch('https://oauth.battle.net/token', {
  method: 'POST',
  headers: {
    Authorization: 'Basic ' + Buffer.from(`${env.bnetClientId}:${env.bnetClientSecret}`).toString('base64'),
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ grant_type: 'client_credentials' }),
});
if (!tokenRes.ok) {
  console.error('Could not get a Battle.net app token:', tokenRes.status, await tokenRes.text());
  process.exit(1);
}
const { access_token } = (await tokenRes.json()) as { access_token: string };

async function probe(label: string, path: string, namespace: string, summarize?: (j: any) => string) {
  const url = `${host}${path}?namespace=${namespace}&locale=${config.blizzard.locale}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  let note = '';
  if (res.ok && summarize) note = ' — ' + summarize(await res.json());
  console.log(`${res.ok ? '✅' : '❌'} ${res.status}  ${label}  [${namespace}]${note}`);
}

const profileNs = config.blizzard.profileNamespace;
const guildSlug = encodeURIComponent(slugify(config.guild.name));

// Forever addresses characters as name-surname with no realm; guilds may follow the same pattern.
const guildPaths = [
  ...(config.guild.realmSlug ? [`/data/wow/guild/${config.guild.realmSlug}/${guildSlug}`] : []),
  `/data/wow/guild/${guildSlug}`,
];
const showRoster = process.argv.includes('--roster');
const args = process.argv.slice(2).filter((x) => x !== '--roster');

let rosterLines = '';
for (const p of guildPaths) {
  rosterLines = '';
  await probe(`Guild "${config.guild.name}"`, p, profileNs, (j) => `${j.member_count ?? '?'} members`);
  await probe('Guild roster', `${p}/roster`, profileNs, (j) => {
    const members: any[] = j.members ?? [];
    if (showRoster) {
      // What Blizzard currently reports. Ranks: 0 = Guild Master, counting down the in-game rank list.
      const rows = members
        .map((m) => ({
          rank: m.rank as number,
          name: [m.character?.name, m.character?.surname].filter(Boolean).join(' '),
          label: config.ranks.find((r) => r.rank === m.rank)?.name ?? '(no role mapped)',
        }))
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
      rosterLines = rows.map((r) => `   ${r.rank}  ${r.label.padEnd(18)} ${r.name}`).join('\n');
    }
    return `${members.length} members`;
  });
  if (rosterLines) console.log(rosterLines);
}

// npm run probe -- peyter-elder        (Forever: name-surname)
// npm run probe -- dreamscythe peyter  (retail-style: realm then name)
const [a, b] = args;
if (a) {
  const path = b
    ? `/profile/wow/character/${a.toLowerCase()}/${encodeURIComponent(b.toLowerCase())}`
    : `/profile/wow/character/${encodeURIComponent(a.toLowerCase())}`;
  await probe(`Character ${b ? `${b}-${a}` : a}`, path, profileNs, (j) =>
    j.guild ? `guild: ${j.guild.name}${j.guild.key?.href ? ` (${new URL(j.guild.key.href).pathname})` : ''}` : 'no guild',
  );
}
