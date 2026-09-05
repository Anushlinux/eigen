import type postgres from "postgres";

/** Additive migration: copy identity links, never Neon sessions or provider secrets. */
export async function migrateHostedAuth(tx: ReturnType<typeof postgres>) {
  await tx`CREATE TABLE eigen_auth_user (
    id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL DEFAULT false, image text,
    "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
    banned boolean NOT NULL DEFAULT false
  )`;
  await tx`CREATE TABLE eigen_auth_session (
    id text PRIMARY KEY, token text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
    "ipAddress" text, "userAgent" text,
    "userId" text NOT NULL REFERENCES eigen_auth_user(id) ON DELETE CASCADE
  )`;
  await tx`CREATE INDEX eigen_auth_session_user ON eigen_auth_session("userId")`;
  await tx`CREATE TABLE eigen_auth_account (
    id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES eigen_auth_user(id) ON DELETE CASCADE,
    "accessToken" text, "refreshToken" text, "idToken" text,
    "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
    scope text, password text, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
    UNIQUE ("providerId", "accountId")
  )`;
  await tx`CREATE INDEX eigen_auth_account_user ON eigen_auth_account("userId")`;
  await tx`CREATE TABLE eigen_auth_verification (
    id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
    "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL
  )`;
  await tx`CREATE INDEX eigen_auth_verification_identifier ON eigen_auth_verification(identifier)`;
  const [source] =
    await tx`SELECT to_regclass('neon_auth.user') AS users, to_regclass('neon_auth.account') AS accounts`;
  if (source?.users && source.accounts) {
    await tx`INSERT INTO eigen_auth_user (id,name,email,"emailVerified",image,"createdAt","updatedAt",banned)
      SELECT id::text,name,email,"emailVerified",image,"createdAt","updatedAt",COALESCE(banned,false)
      FROM neon_auth."user"`;
    await tx`INSERT INTO eigen_auth_account (id,"accountId","providerId","userId","createdAt","updatedAt")
      SELECT id::text,"accountId","providerId","userId"::text,"createdAt","updatedAt"
      FROM neon_auth.account WHERE "providerId"='github'`;
  }
}
