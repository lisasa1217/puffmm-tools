-- IG 自動回覆系統（泡芙與媽工具箱）
-- 全部資料表開 RLS 且不給任何 policy：只有伺服器（service key）讀得到，網頁的 anon key 碰不到

create table if not exists ar_templates (
  id bigint generated always as identity primary key,
  name text not null,
  text text default '',
  image_url text,
  buttons jsonb default '[]',          -- [{type:'url'|'next'|'gate', title, url?, next?, fail?}]
  created_at timestamptz default now()
);

create table if not exists ar_public_replies (
  id bigint generated always as identity primary key,
  text text not null,
  created_at timestamptz default now()
);

create table if not exists ar_rules (
  id bigint generated always as identity primary key,
  name text not null,
  trigger text not null check (trigger in ('comment','story','dm')),
  media_id text,                        -- 空白＝全部貼文／全部限動
  media_label text,
  media_thumb text,
  keywords text[] default '{}',
  fuzzy boolean default true,           -- 同音錯字也算
  public_reply_ids bigint[] default '{}',
  first_template_id bigint references ar_templates(id) on delete set null,
  cooldown_hours int default 24,        -- 限動／私訊：同一人多久內不重複回
  any_text boolean default false,       -- 任何內容都觸發（不看關鍵字）
  starts_at timestamptz,                -- 什麼時候開始回（空白＝立刻）
  ends_at timestamptz,                  -- 什麼時候停（空白＝一直回）
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists ar_sent (
  rule_id bigint references ar_rules(id) on delete cascade,
  user_id text not null,
  sent_at timestamptz default now(),
  primary key (rule_id, user_id)
);

create table if not exists ar_events (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  rule_id bigint,
  user_id text,
  username text,
  trigger text,
  kind text,          -- trigger / dup / public_reply / dm / button / follow_yes / follow_no / click / error
  keyword text,
  detail text
);
create index if not exists ar_events_created on ar_events (created_at desc);

create table if not exists app_secrets (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

alter table ar_templates enable row level security;
alter table ar_public_replies enable row level security;
alter table ar_rules enable row level security;
alter table ar_sent enable row level security;
alter table ar_events enable row level security;
alter table app_secrets enable row level security;

-- 補發佇列：IG 暫時送不出去的私訊／公開回覆排在這裡，api/ar-retry 會重試
create table if not exists ar_queue (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  rule_id bigint, user_id text, username text,
  kind text,                 -- comment_dm / dm / public_reply
  payload jsonb,             -- 要送的內容（recipient + messages，或 comment_id + message）
  status text default 'pending',   -- pending / sending / sent / failed
  attempts int default 0,
  next_at timestamptz default now(),
  last_error text,
  done_at timestamptz
);
create index if not exists ar_queue_next on ar_queue (status, next_at);
alter table ar_queue enable row level security;

-- 每 5 分鐘叫一次補發（Vercel 免費方案的排程一天只能一次，所以用 Supabase 的 pg_cron）
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.schedule('ar-retry', '*/5 * * * *', $$ select net.http_get('https://pufftool.vercel.app/api/ar-retry') $$);
