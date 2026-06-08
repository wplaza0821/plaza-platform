-- FIX: created_by was not auto-stamped on member insert.
-- Cause: trigger as SECURITY DEFINER can shift the auth context; auth.uid() returned null.
-- Fix: plain trigger (no security definer needed — it only sets NEW.created_by),
-- read the user id from the request JWT 'sub' claim with auth.uid() fallback.
create or replace function plz_tasks_stamp_created_by() returns trigger as $$
declare uid text;
begin
  if new.created_by is null then
    begin
      uid := coalesce(
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
        (auth.uid())::text
      );
    exception when others then
      uid := (auth.uid())::text;
    end;
    if uid is not null then new.created_by := uid; end if;
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists trg_tasks_created_by on tasks;
create trigger trg_tasks_created_by before insert on tasks
  for each row execute function plz_tasks_stamp_created_by();
