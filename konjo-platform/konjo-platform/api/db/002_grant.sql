-- Lets the API's managed identity read/write data (and nothing else). Run once per environment
-- as the SQL admin, connected to database "konjo". Use id-konjo-prod-api for prod.
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name='id-konjo-dev-api') CREATE USER [id-konjo-dev-api] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [id-konjo-dev-api];
ALTER ROLE db_datawriter ADD MEMBER [id-konjo-dev-api];
