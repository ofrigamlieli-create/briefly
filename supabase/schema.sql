create table usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  feature text not null,
  input_word_count int,
  model text,
  created_at timestamptz default now()
);

alter table usage_logs enable row level security;

create policy "Users see own logs" on usage_logs
  for select using (auth.uid() = user_id);

create table user_quotas (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',        -- 'free' | 'pro'
  requests_today int not null default 0,
  requests_total int not null default 0,
  last_reset_date date not null default current_date
);

alter table user_quotas enable row level security;

create policy "Users see own quota" on user_quotas
  for select using (auth.uid() = user_id);
