-- ============================================================
-- Migrasi: tabel memory untuk Agent AI (dijalankan di Supabase SQL Editor)
-- ============================================================

-- 1) Riwayat percakapan (konteks + konsep obsidian-mind)
create table if not exists agent_memory (
  id bigint generated always as identity primary key,
  user_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists agent_memory_user_idx on agent_memory (user_id, created_at desc);

-- 2) Catatan penting ("ingat bahwa ...")
create table if not exists agent_notes (
  id bigint generated always as identity primary key,
  user_id text not null,
  note text not null,
  created_at timestamptz not null default now()
);
create index if not exists agent_notes_user_idx on agent_notes (user_id, created_at desc);

-- 3) Log aktivitas (untuk dashboard 3D)
create table if not exists agent_activity (
  id bigint generated always as identity primary key,
  user_id text not null,
  kind text not null,            -- chat | toko | security | note
  summary text not null,
  created_at timestamptz not null default now()
);
create index if not exists agent_activity_time_idx on agent_activity (created_at desc);

-- RLS: aktifkan + izinkan full access untuk role authenticated & service_role
alter table agent_memory enable row level security;
alter table agent_notes enable row level security;
alter table agent_activity enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'agent full access' and tablename = 'agent_memory') then
    create policy "agent full access" on agent_memory for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'agent full access' and tablename = 'agent_notes') then
    create policy "agent full access" on agent_notes for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'agent full access' and tablename = 'agent_activity') then
    create policy "agent full access" on agent_activity for all to authenticated using (true) with check (true);
  end if;
end $$;
