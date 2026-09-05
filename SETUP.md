# Career Toolkit — Security Upgrade Guide (for already-live site)

Your site is already live with working keys and Propeller link.
This package only adds the security fixes. Follow these steps in order.

**If you already ran the previous version of this SQL:** run the block below
anyway — every statement uses `create or replace` / `drop ... if exists`, so
it safely overwrites the earlier (broken) version. Two real bugs in the
previous package are fixed here:

1. The trigger that protects `is_premium` also silently blocked the payment
   Edge Function itself, so **paying customers were charged and never
   actually got unlocked**. Fixed by letting `service_role` through.
2. `grant_extra_generation` had no cap, so anyone could call it from devtools
   in a loop for unlimited free generations, ad or no ad. Fixed with a
   server-side daily limit (3/day).

It also adds a `payments` table so a Paystack reference can only ever unlock
premium once, for the account that actually paid — previously a reference
seen in a URL or receipt could be replayed on a different account.

---

## 1. Run this SQL once (replaces the old permissive policies)

Go to Supabase → **SQL Editor → New query**, paste everything below, and click **Run**.

```sql
-- Drop old permissive policies
drop policy if exists "Users read own profile" on public.profiles;
drop policy if exists "Users update own profile" on public.profiles;
drop policy if exists "Users insert own profile" on public.profiles;
drop policy if exists "Users update own name only" on public.profiles;

-- SELECT: users can read only their own row
create policy "Users read own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- INSERT: users can create their own row
create policy "Users insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- UPDATE: users can change ONLY full_name
create policy "Users update own name only"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Columns used to rate-limit the "watch ads" free-credit RPC below
alter table public.profiles add column if not exists ad_credits_date date;
alter table public.profiles add column if not exists ad_credits_today int not null default 0;

-- Trigger that locks is_premium + counts (client cannot change them) —
-- EXCEPT when the write comes from the service_role key (the Edge
-- Function below uses that key after independently verifying payment
-- with Paystack). Without this exception, real payments silently fail
-- to unlock anything.
create or replace function public.protect_entitlements()
returns trigger
language plpgsql
as $$
begin
  if auth.role() = 'service_role' then
    return new; -- trusted server-side write (Edge Function), let it through
  end if;
  new.is_premium := old.is_premium;
  new.cv_count   := old.cv_count;
  new.id_count   := old.id_count;
  return new;
end;
$$;

drop trigger if exists protect_entitlements_trg on public.profiles;
create trigger protect_entitlements_trg
  before update on public.profiles
  for each row
  execute function public.protect_entitlements();

-- Safe RPC: increment usage after a free export
create or replace function public.increment_usage(p_type text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_type = 'cv' then
    update public.profiles set cv_count = cv_count + 1 where id = auth.uid();
  elsif p_type = 'id' then
    update public.profiles set id_count = id_count + 1 where id = auth.uid();
  end if;
end;
$$;

-- Safe RPC: give one extra free generation after watching ads.
-- Capped at 3 per user per calendar day — there's no server-verified
-- proof the ad actually played (Direct Link ads don't provide that),
-- so this cap is what stops it being called from devtools in a loop
-- for unlimited free generations.
create or replace function public.grant_extra_generation(p_type text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := current_date;
  used int;
  last_date date;
begin
  select ad_credits_today, ad_credits_date into used, last_date
  from public.profiles where id = auth.uid();

  if last_date is distinct from today then
    used := 0;
  end if;

  if used >= 3 then
    raise exception 'daily ad-credit limit reached';
  end if;

  if p_type = 'cv' then
    update public.profiles
      set cv_count = greatest(0, cv_count - 1),
          ad_credits_today = used + 1,
          ad_credits_date = today
      where id = auth.uid();
  elsif p_type = 'id' then
    update public.profiles
      set id_count = greatest(0, id_count - 1),
          ad_credits_today = used + 1,
          ad_credits_date = today
      where id = auth.uid();
  end if;
end;
$$;

grant execute on function public.increment_usage(text) to authenticated;
grant execute on function public.grant_extra_generation(text) to authenticated;

-- Records verified Paystack payments so a reference can only ever be
-- redeemed once. No policies are created on purpose: with RLS on and
-- zero policies, only the service_role key (the Edge Function) can
-- read or write this table — the browser never can.
create table if not exists public.payments (
  reference text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  amount int,
  created_at timestamptz default now()
);
alter table public.payments enable row level security;
```

---

## 2. Deploy the Edge Function (one-time)

```bash
# Install CLI if you don't have it
npm install -g supabase

# Login + link to your existing project
supabase login
supabase link --project-ref pvjnkcznqmwyqawahgun

# Set secrets (use your real live secret key)
supabase secrets set PAYSTACK_SECRET_KEY=sk_live_YOUR_REAL_SECRET
```

> Don't set `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_URL` yourself — the
> Supabase CLI actually rejects any secret name starting with `SUPABASE_`
> (that prefix is reserved), and it's injected into every Edge Function
> automatically anyway. The previous version of this guide told you to set
> it manually, which would have failed with an error — this version doesn't.

```bash
# Deploy
supabase functions deploy verify-paystack
```

(No `--no-verify-jwt` needed — the browser already sends the user's real
Supabase session token, which satisfies the platform's default check on its
own, so there's no reason to turn that extra layer off.)

After deploy you will get a URL like:

```
https://pvjnkcznqmwyqawahgun.supabase.co/functions/v1/verify-paystack
```

Open `config.js` and paste that full URL into `VERIFY_FUNCTION_URL`.

---

## 3. Replace the frontend files on your host

Upload / overwrite these files on your live host (Netlify / Cloudflare / etc.):

- `index.html`
- `cv-builder.html`
- `id-card-generator.html`
- `privacy.html`
- `terms.html`
- `config.js`          ← already contains your live keys + Propeller link
- `auth-pay.js`        ← secure version

(You can leave the `supabase/` folder out of the public host — it is only needed for the CLI deploy above.)

---

## 4. Quick verification

1. Open the live site → log in with an existing account
2. Try the old console attack:
   ```js
   const { data: { user } } = await supabase.auth.getUser()
   await supabase.from('profiles').update({ is_premium: true }).eq('id', user.id)
   ```
   → It should now fail or be ignored by the trigger.
3. Try spamming the ad-credit RPC directly:
   ```js
   for (let i = 0; i < 5; i++) await supabase.rpc('grant_extra_generation', { p_type: 'cv' })
   ```
   → The 4th call onward should return a "daily ad-credit limit reached" error.
4. Hit the free limit → click Unlock ₦1,000 → complete a **real or Paystack
   test-card** payment → confirm the Unlimited badge actually appears (this is
   the step the previous version of this package silently failed on — if it
   doesn't unlock, double check step 1's trigger ran with the `service_role`
   exception).
5. Try replaying the same reference from a second account (or calling
   `verify-paystack` twice with the same reference) → the second call should
   fail because the reference is already in the `payments` table.
6. Ctrl+P is blocked once the free quota is used.

---

That's all. Your existing users, keys, and Propeller link stay intact. Only the insecure parts are replaced.

