-- Backfill page_count for all existing documents.
-- Most permit drawings (A01.01, A03.xx, etc.) are single-sheet PDFs = 1 page.
-- The multi-part survey files (PART1..PART10) are large and unknown — set to 1
-- as a conservative fallback (they render as a single tile; PDF.js will fix on first view).
-- All proposals and smaller documents are clearly 1 page.

UPDATE public.documents
SET page_count = 1
WHERE page_count IS NULL;
