-- `member` = view + download only (William, 2026-07-10; restated 2026-11-17 for
-- Andrew Gillman, Echo Brickell: "view only, all modules").
-- 20260710150000_member_read_only.sql removed the quantity write paths but missed
-- four older member write policies from the June task/storage/pay-app work:
--   tasks: insert + update, pay_app_documents: insert, storage.objects: insert.
-- Members keep every SELECT policy (all modules, scoped to their projects).
DROP POLICY IF EXISTS tasks_member_insert      ON public.tasks;
DROP POLICY IF EXISTS tasks_member_update      ON public.tasks;
DROP POLICY IF EXISTS pad_member_write         ON public.pay_app_documents;
DROP POLICY IF EXISTS plz_storage_member_write ON storage.objects;
