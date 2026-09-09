-- ALL IN PROPERTIES: atomic booking hold protection
-- Run this once in Supabase SQL Editor BEFORE testing checkout.

create or replace function public.create_reservation_hold(
  p_confirmation_code text,
  p_property_id uuid,
  p_guest_name text,
  p_guest_email text,
  p_guest_phone text,
  p_check_in date,
  p_check_out date,
  p_guests integer,
  p_nightly_subtotal numeric,
  p_cleaning_fee numeric,
  p_taxes numeric,
  p_total_amount numeric
)
returns table(reservation_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_check_out <= p_check_in then
    raise exception 'INVALID_DATES';
  end if;

  -- Serialize booking attempts per property so two guests cannot win the same dates.
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));

  if exists (
    select 1 from blocked_dates b
    where b.property_id = p_property_id
      and daterange(b.start_date,b.end_date,'[)') && daterange(p_check_in,p_check_out,'[)')
  ) then
    raise exception 'BLOCKED_DATES';
  end if;

  if exists (
    select 1 from reservations r
    where r.property_id = p_property_id
      and daterange(r.check_in,r.check_out,'[)') && daterange(p_check_in,p_check_out,'[)')
      and (
        r.status in ('confirmed','paid')
        or (r.status='pending' and r.created_at > now() - interval '30 minutes')
      )
  ) then
    raise exception 'DATES_UNAVAILABLE';
  end if;

  insert into reservations(
    confirmation_code, property_id, guest_name, guest_email, guest_phone,
    check_in, check_out, guests, nightly_subtotal, cleaning_fee, taxes,
    total_amount, status
  )
  values(
    p_confirmation_code, p_property_id, p_guest_name, p_guest_email, p_guest_phone,
    p_check_in, p_check_out, p_guests, p_nightly_subtotal, p_cleaning_fee, p_taxes,
    p_total_amount, 'pending'
  )
  returning id into v_id;

  return query select v_id;
end;
$$;

revoke all on function public.create_reservation_hold(
  text,uuid,text,text,text,date,date,integer,numeric,numeric,numeric,numeric
) from public, anon, authenticated;

grant execute on function public.create_reservation_hold(
  text,uuid,text,text,text,date,date,integer,numeric,numeric,numeric,numeric
) to service_role;
