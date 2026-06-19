-- ─────────────────────────────────────────────────────────────────────────────
-- Repair Quantities Module
-- ─────────────────────────────────────────────────────────────────────────────

-- Project-specific stack/drop list
CREATE TABLE IF NOT EXISTS public.repair_stacks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  label       text NOT NULL,            -- e.g. "Stack 7", "Drop A", "Column Line 3"
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repair_stacks_project_idx ON public.repair_stacks(project_id);

-- Seed Terrazas stacks (Stacks 1–12 based on SI reports + 12-story building)
INSERT INTO public.repair_stacks (project_id, label, sort_order)
SELECT '7326b0b7-2e32-4e61-bf76-89f88b4f74f0', 'Stack ' || n, n
FROM generate_series(1,12) AS n
ON CONFLICT DO NOTHING;

-- Repair quantity line items
CREATE TABLE IF NOT EXISTS public.repair_quantity_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  stack_id        uuid REFERENCES public.repair_stacks(id) ON DELETE SET NULL,
  stack_label     text,                  -- denormalized for fast display
  floor_level     text,                  -- "1F", "2F", "PH", "Roof", etc.
  repair_type     text NOT NULL,         -- see REPAIR_TYPES enum below
  description     text,                  -- free text location note
  -- Measurements in inches
  length_in       numeric(10,3),         -- width or length
  height_in       numeric(10,3),         -- height (for area)
  depth_in        numeric(10,3),         -- depth (for volume, optional)
  -- Computed quantities (stored for query/export speed)
  area_sf         numeric(10,4) GENERATED ALWAYS AS (
                    CASE WHEN length_in IS NOT NULL AND height_in IS NOT NULL
                    THEN ROUND((length_in * height_in) / 144.0, 4) END
                  ) STORED,
  lf              numeric(10,4) GENERATED ALWAYS AS (
                    CASE WHEN length_in IS NOT NULL AND height_in IS NULL
                    THEN ROUND(length_in / 12.0, 4) END
                  ) STORED,
  volume_cf       numeric(10,4) GENERATED ALWAYS AS (
                    CASE WHEN length_in IS NOT NULL AND height_in IS NOT NULL AND depth_in IS NOT NULL
                    THEN ROUND((length_in * height_in * depth_in) / 1728.0, 4) END
                  ) STORED,
  -- Tracking
  date_observed   date,
  date_repaired   date,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','complete','rejected')),
  si_report_ref   text,                  -- e.g. "SI-003"
  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rqi_project_idx   ON public.repair_quantity_items(project_id);
CREATE INDEX IF NOT EXISTS rqi_stack_idx     ON public.repair_quantity_items(stack_id);
CREATE INDEX IF NOT EXISTS rqi_type_idx      ON public.repair_quantity_items(repair_type);

-- RLS
ALTER TABLE public.repair_stacks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repair_quantity_items  ENABLE ROW LEVEL SECURITY;

-- Owner: full access
CREATE POLICY rqs_owner_all ON public.repair_stacks
  FOR ALL TO public USING (plz_is_owner());
CREATE POLICY rqi_owner_all ON public.repair_quantity_items
  FOR ALL TO public USING (plz_is_owner());

-- Staff: full CRUD on their projects
CREATE POLICY rqs_staff_all ON public.repair_stacks
  FOR ALL TO public
  USING (plz_role() = 'staff' AND plz_has_project(project_id));
CREATE POLICY rqi_staff_all ON public.repair_quantity_items
  FOR ALL TO public
  USING (plz_role() = 'staff' AND plz_has_project(project_id));

-- Member: read + insert + update own entries
CREATE POLICY rqs_member_read ON public.repair_stacks
  FOR SELECT TO public
  USING (plz_role() = 'member' AND plz_has_project(project_id));
CREATE POLICY rqi_member_read ON public.repair_quantity_items
  FOR SELECT TO public
  USING (plz_role() = 'member' AND plz_has_project(project_id));
CREATE POLICY rqi_member_insert ON public.repair_quantity_items
  FOR INSERT TO public
  WITH CHECK (plz_role() = 'member' AND plz_has_project(project_id));
CREATE POLICY rqi_member_update ON public.repair_quantity_items
  FOR UPDATE TO public
  USING (plz_role() = 'member' AND plz_has_project(project_id) AND created_by = current_setting('request.jwt.claims', true)::json->>'sub');

-- Contractor: read their own stack totals only
CREATE POLICY rqs_contractor_read ON public.repair_stacks
  FOR SELECT TO public
  USING (plz_role() = 'contractor' AND plz_project_code() = (SELECT code FROM projects WHERE id=project_id));
CREATE POLICY rqi_contractor_read ON public.repair_quantity_items
  FOR SELECT TO public
  USING (plz_role() = 'contractor' AND stack_label = ANY(
    SELECT label FROM repair_stacks WHERE project_id = repair_quantity_items.project_id
  ));
