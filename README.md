# WoW: Forever Guild Sync

A small website and Discord bot, running as one process. Guild members:

1. sign in with **Discord** (so we know who gets the roles),
2. sign in with **Battle.net** (scope `wow.profile`), which lists their WoW: Forever characters,
3. pick a character. The bot checks guild membership and rank, then gives them the Discord roles you mapped in `config.json`.

A full re-sync runs on a schedule, so promotions, demotions and people leaving the guild are picked up automatically.

## Blizzard API status for Forever (read this first)

As of launch week (Nov 2026), community testing shows:

| What | Endpoint | Status |
|---|---|---|
| Your own characters | `/profile/user/wow` · `profile-forever-{region}` | ✅ works with a user token |
| Game data | `static-forever-{region}` | ✅ works |
| Single character profile (gives guild) | `/profile/wow/character/{name}-{surname}` | ❌ 404 so far |
| Guild roster (gives rank) | `/data/wow/guild/{realm}/{guild}/roster` | ❌ not confirmed yet |

Blizzard hasn't documented the Forever namespace officially, so it's set in `config.json` (`blizzard.profileNamespace`). If they publish a different name, change that value and restart.

The bot handles this in three tiers, picking the best one that answers:

1. **Guild roster live** → membership and rank come from Blizzard. This is authoritative and overrides officer edits.
2. **Only the character profile is live** → membership is confirmed and the member role is granted. Rank waits for an officer.
3. **Neither is live** → the link is saved as *pending*. An officer runs `/verify @user rank:` in Discord.

Nothing needs to change when Blizzard turns the endpoints on: the next sync picks them up. To check, run `npm run probe` (or `docker compose exec guild-sync node dist/probe.js`). Pass a Forever character as `-- name-surname` (e.g. `-- peyter-elder`) to also test that character's profile and see which guild it reports.

If Blizzard has a brief outage, members keep their roles. Only a definitive "not in guild" answer removes roles.

## Setup

### 1. Discord application

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. **OAuth2** → add redirect `https://YOUR-SITE/auth/discord/callback`. Copy the **Client ID** and **Client Secret**.
3. **Bot** → **Reset Token**, and copy it. Turn on **Server Members Intent**.
4. Invite the bot with this URL (replace the client ID):
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=402653184`
   (This grants Manage Roles and Manage Nicknames.)
5. **Server Settings → Roles**: drag the bot's role **above** every rank role it will hand out. Discord won't let a bot assign roles above its own.

### 2. Battle.net client

1. Go to <https://develop.battle.net/access/clients> and create a client.
2. Redirect URL: `https://YOUR-SITE/auth/bnet/callback`
3. Copy the **Client ID** and **Client Secret**.

### 3. Configure

```bash
cp .env.example .env               # secrets and URLs
cp config.example.json config.json # guild, rank → role mapping
```

To get Discord IDs, turn on **User Settings → Advanced → Developer Mode**, then right-click a server, role or channel and choose **Copy ID**.

`config.json` fields:

| Key | Meaning |
|---|---|
| `guild.name`, `guild.region` | Your in-game guild name, spelled exactly as in game, and region (`us`/`eu`). |
| `guild.realmSlug` | Leave as `""` for Forever. Forever characters are identified by first name + surname (`peyter-elder`), not by realm. The guild's real API address is learned automatically from the first member whose profile Blizzard serves. Only fill this in if Blizzard later confirms guilds use a realm. |
| `blizzard.profileNamespace` | `profile-forever-us` (or `-eu`). Change it if Blizzard renames it. |
| `blizzard.onlyRealms` | Optional list of realm slugs to show in the character picker. Empty means all Forever realms. |
| `discord.serverId` | Your Discord server ID. |
| `discord.memberRoleId` | Role every verified guild member gets, whatever their rank. |
| `discord.officerRoleIds` | Roles allowed to use `/verify`, `/reject`, `/resync`. Anyone with Manage Roles can too. |
| `discord.logChannelId` | Optional channel for link, verify and rank-change messages. |
| `discord.setNickname` | Set the member's server nickname to their character name. |
| `ranks[]` | In-game rank index → Discord role. **0 = Guild Master**, 1 = the next rank down, and so on (up to 9). Unlisted ranks get only the member role. |
| `rankRoleMode` | `exact`: only your rank's role. `cumulative`: your rank's role plus every lower rank's role (an Officer also gets Raider, Member, and so on). |
| `sync.intervalMinutes` | How often to re-check everyone (minimum 15). |
| `sync.removeRolesWhenNotInGuild` | Remove roles from people Blizzard says have left. |

The bot only ever adds or removes the roles listed in `ranks` and `memberRoleId`. Every other role is left alone.

### 4. Run

Docker (recommended):

```bash
docker compose up -d --build
docker compose logs -f
```

Without Docker (Node 20+):

```bash
npm install
npm run build
npm start
```

Slash commands register on your server automatically at startup. Restart after editing `ranks` so `/verify` shows the new choices.

**HTTPS:** Battle.net requires HTTPS redirect URLs (except `localhost`). Put Caddy, nginx or a Cloudflare Tunnel in front of port 3000, and set `BASE_URL` to the public `https://` address.

## Discord commands

| Command | Who | What |
|---|---|---|
| `/link` | Everyone | Shows the website link and your current status. |
| `/status [user]` | Everyone (officers for others) | Shows the linked character and rank. |
| `/unlink [user]` | Everyone (officers for others) | Removes the link and the guild roles. |
| `/verify user rank` | Officers | Confirms membership and sets the rank. This is how ranks are set until Blizzard's roster is live. |
| `/reject user` | Officers | Marks someone as not in the guild and removes their roles. |
| `/resync [user]` | Officers | Re-checks Blizzard now. With no user, re-checks everyone and reports whether the roster endpoint is live. |

## How it fits together

```
src/
  index.ts           starts the bot, web server and scheduler
  config.ts          .env + config.json loading
  db.ts              SQLite: one row per Discord user ↔ character
  blizzard.ts        Battle.net OAuth, character list, roster/profile lookups
  sync.ts            membership merge rules, link/verify/unlink, scheduled resync
  bot/client.ts      discord.js client + log channel
  bot/roles.ts       works out and applies the Discord roles
  bot/commands.ts    slash commands, auto-apply on server join
  web/server.ts      Express routes + OAuth flows
  web/views.ts       HTML pages
  probe.ts           checks which Forever endpoints are live
```

## Privacy and security

- Battle.net tokens are used once, during sign-in, and then discarded. Scheduled checks use the app's own credentials.
- Stored per user: Discord ID and name, Battle.net account ID and BattleTag, and the chosen character's name, realm, class, level, membership and rank.
- Members can see only their own Battle.net characters, so nobody can claim someone else's character. If the same Battle.net owner links a character from a second Discord account, the link moves to the new account and the old account loses its roles.
- OAuth `state` checks and CSRF tokens protect the sign-in and form flows. Session cookies are signed and `httpOnly`.
