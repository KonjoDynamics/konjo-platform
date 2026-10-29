# konjo-platform
- `infra/`  Bicep for one environment (dev, prod): Key Vault, Storage, Azure SQL (serverless, Entra-only auth), Container Registry, Container Apps, Static Web App, monitoring.
- `scripts-bootstrap.sh`  one-time setup of resource groups and the passwordless GitHub deploy identity.
- `.github/workflows/infra.yml`  what-if on pull requests, deploy on main.
- Next (not here yet): `api/` (ported from the Cloudflare prototype), `web/` (designer with sign-in), API deploy workflow.
Deploy by hand once: `az deployment group create -g rg-konjo-dev -f infra/main.bicep -p infra/dev.bicepparam`
