import {
  Events,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config, env, rankName } from '../config.js';
import { getLink } from '../db.js';
import { getGuildRoster } from '../blizzard.js';
import { describe, officerReject, officerVerify, resyncAll, resyncOne, unlink } from '../sync.js';
import { client } from './client.js';
import { applyRoles, type ApplyResult } from './roles.js';

const NO_RANK = -1;

export const commandDefinitions = [
  new SlashCommandBuilder().setName('link').setDescription('Get the link to connect your WoW: Forever character'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show which character is linked')
    .addUserOption((o) => o.setName('user').setDescription('Officers: check someone else')),

  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Officers: confirm a linked member and set their guild rank')
    .addUserOption((o) => o.setName('user').setDescription('Discord member').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('rank')
        .setDescription('Their in-game guild rank')
        .setRequired(true)
        .addChoices(
          ...config.ranks.map((r) => ({ name: `${r.rank} · ${r.name}`, value: r.rank })),
          { name: 'Member, no rank role', value: NO_RANK },
        ),
    ),

  new SlashCommandBuilder()
    .setName('reject')
    .setDescription('Officers: mark a linked user as not in the guild')
    .addUserOption((o) => o.setName('user').setDescription('Discord member').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Remove a character link and its guild roles')
    .addUserOption((o) => o.setName('user').setDescription('Officers: unlink someone else')),

  new SlashCommandBuilder()
    .setName('resync')
    .setDescription('Officers: re-check Blizzard and re-apply roles')
    .addUserOption((o) => o.setName('user').setDescription('Only this member (default: everyone)')),
].map((c) => c.toJSON());

function isOfficer(i: ChatInputCommandInteraction): boolean {
  const member = i.member;
  if (!(member instanceof GuildMember)) return false;
  return (
    member.permissions.has(PermissionFlagsBits.ManageRoles) ||
    config.discord.officerRoleIds.some((id) => member.roles.cache.has(id))
  );
}

function roleNote(r: ApplyResult): string {
  if (r.ok) return '';
  if (r.reason === 'not_in_server') return '\n_They are not in the server yet — roles apply when they join._';
  return `\n⚠️ Roles not updated: ${r.message}`;
}

async function handle(i: ChatInputCommandInteraction): Promise<void> {
  const reply = (content: string) =>
    i.deferred || i.replied
      ? i.editReply({ content, allowedMentions: { parse: [] } })
      : i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

  const officerOnly = async (): Promise<boolean> => {
    if (isOfficer(i)) return true;
    await reply('Only officers can use that.');
    return false;
  };

  switch (i.commandName) {
    case 'link': {
      const link = getLink(i.user.id);
      await reply(
        `Connect your Battle.net account here: ${env.baseUrl}\n` +
          (link ? `Currently linked: **${describe(link)}**` : 'You have no character linked yet.'),
      );
      return;
    }

    case 'status': {
      const target = i.options.getUser('user') ?? i.user;
      if (target.id !== i.user.id && !(await officerOnly())) return;
      const link = getLink(target.id);
      await reply(
        link
          ? `<@${target.id}> → **${describe(link)}**\nBattleTag: ${link.battletag ?? 'n/a'} · last checked ${link.last_checked_at}`
          : `<@${target.id}> has not linked a character.`,
      );
      return;
    }

    case 'verify': {
      if (!(await officerOnly())) return;
      const target = i.options.getUser('user', true);
      const rankOpt = i.options.getInteger('rank', true);
      const rank = rankOpt === NO_RANK ? null : rankOpt;
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const out = await officerVerify(target.id, rank, i.user.tag);
      await reply(
        out
          ? `Verified <@${target.id}> as **${rank === null ? 'member' : rankName(rank)}** (${out.link.character_name}).${roleNote(out.roles)}`
          : `<@${target.id}> hasn't linked a character yet. Send them to ${env.baseUrl}`,
      );
      return;
    }

    case 'reject': {
      if (!(await officerOnly())) return;
      const target = i.options.getUser('user', true);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const out = await officerReject(target.id, i.user.tag);
      await reply(out ? `Marked <@${target.id}> as not in the guild.${roleNote(out.roles)}` : `<@${target.id}> has no link.`);
      return;
    }

    case 'unlink': {
      const target = i.options.getUser('user') ?? i.user;
      if (target.id !== i.user.id && !(await officerOnly())) return;
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await reply((await unlink(target.id)) ? `Unlinked <@${target.id}> and removed guild roles.` : 'No link to remove.');
      return;
    }

    case 'resync': {
      if (!(await officerOnly())) return;
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const target = i.options.getUser('user');
      if (target) {
        const out = await resyncOne(target.id);
        await reply(out ? `**${describe(out.link)}**\n${out.detail}${roleNote(out.roles)}` : `<@${target.id}> has no link.`);
      } else {
        const r = await resyncAll();
        const roster = await getGuildRoster();
        await reply(
          `Checked ${r.checked} links, ${r.changed} changed.\n` +
            `Blizzard guild roster: ${roster.ok ? `✅ live (${roster.data.size} members)` : `❌ not available yet (HTTP ${roster.status}) — use /verify for ranks`}`,
        );
      }
      return;
    }
  }
}

export function registerHandlers(): void {
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand() || i.guildId !== config.discord.serverId) return;
    try {
      await handle(i);
    } catch (err) {
      console.error('[bot] command failed', err);
      const msg = 'Something went wrong. Check the bot logs.';
      if (i.deferred || i.replied) await i.editReply(msg).catch(() => undefined);
      else await i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  });

  // Someone linked on the website before joining the server: give them their roles on arrival.
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== config.discord.serverId) return;
    const link = getLink(member.id);
    if (link) await applyRoles(member.id, link);
  });
}
