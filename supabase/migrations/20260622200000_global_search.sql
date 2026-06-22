-- ============================================================================
-- Global Search: full-text search across field_reports + documents
-- 2026-06-22
--   * field_reports.extracted_text  : raw PDF body text (backfilled by sync)
--   * field_reports.search_tsv       : generated tsvector over key fields + text
--   * documents.search_tsv           : generated tsvector over name/sheet/category
--   * plz_global_search(q, p_project) : unified, RLS-respecting search RPC
-- RLS: the RPC is SECURITY INVOKER, so it returns ONLY rows the calling user is
--      allowed to see (owner/staff/member/contractor policies still apply).
-- ============================================================================

-- 1. field_reports: raw extracted text column ------------------------------
ALTER TABLE public.field_reports
  ADD COLUMN IF NOT EXISTS extracted_text text;

-- 2. field_reports: generated search vector --------------------------------
ALTER TABLE public.field_reports
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(report_number,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(inspector,'')),      'B') ||
    setweight(to_tsvector('english', coalesce(work_observed,'')),  'B') ||
    setweight(to_tsvector('english', coalesce(findings,'')),       'B') ||
    setweight(to_tsvector('english', coalesce(deficiencies_noted,'')),'B') ||
    setweight(to_tsvector('english', coalesce(recommendations,'')),'B') ||
    setweight(to_tsvector('english', coalesce(weather,'')),        'C') ||
    setweight(to_tsvector('english', coalesce(materials_used,'')), 'C') ||
    setweight(to_tsvector('english', coalesce(extracted_text,'')), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS field_reports_search_tsv_idx
  ON public.field_reports USING gin (search_tsv);

-- 3. documents: generated search vector ------------------------------------
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name,'')),         'A') ||
    setweight(to_tsvector('english', coalesce(sheet_number,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(category,'')),     'B') ||
    setweight(to_tsvector('english', coalesce(revision,'')),     'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS documents_search_tsv_idx
  ON public.documents USING gin (search_tsv);

-- 4. Unified search RPC -----------------------------------------------------
-- Returns a normalized result row from either table. websearch_to_tsquery
-- gives Google-style query parsing ("foundation crack", quoted phrases, OR).
DROP FUNCTION IF EXISTS public.plz_global_search(text, uuid);
CREATE OR REPLACE FUNCTION public.plz_global_search(q text, p_project uuid DEFAULT NULL)
RETURNS TABLE (
  kind         text,    -- 'report' | 'document'
  id           uuid,
  project_id   uuid,
  title        text,    -- report_number / document name
  subtitle     text,    -- report_type+date / category+sheet
  snippet      text,    -- ts_headline excerpt
  file_path    text,
  rank         real
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH tq AS (SELECT websearch_to_tsquery('english', q) AS query)
  -- field reports
  SELECT
    'report'::text AS kind,
    fr.id,
    fr.project_id,
    fr.report_number AS title,
    (coalesce(fr.report_type,'') || ' · ' || coalesce(fr.visit_date::text,'')) AS subtitle,
    ts_headline('english',
      coalesce(nullif(fr.findings,''),
               nullif(fr.work_observed,''),
               nullif(fr.extracted_text,''),''),
      tq.query,
      'MaxFragments=2,MinWords=4,MaxWords=18,StartSel=<mark>,StopSel=</mark>'
    ) AS snippet,
    fr.file_path,
    ts_rank(fr.search_tsv, tq.query) AS rank
  FROM public.field_reports fr, tq
  WHERE fr.search_tsv @@ tq.query
    AND (p_project IS NULL OR fr.project_id = p_project)

  UNION ALL
  -- documents
  SELECT
    'document'::text AS kind,
    d.id,
    d.project_id,
    coalesce(nullif(d.name,''), d.sheet_number, 'Document') AS title,
    (coalesce(d.category,'') ||
       CASE WHEN d.sheet_number IS NOT NULL AND d.sheet_number<>''
            THEN ' · ' || d.sheet_number ELSE '' END) AS subtitle,
    coalesce(d.name,'') AS snippet,
    d.file_path,
    ts_rank(d.search_tsv, tq.query) AS rank
  FROM public.documents d, tq
  WHERE d.search_tsv @@ tq.query
    AND (p_project IS NULL OR d.project_id = p_project)

  ORDER BY rank DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.plz_global_search(text, uuid)
  TO anon, authenticated, service_role;
