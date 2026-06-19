-- submittal_files: file attachments on submittals
CREATE TABLE IF NOT EXISTS public.submittal_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submittal_id  uuid NOT NULL REFERENCES public.submittals(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  file_name     text NOT NULL,
  file_path     text NOT NULL,
  file_type     text,
  file_size     bigint,
  uploaded_by   text,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submittal_files_sub_idx ON public.submittal_files(submittal_id);
CREATE INDEX IF NOT EXISTS submittal_files_proj_idx ON public.submittal_files(project_id);
ALTER TABLE public.submittal_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY sf_owner ON public.submittal_files FOR ALL TO public USING (plz_is_owner());
CREATE POLICY sf_staff  ON public.submittal_files FOR ALL TO public USING (plz_role()='staff' AND plz_has_project(project_id));
CREATE POLICY sf_member_read ON public.submittal_files FOR SELECT TO public USING (plz_role()='member' AND plz_has_project(project_id));
CREATE POLICY sf_contractor_read ON public.submittal_files FOR SELECT TO public USING (plz_role()='contractor' AND plz_has_project(project_id));
CREATE POLICY sf_contractor_insert ON public.submittal_files FOR INSERT TO public WITH CHECK (plz_role()='contractor' AND plz_has_project(project_id));

-- schedule_tasks: parsed Gantt task rows from MS Project imports
CREATE TABLE IF NOT EXISTS public.schedule_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  import_id     uuid REFERENCES public.schedule_imports(id) ON DELETE CASCADE,
  task_name     text NOT NULL,
  start_date    date,
  end_date      date,
  duration_days integer,
  percent_complete numeric(5,2) DEFAULT 0,
  predecessors  text,
  assignee      text,
  notes         text,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedule_tasks_proj_idx ON public.schedule_tasks(project_id);
CREATE INDEX IF NOT EXISTS schedule_tasks_import_idx ON public.schedule_tasks(import_id);
ALTER TABLE public.schedule_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY st_owner ON public.schedule_tasks FOR ALL TO public USING (plz_is_owner());
CREATE POLICY st_staff  ON public.schedule_tasks FOR ALL TO public USING (plz_role()='staff' AND plz_has_project(project_id));
CREATE POLICY st_read   ON public.schedule_tasks FOR SELECT TO public USING (plz_has_project(project_id));
