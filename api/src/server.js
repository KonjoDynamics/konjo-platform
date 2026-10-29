import { createRemoteJWKSet, jwtVerify } from 'jose';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { createApp } from './app.js';
import http from 'node:http';
import { sqlStore } from './store-sql.js';

const e = process.env;
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

const store = await sqlStore({ server: e.SQL_SERVER, database: e.SQL_DATABASE, clientId: e.AZURE_CLIENT_ID });
const handler = createApp({ store, verify, getSecret, cfg });
const port = +e.PORT || 8080;
http.createServer(handler).listen(port, () => console.log(`konjo-api listening on ${port}; auth ${verify ? 'on' : 'NOT CONFIGURED'}`));
