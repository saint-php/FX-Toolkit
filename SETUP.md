# Career Toolkit — Deploy checklist

## 1. Supabase (required for login + limits)

1. Go to https://supabase.com → **New project**
2. Wait for the project to finish provisioning
3. **Authentication → Providers → Email** → enable Email (confirm email optional for testing; turn on later for production)
4. **SQL Editor → New query** → paste and run:

```sql
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  is_premium boolean not null default false,
  cv_count int not null default 0,
  id_count int not null default 0,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Users read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users update own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Users insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);
```

5. **Project Settings → API**
   - Copy **Project URL** → paste into `config.js` as `SUPABASE_URL`
   - Copy **anon public** key → paste as `SUPABASE_ANON_KEY`

6. (Optional) **Authentication → URL configuration**  
   Add your live site URL (e.g. `https://yourdomain.com`) under Site URL and Redirect URLs.

---

## 2. Host the site (required for PropellerAds)

Upload the whole folder (all HTML + JS files) to any static host:

- **Netlify**: drag-and-drop the folder, or connect GitHub  
- **Cloudflare Pages** / **GitHub Pages** / **Vercel**

You need a **real HTTPS domain** (custom domain preferred for ad approval).

Replace `support@yourdomain.com` in `privacy.html` and `terms.html` with your email.

---

## 3. Paystack (₦1,000 unlock)

1. https://dashboard.paystack.com → Settings → API Keys  
2. Copy **Public key** into `config.js` → `PAYSTACK_PUBLIC_KEY`  
3. Use test key until you’re ready; switch to live key for real money.

---

## 4. PropellerAds

1. Create account at https://propellerads.com  
2. Add your **live site URL** for review  
3. They typically want:
   - Working site on a real domain  
   - Privacy Policy + Terms linked (already in this package)  
   - Clear navigation (home, tools, legal pages)
4. After approval, create an **Interstitial** or **OnClick** zone  
5. Put the zone ID in `config.js` → `PROPELLER_INTERSTITIAL_ZONE`  
6. If they give you a script URL, put it in `PROPELLER_SCRIPT_URL`  
7. For full rewarded callback integration, their manager may give you exact JS — wire it to `window.showPropellerAd(zoneId, onComplete)` in a small extra script, or ask them for the recommended “rewarded / unlock” snippet and we can drop it into `auth-pay.js`.

Until the zone ID is set, the app uses a **placeholder timer** so you can still test the unlock flow.

---

## 5. File list to deploy

```
index.html
cv-builder.html
id-card-generator.html
privacy.html
terms.html
config.js          ← edit this
auth-pay.js
SETUP.md           ← you can omit from public host if you want
```

---

## 6. Quick test order

1. Fill `config.js` with Supabase URL + anon key  
2. Open site → Sign up → confirm login works  
3. Export 1 CV + 1 ID → hit limit → see paywall  
4. Test Paystack (test key) or simulated payment  
5. Deploy to HTTPS domain → submit URL to PropellerAds  
6. After Propeller approval → add zone ID to `config.js` → redeploy  

