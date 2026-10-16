-- ISS Laboratory module for InfinityCRM
-- Run once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
-- Adds only; nothing existing is removed.

-- ===== Numbering: lab reports (ISSL-2026-0001) and lab client references (LAB-0001) =====
insert into public.number_sequences (number_type, scope_year, prefix, padding, yearly, next_value, active) values
  ('lab_report', 0, 'ISSL-', 4, true, 1, true),
  ('lab_client', 0, 'LAB-', 4, false, 1, true)
on conflict do nothing;

-- ===== Clients: LAB reference + ISS Lab as a source =====
alter table public.clients add column if not exists lab_ref text unique;
alter table public.clients drop constraint if exists clients_source_check;
alter table public.clients add constraint clients_source_check check (source = any (array[
  'market_stall','website','networking_event','referral','instagram','facebook','academy','iss_lab','other']));
drop trigger if exists trg_clients_protect_lab_ref on public.clients;
create trigger trg_clients_protect_lab_ref before update on public.clients
  for each row execute function public.protect_number('lab_ref');

create or replace function public.lab_client_ref(p_client_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v text; candidate text; taken boolean; tries int := 0;
begin
  if not private.is_supervisor() then raise exception 'Supervisor role required'; end if;
  select lab_ref into v from public.clients where id = p_client_id;
  if not found then raise exception 'Client not found'; end if;
  if v is not null then return v; end if;
  loop
    candidate := public.next_number('lab_client');
    select exists (select 1 from public.clients where lab_ref = candidate) into taken;
    exit when not taken;
    tries := tries + 1; if tries > 1000 then raise exception 'Could not find a free LAB number'; end if;
  end loop;
  perform set_config('iss.number_override', 'on', true);
  update public.clients set lab_ref = candidate where id = p_client_id;
  perform set_config('iss.number_override', 'off', true);
  return candidate;
end $$;
revoke all on function public.lab_client_ref(uuid) from public, anon;
grant execute on function public.lab_client_ref(uuid) to authenticated;

-- ===== Lab settings (single row) =====
create table if not exists public.lab_settings (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.lab_settings enable row level security;
drop policy if exists "supervisors manage lab settings" on public.lab_settings;
create policy "supervisors manage lab settings" on public.lab_settings
  for all to authenticated using (private.is_supervisor()) with check (private.is_supervisor());
drop trigger if exists trg_lab_settings_updated on public.lab_settings;
create trigger trg_lab_settings_updated before update on public.lab_settings
  for each row execute function public.set_updated_at();

insert into public.lab_settings (id, data) values (1, jsonb_build_object(
  'businessName','ISS Laboratory','parent','Infinity Sparkle Studios','gemmologist','Martha du Plessis',
  'credentials','GIA Gemologist · Accredited Jewellery Professional','phone','0790400809',
  'email','ISSLaboratory@infinitysstudio.com','address','','payLink','','bank','','verifyUrl','','logo','',
  'remindMonths',24,
  'services', jsonb_build_array(
    jsonb_build_object('id','idLoose','label','Identification Report — loose stone (up to 15 ct)','price',850),
    jsonb_build_object('id','idMounted','label','Identification Report — mounted stone','price',950),
    jsonb_build_object('id','addStone','label','Additional stone, same submission','price',350),
    jsonb_build_object('id','idVal','label','Identification + Insurance Valuation (combined)','price',1350),
    jsonb_build_object('id','valSimple','label','Insurance valuation — simple single item','price',750),
    jsonb_build_object('id','valComplex','label','Insurance valuation — complex or multi-stone piece','price',1450),
    jsonb_build_object('id','reval','label','Re-valuation of an ISS-certified item','price',450),
    jsonb_build_object('id','dup','label','Duplicate or reissued certificate','price',250))
)) on conflict (id) do nothing;

-- ===== Lab jobs =====
create table if not exists public.lab_jobs (
  id uuid primary key default gen_random_uuid(),
  report_no text unique,
  verify_code text not null default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
  client_id uuid references public.clients(id) on delete set null,
  client_name text not null,
  client_phone text,
  client_email text,
  client_ref text,
  status text not null default 'received' check (status in ('received','testing','reported')),
  item jsonb not null default '{}'::jsonb,
  photos text[] not null default '{}',
  services jsonb not null default '[]'::jsonb,
  walk_in boolean not null default false,
  total numeric(12,2) not null default 0,
  consent jsonb not null default '{}'::jsonb,
  micrographs jsonb not null default '[]'::jsonb,
  tests jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  valuation jsonb not null default '{}'::jsonb,
  public_photo text,
  report_issued_at timestamptz,
  paid boolean not null default false,
  paid_at timestamptz,
  pay_method text,
  pay_ref text,
  amount_paid numeric(12,2),
  receipt_no text,
  reminder_due date,
  reminder_sent_at timestamptz,
  reminder_count integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.lab_jobs enable row level security;
create index if not exists lab_jobs_client_idx on public.lab_jobs (client_id);
create index if not exists lab_jobs_created_idx on public.lab_jobs (created_at desc);
create index if not exists lab_jobs_reminder_idx on public.lab_jobs (reminder_due);

drop policy if exists "supervisors manage lab jobs" on public.lab_jobs;
create policy "supervisors manage lab jobs" on public.lab_jobs
  for all to authenticated using (private.is_supervisor()) with check (private.is_supervisor());

drop trigger if exists trg_lab_jobs_number on public.lab_jobs;
create trigger trg_lab_jobs_number before insert on public.lab_jobs
  for each row execute function public.assign_number('lab_report', 'report_no');
drop trigger if exists trg_lab_jobs_protect_no on public.lab_jobs;
create trigger trg_lab_jobs_protect_no before update on public.lab_jobs
  for each row execute function public.protect_number('report_no');
drop trigger if exists trg_lab_jobs_updated on public.lab_jobs;
create trigger trg_lab_jobs_updated before update on public.lab_jobs
  for each row execute function public.set_updated_at();

-- Re-test / re-valuation reminder date, set automatically when a report is issued
create or replace function private.lab_set_reminder()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m int;
begin
  if new.status = 'reported' and new.report_issued_at is null then new.report_issued_at := now(); end if;
  if new.status = 'reported' and new.reminder_due is null and (tg_op = 'INSERT' or old.status is distinct from 'reported') then
    select coalesce((data->>'remindMonths')::int, 24) into m from public.lab_settings where id = 1;
    new.reminder_due := ((new.report_issued_at at time zone 'Africa/Johannesburg')::date
                         + make_interval(months => coalesce(m, 24)))::date;
  end if;
  return new;
end $$;
drop trigger if exists trg_lab_jobs_reminder on public.lab_jobs;
create trigger trg_lab_jobs_reminder before insert or update on public.lab_jobs
  for each row execute function private.lab_set_reminder();

-- ===== Supervisor renumber now also covers lab reports =====
create or replace function public.supervisor_renumber(p_table text, p_record_id uuid, p_new_number text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $function$
declare col text; ntype text; pfx text; old_no text; taken boolean;
begin
  if not private.is_supervisor() then raise exception 'Supervisor role required'; end if;
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'Please give a reason'; end if;
  case p_table
    when 'clients' then col := 'client_no'; ntype := 'client';
    when 'orders' then col := 'order_no'; ntype := 'order';
    when 'lab_jobs' then col := 'report_no'; ntype := 'lab_report';
    else raise exception 'Renumbering is not set up for table %', p_table;
  end case;
  select prefix into pfx from public.number_sequences where number_type = ntype and scope_year = 0;
  if p_new_number not like pfx || '%' then raise exception 'New number must start with %', pfx; end if;
  execute format('select %I from public.%I where id = $1', col, p_table) into old_no using p_record_id;
  if old_no is null then raise exception 'Record not found'; end if;
  execute format('select exists (select 1 from public.%I where %I = $1)', p_table, col) into taken using p_new_number;
  if taken then raise exception 'Number % is already in use', p_new_number; end if;
  perform set_config('iss.number_override', 'on', true);
  execute format('update public.%I set %I = $1 where id = $2', p_table, col) using p_new_number, p_record_id;
  perform set_config('iss.number_override', 'off', true);
  insert into public.number_overrides (table_name, record_id, number_type, action, old_number, new_number, reason, overridden_by)
    values (p_table, p_record_id, ntype, 'renumber', old_no, p_new_number, p_reason, auth.uid());
  return p_new_number;
end $function$;

-- ===== Public report verification (never returns client details or valuation amount) =====
create or replace function public.verify_lab_report(p_report_no text, p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'report_no', j.report_no,
    'issued', j.report_issued_at,
    'description', j.item->>'description',
    'setting', j.item->>'setting',
    'weight', coalesce(nullif(j.tests->>'weight',''), j.item->>'estWeight'),
    'measurements', coalesce(nullif(j.tests->>'measurements',''), j.item->>'measurements'),
    'shape_cut', coalesce(nullif(j.result->>'shapeCut',''), j.item->>'shape'),
    'colour', coalesce(nullif(j.result->>'colour',''), j.item->>'colour'),
    'species', j.result->>'species',
    'variety', j.result->>'variety',
    'origin', j.result->>'origin',
    'treatment', j.result->>'treatment',
    'ri', j.tests->>'ri', 'sg', j.tests->>'sg', 'optic', j.tests->>'optic',
    'valuation_included', coalesce(j.valuation->>'amount','') <> '',
    'photo', j.public_photo,
    'lab', s.data->>'businessName',
    'gemmologist', s.data->>'gemmologist',
    'credentials', s.data->>'credentials',
    'logo', s.data->>'logo')
  from public.lab_jobs j left join public.lab_settings s on s.id = 1
  where upper(j.report_no) = upper(trim(p_report_no))
    and upper(j.verify_code) = upper(trim(p_code))
    and j.status = 'reported'
$$;
revoke all on function public.verify_lab_report(text, text) from public;
grant execute on function public.verify_lab_report(text, text) to anon, authenticated;

-- ===== Photo storage =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('lab-private', 'lab-private', false, 15728640, array['image/jpeg','image/png']),
  ('lab-public',  'lab-public',  true,  5242880,  array['image/jpeg','image/png'])
on conflict (id) do nothing;

drop policy if exists "lab private: supervisors read" on storage.objects;
drop policy if exists "lab private: supervisors upload" on storage.objects;
drop policy if exists "lab private: supervisors update" on storage.objects;
drop policy if exists "lab private: supervisors delete" on storage.objects;
drop policy if exists "lab public: supervisors read" on storage.objects;
drop policy if exists "lab public: supervisors upload" on storage.objects;
drop policy if exists "lab public: supervisors update" on storage.objects;
drop policy if exists "lab public: supervisors delete" on storage.objects;
create policy "lab private: supervisors read" on storage.objects for select to authenticated
  using (bucket_id = 'lab-private' and private.is_supervisor());
create policy "lab private: supervisors upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'lab-private' and private.is_supervisor());
create policy "lab private: supervisors update" on storage.objects for update to authenticated
  using (bucket_id = 'lab-private' and private.is_supervisor());
create policy "lab private: supervisors delete" on storage.objects for delete to authenticated
  using (bucket_id = 'lab-private' and private.is_supervisor());
create policy "lab public: supervisors read" on storage.objects for select to authenticated
  using (bucket_id = 'lab-public' and private.is_supervisor());
create policy "lab public: supervisors upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'lab-public' and private.is_supervisor());
create policy "lab public: supervisors update" on storage.objects for update to authenticated
  using (bucket_id = 'lab-public' and private.is_supervisor());
create policy "lab public: supervisors delete" on storage.objects for delete to authenticated
  using (bucket_id = 'lab-public' and private.is_supervisor());
