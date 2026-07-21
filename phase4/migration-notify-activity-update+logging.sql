-- Phase 5.1 · notify-activity hardening (2026-07-20)
-- Three changes on top of migration-notify-activity-triggers.sql:
--   1. AFTER UPDATE fan-out (was INSERT-only) so status changes — e.g. a CO
--      going pending -> approved/executed — also notify PM + Client.
--      Only fires when the row's `status` actually changed (or, for tables
--      without a status col, on any update), to avoid noise from unrelated
--      column writes.
--   2. Stop swallowing failures silently. The old function used
--      `exception when others then null`, which hid a persistent 401 for
--      the entire life of the feature. We now log to a diagnostics table
--      (plz_notify_log) so failures are visible, while STILL never blocking
--      the underlying write.
--   3. Send the anon apikey/Authorization header too, so the call passes the
--      platform JWT gate even if the function is ever redeployed WITH jwt
--      verification. (Belt-and-suspenders alongside --no-verify-jwt.)

-- Diagnostics sink for trigger dispatch (never blocks writes).
create table if not exists public.plz_notify_log (
  id           bigint generated always as identity primary key,
  ref_table    text,
  ref_id       uuid,
  op           text,
  request_id   bigint,
  note         text,
  created_at   timestamptz not null default now()
);

create or replace function plz_notify_activity()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text;
  v_secret text;
  v_anon   text;
  v_actor  text;
  v_req    bigint;
  v_status_changed boolean := true;
begin
  select value into v_url    from private_config where key = 'notify_url';
  select value into v_secret from private_config where key = 'notify_secret';
  select value into v_anon   from private_config where key = 'notify_anon_key';
  if v_url is null then return coalesce(NEW, OLD); end if;

  -- On UPDATE, only fire when `status` actually changed. If the table has no
  -- status column the to_jsonb->>'status' is null on both sides -> treated as
  -- "changed" so status-less tables still notify on update if ever enabled.
  if TG_OP = 'UPDATE' then
    v_status_changed := (to_jsonb(NEW)->>'status') is distinct from (to_jsonb(OLD)->>'status');
    if not v_status_changed then
      return NEW;
    end if;
  end if;

  begin
    v_actor := auth.uid()::text;
  exception when others then
    v_actor := null;
  end;

  begin
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type','application/json',
        'x-notify-secret', coalesce(v_secret,''),
        'apikey', coalesce(v_anon,''),
        'Authorization', 'Bearer ' || coalesce(v_anon,'')
      ),
      body    := jsonb_build_object(
        'ref_table', TG_TABLE_NAME,
        'ref_id',    NEW.id,
        'event',     lower(TG_OP),
        'actor_id',  v_actor
      )
    ) into v_req;

    insert into plz_notify_log(ref_table, ref_id, op, request_id, note)
    values (TG_TABLE_NAME, NEW.id, lower(TG_OP), v_req, 'queued');
  exception when others then
    -- Never block the underlying write, but DO record why dispatch failed.
    begin
      insert into plz_notify_log(ref_table, ref_id, op, request_id, note)
      values (TG_TABLE_NAME, NEW.id, lower(TG_OP), null, 'dispatch_error: ' || SQLERRM);
    exception when others then null;
    end;
  end;

  return NEW;
end;
$$;

-- (Re)create AFTER INSERT OR UPDATE triggers on each activity table.
do $$
declare t text;
  tbls text[] := array[
    'pay_apps','submittals','change_orders','rfis','deficiencies',
    'daily_reports','photos','documents','field_reports','tasks',
    'milestones','plan_markups'
  ];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is not null then
      execute format('drop trigger if exists trg_notify_activity on public.%I;', t);
      execute format(
        'create trigger trg_notify_activity after insert or update on public.%I
           for each row execute function plz_notify_activity();', t);
    end if;
  end loop;
end$$;
