// Azure SQL store. Same interface as store-memory.js. Every query is parameterized.
// NOTE: written without access to a SQL Server; exercised first in the dev environment.
import sql from 'mssql';
import crypto from 'node:crypto';

export async function sqlStore({ server, database, clientId }) {
  const pool = await new sql.ConnectionPool({
    server, database, options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-default', options: clientId ? { clientId } : {} },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }, connectionTimeout: 60000, requestTimeout: 30000,
  }).connect();
  const now = () => Date.now();
  const run = async (q, p = {}, tx) => {
    const r = (tx ? new sql.Request(tx) : pool.request());
    for (const [k, [t, v]] of Object.entries(p)) r.input(k, t, v);
    return r.query(q);
  };
  const G = sql.UniqueIdentifier, S = (n) => sql.NVarChar(n), I = sql.Int, B = sql.BigInt;
  const dup = e => e && (e.number === 2627 || e.number === 2601);

  return {
    async upsertUser({ extId, email, name }) {
      const sel = () => run('SELECT id,email,name FROM dbo.users WHERE ext_id=@e', { e: [S(100), extId] });
      let r = await sel();
      if (!r.recordset[0]) {
        try { await run('INSERT INTO dbo.users (ext_id,email,name,created_at) VALUES (@e,@m,@n,@t)', { e: [S(100), extId], m: [S(254), email], n: [S(120), name], t: [B, now()] }) }
        catch (e) { if (!dup(e)) throw e }
        r = await sel();
      } else if ((email && email !== r.recordset[0].email) || (name && name !== r.recordset[0].name)) {
        await run('UPDATE dbo.users SET email=COALESCE(@m,email), name=COALESCE(@n,name) WHERE ext_id=@e', { e: [S(100), extId], m: [S(254), email], n: [S(120), name] });
        r = await sel();
      }
      return r.recordset[0];
    },
    async getMembership(userId) {
      const r = await run(`SELECT m.team_id, m.role, t.name team_name, t.active, t.monthly_calls, t.monthly_images
        FROM dbo.members m JOIN dbo.teams t ON t.id=m.team_id WHERE m.user_id=@u`, { u: [G, userId] });
      const x = r.recordset[0]; return x ? { ...x, active: !!x.active } : null;
    },
    async createTeam(userId, name) {
      const tx = new sql.Transaction(pool); await tx.begin();
      try {
        const id = crypto.randomUUID();
        await run('INSERT INTO dbo.teams (id,name,created_at) VALUES (@i,@n,@t)', { i: [G, id], n: [S(80), name], t: [B, now()] }, tx);
        await run("INSERT INTO dbo.members (user_id,team_id,role,joined_at) VALUES (@u,@i,'owner',@t)", { u: [G, userId], i: [G, id], t: [B, now()] }, tx);
        await tx.commit(); return id;
      } catch (e) { await tx.rollback().catch(() => {}); throw e }
    },
    async createInvite(teamId, by) {
      const code = crypto.randomBytes(5).toString('hex').toUpperCase();
      await run('INSERT INTO dbo.invites (code,team_id,created_by,expires_at) VALUES (@c,@t,@b,@x)', { c: [sql.VarChar(20), code], t: [G, teamId], b: [G, by], x: [B, now() + 7 * 864e5] });
      return code;
    },
    async joinWithInvite(userId, code) {
      const tx = new sql.Transaction(pool); await tx.begin();
      try {
        const r = await run('UPDATE dbo.invites SET used_by=@u OUTPUT inserted.team_id WHERE code=@c AND used_by IS NULL AND expires_at>@n',
          { u: [G, userId], c: [sql.VarChar(20), code], n: [B, now()] }, tx);
        const t = r.recordset[0]; if (!t) { await tx.rollback(); return null }
        await run("INSERT INTO dbo.members (user_id,team_id,role,joined_at) VALUES (@u,@t,'member',@n)", { u: [G, userId], t: [G, t.team_id], n: [B, now()] }, tx);
        await tx.commit(); return t.team_id;
      } catch (e) { await tx.rollback().catch(() => {}); if (dup(e)) return null; throw e }
    },
    async listMembers(teamId) {
      return (await run(`SELECT u.name,u.email,m.role FROM dbo.members m JOIN dbo.users u ON u.id=m.user_id WHERE m.team_id=@t ORDER BY m.joined_at`, { t: [G, teamId] })).recordset;
    },
    async listModels(teamId) {
      return (await run(`SELECT m.id,m.name,m.version,m.updated_at,m.created_at,u.name updated_by FROM dbo.models m JOIN dbo.users u ON u.id=m.updated_by WHERE m.team_id=@t ORDER BY m.updated_at DESC`, { t: [G, teamId] })).recordset;
    },
    async getModel(teamId, id) {
      return (await run('SELECT id,name,body,version,updated_at FROM dbo.models WHERE team_id=@t AND id=@i', { t: [G, teamId], i: [S(64), id] })).recordset[0] || null;
    },
    async putModel(teamId, id, { name, body, baseVersion, userId }) {
      const p = { t: [G, teamId], i: [S(64), id], n: [S(120), name], b: [sql.NVarChar(sql.MAX), body], u: [G, userId], x: [B, now()] };
      const cur = (await run('SELECT version FROM dbo.models WHERE team_id=@t AND id=@i', p)).recordset[0];
      if (!cur) {
        try { await run('INSERT INTO dbo.models (team_id,id,name,body,version,updated_by,updated_at,created_at) VALUES (@t,@i,@n,@b,1,@u,@x,@x)', p); return { status: 'created', version: 1 } }
        catch (e) { if (dup(e)) return { status: 'conflict' }; throw e }
      }
      if (baseVersion !== cur.version) return { status: 'conflict' };
      const r = await run('UPDATE dbo.models SET name=@n,body=@b,version=version+1,updated_by=@u,updated_at=@x WHERE team_id=@t AND id=@i AND version=@v', { ...p, v: [I, cur.version] });
      return r.rowsAffected[0] ? { status: 'updated', version: cur.version + 1 } : { status: 'conflict' };
    },
    async deleteModel(teamId, id) { await run('DELETE FROM dbo.models WHERE team_id=@t AND id=@i', { t: [G, teamId], i: [S(64), id] }) },
    async getUsage(teamId, month) {
      return (await run('SELECT calls,images FROM dbo.usage WHERE team_id=@t AND month=@m', { t: [G, teamId], m: [sql.Char(7), month] })).recordset[0] || { calls: 0, images: 0 };
    },
    async reserveUsage(teamId, month, images, callCap, imageCap) {
      const p = { t: [G, teamId], m: [sql.Char(7), month], i: [I, images], cc: [I, callCap], ic: [I, imageCap] };
      try { await run('INSERT INTO dbo.usage (team_id,month) VALUES (@t,@m)', p) } catch (e) { if (!dup(e)) throw e }
      const r = await run('UPDATE dbo.usage SET calls=calls+1, images=images+@i WHERE team_id=@t AND month=@m AND calls<@cc AND images+@i<=@ic', p);
      return r.rowsAffected[0] > 0;
    },
    async releaseUsage(teamId, month, images) {
      await run('UPDATE dbo.usage SET calls=CASE WHEN calls>0 THEN calls-1 ELSE 0 END, images=CASE WHEN images>=@i THEN images-@i ELSE 0 END WHERE team_id=@t AND month=@m', { t: [G, teamId], m: [sql.Char(7), month], i: [I, images] });
    },
    async adminListTeams(month) {
      return (await run(`SELECT t.id,t.name,t.active,t.monthly_calls,t.monthly_images,COALESCE(u.calls,0) calls,COALESCE(u.images,0) images
        FROM dbo.teams t LEFT JOIN dbo.usage u ON u.team_id=t.id AND u.month=@m`, { m: [sql.Char(7), month] })).recordset;
    },
    async adminUpdateTeam(id, patch) {
      const sets = [], p = { i: [G, id] };
      if ('active' in patch) { sets.push('active=@a'); p.a = [sql.Bit, patch.active] }
      if ('monthly_calls' in patch) { sets.push('monthly_calls=@c'); p.c = [I, patch.monthly_calls] }
      if ('monthly_images' in patch) { sets.push('monthly_images=@m'); p.m = [I, patch.monthly_images] }
      await run(`UPDATE dbo.teams SET ${sets.join(',')} WHERE id=@i`, p);
    },
  };
}
