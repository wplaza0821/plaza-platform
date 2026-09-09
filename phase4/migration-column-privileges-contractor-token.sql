-- phase4/migration-column-privileges-contractor-token.sql
-- 2026-09-08 — closes the residual risk documented at the bottom of
-- migration-drop-open-public-policies-03-contractors.sql.
--
-- PROBLEM:
--   RLS is row-level. contractors_participant_read lets staff/member/client read
--   their own project's contractor rows — and index.html did select('*'), so those
--   authenticated, project-scoped users could read access_token, i.e. mint their
--   own contractor portal links for that project.
--
-- FIX (two parts):
--   1. Column privileges: anon/authenticated lose SELECT on contractors.access_token
--      entirely. Postgres cannot revoke a single column out of a table-wide grant,
--      so we drop the table grant and re-grant the nine safe columns explicitly.
--   2. plz_contractor_token(): SECURITY DEFINER, gated on plz_is_owner(), returns
--      one token at a time. That is the only authenticated path to a token.
--   service_role keeps full SELECT — the auth-token edge function needs it.
--
-- ORDER OF OPERATIONS (important):
--   1. Deploy index.html (sw.js CACHE bumped to plazacore-shell-v37) FIRST.
--      The old bundle does select('*') and would start 403-ing on the Access tab.
--   2. Then run this migration.

BEGIN;

CREATE OR REPLACE FUNCTION public.plz_contractor_token(p_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.access_token
  FROM public.contractors c
  WHERE c.id = p_id
    AND public.plz_is_owner();
$$;

REVOKE ALL ON FUNCTION public.plz_contractor_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.plz_contractor_token(uuid) TO authenticated;

-- Column-level SELECT. Note the deliberate omission of access_token.
REVOKE SELECT ON public.contractors FROM anon, authenticated;
GRANT SELECT (id, name, contact_email, contact_phone, project_id,
              permissions, active, created_at, revoked_at)
  ON public.contractors TO anon, authenticated;

COMMIT;
