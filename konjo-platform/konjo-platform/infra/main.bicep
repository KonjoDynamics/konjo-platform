// Konjo platform: one environment (dev or prod) in one resource group.
// Deploy:  az deployment group create -g rg-konjo-dev -f infra/main.bicep -p infra/dev.bicepparam
targetScope = 'resourceGroup'

@allowed(['dev', 'prod'])
param env string
param location string = resourceGroup().location
@description('Entra object id of the person who administers SQL and Key Vault (you). Get it: az ad signed-in-user show --query id -o tsv')
param adminObjectId string
@description('Sign-in name of that person, e.g. trever@KonjoDynamics.onmicrosoft.com')
param adminLogin string
@description('Static Web Apps is only available in a few regions.')
@allowed(['centralus', 'eastus2', 'westus2', 'westeurope', 'eastasia'])
param swaLocation string = 'centralus'
@description('Pause the database after this many idle minutes (serverless). -1 = never pause.')
param sqlAutoPauseMinutes int = 60

var suffix = uniqueString(resourceGroup().id)
var base = 'konjo-${env}'
var kvName = take('kv-${base}-${suffix}', 24)
var stName = take(replace('st${base}${suffix}', '-', ''), 24)
var acrName = take(replace('acr${base}${suffix}', '-', ''), 50)
var sqlName = 'sql-${base}-${suffix}'

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${base}'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${base}'
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: law.id }
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource st 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: stName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}
resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: st
  name: 'default'
  properties: { deleteRetentionPolicy: { enabled: true, days: 14 } }
}
resource photos 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'photos'
  properties: { publicAccess: 'None' }
}

resource sql 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlName
  location: location
  properties: {
    minimalTlsVersion: '1.2'
    administrators: {
      administratorType: 'ActiveDirectory'
      principalType: 'User'
      login: adminLogin
      sid: adminObjectId
      tenantId: subscription().tenantId
      azureADOnlyAuthentication: true // no SQL passwords exist
    }
  }
}
resource sqlAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sql
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}
resource db 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sql
  name: 'konjo'
  location: location
  sku: { name: 'GP_S_Gen5', tier: 'GeneralPurpose', family: 'Gen5', capacity: 1 }
  properties: {
    autoPauseDelay: sqlAutoPauseMinutes
    minCapacity: json('0.5')
    maxSizeBytes: 34359738368
    zoneRedundant: false
    requestedBackupStorageRedundancy: 'Local'
  }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource id 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${base}-api'
  location: location
}

var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var roleKvSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var roleKvSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var roleBlobContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource raAcr 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, id.id, roleAcrPull)
  properties: { principalId: id.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull) }
}
resource raKv 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, id.id, roleKvSecretsUser)
  properties: { principalId: id.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKvSecretsUser) }
}
resource raSt 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: st
  name: guid(st.id, id.id, roleBlobContributor)
  properties: { principalId: id.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleBlobContributor) }
}
resource raAdminKv 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, adminObjectId, roleKvSecretsOfficer)
  properties: { principalId: adminObjectId, principalType: 'User', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKvSecretsOfficer) }
}

resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${base}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: law.properties.customerId, sharedKey: law.listKeys().primarySharedKey }
    }
  }
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${base}-api'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${id.id}': {} } }
  dependsOn: [raAcr]
  properties: {
    managedEnvironmentId: cae.id
    configuration: {
      ingress: { external: true, targetPort: 80, transport: 'auto', allowInsecure: false }
      registries: [{ server: acr.properties.loginServer, identity: id.id }]
    }
    template: {
      // Placeholder until the first real image is pushed by the deploy workflow.
      containers: [{
        name: 'api'
        image: 'mcr.microsoft.com/k8se/quickstart:latest'
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'KEYVAULT_URI', value: kv.properties.vaultUri }
          { name: 'STORAGE_ACCOUNT', value: st.name }
          { name: 'SQL_SERVER', value: sql.properties.fullyQualifiedDomainName }
          { name: 'SQL_DATABASE', value: db.name }
          { name: 'AZURE_CLIENT_ID', value: id.properties.clientId }
          { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appi.properties.ConnectionString }
        ]
      }]
      scale: { minReplicas: env == 'prod' ? 1 : 0, maxReplicas: 5, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '30' } } }] }
    }
  }
}

resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'swa-${base}'
  location: swaLocation
  sku: { name: 'Free', tier: 'Free' }
  properties: {}
}

output apiHost string = api.properties.configuration.ingress.fqdn
output swaHost string = swa.properties.defaultHostname
output keyVaultUri string = kv.properties.vaultUri
output sqlServer string = sql.properties.fullyQualifiedDomainName
output acrLoginServer string = acr.properties.loginServer
output apiIdentityName string = id.name
output storageAccount string = st.name
