import { config, rankName } from '../config.js';
import type { Character } from '../blizzard.js';
import type { LinkRow } from '../db.js';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CLASS_COLORS: Record<string, string> = {
  'Death Knight': '#C41E3A', 'Demon Hunter': '#A330C9', Druid: '#FF7C0A', Evoker: '#33937F', Hunter: '#AAD372',
  Mage: '#3FC7EB', Monk: '#00FF98', Paladin: '#F48CBA', Priest: '#FFFFFF', Rogue: '#FFF468', Shaman: '#0070DD',
  Warlock: '#8788EE', Warrior: '#C69B6D',
};

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(config.guild.name)}</title>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --line:#2a2f3a; --text:#e8e6e1; --muted:#9aa0ab; --gold:#e3b04b; --ok:#4cc38a; --warn:#e3a33b; --bad:#e5534b; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 680px; margin: 0 auto; padding: 40px 16px 64px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; color: var(--gold); letter-spacing: .01em; }
  .sub { color: var(--muted); margin: 0 0 28px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .step { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
  .step b { display:block; }
  .muted { color: var(--muted); font-size: .92rem; }
  .btn { display:inline-block; border:0; border-radius:8px; padding:10px 16px; font:600 15px system-ui, sans-serif; cursor:pointer; text-decoration:none; color:#fff; }
  .btn-discord { background:#5865F2; } .btn-bnet { background:#148EFF; } .btn-gold { background:var(--gold); color:#1a1408; }
  .btn-ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
  .done { color: var(--ok); font-weight: 600; }
  .chars { display:grid; gap:10px; }
  .char { display:flex; align-items:center; gap:12px; padding:12px 14px; border:1px solid var(--line); border-radius:10px; cursor:pointer; }
  .char:hover { border-color: var(--gold); }
  .char input { accent-color: var(--gold); width:18px; height:18px; }
  .char .name { font-weight:700; }
  .tag { font-size:.75rem; padding:2px 8px; border-radius:99px; border:1px solid var(--line); color:var(--muted); margin-left:auto; white-space:nowrap; }
  .tag.home { color: var(--gold); border-color: var(--gold); }
  .status { font-weight:700; } .s-member { color:var(--ok); } .s-pending { color:var(--warn); } .s-not_member { color:var(--bad); }
  .row { display:flex; gap:10px; flex-wrap:wrap; margin-top:16px; }
  .alert { border-left: 3px solid var(--warn); padding: 10px 14px; background: #221d12; border-radius: 6px; margin-bottom: 16px; }
  form { margin: 0; }
</style>
</head>
<body><main>
<h1>${esc(config.guild.name)}</h1>
<p class="sub">Link your WoW: Forever character to get your guild roles on Discord.</p>
${body}
</main></body></html>`;
}

export function statusLine(link: LinkRow): string {
  const label =
    link.status === 'member'
      ? link.rank === null
        ? 'Guild member · rank awaiting officer confirmation'
        : rankName(link.rank)
      : link.status === 'pending'
        ? 'Pending verification'
        : `Not in ${config.guild.name}`;
  return `<span class="status s-${link.status}">${esc(label)}</span>`;
}

export function homePage(opts: {
  discordName?: string;
  link?: LinkRow;
  csrf: string;
  error?: string;
}): string {
  const { discordName, link, csrf, error } = opts;
  const discordStep = discordName
    ? `<div class="step"><div><b>1. Discord</b><span class="muted">Signed in as ${esc(discordName)}</span></div><span class="done">✓</span></div>`
    : `<div class="step"><div><b>1. Sign in with Discord</b><span class="muted">So we know which Discord account gets the roles.</span></div><a class="btn btn-discord" href="/auth/discord">Sign in with Discord</a></div>`;

  const bnetStep = `<div class="step"><div><b>2. Connect Battle.net</b><span class="muted">We read your Forever character list. We never see your password.</span></div>${
    discordName ? `<a class="btn btn-bnet" href="/auth/bnet">${link ? 'Change character' : 'Connect Battle.net'}</a>` : `<span class="muted">Sign in with Discord first</span>`
  }</div>`;

  const current = link
    ? `<div class="card"><b>Linked character</b>
        <p style="margin:6px 0 0"><span class="name" style="color:${CLASS_COLORS[link.class_name ?? ''] ?? 'inherit'};font-weight:700">${esc(link.character_name)}</span>
        <span class="muted">${link.realm_name ? `· ${esc(link.realm_name)} ` : ''}· level ${esc(link.level)} ${esc(link.class_name)}</span></p>
        <p style="margin:6px 0 0">${statusLine(link)}</p>
        ${link.status === 'pending' ? `<p class="muted">Blizzard isn't sharing Forever guild data yet. An officer will confirm your rank in Discord.</p>` : ''}
        <div class="row">
          <form method="post" action="/unlink"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn btn-ghost">Unlink</button></form>
          <a class="btn btn-ghost" href="/logout">Sign out</a>
        </div></div>`
    : '';

  return layout(
    'Link your character',
    `${error ? `<div class="alert">${esc(error)}</div>` : ''}
     ${current}
     <div class="card">${discordStep}</div>
     <div class="card">${bnetStep}</div>`,
  );
}

const home = (c: Character) => !!config.guild.realmSlug && c.realmSlug === config.guild.realmSlug;

export function charactersPage(chars: Character[], csrf: string): string {
  if (!chars.length) {
    return layout(
      'No characters',
      `<div class="card"><b>No WoW: Forever characters found</b>
       <p class="muted">This Battle.net account has no characters on Forever realms yet, or Blizzard hasn't published them. New characters can take a little while to appear — log out of the game fully, wait a few minutes, then try again.</p>
       <div class="row"><a class="btn btn-bnet" href="/auth/bnet">Try again</a><a class="btn btn-ghost" href="/">Back</a></div></div>`,
    );
  }
  const items = chars
    .map(
      (c, i) => `<label class="char">
        <input type="radio" name="character" value="${esc(`${c.realmSlug}:${c.id}`)}" ${i === 0 ? 'checked' : ''}>
        <span><span class="name" style="color:${CLASS_COLORS[c.className] ?? 'inherit'}">${esc(c.displayName)}</span>
        <span class="muted">${c.realmName ? ` · ${esc(c.realmName)}` : ''} · ${esc(c.level)} ${esc(c.raceName)} ${esc(c.className)}</span></span>
        ${home(c) ? `<span class="tag home">Guild realm</span>` : c.faction ? `<span class="tag">${esc(c.faction)}</span>` : ''}
      </label>`,
    )
    .join('');
  return layout(
    'Choose a character',
    `<form method="post" action="/characters" class="card">
       <b>Choose the character to link</b>
       <p class="muted">Pick your main in ${esc(config.guild.name)}. Your Discord roles follow this character's guild rank.</p>
       <div class="chars">${items}</div>
       <input type="hidden" name="csrf" value="${esc(csrf)}">
       <div class="row"><button class="btn btn-gold">Link character</button><a class="btn btn-ghost" href="/">Cancel</a></div>
     </form>`,
  );
}

export function resultPage(link: LinkRow, detail: string, roleWarning?: string): string {
  return layout(
    'Linked',
    `<div class="card"><b>${esc(link.character_name)} is linked</b>
      <p style="margin:6px 0">${statusLine(link)}</p>
      <p class="muted">${esc(detail)}</p>
      ${roleWarning ? `<div class="alert">${esc(roleWarning)}</div>` : ''}
      <div class="row"><a class="btn btn-gold" href="/">Done</a></div></div>`,
  );
}
