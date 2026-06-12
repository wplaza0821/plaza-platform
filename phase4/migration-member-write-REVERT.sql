-- migration-member-write-REVERT.sql
-- Reverts migration-member-write-rls.sql. That migration was based on a wrong
-- assumption that Tareec was a "member". He is actually a CONTRACTOR. Members
-- (e.g. Noel, an inspector) are intended to be READ-ONLY (canEdit() returns
-- false for members except tasks). So broad member write was an overreach.
-- Member READ policies (migration-member-rls.sql) are kept — the app does
-- intend members to view their project.
--
-- Tasks member write (tasks_member_insert / tasks_member_update) predates this
-- and is part of the app design, so it is NOT dropped here.

drop policy if exists pa_member_write     on pay_apps;
drop policy if exists pa_member_update     on pay_apps;
drop policy if exists pal_member_rw        on pay_app_lines;
drop policy if exists rfis_member_write    on rfis;
drop policy if exists rfis_member_update   on rfis;
drop policy if exists sub_member_write     on submittals;
drop policy if exists sub_member_update    on submittals;
drop policy if exists def_member_rw        on deficiencies;
drop policy if exists daily_member_rw      on daily_reports;
drop policy if exists photos_member_rw     on photos;
drop policy if exists markups_member_insert on plan_markups;
drop policy if exists markups_member_update on plan_markups;
drop policy if exists plan_pins_member_rw  on plan_pins;
drop policy if exists lw_member_write      on lien_waivers;
drop policy if exists fr_member_rw         on field_reports;
