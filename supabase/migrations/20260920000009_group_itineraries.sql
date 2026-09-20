-- Group date-course recommendation runs.
-- Stores derived profile snapshots only; raw captions and personal saved-place rows
-- remain in their source tables and are never copied into this result record.

create table group_itineraries (
  id                      uuid primary key default uuidv7(),
  group_id                uuid not null references groups(id) on delete cascade,
  requested_by            uuid not null references users(id) on delete cascade,
  participant_ids         uuid[] not null check (cardinality(participant_ids) between 1 and 8),
  request                 jsonb not null,
  member_profile_snapshot jsonb not null,
  result                  jsonb,
  fairness_score          double precision check (fairness_score between 0 and 1),
  status                  text not null check (status in ('completed','failed')),
  created_at              timestamptz not null default now()
);

create index group_itineraries_group_created_idx
  on group_itineraries (group_id, created_at desc);

revoke all on group_itineraries from anon, authenticated;
alter table group_itineraries enable row level security;
