-- Migration: add closeout photo columns to deficiencies
-- Run in Supabase SQL editor for project xpeppmurxgbqlsabswqn

alter table deficiencies
  add column if not exists closeout_photo_path text,
  add column if not exists closeout_photo_name text,
  add column if not exists closeout_photo_size bigint;
