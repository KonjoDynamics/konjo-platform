// Konjo API: accounts via Entra tokens, teams, shared warehouse models, Claude proxy.
// Plain node:http with no web framework, so there is little to patch. createApp() takes everything
// external as arguments, so tests run with no Azure and no network.
import crypto from 'node:crypto';

const MAX_IMAGES = 20, MAX_PHOTO = 8 * 1024 * 1024, MAX_UPLOAD = 25 * 1024 * 1024, MAX_JSON = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const monthKey = () => new Date().toISOString().slice(0, 7);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

function extractJson(text) {
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < i) return null;
  try { return JSON.parse(s.slice(i, j + 1)) } catch { return null }
}
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y) };

async function readBody(req, limit) {
  if (+req.headers['content-length'] > limit) throw fail(413, 'too_big', 'Request is too large.');
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw fail(413, 'too_big', 'Request is too large.'); chunks.push(c) }
  return Buffer.concat(chunks);
}
async function readJson(req, limit = 1024 * 1024) {
  const b = await readBody(req, limit); if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')) } catch { throw fail(400, 'bad_json', 'Body is not valid JSON.') }
}
async function readForm(req) { // node's built-in multipart parser
  const b = await readBody(req, MAX_UPLOAD);
  try { return await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body: b }).formData() }
  catch { throw fail(400, 'bad_form', 'Send multipart/form-data with fields prompt, tier and image files.') }
}

/** @param {{store:any, verify:((token:string)=>Promise<any>)|null, getSecret:(n:string)=>Promise<string|null>, cfg:any, fetchImpl?:typeof fetch}} d */
export function createApp({ store, verify, getSecret, cfg, fetchImpl = fetch }) {
  const allowed = new Set(cfg.allowedOrigins || []);
  const send = (res, status, obj) => { res.writeHead(status, { ...res.getHeaders(), 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) };

  async function admin(req, res, route) {
    const want = await getSecret('admin-token'), got = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!want || !got || !safeEq(got, want)) throw fail(401, 'admin_only', 'Admin token required.');
    if (route === 'GET /admin/teams') return send(res, 200, { teams: await store.adminListTeams(monthKey()) });
    if (route === 'POST /admin/team') {
      const b = await readJson(req), patch = {};
      if (typeof b.active === 'boolean') patch.active = b.active;
      if (Number.isInteger(b.monthly_calls) && b.monthly_calls >= 0) patch.monthly_calls = b.monthly_calls;
      if (Number.isInteger(b.monthly_images) && b.monthly_images >= 0) patch.monthly_images = b.monthly_images;
      if (!b.id || !Object.keys(patch).length) throw fail(400, 'bad_request', 'Send {id, active?, monthly_calls?, monthly_images?}.');
      await store.adminUpdateTeam(b.id, patch); return send(res, 200, { ok: true });
    }
    throw fail(404, 'not_found', 'Unknown route.');
  }

  async function user(req, res, path) {
    if (!verify) throw fail(503, 'auth_not_configured', 'Sign-in is not set up on the server yet.');
    const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!tok) throw fail(401, 'signed_out', 'Sign in first.');
    let c; try { c = await verify(tok) } catch { throw fail(401, 'bad_token', 'Your sign-in has expired. Sign in again.') }
    const extId = c.oid || c.sub; if (!extId) throw fail(401, 'bad_token', 'Token has no user id.');
    const u = await store.upsertUser({ extId, email: c.email || c.preferred_username || (Array.isArray(c.emails) ? c.emails[0] : null) || null, name: c.name || null });
    const mem = await store.getMembership(u.id), M = req.method;
    const needTeam = () => { if (!mem) throw fail(403, 'no_team', 'Create a team or join one with an invite code first.') };

    if (path === '/v1/me' && M === 'GET') {
      if (!mem) return send(res, 200, { user: { id: u.id, name: u.name, email: u.email }, team: null });
      const us = await store.getUsage(mem.team_id, monthKey());
      return send(res, 200, { user: { id: u.id, name: u.name, email: u.email, role: mem.role },
        team: { id: mem.team_id, name: mem.team_name, active: !!mem.active, members: await store.listMembers(mem.team_id) },
        usage: { month: monthKey(), calls: us.calls, images: us.images, callLimit: mem.monthly_calls, imageLimit: mem.monthly_images } });
    }
    if (path === '/v1/teams' && M === 'POST') {
      if (mem) throw fail(409, 'has_team', 'You are already on a team.');
      const name = String((await readJson(req)).name || '').trim().slice(0, 80);
      if (!name) throw fail(400, 'bad_name', 'Enter a company name.');
      return send(res, 201, { teamId: await store.createTeam(u.id, name) });
    }
    if (path === '/v1/teams/join' && M === 'POST') {
      if (mem) throw fail(409, 'has_team', 'You are already on a team.');
      const teamId = await store.joinWithInvite(u.id, String((await readJson(req)).code || '').trim().toUpperCase());
      if (!teamId) throw fail(400, 'bad_invite', 'That invite code is invalid, expired or already used.');
      return send(res, 200, { teamId });
    }
    if (path === '/v1/team/invites' && M === 'POST') {
      needTeam(); if (mem.role !== 'owner') throw fail(403, 'owner_only', 'Only a team owner can invite people.');
      return send(res, 200, { code: await store.createInvite(mem.team_id, u.id), expiresInDays: 7 });
    }
    if (path === '/v1/models' && M === 'GET') { needTeam(); return send(res, 200, { models: await store.listModels(mem.team_id) }) }
    const mm = path.match(/^\/v1\/models\/([^/]+)$/);
    if (mm) {
      needTeam(); const id = mm[1], T = mem.team_id;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw fail(400, 'bad_id', 'Model ids use letters, digits, - and _.');
      if (M === 'GET') {
        const m = await store.getModel(T, id); if (!m) throw fail(404, 'not_found', 'No such warehouse.');
        return send(res, 200, { id, name: m.name, version: m.version, updated_at: m.updated_at, model: JSON.parse(m.body) });
      }
      if (M === 'DELETE') { await store.deleteModel(T, id); return send(res, 200, { ok: true }) }
      if (M === 'PUT') {
        const b = await readJson(req, MAX_JSON);
        if (!b.model || typeof b.model !== 'object') throw fail(400, 'bad_model', 'Send {name, model, baseVersion}.');
        const r = await store.putModel(T, id, { name: String(b.name || 'Untitled').slice(0, 120), body: JSON.stringify(b.model), baseVersion: b.baseVersion, userId: u.id });
        if (r.status === 'conflict') throw fail(409, 'conflict', 'A teammate saved a newer version. Reload it before saving.');
        return send(res, r.status === 'created' ? 201 : 200, { id, version: r.version });
      }
    }
    if (path === '/v1/claude' && M === 'POST') { needTeam(); return claude(req, res, mem) }
    throw fail(404, 'not_found', 'Unknown route.');
  }

  async function claude(req, res, m) {
    if (!m.active) throw fail(403, 'team_disabled', 'This team is switched off. Contact Konjo Consulting.');
    const key = await getSecret('anthropic-api-key'); if (!key) throw fail(503, 'not_configured', 'The server has no Claude key yet.');
    const fd = await readForm(req);
    const prompt = String(fd.get('prompt') || ''); if (!prompt) throw fail(400, 'bad_prompt', 'Prompt missing.');
    const files = fd.getAll('image').filter(f => typeof f === 'object');
    if (files.length > MAX_IMAGES) throw fail(400, 'too_many', `At most ${MAX_IMAGES} photos per call.`);
    if (files.some(f => !TYPES.includes(f.type))) throw fail(400, 'bad_image', 'Photos must be JPEG, PNG, WebP or GIF.');
    if (files.some(f => f.size > MAX_PHOTO)) throw fail(413, 'too_big', 'A photo is over 8 MB.');
    const tier = ['quick', 'default', 'complex'].includes(fd.get('tier')) ? fd.get('tier') : 'default';
    const model = cfg.models[tier], mk = monthKey();
    if (!await store.reserveUsage(m.team_id, mk, files.length, m.monthly_calls, m.monthly_images))
      throw fail(429, 'quota', 'This team has used its Claude allowance for the month. Contact Konjo Consulting to raise it.');
    let out, ok = false;
    try {
      const content = [];
      for (const f of files) content.push({ type: 'image', source: { type: 'base64', media_type: f.type, data: Buffer.from(await f.arrayBuffer()).toString('base64') } });
      content.push({ type: 'text', text: prompt });
      const r = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(170000),
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: 'user', content }] }) });
      out = await r.json().catch(() => null); ok = r.ok && !!out;
    } catch { ok = false }
    if (!ok) { await store.releaseUsage(m.team_id, mk, files.length); throw fail(502, 'upstream', (out && out.error && out.error.message) || 'Claude did not answer. Your allowance was not used.') }
    const text = (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return send(res, 200, { text, json: extractJson(text), model, truncated: out.stop_reason === 'max_tokens' });
  }

  return async function handler(req, res) {
    const o = req.headers.origin;
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    if (o && allowed.has(o)) {
      res.setHeader('access-control-allow-origin', o); res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization,content-type'); res.setHeader('access-control-allow-methods', 'GET,PUT,POST,DELETE,OPTIONS'); res.setHeader('access-control-max-age', '600');
    }
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
      const path = new URL(req.url, 'http://x').pathname, route = req.method + ' ' + path;
      if (route === 'GET /healthz') return send(res, 200, { ok: true });
      if (path.startsWith('/admin/')) return await admin(req, res, route);
      if (path.startsWith('/v1/')) return await user(req, res, path);
      throw fail(404, 'not_found', 'Unknown route.');
    } catch (e) {
      if (!e.status) console.error('unhandled', e);
      if (res.headersSent) return res.end();
      send(res, e.status || 500, { error: { code: e.status ? e.code : 'server', message: e.status ? e.message : 'Something went wrong on the server.' } });
    }
  };
}
