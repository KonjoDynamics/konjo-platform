-- Konjo schema v1 (Azure SQL). Safe to run more than once.
IF OBJECT_ID('dbo.users') IS NULL CREATE TABLE dbo.users (
  id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
  ext_id NVARCHAR(100) NOT NULL UNIQUE,         -- Entra External ID object id (oid)
  email NVARCHAR(254) NULL, name NVARCHAR(120) NULL, created_at BIGINT NOT NULL);
IF OBJECT_ID('dbo.teams') IS NULL CREATE TABLE dbo.teams (
  id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
  name NVARCHAR(80) NOT NULL, created_at BIGINT NOT NULL,
  active BIT NOT NULL DEFAULT 1,
  monthly_calls INT NOT NULL DEFAULT 300, monthly_images INT NOT NULL DEFAULT 3000);
IF OBJECT_ID('dbo.members') IS NULL CREATE TABLE dbo.members (
  user_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY REFERENCES dbo.users(id),   -- one team per user
  team_id UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.teams(id),
  role VARCHAR(10) NOT NULL CHECK (role IN ('owner','member')), joined_at BIGINT NOT NULL);
IF OBJECT_ID('dbo.invites') IS NULL CREATE TABLE dbo.invites (
  code VARCHAR(20) NOT NULL PRIMARY KEY, team_id UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.teams(id),
  created_by UNIQUEIDENTIFIER NOT NULL, expires_at BIGINT NOT NULL, used_by UNIQUEIDENTIFIER NULL);
IF OBJECT_ID('dbo.models') IS NULL CREATE TABLE dbo.models (
  team_id UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.teams(id), id NVARCHAR(64) NOT NULL,
  name NVARCHAR(120) NOT NULL, body NVARCHAR(MAX) NOT NULL, version INT NOT NULL DEFAULT 1,
  updated_by UNIQUEIDENTIFIER NOT NULL, updated_at BIGINT NOT NULL, created_at BIGINT NOT NULL,
  PRIMARY KEY (team_id, id));
IF OBJECT_ID('dbo.usage') IS NULL CREATE TABLE dbo.usage (
  team_id UNIQUEIDENTIFIER NOT NULL, month CHAR(7) NOT NULL,
  calls INT NOT NULL DEFAULT 0, images INT NOT NULL DEFAULT 0, PRIMARY KEY (team_id, month));
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_models_team') CREATE INDEX idx_models_team ON dbo.models(team_id, updated_at DESC);
