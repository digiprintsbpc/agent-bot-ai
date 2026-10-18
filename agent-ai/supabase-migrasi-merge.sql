-- ============================================================
-- Migrasi MERGE bot lama + bot baru (satu bot, dua tampilan)
-- Jalankan di Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. STATE MENU ADMIN (pengganti userState in-memory di bot lama)
create table if not exists admin_states (
  user_id    text primary key,
  step       text not null default '',
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- 2. PROFIL TOKO (pengganti store_profile.json)
create table if not exists store_profile (
  id         int primary key default 1,
  nama       text not null default 'Toko Cetak Custom',
  alamat     text not null default '-',
  kontak     text not null default '-',
  logo       text not null default '',
  updated_at timestamptz not null default now()
);
insert into store_profile (id) values (1) on conflict (id) do nothing;

-- 3. ANTREAN PESAN WA (Vercel tulis, panel/Baileys kirim)
create table if not exists wa_outbox (
  id         uuid primary key default gen_random_uuid(),
  to_wa      text not null,
  kind       text not null default 'text',   -- text | image
  content    text not null,                   -- teks pesan / URL gambar
  caption    text,
  status     text not null default 'pending', -- pending | sent | failed
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_outbox_status on wa_outbox (status, created_at);

-- 4. LOG FOLLOW-UP (pengganti Set in-memory, anti kirim dobel)
create table if not exists followup_log (
  order_id text primary key,
  sent_at  timestamptz not null default now()
);

-- RLS: samakan pola tabel lain (full access untuk authenticated; service_role bypass)
alter table admin_states  enable row level security;
alter table store_profile enable row level security;
alter table wa_outbox     enable row level security;
alter table followup_log  enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'full access' and tablename = 'admin_states') then
    create policy "full access" on admin_states  for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'full access' and tablename = 'store_profile') then
    create policy "full access" on store_profile for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'full access' and tablename = 'wa_outbox') then
    create policy "full access" on wa_outbox     for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'full access' and tablename = 'followup_log') then
    create policy "full access" on followup_log  for all to authenticated using (true) with check (true);
  end if;
end $$;
