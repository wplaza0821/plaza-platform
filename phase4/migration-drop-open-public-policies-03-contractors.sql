-- phase4/migration-drop-open-public-policies-03-contractors.sql
-- 2026-09-08 — closes the last wide-open PUBLIC policy set.
--
-- WHY THIS WAS DEFERRED IN -02:
--   tryBootAuth() used to look a contractor up by `access_token` with the ANON
--   (publishable) key before any JWT existed. That required "anon read
--   contractors" (qual: true), which meant ANYONE holding the public key could
--   dump the whole contractors table — including every access_token, i.e. every
--   contractor portal link.
--
-- WHAT CHANGED:
--   index.html now calls the `auth-token` edge function FIRST. That function
--   already performs the access_token lookup with the SERVICE ROLE key and
--   returns the contractor's identity + a signed JWT. The client-side anon
--   lookup was pure duplication and has been removed.
--
-- ORDER OF OPERATIONS (important):
--   1. Deploy index.html (sw.js CACHE bumped to plazacore-shell-v36) FIRST.
--   2. Then run this migration.
--   Running this before the deploy breaks contractor ?key= portal links.

BEGIN;

-- Scoped replacement for "anon read contractors".
--   owner       -> all rows (contractors_owner_all already covers ALL cmds)
--   contractor  -> own row only (cannot harvest peers' access_tokens)
--   staff/member/client -> contractors on projects they belong to
CREATE POLICY "contractors_participant_read" ON public.contractors
  AS PERMISSIVE FOR SELECT TO public
  USING (
    plz_is_owner()
    OR (
      plz_role() = 'contractor'::text
      AND id = nullif(auth.jwt() ->> 'contractor_id', '')::uuid
    )
    OR (
      plz_role() = ANY (ARRAY['staff'::text, 'member'::text, 'client'::text])
      AND plz_has_project(project_id)
    )
  );

-- INSERT/UPDATE remain owner-only via the existing contractors_owner_all policy.
DROP POLICY IF EXISTS "anon read contractors"   ON public.contractors;
DROP POLICY IF EXISTS "anon insert contractors" ON public.contractors;
DROP POLICY IF EXISTS "anon update contractors" ON public.contractors;

COMMIT;

-- RESIDUAL RISK (accepted, documented):
--   staff/member/client on a project can still SELECT * on that project's
--   contractor rows, which includes access_token. RLS is row-level, not
--   column-level, and index.html does select('*'). Closing that would need
--   either column privileges plus an explicit select list, or a view.
--   Tracked, not urgent: those are authenticated, project-scoped users.
