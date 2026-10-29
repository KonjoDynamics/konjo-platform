import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { memoryStore } from '../src/store-memory.js';

const secrets = { 'anthropic-api-key': 'sk-test', 'admin-token': 'adm' };
const sent = [];
let upstream = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok\n```json\n{"observations":[1]}\n```' }], stop_reason: 'end_turn' }), { status: 200 });
const fetchImpl = async (u, o) => { sent.push(JSON.parse(o.body)); return upstream() };
const store = memoryStore();
const verify = async t => { if (!t.startsWith('good:')) throw new Error('bad'); const [, oid, name] = t.split(':'); return { oid, name, email: oid + '@x.com' } };
const cfg = { allowedOrigins: ['https://designer.konjod365.com'], models: { quick: 'q', default: 'd', complex: 'c' } };
const mk = v => http.createServer(createApp({ store, verify: v, getSecret: async n => secrets[n] || null, cfg, fetchImpl }));
const srv = mk(verify), noAuth = mk(null);
await new Promise(r => srv.listen(0, r)); await new Promise(r => noAuth.listen(0, r));
test.after(() => { srv.close(); noAuth.close() });
const call = async (s, path, { method = 'GET', body, tok, headers = {}, form } = {}) => {
  const h = { ...headers }; if (tok) h.authorization = 'Bearer ' + tok;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${s.address().port}${path}`, { method, headers: h, body: form || (body ? JSON.stringify(body) : undefined) });
  return { s: r.status, j: await r.json().catch(() => null), h: r.headers };
};
const A = 'good:ann:Ann', B = 'good:bob:Bob', E = 'good:eve:Eve';
const form = (n, o = {}) => { const f = new FormData(); f.set('prompt', o.prompt ?? 'read'); for (let i = 0; i < n; i++) f.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: o.type || 'image/jpeg' }), i + '.jpg'); return f };

test('health works with no sign-in', async () => assert.equal((await call(srv, '/healthz')).s, 200));
test('before sign-in is configured, user routes answer 503', async () => assert.equal((await call(noAuth, '/v1/me', { tok: A })).s, 503));
test('no token / bad token refused', async () => {
  assert.equal((await call(srv, '/v1/me')).s, 401);
  assert.equal((await call(srv, '/v1/me', { tok: 'nope' })).s, 401);
});
test('new user has no team and cannot use team routes', async () => {
  const me = await call(srv, '/v1/me', { tok: A }); assert.equal(me.s, 200); assert.equal(me.j.team, null);
  assert.equal((await call(srv, '/v1/models', { tok: A })).s, 403);
});
test('team flow: create, invite, join, shared warehouses, isolation', async () => {
  assert.equal((await call(srv, '/v1/teams', { method: 'POST', tok: A, body: { name: '  ' } })).s, 400);
  assert.equal((await call(srv, '/v1/teams', { method: 'POST', tok: A, body: { name: 'Acme Foods' } })).s, 201);
  assert.equal((await call(srv, '/v1/teams', { method: 'POST', tok: A, body: { name: 'Again' } })).s, 409);
  const inv = await call(srv, '/v1/team/invites', { method: 'POST', tok: A }); assert.equal(inv.j.code.length, 10);
  assert.equal((await call(srv, '/v1/teams/join', { method: 'POST', tok: B, body: { code: 'WRONG' } })).s, 400);
  assert.equal((await call(srv, '/v1/teams/join', { method: 'POST', tok: B, body: { code: inv.j.code.toLowerCase() } })).s, 200);
  assert.equal((await call(srv, '/v1/teams/join', { method: 'POST', tok: E, body: { code: inv.j.code } })).s, 400, 'code is single use');
  assert.equal((await call(srv, '/v1/team/invites', { method: 'POST', tok: B })).s, 403, 'members cannot invite');
  const me = await call(srv, '/v1/me', { tok: B }); assert.equal(me.j.team.members.length, 2); assert.equal(me.j.team.name, 'Acme Foods');

  assert.equal((await call(srv, '/v1/models/wh1', { method: 'PUT', tok: A, body: { name: 'Denver', model: { els: [1] } } })).s, 201);
  const got = await call(srv, '/v1/models/wh1', { tok: B }); assert.deepEqual(got.j.model, { els: [1] });
  assert.equal((await call(srv, '/v1/models', { tok: B })).j.models[0].updated_by, 'Ann');
  assert.equal((await call(srv, '/v1/models/wh1', { method: 'PUT', tok: B, body: { name: 'Denver', model: { els: [1, 2] }, baseVersion: 1 } })).j.version, 2);
  assert.equal((await call(srv, '/v1/models/wh1', { method: 'PUT', tok: A, body: { name: 'x', model: {}, baseVersion: 1 } })).s, 409, 'stale save refused');
  assert.equal((await call(srv, '/v1/models/bad.id', { tok: A })).s, 400);

  await call(srv, '/v1/teams', { method: 'POST', tok: E, body: { name: 'Other Co' } });
  assert.equal((await call(srv, '/v1/models/wh1', { tok: E })).s, 404);
  assert.equal((await call(srv, '/v1/models', { tok: E })).j.models.length, 0);
  await call(srv, '/v1/models/wh1', { method: 'DELETE', tok: E });
  assert.equal((await call(srv, '/v1/models/wh1', { tok: A })).s, 200, 'other company cannot delete it');
});
test('Claude proxy: parsed json, images forwarded, right model', async () => {
  const r = await call(srv, '/v1/claude', { method: 'POST', tok: A, form: form(3) });
  assert.equal(r.s, 200); assert.equal(r.j.json.observations[0], 1);
  const b = sent.at(-1); assert.equal(b.model, 'd'); assert.equal(b.messages[0].content.length, 4);
});
test('Claude proxy: validation', async () => {
  assert.equal((await call(srv, '/v1/claude', { method: 'POST', tok: A, form: form(21) })).s, 400);
  assert.equal((await call(srv, '/v1/claude', { method: 'POST', tok: A, form: form(1, { type: 'image/heic' }) })).s, 400);
  assert.equal((await call(srv, '/v1/claude', { method: 'POST', tok: A, form: form(1, { prompt: '' }) })).s, 400);
  assert.equal((await call(srv, '/v1/claude', { method: 'POST', tok: A, body: { prompt: 'x' } })).s, 400, 'JSON instead of multipart');
  const before = sent.length; await call(srv, '/v1/claude', { method: 'POST', tok: A, form: form(1, { type: 'image/heic' }) });
  assert.equal(sent.length, before, 'rejected requests never reach Claude');
});
test('invalid requests do not use the monthly allowance', async () => {
  const u0 = (await call(srv, '/v1/me', { tok: A })).j.usage.calls;
  await call(srv, '/v1/claude', { method: 'POST', tok: A, form: form(21) });
  assert.equal((await call(srv, '/v1/me', { tok: A })).j.usage.calls, u0);
});
test('upstream failure returns 502 and gives the allowance back', async () => {
  const u0 = (await call(srv, '/v1/me', { tok: A })).j.usage; upstream = () => new Response('{"error":{"message":"overloaded"}}', { status: 529 });
  const r = await call(srv, '/v1/claude', { method: 'POST', tok: A, form: form(2) });
  upstream = () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"observations":[]}' }] }), { status: 200 });
  assert.equal(r.s, 502); const u1 = (await call(srv, '/v1/me', { tok: A })).j.usage;
  assert.deepEqual([u1.calls, u1.images], [u0.calls, u0.images]);
});
test('admin: token required, caps enforced, switch-off enforced', async () => {
  assert.equal((await call(srv, '/admin/teams')).s, 401);
  assert.equal((await call(srv, '/admin/teams', { tok: 'wrong' })).s, 401);
  const teams = (await call(srv, '/admin/teams', { tok: 'adm' })).j.teams, acme = teams.find(t => t.name === 'Acme Foods');
  const used = (await call(srv, '/v1/me', { tok: A })).j.usage.calls;
  await call(srv, '/admin/team', { method: 'POST', tok: 'adm', body: { id: acme.id, monthly_calls: used + 1 } });
  assert.equal((await call(srv, '/v1/claude', { method: 'POST', tok: A, form: form(1) })).s, 200);
  assert.equal((await call(srv, '/v1/claude', { method: 'POST', tok: B, form: form(1) })).s, 429, 'cap is per team, shared by both users');
  await call(srv, '/admin/team', { method: 'POST', tok: 'adm', body: { id: acme.id, monthly_calls: 999, active: false } });
  assert.equal((await call(srv, '/v1/claude', { method: 'POST', tok: A, form: form(1) })).s, 403);
  assert.equal((await call(srv, '/admin/team', { method: 'POST', tok: 'adm', body: { id: acme.id } })).s, 400);
});
test('CORS: only the designer origin is allowed', async () => {
  const ok = await call(srv, '/healthz', { headers: { origin: 'https://designer.konjod365.com' } });
  assert.equal(ok.h.get('access-control-allow-origin'), 'https://designer.konjod365.com');
  assert.equal((await call(srv, '/healthz', { headers: { origin: 'https://evil.test' } })).h.get('access-control-allow-origin'), null);
  assert.equal((await call(srv, '/v1/me', { method: 'OPTIONS', headers: { origin: 'https://designer.konjod365.com' } })).s, 204);
});
test('errors never leak internals', async () => {
  const r = await call(srv, '/v1/nothing', { tok: A }); assert.equal(r.s, 404); assert.equal(r.j.error.code, 'not_found');
});
