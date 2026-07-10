-- Make the `member` role TRULY read-only.
--
-- Background: the 2026-06-22 "repair_quantities_owner_only_writes" migration
-- left members with INSERT on repair_quantity_items / repair_stacks for field
-- data entry. External read-only stakeholders (e.g. Jenny Cámara, TRP Village
-- AGM — invited 2026-07-10 as a member scoped to Terrazas 26011) must NOT be
-- able to modify any data. They may VIEW everything in their project scope and
-- DOWNLOAD documents, but never write.
--
-- This drops the two remaining member write paths so `member` == view + download
-- only. Owner/staff writes are untouched. Member SELECT policies are untouched.

DROP POLICY IF EXISTS rqi_member_insert ON public.repair_quantity_items;
DROP POLICY IF EXISTS rqi_member_update ON public.repair_quantity_items;
DROP POLICY IF EXISTS rqi_member_delete ON public.repair_quantity_items;

DROP POLICY IF EXISTS rqs_member_insert ON public.repair_stacks;
DROP POLICY IF EXISTS rqs_member_update ON public.repair_stacks;
DROP POLICY IF EXISTS rqs_member_delete ON public.repair_stacks;
