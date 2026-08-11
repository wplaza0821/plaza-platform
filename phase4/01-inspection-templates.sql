-- =====================================================================
-- PLAZACORE PHASE 4-01 — INSPECTION TEMPLATES (FBC / ASTM / ICRI)
-- P0 #2. Turns free-text field_reports into structured, standards-tied
-- checklists. This is the firm's #1 deliverable.
-- Pattern: owner full; contractor read on own project. Re-runnable.
-- =====================================================================
begin;

-- Master template catalog (reusable checklist definitions)
create table if not exists inspection_templates (
  id uuid primary key default uuid_generate_v4(),
  name        text not null,                 -- "FBC Threshold - Concrete Placement"
  standard    text,                          -- 'FBC' | 'ASTM' | 'ICRI' | 'AISC' | 'other'
  discipline  text,                          -- 'structural' | 'concrete' | 'masonry' | 'waterproofing' | ...
  code_ref    text,                          -- e.g. "FBC 1705.3", "ASTM C172"
  description text,
  -- checklist schema: array of {key,label,type:pass_fail_na|numeric|text|photo,required,code_ref,note}
  schema      jsonb not null default '[]'::jsonb,
  active      boolean default true,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists insp_tpl_standard_idx on inspection_templates(standard);

alter table inspection_templates enable row level security;
drop policy if exists insp_tpl_owner_all       on inspection_templates;
drop policy if exists insp_tpl_contractor_read on inspection_templates;
create policy insp_tpl_owner_all on inspection_templates for all
  using (plz_is_owner()) with check (plz_is_owner());
create policy insp_tpl_contractor_read on inspection_templates for select
  using (plz_role() = 'contractor');   -- templates are not project-secret

-- Link field_reports to a template + store the filled checklist results.
alter table field_reports
  add column if not exists template_id uuid references inspection_templates(id),
  add column if not exists checklist   jsonb default '[]'::jsonb,  -- filled answers
  add column if not exists pass_count  int,
  add column if not exists fail_count  int,
  add column if not exists na_count    int;

-- Seed a few starter templates the firm actually uses (idempotent by name).
insert into inspection_templates (name, standard, discipline, code_ref, description, schema)
select * from (values
  ('FBC Threshold - Concrete Placement','FBC','concrete','FBC 1705.3',
   'Special inspection of concrete placement per FBC Chapter 17.',
   '[
     {"key":"mix_design","label":"Approved mix design on site","type":"pass_fail_na","required":true,"code_ref":"ACI 318"},
     {"key":"slump","label":"Slump test (in)","type":"numeric","required":true,"code_ref":"ASTM C143"},
     {"key":"air_content","label":"Air content (%)","type":"numeric","required":false,"code_ref":"ASTM C231"},
     {"key":"cylinders","label":"Test cylinders cast","type":"pass_fail_na","required":true,"code_ref":"ASTM C31"},
     {"key":"rebar_placement","label":"Reinforcement size/spacing/cover verified","type":"pass_fail_na","required":true,"code_ref":"FBC 1705.3"},
     {"key":"consolidation","label":"Consolidation observed","type":"pass_fail_na","required":true},
     {"key":"photos","label":"Photos","type":"photo","required":false}
   ]'::jsonb),
  ('ICRI Concrete Repair Inspection','ICRI','concrete','ICRI 310.1R',
   'Inspection of concrete surface repair per ICRI guidelines.',
   '[
     {"key":"surface_prep","label":"Surface prep / ICRI CSP profile achieved","type":"pass_fail_na","required":true,"code_ref":"ICRI 310.2R"},
     {"key":"sound_concrete","label":"Unsound concrete removed to sound substrate","type":"pass_fail_na","required":true},
     {"key":"reinf_cleaned","label":"Exposed reinforcement cleaned (SSPC-SP)","type":"pass_fail_na","required":true},
     {"key":"bonding_agent","label":"Bonding agent applied per spec","type":"pass_fail_na","required":false},
     {"key":"repair_material","label":"Repair mortar / material batch verified","type":"pass_fail_na","required":true},
     {"key":"cure","label":"Curing method observed","type":"pass_fail_na","required":true},
     {"key":"photos","label":"Photos","type":"photo","required":false}
   ]'::jsonb),
  ('FBC Threshold - Masonry','FBC','masonry','FBC 1705.4',
   'Special inspection of masonry per FBC Chapter 17.',
   '[
     {"key":"units","label":"Masonry units / type verified","type":"pass_fail_na","required":true},
     {"key":"mortar_grout","label":"Mortar/grout proportions verified","type":"pass_fail_na","required":true,"code_ref":"ASTM C270"},
     {"key":"reinf","label":"Reinforcement placement / lap verified","type":"pass_fail_na","required":true},
     {"key":"grout_lift","label":"Grout lift height within limits","type":"pass_fail_na","required":true},
     {"key":"prisms","label":"Prisms / grout samples taken","type":"pass_fail_na","required":false,"code_ref":"ASTM C1314"},
     {"key":"photos","label":"Photos","type":"photo","required":false}
   ]'::jsonb)
) as v(name,standard,discipline,code_ref,description,schema)
where not exists (select 1 from inspection_templates t where t.name = v.name);

commit;
