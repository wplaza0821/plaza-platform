-- Phase 5 · Activity-fanout triggers.
-- AFTER INSERT on every project activity table -> async pg_net POST to the
-- notify-activity edge function, which notifies PM + Client (+ assignee).
-- actor_id = auth.uid() (the authenticated writer); the edge fn skips the actor.
-- SECURITY DEFINER so it can read private_config + reach pg_net regardless of
-- the writer's role. Failures are swallowed so they never block the write.

create or replace function plz_notify_activity()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text;
  v_secret text;
  v_actor  text;
begin
  select value into v_url    from private_config where key = 'notify_url';
  select value into v_secret from private_config where key = 'notify_secret';
  if v_url is null then return NEW; end if;

  begin
    v_actor := auth.uid()::text;
  exception when others then
    v_actor := null;
  end;

  begin
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object('content-type','application/json','x-notify-secret',coalesce(v_secret,'')),
      body    := jsonb_build_object(
        'ref_table', TG_TABLE_NAME,
        'ref_id',    NEW.id,
        'event',     lower(TG_OP),
        'actor_id',  v_actor
      )
    );
  exception when others then
    -- never block the underlying write
    null;
  end;

  return NEW;
end;
$$;

-- (Re)create AFTER INSERT triggers on each activity table.
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
        'create trigger trg_notify_activity after insert on public.%I
           for each row execute function plz_notify_activity();', t);
    end if;
  end loop;
end$$;
