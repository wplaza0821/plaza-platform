CREATE TABLE IF NOT EXISTS public.schedule_imports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  file_name    text NOT NULL,
  file_path    text NOT NULL,
  file_type    text,              -- 'xlsx','csv','xml','pdf','mpp'
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','analyzed','applied','rejected')),
  uploaded_by  text,
  notes        text,
  analyzed_at  timestamptz,
  applied_at   timestamptz,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedule_imports_project_idx ON public.schedule_imports(project_id);

ALTER TABLE public.schedule_imports ENABLE ROW LEVEL SECURITY;

-- Owner / staff: full access
CREATE POLICY si_owner_all ON public.schedule_imports
  FOR ALL TO public USING (plz_is_owner());
CREATE POLICY si_staff_all ON public.schedule_imports
  FOR ALL TO public
  USING (plz_role() = 'staff' AND plz_has_project(project_id));

-- Contractors: insert + read own
CREATE POLICY si_contractor_insert ON public.schedule_imports
  FOR INSERT TO public
  WITH CHECK (plz_role() = 'contractor' AND plz_has_project(project_id));
CREATE POLICY si_contractor_read ON public.schedule_imports
  FOR SELECT TO public
  USING (plz_role() = 'contractor' AND plz_has_project(project_id));

-- Members: read only
CREATE POLICY si_member_read ON public.schedule_imports
  FOR SELECT TO public
  USING (plz_role() = 'member' AND plz_has_project(project_id));
