-- ============================================================
-- Wonderful Tools Registry
-- Project: plazacore (xpeppmurxgbqlsabswqn)
-- Purpose: queryable catalog + PRIVATE hosting for the ~/wonderful suite
-- Created: 2026-07-25
-- ============================================================
-- WHY THIS EXISTS
--   The ~/wonderful folder holds ~44 single-file tools containing real
--   client A/R, project financials, PE license numbers and personal
--   trading data. The plazacore GitHub Pages repo is PUBLIC, so tool
--   content must NOT be committed there. Instead: content lives in a
--   PRIVATE storage bucket, served only via short-lived signed URLs
--   after authentication. This table is the catalog/index.
--
-- SAFETY
--   * Additive only: 1 new table, 1 new private bucket, 1 view, 1 RPC.
--   * Touches NO existing table, policy, bucket, or function.
--   * Reuses the project's existing plz_is_owner() / plz_role() helpers
--     rather than defining a competing owner definition.
--
-- AUTH MODEL NOTE (verified against phase3/fix-hook-secdef.sql):
--   plz_access_token_hook() copies profiles.app_role into the JWT claim
--   'user_role'. plz_is_owner() reads that claim. Therefore it is TRUE for
--   both the native email+password session AND the legacy owner-pw token.
--   NOTE: profiles column is `app_role` (NOT `role`).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Registry table
-- ------------------------------------------------------------
create table if not exists public.tools_registry (
  id                uuid primary key default gen_random_uuid(),

  -- identity
  slug              text not null unique,
  title             text not null,
  filename          text not null,

  -- classification
  category          text not null
                      check (category in (
                        'reports-field',
                        'proposals-bd',
                        'billing-ar',
                        'plazacore',
                        'trading',
                        'personal',
                        'research'
                      )),
  kind              text not null default 'tool'
                      check (kind in ('tool','research','cli')),
  tags              text[] not null default '{}',

  -- content
  description       text,
  build_date        date not null,
  storage_path      text,            -- object path inside bucket 'wonderful-tools'
  file_bytes        bigint,
  has_localstorage  boolean not null default false,

  -- access tier
  sensitivity       text not null default 'firm'
                      check (sensitivity in ('public','firm','owner_only')),

  -- lifecycle
  status            text not null default 'live'
                      check (status in ('live','archived','deprecated')),
  supersedes_id     uuid references public.tools_registry(id) on delete set null,

  -- curation + telemetry ("which of these 44 do I actually use?")
  usefulness_rating smallint check (usefulness_rating between 1 and 5),
  is_favorite       boolean not null default false,
  open_count        integer not null default 0,
  last_opened_at    timestamptz,

  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.tools_registry is
  'Catalog of the ~/wonderful build suite. Content served privately via signed URLs from bucket wonderful-tools.';
comment on column public.tools_registry.sensitivity is
  'public = generic engineering reference, zero client data. firm = client/financial data (owner+staff). owner_only = William personal (trading, private investments) - owner only.';
comment on column public.tools_registry.open_count is
  'Incremented via tools_registry_log_open(); drives the usefulness audit.';

-- ------------------------------------------------------------
-- 2. Indexes
-- ------------------------------------------------------------
create index if not exists tools_registry_category_idx    on public.tools_registry (category);
create index if not exists tools_registry_status_idx      on public.tools_registry (status);
create index if not exists tools_registry_sensitivity_idx on public.tools_registry (sensitivity);
create index if not exists tools_registry_build_date_idx  on public.tools_registry (build_date desc);
create index if not exists tools_registry_tags_idx        on public.tools_registry using gin (tags);
create index if not exists tools_registry_storage_path_idx on public.tools_registry (storage_path);

-- Full-text over title + description.
-- NOTE: tags is deliberately NOT included here. array_to_string() is STABLE,
-- not IMMUTABLE, so Postgres rejects it in an index expression
-- (SQLSTATE 42P17). Tag search is served by tools_registry_tags_idx (GIN on
-- the array) via `tags @> '{...}'` / `&& ` operators instead.
create index if not exists tools_registry_search_idx
  on public.tools_registry
  using gin (
    to_tsvector('english',
      coalesce(title,'') || ' ' || coalesce(description,'')
    )
  );

-- ------------------------------------------------------------
-- 3. updated_at trigger
-- ------------------------------------------------------------
create or replace function public.tools_registry_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tools_registry_touch_trg on public.tools_registry;
create trigger tools_registry_touch_trg
  before update on public.tools_registry
  for each row execute function public.tools_registry_touch();

-- ------------------------------------------------------------
-- 4. Row Level Security
--    Uses the EXISTING plz_is_owner() / plz_role() helpers.
-- ------------------------------------------------------------
alter table public.tools_registry enable row level security;

-- READ
--   owner            -> everything (incl. owner_only + archived)
--   staff            -> live 'firm' + 'public'
--   member/contractor-> live 'public' only (generic engineering refs)
drop policy if exists tools_registry_select on public.tools_registry;
create policy tools_registry_select
  on public.tools_registry
  for select
  to authenticated
  using (
    plz_is_owner()
    or (
      status = 'live'
      and (
        (plz_role() = 'staff' and sensitivity in ('public','firm'))
        or sensitivity = 'public'
      )
    )
  );

-- WRITE: owner only.
drop policy if exists tools_registry_insert on public.tools_registry;
create policy tools_registry_insert
  on public.tools_registry for insert
  to authenticated
  with check (plz_is_owner());

drop policy if exists tools_registry_update on public.tools_registry;
create policy tools_registry_update
  on public.tools_registry for update
  to authenticated
  using (plz_is_owner())
  with check (plz_is_owner());

drop policy if exists tools_registry_delete on public.tools_registry;
create policy tools_registry_delete
  on public.tools_registry for delete
  to authenticated
  using (plz_is_owner());

-- ------------------------------------------------------------
-- 5. PRIVATE storage bucket for tool files
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('wonderful-tools', 'wonderful-tools', false)
on conflict (id) do update set public = false;   -- force private even if pre-existing

-- Storage READ mirrors the table policy: an object is readable only if its
-- registry row is readable. Prevents a private tool leaking via direct path.
drop policy if exists wonderful_tools_read on storage.objects;
create policy wonderful_tools_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'wonderful-tools'
    and (
      plz_is_owner()
      or exists (
        select 1
        from public.tools_registry t
        where t.storage_path = storage.objects.name
          and t.status = 'live'
          and (
            (plz_role() = 'staff' and t.sensitivity in ('public','firm'))
            or t.sensitivity = 'public'
          )
      )
    )
  );

-- Storage WRITE: owner only.
drop policy if exists wonderful_tools_insert on storage.objects;
create policy wonderful_tools_insert
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'wonderful-tools' and plz_is_owner());

drop policy if exists wonderful_tools_update on storage.objects;
create policy wonderful_tools_update
  on storage.objects for update
  to authenticated
  using (bucket_id = 'wonderful-tools' and plz_is_owner())
  with check (bucket_id = 'wonderful-tools' and plz_is_owner());

drop policy if exists wonderful_tools_delete on storage.objects;
create policy wonderful_tools_delete
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'wonderful-tools' and plz_is_owner());

-- ------------------------------------------------------------
-- 6. Open telemetry RPC
--    Records a real open without granting blanket UPDATE.
--    Guarded so a low-privilege user can't bump a hidden row.
-- ------------------------------------------------------------
create or replace function public.tools_registry_log_open(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tools_registry t
     set open_count     = t.open_count + 1,
         last_opened_at = now()
   where t.slug = p_slug
     and (
       plz_is_owner()
       or (
         t.status = 'live'
         and (
           (plz_role() = 'staff' and t.sensitivity in ('public','firm'))
           or t.sensitivity = 'public'
         )
       )
     );
end;
$$;

revoke all on function public.tools_registry_log_open(text) from public;
grant execute on function public.tools_registry_log_open(text) to authenticated;

-- ------------------------------------------------------------
-- 7. Usage audit view (RLS-respecting: inherits table policy)
-- ------------------------------------------------------------
create or replace view public.tools_usage_audit
with (security_invoker = true)
as
select
  slug,
  title,
  category,
  sensitivity,
  status,
  build_date,
  open_count,
  last_opened_at,
  usefulness_rating,
  is_favorite,
  case
    when open_count = 0 then 'never opened'
    when last_opened_at < now() - interval '90 days' then 'stale'
    when open_count >= 10 then 'core'
    else 'occasional'
  end as usage_tier
from public.tools_registry;

-- ============================================================
-- END
-- ============================================================
