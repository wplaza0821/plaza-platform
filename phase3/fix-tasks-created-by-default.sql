-- FIX (final): tasks.created_by had column DEFAULT 'owner' (from base schema line 284),
-- which pre-empted the stamp trigger (trigger only fires when created_by IS NULL).
-- Drop the default so inserts arrive NULL and plz_tasks_stamp_created_by() stamps the
-- real user id from the JWT 'sub' claim. (Trigger already re-created in prior fix.)
alter table tasks alter column created_by drop default;
