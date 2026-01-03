create extension if not exists "pgcrypto";

create table if not exists public.resumes (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references auth.users (id),
  candidate_name text,
  job_id text,
  file_bucket text,
  file_path text,
  raw_text text,
  parsed jsonb,
  parser_version text,
  status text default 'parsed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.resumes enable row level security;

create policy "Users can insert their own resumes"
  on public.resumes
  for insert
  with check (auth.uid() = created_by);

create policy "Users can view their own resumes"
  on public.resumes
  for select
  using (auth.uid() = created_by);

create index if not exists resumes_created_at_idx on public.resumes (created_at desc);

