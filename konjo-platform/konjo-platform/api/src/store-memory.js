// In-memory store with the same behavior as store-sql.js. Used by tests only.
import crypto from 'node:crypto';
const uid = () => crypto.randomUUID(), now = () => Date.now();
export function memoryStore() {
  const users = new Map(), teams = new Map(), members = new Map(), invites = new Map(), models = new Map(), usage = new Map();
  const uk = (t, m) => t + '|' + m;
  return {
    async upsertUser({ extId, email, name }) {
      let u = [...users.values()].find(x => x.ext_id === extId);
      if (!u) { u = { id: uid(), ext_id: extId, email, name, created_at: now() }; users.set(u.id, u) }
      else { u.email = email ?? u.email; u.name = name ?? u.name }
      return { id: u.id, email: u.email, name: u.name };
    },
    async getMembership(userId) {
      const m = members.get(userId); if (!m) return null; const t = teams.get(m.team_id);
      return { team_id: m.team_id, role: m.role, team_name: t.name, active: t.active, monthly_calls: t.monthly_calls, monthly_images: t.monthly_images };
    },
    async createTeam(userId, name) {
      if (members.has(userId)) throw new Error('already member');
      const id = uid(); teams.set(id, { id, name, active: true, monthly_calls: 300, monthly_images: 3000 });
      members.set(userId, { team_id: id, role: 'owner', joined_at: now() }); return id;
    },
    async createInvite(teamId, by) { const code = crypto.randomBytes(5).toString('hex').toUpperCase(); invites.set(code, { team_id: teamId, created_by: by, expires_at: now() + 7 * 864e5, used_by: null }); return code },
    async joinWithInvite(userId, code) {
      const i = invites.get(code); if (!i || i.used_by || i.expires_at <= now() || members.has(userId)) return null;
      i.used_by = userId; members.set(userId, { team_id: i.team_id, role: 'member', joined_at: now() }); return i.team_id;
    },
    async listMembers(teamId) { return [...members.entries()].filter(([, m]) => m.team_id === teamId).sort((a, b) => a[1].joined_at - b[1].joined_at).map(([id, m]) => ({ name: users.get(id).name, email: users.get(id).email, role: m.role })) },
    async listModels(teamId) { return [...models.values()].filter(m => m.team_id === teamId).sort((a, b) => b.updated_at - a.updated_at).map(m => ({ id: m.id, name: m.name, version: m.version, updated_at: m.updated_at, created_at: m.created_at, updated_by: users.get(m.updated_by)?.name })) },
    async getModel(teamId, id) { return models.get(teamId + '|' + id) || null },
    async putModel(teamId, id, { name, body, baseVersion, userId }) {
      const k = teamId + '|' + id, cur = models.get(k), t = now();
      if (!cur) { models.set(k, { team_id: teamId, id, name, body, version: 1, updated_by: userId, updated_at: t, created_at: t }); return { status: 'created', version: 1 } }
      if (baseVersion !== cur.version) return { status: 'conflict' };
      Object.assign(cur, { name, body, version: cur.version + 1, updated_by: userId, updated_at: t }); return { status: 'updated', version: cur.version };
    },
    async deleteModel(teamId, id) { models.delete(teamId + '|' + id) },
    async getUsage(teamId, month) { return usage.get(uk(teamId, month)) || { calls: 0, images: 0 } },
    async reserveUsage(teamId, month, images, callCap, imageCap) {
      const u = usage.get(uk(teamId, month)) || { calls: 0, images: 0 };
      if (u.calls >= callCap || u.images + images > imageCap) return false;
      usage.set(uk(teamId, month), { calls: u.calls + 1, images: u.images + images }); return true;
    },
    async releaseUsage(teamId, month, images) { const u = usage.get(uk(teamId, month)); if (u) { u.calls = Math.max(0, u.calls - 1); u.images = Math.max(0, u.images - images) } },
    async adminListTeams(month) { return [...teams.values()].map(t => ({ ...t, ...(usage.get(uk(t.id, month)) || { calls: 0, images: 0 }) })) },
    async adminUpdateTeam(id, patch) { Object.assign(teams.get(id) || {}, patch) },
  };
}
