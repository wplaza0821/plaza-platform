-- Plazacore RLS cleanup 2026-09-08 — PHASE 1 (safe)
-- Drops wide-open PERMISSIVE PUBLIC policies on tables where phase4
-- role-scoped policies already provide full coverage.
-- Rollback: rollback-recreate-open-policies.sql
-- VERIFY AFTER: query as Edwin's JWT, expect exactly project 26011.
BEGIN;
DROP POLICY IF EXISTS "anon insert change_orders" ON public."change_orders";
DROP POLICY IF EXISTS "anon read change_orders" ON public."change_orders";
DROP POLICY IF EXISTS "anon update change_orders" ON public."change_orders";
DROP POLICY IF EXISTS "anon insert lien_waivers" ON public."lien_waivers";
DROP POLICY IF EXISTS "anon read lien_waivers" ON public."lien_waivers";
DROP POLICY IF EXISTS "anon insert pay_app_lines" ON public."pay_app_lines";
DROP POLICY IF EXISTS "anon read pay_app_lines" ON public."pay_app_lines";
DROP POLICY IF EXISTS "anon update pay_app_lines" ON public."pay_app_lines";
DROP POLICY IF EXISTS "anon insert pay_apps" ON public."pay_apps";
DROP POLICY IF EXISTS "anon read pay_apps" ON public."pay_apps";
DROP POLICY IF EXISTS "anon update pay_apps" ON public."pay_apps";
DROP POLICY IF EXISTS "anon insert projects" ON public."projects";
DROP POLICY IF EXISTS "anon read projects" ON public."projects";
DROP POLICY IF EXISTS "anon update projects" ON public."projects";
DROP POLICY IF EXISTS "anon insert rfis" ON public."rfis";
DROP POLICY IF EXISTS "anon read rfis" ON public."rfis";
DROP POLICY IF EXISTS "anon update rfis" ON public."rfis";
DROP POLICY IF EXISTS "anon delete sov" ON public."sov_items";
DROP POLICY IF EXISTS "anon insert sov" ON public."sov_items";
DROP POLICY IF EXISTS "anon read sov" ON public."sov_items";
DROP POLICY IF EXISTS "anon update sov" ON public."sov_items";
DROP POLICY IF EXISTS "anon delete submittal_files" ON public."submittal_files";
DROP POLICY IF EXISTS "anon insert submittal_files" ON public."submittal_files";
DROP POLICY IF EXISTS "anon read submittal_files" ON public."submittal_files";
DROP POLICY IF EXISTS "anon insert submittals" ON public."submittals";
DROP POLICY IF EXISTS "anon read submittals" ON public."submittals";
DROP POLICY IF EXISTS "anon update submittals" ON public."submittals";
COMMIT;
