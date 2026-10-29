#!/usr/bin/env bash
# One-time bootstrap in YOUR tenant. Run in Azure Cloud Shell (portal top bar, ">_" icon) or any terminal after `az login`.
# Safe to re-run. Replace GITHUB_OWNER/REPO first.
set -euo pipefail
TENANT=e35ca905-3cde-40da-a469-5ae19021f9d7
LOC=westus3
GITHUB_OWNER="${GITHUB_OWNER:?set GITHUB_OWNER=your-github-username}"
REPO="${REPO:-konjo-platform}"

az account show --query "{sub:name,id:id,tenant:tenantId}" -o table
[ "$(az account show --query tenantId -o tsv)" = "$TENANT" ] || { echo "Wrong tenant. Run: az login --tenant $TENANT"; exit 1; }
SUB=$(az account show --query id -o tsv)

az provider register -n Microsoft.App -n Microsoft.OperationalInsights -n Microsoft.ContainerRegistry -n Microsoft.Sql -n Microsoft.KeyVault -n Microsoft.Web -n Microsoft.Insights --wait >/dev/null
az group create -n rg-konjo-dev  -l $LOC >/dev/null
az group create -n rg-konjo-prod -l $LOC >/dev/null

# Deploy identity for GitHub Actions (federated: no password or secret is stored anywhere). Re-runnable.
APP=$(az ad app list --display-name konjo-github-deploy --query "[0].appId" -o tsv)
[ -n "$APP" ] || APP=$(az ad app create --display-name konjo-github-deploy --query appId -o tsv)
az ad sp show --id "$APP" >/dev/null 2>&1 || az ad sp create --id "$APP" >/dev/null
have_cred() { az ad app federated-credential list --id "$APP" --query "[?name=='$1'] | length(@)" -o tsv; }
add_cred() { # name subject
  [ "$(have_cred "$1")" != "0" ] && { echo "credential $1 already exists"; return; }
  az ad app federated-credential create --id "$APP" --parameters "{\"name\":\"$1\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"$2\",\"audiences\":[\"api://AzureADTokenExchange\"]}" >/dev/null
}
add_cred gh-main "repo:$GITHUB_OWNER/$REPO:ref:refs/heads/main"
add_cred gh-pr   "repo:$GITHUB_OWNER/$REPO:pull_request"
# Contributor on dev only; prod gets its own grant later. User Access Administrator is needed because main.bicep assigns roles.
for RG in rg-konjo-dev; do
  az role assignment create --assignee "$APP" --role Contributor --scope /subscriptions/$SUB/resourceGroups/$RG >/dev/null
  az role assignment create --assignee "$APP" --role "Role Based Access Control Administrator" --scope /subscriptions/$SUB/resourceGroups/$RG >/dev/null
done

echo; echo "Put these in GitHub > repo > Settings > Secrets and variables > Actions > Variables:"
echo "  AZURE_CLIENT_ID=$APP"; echo "  AZURE_TENANT_ID=$TENANT"; echo "  AZURE_SUBSCRIPTION_ID=$SUB"
echo; echo "Your values for infra/dev.bicepparam:"
echo "  adminObjectId=$(az ad signed-in-user show --query id -o tsv)"
echo "  adminLogin=$(az ad signed-in-user show --query userPrincipalName -o tsv)"
