-- Enterprise AI Access Lab schema. Safe to run repeatedly.
-- gen_random_uuid() is built in from Postgres 13; SCIM ids are opaque, so UUIDs work well
-- and don't leak row counts the way serial ids would.

create table if not exists users (
  id           uuid primary key default gen_random_uuid(),
  external_id  text,                      -- the IdP's own id for this user (Okta/Entra object id)
  user_name    text not null,
  -- email is the join key between SCIM and SAML: the SAML assertion's email attribute
  -- must match this column (see README, "Identity matching").
  email        text not null,
  given_name   text,
  family_name  text,
  display_name text,
  active       boolean not null default true,  -- IdPs deprovision by setting this false
  version      integer not null default 1,     -- surfaced as the SCIM meta.version ETag
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- userName is case-insensitive in SCIM (caseExact: false), so uniqueness is too.
create unique index if not exists users_user_name_key on users (lower(user_name));
create unique index if not exists users_email_key on users (lower(email));

create table if not exists groups (
  id           uuid primary key default gen_random_uuid(),
  external_id  text,
  display_name text not null,
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists groups_display_name_key on groups (lower(display_name));

create table if not exists group_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id  uuid not null references users(id)  on delete cascade,
  primary key (group_id, user_id)  -- makes "add member" naturally idempotent
);
create index if not exists group_members_user_idx on group_members (user_id);

-- ---------- Phase 2: SAML sessions ----------

-- Server-side sessions, so an admin (or SCIM deprovisioning) can revoke them instantly.
-- A stateless JWT cookie couldn't be taken back before it expired.
create table if not exists sessions (
  id                 uuid primary key default gen_random_uuid(),
  -- Only a SHA-256 of the cookie value is stored: a leaked sessions table can't be replayed.
  token_hash         bytea not null unique,
  user_id            uuid not null references users(id) on delete cascade,
  saml_session_index text,
  -- Groups the IdP put in the assertion, kept for debugging. Authorization uses the
  -- SCIM-managed group_members table instead, which updates without a re-login.
  idp_groups         text[] not null default '{}',
  ip                 text,
  user_agent         text,
  created_at         timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  expires_at         timestamptz not null,
  revoked_at         timestamptz
);
create index if not exists sessions_user_idx on sessions (user_id) where revoked_at is null;

-- IDs of AuthnRequests we sent. A SAML response must answer one of them (InResponseTo),
-- and each ID is deleted on use, which blocks IdP-initiated logins and replayed responses.
create table if not exists saml_requests (
  id         text primary key,
  created_at timestamptz not null default now()
);

-- ---------- Phase 3: groups -> roles -> capabilities ----------
-- Modeled on Claude Enterprise custom roles: an admin defines roles as a set of
-- capabilities, then assigns roles to IdP groups. Users never get roles directly;
-- access always flows from IdP group membership (via SCIM).

create table if not exists roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Capability strings are defined in code (lib/authz/capabilities.ts), so the app
-- can't be granted a capability it doesn't know how to enforce.
create table if not exists role_capabilities (
  role_id    uuid not null references roles(id) on delete cascade,
  capability text not null,
  primary key (role_id, capability)
);

-- Keyed by group *name* rather than group id so an admin can set mappings before Okta
-- pushes the group. Trade-off: renaming the group in Okta removes its access until the
-- mapping is updated, which fails closed.
create table if not exists group_role_mappings (
  group_name text not null,
  role_id    uuid not null references roles(id) on delete cascade
);
create unique index if not exists group_role_mappings_key on group_role_mappings (lower(group_name), role_id);

-- ---------- Phase 4: audit log ----------
-- Append-only record of SCIM events, logins, role changes, Claude tool calls and admin
-- actions. No foreign keys: entries must outlive the users and groups they describe.
create table if not exists audit_log (
  id          bigint generated always as identity primary key,  -- also the ordering/cursor
  occurred_at timestamptz not null default clock_timestamp(),
  actor       text not null,   -- "scim", "user:<email>", or "anonymous"
  action      text not null,   -- dotted name, e.g. "scim.user.deactivate"
  target      text,            -- "user:<id>", "group:<id>", "role:<name>", "tool:<name>"
  metadata    jsonb not null default '{}'
);
create index if not exists audit_log_action_idx on audit_log (action, id desc);
create index if not exists audit_log_actor_idx on audit_log (actor, id desc);
create index if not exists audit_log_target_idx on audit_log (target, id desc);

-- Append-only in the database itself, not just by convention in the app: UPDATE, DELETE
-- and TRUNCATE all raise. (In production, also run the app as a role that only has
-- INSERT and SELECT on this table; a table owner could still drop these triggers.)
create or replace function audit_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create or replace trigger audit_log_no_change before update or delete on audit_log
  for each row execute function audit_log_append_only();
create or replace trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_append_only();
