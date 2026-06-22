-- ─────────────────────────────────────────────────────────────────────────────
-- Add Tower dimension to Repair Quantities (Park / River for Terrazas 26011)
-- Each repair quantity entry can be tagged with a tower so quantities can be
-- differentiated and documented per tower. Nullable + free-text so it stays
-- generic for projects that do not use towers.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.repair_quantity_items
  ADD COLUMN IF NOT EXISTS tower text;

CREATE INDEX IF NOT EXISTS rqi_tower_idx
  ON public.repair_quantity_items(project_id, tower);

COMMENT ON COLUMN public.repair_quantity_items.tower IS
  'Building/tower designation (e.g. "Park", "River" for Terrazas Riverpark Village). NULL for projects without towers.';
