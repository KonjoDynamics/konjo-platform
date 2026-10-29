using './main.bicep'
param env = 'prod'
param adminObjectId = 'REPLACE: az ad signed-in-user show --query id -o tsv'
param adminLogin = 'REPLACE: your sign-in name in the KonjoDynamics tenant'
