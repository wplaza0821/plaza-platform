-- Quantity Reconciliation (William, 2026-06-22):
-- Cross-reference inspector-verified repair quantities (repair_quantity_items,
-- status='complete' = approved) against the quantities the contractor has billed
-- through pay applications (pay_app_lines), and flag over-billing.
--
-- A repair_type (e.g. concrete_repair) generally maps to MANY SOV line items
-- (partial/full depth, crack, by area). This table records which SOV item_no(s)
-- belong to each repair_type so both sides can be summed per type and compared.
-- Owner-maintained.

CREATE TABLE IF NOT EXISTS public.qty_recon_map (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  repair_type  text NOT NULL,            -- matches RQ_TYPES key
  sov_item_no  text NOT NULL,            -- matches sov_items.item_no
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, repair_type, sov_item_no)
);
CREATE INDEX IF NOT EXISTS qrm_project_idx ON public.qty_recon_map(project_id);

ALTER TABLE public.qty_recon_map ENABLE ROW LEVEL SECURITY;

-- Owner: full control of the mapping.
DROP POLICY IF EXISTS qrm_owner_all ON public.qty_recon_map;
CREATE POLICY qrm_owner_all ON public.qty_recon_map
  FOR ALL TO public USING (plz_is_owner());

-- Staff/members on the project: read-only (so they can view the reconciliation,
-- but only the owner curates the mapping — consistent with Option B).
DROP POLICY IF EXISTS qrm_member_read ON public.qty_recon_map;
CREATE POLICY qrm_member_read ON public.qty_recon_map
  FOR SELECT TO public
  USING (plz_role() IN ('staff','member') AND plz_has_project(project_id));
