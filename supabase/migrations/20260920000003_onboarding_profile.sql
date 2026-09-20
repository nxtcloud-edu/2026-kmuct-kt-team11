-- Onboarding profile.
--
-- Four nullable columns for the four things onboarding asks after the nickname.
-- display_name is reused as the nickname rather than adding a column: it is
-- already not null, already rendered in groups, and a second name field would
-- immediately raise the question of which one is shown where.
--
-- age_band, not an exact age. It buckets identically for recommendation
-- purposes and is materially less invasive to ask of someone who has just
-- arrived. Every column here is optional; only the nickname is required, and
-- that one already existed.

alter table users
  add column gender       text check (gender in ('female','male','undisclosed')),
  add column age_band     text check (age_band in ('10s','20s','30s','40s','50plus')),
  add column mbti         text check (mbti ~ '^[EI][SN][TF][JP]$'),
  -- Set when onboarding finishes, whether or not the optional steps were
  -- answered. Skipping is a valid answer; being asked twice is not.
  add column onboarded_at timestamptz;

create index users_onboarded_idx on users (onboarded_at) where onboarded_at is null;
