-- =====================================================================
-- PLAZACORE PHASE 4-09 — SOV QUANTITY / UNIT / UNIT PRICE
-- The Schedule of Values stored only a lump `scheduled_value` per line.
-- Real AIA G703 / contract SOVs are unit-priced: quantity x unit price =
-- scheduled value. Add those columns so the contract's unit pricing is
-- captured and displayed. scheduled_value remains the source of truth for
-- billing math (so existing 95 rows + pay-app reconciliation are untouched);
-- the new columns are descriptive contract detail.
-- Re-runnable.
-- =====================================================================
begin;

alter table sov_items add column if not exists quantity   numeric;
alter table sov_items add column if not exists unit       text;
alter table sov_items add column if not exists unit_price numeric;

comment on column sov_items.quantity   is 'Contract quantity for this line (nullable for lump-sum lines).';
comment on column sov_items.unit       is 'Unit of measure: LS, SF, LF, CY, EA, etc.';
comment on column sov_items.unit_price is 'Contract unit price; quantity * unit_price should equal scheduled_value.';

commit;

-- Frontend:
--   scheduled_value stays authoritative for billing/% used/balance.
--   When qty + unit_price are both present, scheduled_value auto-computes
--   (qty * unit_price) in the editor; lump-sum lines leave qty/unit_price null
--   and just enter scheduled_value directly.
