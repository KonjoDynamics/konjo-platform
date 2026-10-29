import http from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { createApp } from './app.js';
import { sqlStore } from './store-sql.js';

process.on('unhandledRejection', err => console.error('unhandledRejection', err && (err.stack || err.message || err)));
process.on('uncaughtException', err => console.error('uncaughtException', err && (err.stack || err.message || err)));

const e = process.env;
console.log('konjo-api starting', JSON.stringify({ node: process.version, sql: !!e.SQL_SERVER, keyvault: !!e.KEYVAULT_URI, auth: !!(e.AUTH_ISSUER && e.AUTH_AUDIENCE && e.AUTH_JWKS_URI) }));
const cfg = {
  allowedOrigins: (e.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  models: { quick: e.MODEL_QUICK || 'claude-haiku-4-5-20251001', default: e.MODEL_DEFAULT || 'claude-sonnet-5-5', complex: e.MODEL_COMPLEX || 'claude-opus-5-5' },
};

// Secrets come from Key Vault through the container's managed identity (cached 5 minutes).
const cred = new DefaultAzureCredential({ managedIdentityClientId: e.AZURE_CLIENT_ID });
const kv = e.KEYVAULT_URI ? new SecretClient(e.KEYVAULT_URI, cred) : null;
const cache = new Map();
async function getSecret(name) {
  const hit = cache.get(name); if (hit && hit.t > Date.now()) return hit.v;
  let v = null;
  try { v = kv ? (await kv.getSecret(name)).value : null } catch (err) { if (err.statusCode !== 404) console.error('keyvault', name, err.code || err.message) }
  cache.set(name, { v, t: Date.now() + (v ? 300000 : 15000) }); return v;
}

// Token check for Entra External ID. Until AUTH_* are set, protected routes answer 503 (health still works).
let verify = null;
if (e.AUTH_ISSUER && e.AUTH_AUDIENCE && e.AUTH_JWKS_URI) {
  const jwks = createRemoteJWKSet(new URL(e.AUTH_JWKS_URI));
  verify = async token => (await jwtVerify(token, jwks, { issuer: e.AUTH_ISSUER, audience: e.AUTH_AUDIENCE })).payload;
}

// The server starts listening immediately; the database connects in the background and retries.
// So /healthz answers even when SQL is unreachable, and the reason is written to the log.
let storeP = null, lastDbError = null;
function connectDb() {
  console.log('connecting to SQL', e.SQL_SERVER, e.SQL_DATABASE);
  storeP = sqlStore({ server: e.SQL_SERVER, database: e.SQL_DATABASE, clientId: e.AZURE_CLIENT_ID })
    .then(s => { lastDbError = null; console.log('SQL connected'); return s })
    .catch(err => { lastDbError = (err && (err.code || err.message)) || 'unknown'; console.error('SQL connect failed:', err && (err.stack || err.message || err)); storeP = null; throw err });
  storeP.catch(() => {});
  return storeP;
}
connectDb();
const store = new Proxy({}, { get: (_, m) => async (...a) => { const s = await (storeP || connectDb()); return s[m](...a) } });

const handler = createApp({ store, verify, getSecret, cfg });
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/readyz') { // is the database reachable? (no details leave the server)
    return Promise.resolve(storeP || connectDb()).then(
      () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') },
      () => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"ok":false,"database":"unreachable"}') });
  }
  return handler(req, res);
});
const port = +e.PORT || 8080;
server.listen(port, () => console.log(`konjo-api listening on ${port}; auth ${verify ? 'on' : 'NOT CONFIGURED'}`));
