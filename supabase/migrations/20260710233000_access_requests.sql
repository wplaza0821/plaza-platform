-- Access requests: public "request access" form on the login page.
-- Anonymous visitors may ONLY insert a pending request; only the owner can
-- read/update/delete. Approval happens through the existing invite-user flow
-- (owner picks role + project scope), so nothing here grants access by itself.

create table if not exists public.access_requests (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null,
  email       text not null,
  company     text,
  phone       text,
  message     text,
  status      text not null default 'pending' check (status in ('pending','approved','denied')),
  reviewed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- One live pending request per email (case-insensitive).
create unique index if not exists access_requests_pending_email_uidx
  on public.access_requests (lower(email)) where status = 'pending';

alter table public.access_requests enable row level security;

-- Anonymous (and any authed) clients may create a pending request only.
drop policy if exists ar_public_insert on public.access_requests;
create policy ar_public_insert on public.access_requests
  for insert to anon, authenticated
  with check (
    status = 'pending'
    and char_length(full_name) between 2 and 120
    and char_length(email) between 5 and 200
    and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and (company is null or char_length(company) <= 200)
    and (phone   is null or char_length(phone)   <= 40)
    and (message is null or char_length(message) <= 2000)
  );

-- Owner-only visibility + review.
drop policy if exists ar_owner_select on public.access_requests;
create policy ar_owner_select on public.access_requests
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.app_role = 'owner'));

drop policy if exists ar_owner_update on public.access_requests;
create policy ar_owner_update on public.access_requests
  for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.app_role = 'owner'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.app_role = 'owner'));

drop policy if exists ar_owner_delete on public.access_requests;
create policy ar_owner_delete on public.access_requests
  for delete to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.app_role = 'owner'));
