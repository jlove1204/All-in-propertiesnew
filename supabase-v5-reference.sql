-- ALL IN PROPERTIES LLC v5 reference schema
-- The live Supabase project was already migrated by ChatGPT.
-- This file is for backup/reference and is intentionally idempotent where practical.

alter table public.properties
  add column if not exists general_area text,
  add column if not exists general_area_description text,
  add column if not exists cancellation_policy text,
  add column if not exists pets_allowed boolean not null default false,
  add column if not exists smoking_allowed boolean not null default false,
  add column if not exists parties_allowed boolean not null default false;

alter table public.reservations
  add column if not exists guest_portal_token_hash text,
  add column if not exists guest_portal_token_created_at timestamptz,
  add column if not exists guest_portal_last_accessed_at timestamptz,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version text,
  add column if not exists owner_checkin_message text,
  add column if not exists access_code text,
  add column if not exists internal_notes text,
  add column if not exists special_requests text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text;

create table if not exists public.property_private_details (
  property_id uuid primary key references public.properties(id) on delete cascade,
  address_line1 text,
  address_line2 text,
  city text,
  state_region text not null default 'FL',
  postal_code text,
  arrival_instructions text,
  parking_instructions text,
  wifi_name text,
  wifi_password text,
  access_instructions text,
  checkout_instructions text,
  directions_notes text,
  emergency_contact text,
  updated_at timestamptz not null default now()
);

create table if not exists public.reservation_messages (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  sender text not null check (sender in ('owner','guest','system')),
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_by_owner_at timestamptz,
  read_by_guest_at timestamptz
);

create unique index if not exists reservations_guest_portal_token_hash_uidx
  on public.reservations (guest_portal_token_hash)
  where guest_portal_token_hash is not null;
create index if not exists reservations_guest_email_confirmation_idx
  on public.reservations (lower(guest_email), confirmation_code);
create index if not exists reservations_status_checkin_idx
  on public.reservations (status, check_in);
create index if not exists reservation_messages_reservation_created_idx
  on public.reservation_messages (reservation_id, created_at);
create index if not exists reservation_messages_owner_unread_idx
  on public.reservation_messages (reservation_id, created_at)
  where sender='guest' and read_by_owner_at is null;
create index if not exists reservation_messages_guest_unread_idx
  on public.reservation_messages (reservation_id, created_at)
  where sender='owner' and read_by_guest_at is null;

alter table public.property_private_details enable row level security;
alter table public.reservation_messages enable row level security;
revoke all on table public.property_private_details from anon, authenticated;
revoke all on table public.reservation_messages from anon, authenticated;
grant select,insert,update,delete on table public.property_private_details to service_role;
grant select,insert,update,delete on table public.reservation_messages to service_role;
