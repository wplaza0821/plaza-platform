-- SMS consent capture on the public "request access" form (A2P 10DLC compliance).
--
-- US carriers (via TCR / The Campaign Registry) require that an A2P 10DLC
-- campaign's stated Call-to-Action actually exist on a publicly reachable page,
-- and that the sender retain proof of express written consent for each
-- recipient. Campaign QE2c6890da8086d771620e9b13fadeba0b was rejected with
-- error 30909 (MESSAGE_FLOW) because the described opt-in checkbox did not
-- exist on any public page — plazacore.plazaandassociates.com is login-gated.
--
-- These columns record, per request:
--   sms_consent          — did the visitor affirmatively check the box (opt-in)
--   sms_consent_at       — when consent was given
--   sms_consent_text     — the exact disclosure language shown at the time,
--                          retained verbatim as consent evidence for audits
-- Consent is OPT-IN ONLY: default false, never pre-checked in the UI.

alter table public.access_requests
  add column if not exists sms_consent      boolean not null default false,
  add column if not exists sms_consent_at   timestamptz,
  add column if not exists sms_consent_text text;

comment on column public.access_requests.sms_consent is
  'Express written consent to receive SMS. Opt-in only; false unless the visitor checked the box.';
comment on column public.access_requests.sms_consent_at is
  'Timestamp consent was captured (null when sms_consent is false).';
comment on column public.access_requests.sms_consent_text is
  'Verbatim disclosure language displayed when consent was given — retained as A2P consent evidence.';

-- Re-assert the public insert policy so the new columns are covered:
-- anonymous visitors may still only create a PENDING request, and a consent
-- timestamp + disclosure text must accompany any true consent value (prevents
-- a forged "consented" row with no evidence attached).
drop policy if exists ar_public_insert on public.access_requests;
create policy ar_public_insert on public.access_requests
  for insert to anon, authenticated
  with check (
    status = 'pending'
    and char_length(full_name) between 2 and 120
    and char_length(email) between 5 and 200
    and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and (company is null or char_length(company) <= 200)
    and (phone   is null or char_length(phone)   <= 40)
    and (message is null or char_length(message) <= 2000)
    -- consent must carry its evidence, and requires a phone number to apply to
    and (
      sms_consent = false
      or (
        sms_consent_at is not null
        and sms_consent_text is not null
        and char_length(sms_consent_text) between 20 and 2000
        and phone is not null
        and char_length(phone) >= 7
      )
    )
  );
