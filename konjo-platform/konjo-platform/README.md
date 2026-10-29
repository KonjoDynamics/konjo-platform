# konjo-platform
- `infra/`  Bicep for one environment (dev, prod).
- `api/`  The Konjo API (Node 22, no web framework). `cd api && node --test` runs 12 tests with no Azure needed.
  - `src/app.js` all routes and rules; `src/store-sql.js` Azure SQL; `src/store-memory.js` test double; `src/server.js` wiring (Key Vault secrets, Entra token check).
  - `db/001_init.sql` tables; `db/002_grant.sql` gives the API's identity data-only access.
- `.github/workflows/infra.yml` what-if on PR, deploy on main. `api.yml` test, build in Azure, roll out, smoke test.
- `scripts-bootstrap.sh` one-time GitHub-to-Azure link (already run for dev).
Not built yet: web/ (designer with sign-in), Entra External ID setup, photo storage in Blob, prod environment grant.
Known gap: no package-lock.json yet (generate with `cd api && npm install`, then commit it).
