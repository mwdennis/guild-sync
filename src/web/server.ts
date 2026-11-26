import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import cookieSession from 'cookie-session';
import { env } from '../config.js';
import { bnetAuthorizeUrl, exchangeBnetCode, getAccountCharacters, getBnetUser, type Character } from '../blizzard.js';
import { getLink } from '../db.js';
import { linkCharacter, unlink } from '../sync.js';
import { charactersPage, homePage, resultPage } from './views.js';

interface Session {
  csrf?: string;
  state?: string;
  discordId?: string;
  discordName?: string;
  pickToken?: string;
  error?: string;
}

/** Character lists from Battle.net, held server-side for 15 minutes while the user picks one. */
const pending = new Map<string, { at: number; bnetId: string; battletag: string | null; characters: Character[] }>();
const PICK_TTL_MS = 15 * 60_000;
setInterval(() => {
  for (const [k, v] of pending) if (Date.now() - v.at > PICK_TTL_MS) pending.delete(k);
}, 60_000).unref();

const rand = () => crypto.randomBytes(24).toString('hex');
const DISCORD_REDIRECT_URI = () => `${env.baseUrl}/auth/discord/callback`;

function sess(req: Request): Session {
  const s = req.session as Session;
  s.csrf ||= rand();
  return s;
}

function checkCsrf(req: Request): boolean {
  const expected = Buffer.from((req.session as Session).csrf ?? '');
  const given = Buffer.from(typeof req.body?.csrf === 'string' ? req.body.csrf : '');
  return expected.length > 0 && expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function fail(req: Request, res: Response, message: string): void {
  sess(req).error = message;
  res.redirect('/');
}

export function createServer(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));
  app.use(
    cookieSession({
      name: 'gs',
      secret: env.sessionSecret,
      maxAge: 7 * 24 * 3600_000,
      sameSite: 'lax',
      httpOnly: true,
      secure: env.baseUrl.startsWith('https://'),
    }),
  );

  app.get('/healthz', (_req, res) => res.send('ok'));

  app.get('/', (req, res) => {
    const s = sess(req);
    const error = s.error;
    delete s.error;
    res.send(homePage({ discordName: s.discordName, link: s.discordId ? getLink(s.discordId) : undefined, csrf: s.csrf!, error }));
  });

  // ---- Discord OAuth (identify only) ----
  app.get('/auth/discord', (req, res) => {
    const s = sess(req);
    const state = (s.state = rand());
    const params = new URLSearchParams({
      client_id: env.discordClientId,
      redirect_uri: DISCORD_REDIRECT_URI(),
      response_type: 'code',
      scope: 'identify',
      state,
      prompt: 'none',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get('/auth/discord/callback', async (req, res) => {
    const s = sess(req);
    const { code, state } = req.query as Record<string, string | undefined>;
    if (!code || !state || state !== s.state) return fail(req, res, 'Discord sign-in was cancelled or expired. Please try again.');
    delete s.state;
    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.discordClientId,
          client_secret: env.discordClientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: DISCORD_REDIRECT_URI(),
        }),
      });
      if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
      const { access_token } = (await tokenRes.json()) as { access_token: string };
      const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
      if (!meRes.ok) throw new Error(`users/@me ${meRes.status}`);
      const me = (await meRes.json()) as { id: string; username: string; global_name?: string | null };
      s.discordId = me.id;
      s.discordName = me.global_name || me.username;
      res.redirect('/');
    } catch (err) {
      console.error('[web] Discord OAuth failed', err);
      fail(req, res, 'Could not sign in with Discord. Please try again.');
    }
  });

  // ---- Battle.net OAuth (openid + wow.profile) ----
  app.get('/auth/bnet', (req, res) => {
    const s = sess(req);
    if (!s.discordId) return res.redirect('/');
    const state = (s.state = rand());
    res.redirect(bnetAuthorizeUrl(state));
  });

  app.get('/auth/bnet/callback', async (req, res) => {
    const s = sess(req);
    const { code, state } = req.query as Record<string, string | undefined>;
    if (!s.discordId) return res.redirect('/');
    if (!code || !state || state !== s.state) return fail(req, res, 'Battle.net sign-in was cancelled or expired. Please try again.');
    delete s.state;
    try {
      // The user token is used right here and then discarded; nothing is stored.
      const token = await exchangeBnetCode(code);
      const [user, characters] = await Promise.all([getBnetUser(token), getAccountCharacters(token)]);
      const pickToken = rand();
      pending.set(pickToken, { at: Date.now(), bnetId: user.id, battletag: user.battletag, characters });
      s.pickToken = pickToken;
      res.redirect('/characters');
    } catch (err) {
      console.error('[web] Battle.net OAuth failed', err);
      fail(req, res, (err as Error).message.startsWith('Could not') ? (err as Error).message : 'Could not connect to Battle.net. Please try again.');
    }
  });

  // ---- Character picker ----
  app.get('/characters', (req, res) => {
    const s = sess(req);
    const p = s.pickToken ? pending.get(s.pickToken) : undefined;
    if (!s.discordId || !p) return res.redirect('/');
    res.send(charactersPage(p.characters, s.csrf!));
  });

  app.post('/characters', async (req, res) => {
    const s = sess(req);
    const p = s.pickToken ? pending.get(s.pickToken) : undefined;
    if (!s.discordId || !p) return res.redirect('/');
    if (!checkCsrf(req)) return fail(req, res, 'Your session expired. Please try again.');

    // Only characters Battle.net returned for this account can be chosen.
    const choice = p.characters.find((c) => `${c.realmSlug}:${c.id}` === req.body.character);
    if (!choice) return fail(req, res, 'Please choose one of your characters.');

    try {
      const out = await linkCharacter({
        discordId: s.discordId,
        discordName: s.discordName ?? s.discordId,
        bnetId: p.bnetId,
        battletag: p.battletag,
        character: choice,
      });
      pending.delete(s.pickToken!);
      delete s.pickToken;
      const warning = out.roles.ok
        ? undefined
        : out.roles.reason === 'not_in_server'
          ? "You're not in our Discord server yet. Join it and your roles will be applied automatically."
          : 'Your link is saved, but the bot could not update your roles. Please let an officer know.';
      res.send(resultPage(out.link, out.detail, warning));
    } catch (err) {
      console.error('[web] link failed', err);
      fail(req, res, 'Something went wrong while linking. Please try again.');
    }
  });

  app.post('/unlink', async (req, res) => {
    const s = sess(req);
    if (!s.discordId || !checkCsrf(req)) return res.redirect('/');
    await unlink(s.discordId).catch((e) => console.error('[web] unlink failed', e));
    res.redirect('/');
  });

  app.get('/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
  });

  return app;
}
