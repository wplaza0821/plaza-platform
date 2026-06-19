-- Add page_count column to documents table so we never need to download
-- the full PDF just to know how many tiles to render in the grid.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS page_count integer;
