/**
 * Career Toolkit — Supabase auth, usage limits, Paystack, PropellerAds
 * Requires: config.js, Supabase JS CDN, (optional) Paystack + Propeller tags
 */
(function (global) {
  const cfg = global.CT_CONFIG || {};
  let supabase = null;
  let sessionUser = null; // { id, email, name }
  let profile = null;     // { is_premium, cv_count, id_count }

  function ensureSupabase() {
    if (supabase) return supabase;
    const lib = global.supabase || global.Supabase || null;
    if (!lib || !lib.createClient) {
      console.warn('Supabase JS not loaded. Check the CDN script tag.');
      return null;
    }
    if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR_PROJECT') || !cfg.SUPABASE_ANON_KEY) {
      console.warn('Supabase not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in config.js');
      return null;
    }
    supabase = lib.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    return supabase;
  }

  async function refreshSession() {
    const sb = ensureSupabase();
    if (!sb) { sessionUser = null; profile = null; return null; }
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.user) { sessionUser = null; profile = null; return null; }
    const u = session.user;
    sessionUser = {
      id: u.id,
      email: u.email,
      name: u.user_metadata?.name || u.email?.split('@')[0] || 'User'
    };
    await loadProfile();
    return sessionUser;
  }

  async function loadProfile() {
    const sb = ensureSupabase();
    if (!sb || !sessionUser) { profile = null; return; }
    const { data, error } = await sb.from('profiles')
      .select('is_premium, cv_count, id_count, full_name')
      .eq('id', sessionUser.id)
      .maybeSingle();
    if (error) { console.warn('profile load', error); profile = { is_premium: false, cv_count: 0, id_count: 0 }; return; }
    if (!data) {
      // create row
      const { data: created } = await sb.from('profiles').insert({
        id: sessionUser.id,
        full_name: sessionUser.name,
        is_premium: false,
        cv_count: 0,
        id_count: 0
      }).select().single();
      profile = created || { is_premium: false, cv_count: 0, id_count: 0 };
    } else {
      profile = data;
      if (data.full_name) sessionUser.name = data.full_name;
    }
  }

  async function signup(email, password, name) {
    const sb = ensureSupabase();
    if (!sb) return { ok: false, error: 'Supabase not configured. Edit config.js / check CDN script.' };
    email = (email || '').trim().toLowerCase();
    if (!email || !password || password.length < 6) return { ok: false, error: 'Email and password (min 6 chars) required.' };
    try {
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { data: { name: (name || email.split('@')[0]).trim() } }
      });
      if (error) return { ok: false, error: error.message };
      // If email confirmation is ON, session may be null until they confirm
      if (!data.session) {
        return {
          ok: false,
          error: 'Account created. Check your email and confirm the link, then log in. (Or turn off "Confirm email" in Supabase → Authentication → Providers → Email.)'
        };
      }
      await refreshSession();
      return { ok: true, user: sessionUser };
    } catch (e) {
      return { ok: false, error: e.message || 'Signup failed' };
    }
  }

  async function login(email, password) {
    const sb = ensureSupabase();
    if (!sb) return { ok: false, error: 'Supabase not configured. Edit config.js / check CDN script.' };
    email = (email || '').trim().toLowerCase();
    if (!email || !password) return { ok: false, error: 'Email and password required.' };
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        let msg = error.message;
        if (/confirm|verification/i.test(msg)) {
          msg = 'Email not confirmed. Open the confirmation link in your inbox, or disable Confirm email in Supabase Auth settings.';
        } else if (/invalid login/i.test(msg)) {
          msg = 'Invalid email or password.';
        }
        return { ok: false, error: msg };
      }
      await refreshSession();
      if (!sessionUser) return { ok: false, error: 'Login succeeded but session was not saved. Check site URL in Supabase Auth settings.' };
      return { ok: true, user: sessionUser };
    } catch (e) {
      return { ok: false, error: e.message || 'Login failed' };
    }
  }

  async function logout() {
    const sb = ensureSupabase();
    if (sb) await sb.auth.signOut();
    sessionUser = null;
    profile = null;
  }

  function currentUser() { return sessionUser; }
  function isPremium() { return !!(profile && profile.is_premium); }

  function getUsage() {
    return {
      cv: profile?.cv_count || 0,
      id: profile?.id_count || 0
    };
  }

  async function incrementUsage(type) {
    const sb = ensureSupabase();
    if (!sb || !sessionUser || !profile) return;
    const field = type === 'cv' ? 'cv_count' : 'id_count';
    const next = (profile[field] || 0) + 1;
    const { error } = await sb.from('profiles').update({ [field]: next }).eq('id', sessionUser.id);
    if (!error) profile[field] = next;
  }

  function canGenerate(type) {
    if (isPremium()) return { allowed: true, usage: getUsage() };
    const usage = getUsage();
    if ((usage[type] || 0) < 1) return { allowed: true, usage };
    return {
      allowed: false,
      reason: type === 'cv'
        ? 'Free limit reached (1 resume). Unlock unlimited or watch ads for one more.'
        : 'Free limit reached (1 ID card). Unlock unlimited or watch ads for one more.',
      usage
    };
  }

  async function setPremium() {
    const sb = ensureSupabase();
    if (!sb || !sessionUser) return;
    await sb.from('profiles').update({ is_premium: true }).eq('id', sessionUser.id);
    if (profile) profile.is_premium = true;
  }

  // ---------- UI ----------
  function ensureStyles() {
    if (document.getElementById('ct-auth-styles')) return;
    const s = document.createElement('style');
    s.id = 'ct-auth-styles';
    s.textContent = `
      .ct-auth-bar{display:flex;align-items:center;gap:10px;font-size:12.5px;flex-wrap:wrap;}
      .ct-auth-bar button{background:none;border:1px solid #E2DFD5;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer;color:#1E2A32;font-size:12px;}
      .ct-auth-bar button.primary{background:#1E2A32;color:#fff;border-color:#1E2A32;}
      .ct-auth-bar .ct-user{color:#70706A;font-weight:500;}
      .ct-modal-overlay{position:fixed;inset:0;background:rgba(30,42,50,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;}
      .ct-modal{background:#fff;border-radius:14px;max-width:400px;width:100%;padding:28px 26px;box-shadow:0 20px 60px rgba(0,0,0,0.25);font-family:Inter,system-ui,sans-serif;}
      .ct-modal h2{font-family:Newsreader,Georgia,serif;font-size:22px;margin:0 0 6px;color:#1E2A32;}
      .ct-modal p.sub{color:#70706A;font-size:13px;margin:0 0 18px;line-height:1.5;}
      .ct-modal .field{margin-bottom:12px;}
      .ct-modal label{display:block;font-size:11.5px;color:#70706A;margin-bottom:4px;font-weight:500;}
      .ct-modal input{width:100%;padding:10px 12px;border:1px solid #E2DFD5;border-radius:7px;font-size:14px;box-sizing:border-box;}
      .ct-modal input:focus{outline:none;border-color:#B08D57;}
      .ct-modal .actions{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap;}
      .ct-modal .actions button{flex:1;padding:11px;border-radius:8px;border:1px solid #1E2A32;background:#1E2A32;color:#fff;font-weight:600;font-size:13.5px;cursor:pointer;}
      .ct-modal .actions button.secondary{background:#fff;color:#1E2A32;}
      .ct-modal .actions button:disabled{opacity:0.5;cursor:not-allowed;}
      .ct-modal .err{color:#B5473A;font-size:12.5px;margin-top:8px;}
      .ct-modal .switch{margin-top:14px;text-align:center;font-size:12.5px;color:#70706A;}
      .ct-modal .switch a{color:#1E2A32;font-weight:600;cursor:pointer;text-decoration:underline;}
      .ct-pay-options{display:flex;flex-direction:column;gap:10px;margin:16px 0;}
      .ct-pay-opt{border:1px solid #E2DFD5;border-radius:10px;padding:14px 16px;cursor:pointer;transition:border-color .15s;}
      .ct-pay-opt:hover{border-color:#B08D57;background:#FBF3E7;}
      .ct-pay-opt strong{display:block;font-size:14px;margin-bottom:3px;}
      .ct-pay-opt span{font-size:12px;color:#70706A;}
      .ct-ad-box{background:#1E2A32;color:#fff;border-radius:10px;padding:24px;text-align:center;margin:12px 0;}
      .ct-ad-box .timer{font-size:28px;font-weight:700;margin:8px 0;}
      .ct-badge{display:inline-block;background:#EAF2EF;color:#2F6F63;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;margin-left:6px;}
      .ct-badge.free{background:#F3ECDF;color:#8C6D3F;}
    `;
    document.head.appendChild(s);
  }

  function closeModal() {
    document.getElementById('ct-modal-root')?.remove();
  }

  function showModal(html) {
    ensureStyles();
    closeModal();
    const root = document.createElement('div');
    root.id = 'ct-modal-root';
    root.className = 'ct-modal-overlay';
    root.innerHTML = `<div class="ct-modal">${html}</div>`;
    root.addEventListener('click', e => { if (e.target === root) closeModal(); });
    document.body.appendChild(root);
    return root;
  }

  function showAuthModal(mode) {
    const isSignup = mode === 'signup';
    showModal(`
      <h2>${isSignup ? 'Create account' : 'Log in'}</h2>
      <p class="sub">${isSignup ? 'Save free generations and unlock premium later.' : 'Welcome back.'}</p>
      ${isSignup ? '<div class="field"><label>Name</label><input id="ct-name" placeholder="Your name"></div>' : ''}
      <div class="field"><label>Email</label><input id="ct-email" type="email" placeholder="you@email.com"></div>
      <div class="field"><label>Password</label><input id="ct-pass" type="password" placeholder="Min 6 characters"></div>
      <div class="err" id="ct-err" style="display:none"></div>
      <div class="actions">
        <button class="secondary" id="ct-cancel">Cancel</button>
        <button id="ct-submit">${isSignup ? 'Sign up' : 'Log in'}</button>
      </div>
      <div class="switch">
        ${isSignup ? 'Already have an account? <a id="ct-switch">Log in</a>' : 'New here? <a id="ct-switch">Create account</a>'}
      </div>
    `);
    document.getElementById('ct-cancel').onclick = closeModal;
    document.getElementById('ct-switch').onclick = () => showAuthModal(isSignup ? 'login' : 'signup');
    document.getElementById('ct-submit').onclick = async () => {
      const email = document.getElementById('ct-email').value;
      const pass = document.getElementById('ct-pass').value;
      const name = isSignup ? (document.getElementById('ct-name')?.value || '') : '';
      const btn = document.getElementById('ct-submit');
      const err = document.getElementById('ct-err');
      err.style.display = 'none';
      btn.disabled = true;
      btn.textContent = isSignup ? 'Creating…' : 'Signing in…';
      let res;
      try {
        res = isSignup ? await signup(email, pass, name) : await login(email, pass);
      } catch (e) {
        res = { ok: false, error: e.message || 'Something went wrong' };
      }
      btn.disabled = false;
      btn.textContent = isSignup ? 'Sign up' : 'Log in';
      if (!res.ok) { err.style.display = 'block'; err.textContent = res.error; return; }
      closeModal();
      renderAuthBar();
      if (global.CTAuth.onAuthChange) global.CTAuth.onAuthChange();
    };
  }

  function showPaywall(type, onUnlocked) {
    if (!sessionUser) { showAuthModal('login'); return; }
    showModal(`
      <h2>Free limit reached</h2>
      <p class="sub">You’ve used your free ${type === 'cv' ? 'resume' : 'ID card'}. Choose how to continue:</p>
      <div class="ct-pay-options">
        <div class="ct-pay-opt" id="ct-pay">
          <strong>🔓 Unlock unlimited — ₦1,000</strong>
          <span>One-time Paystack payment. Unlimited on this account.</span>
        </div>
        <div class="ct-pay-opt" id="ct-ads">
          <strong>📺 Watch 2 ads — unlock 1 more</strong>
          <span>View two ads to generate one more ${type === 'cv' ? 'resume' : 'ID card'}.</span>
        </div>
      </div>
      <div class="actions"><button class="secondary" id="ct-cancel">Not now</button></div>
    `);
    document.getElementById('ct-cancel').onclick = closeModal;
    document.getElementById('ct-pay').onclick = () => startPaystack(onUnlocked);
    document.getElementById('ct-ads').onclick = () => startAdFlow(type, onUnlocked);
  }

  function startPaystack(onUnlocked) {
    const key = cfg.PAYSTACK_PUBLIC_KEY || '';
    const amount = cfg.PRICE_KOBO || 100000;
    if (typeof PaystackPop === 'undefined') {
      const scr = document.createElement('script');
      scr.src = 'https://js.paystack.co/v1/inline.js';
      scr.onload = () => startPaystack(onUnlocked);
      document.head.appendChild(scr);
      return;
    }
    if (!key || key.includes('xxxx')) {
      if (confirm('Paystack key not set in config.js.\nSimulate successful ₦1,000 payment?')) {
        setPremium().then(() => {
          closeModal();
          if (onUnlocked) onUnlocked('premium');
          renderAuthBar();
          alert('Premium unlocked (demo).');
        });
      }
      return;
    }
    const handler = PaystackPop.setup({
      key,
      email: sessionUser.email,
      amount,
      currency: 'NGN',
      ref: 'CT-' + Date.now(),
      callback: function () {
        setPremium().then(() => {
          closeModal();
          if (onUnlocked) onUnlocked('premium');
          renderAuthBar();
          alert('Payment successful! Unlimited unlocked.');
        });
      },
      onClose: function () {}
    });
    handler.openIframe();
  }

  /**
   * Ads ONLY run when user clicks "Watch 2 ads" on the paywall.
   * Do NOT put Monetag Multitag in <head> — it hijacks all navigation.
   *
   * Optional config:
   *   PROPELLER_SCRIPT_URL  — script loaded once, only when ad flow starts
   *   PROPELLER_INTERSTITIAL_ZONE — zone id (for your records / custom hooks)
   *   PROPELLER_DIRECT_LINK — if set, opens this URL for each ad step (Monetag Direct Link)
   */
  let adScriptLoaded = false;
  function loadAdScriptOnce() {
    return new Promise((resolve) => {
      const url = cfg.PROPELLER_SCRIPT_URL;
      if (!url || adScriptLoaded) { resolve(); return; }
      if (document.querySelector('script[data-ct-ad="1"]')) { adScriptLoaded = true; resolve(); return; }
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.dataset.ctAd = '1';
      s.onload = () => { adScriptLoaded = true; resolve(); };
      s.onerror = () => resolve();
      document.body.appendChild(s);
    });
  }

  function startAdFlow(type, onUnlocked) {
    let remaining = 2;
    const directLink = cfg.PROPELLER_DIRECT_LINK || '';

    function grantOne() {
      const sb = ensureSupabase();
      if (sb && sessionUser && profile) {
        const field = type === 'cv' ? 'cv_count' : 'id_count';
        const next = Math.max(0, (profile[field] || 0) - 1);
        sb.from('profiles').update({ [field]: next }).eq('id', sessionUser.id).then(() => {
          profile[field] = next;
        });
      }
      closeModal();
      if (onUnlocked) onUnlocked('ad');
      alert('Ads complete! You can generate one more ' + (type === 'cv' ? 'resume' : 'ID card') + '.');
    }

    async function showOneAd() {
      await loadAdScriptOnce();
      let seconds = 10;
      const step = 3 - remaining;
      showModal(`
        <h2>Ad ${step} of 2</h2>
        <p class="sub">Watch this ad to unlock one more ${type === 'cv' ? 'resume' : 'ID card'}. Navigation on the site stays ad-free.</p>
        <div class="ct-ad-box">
          <div style="font-size:13px;opacity:0.8;margin-bottom:8px;">Sponsored</div>
          <button id="ct-open-ad" style="background:#fff;color:#1E2A32;border:none;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer;margin-bottom:12px;">
            ${directLink ? 'Open ad' : 'Continue'}
          </button>
          <div class="timer" id="ct-ad-timer">${seconds}</div>
          <div style="font-size:12px;opacity:0.75;">Please wait for the timer</div>
        </div>
        <div class="actions"><button id="ct-ad-skip" disabled>Please wait…</button></div>
      `);

      const openBtn = document.getElementById('ct-open-ad');
      const btn = document.getElementById('ct-ad-skip');
      const timerEl = document.getElementById('ct-ad-timer');

      openBtn.onclick = () => {
        if (directLink) {
          window.open(directLink, '_blank', 'noopener,noreferrer');
        } else if (typeof global.showPropellerAd === 'function') {
          global.showPropellerAd(cfg.PROPELLER_INTERSTITIAL_ZONE, function () {});
        }
        // If only a script was loaded, Monetag may show its own unit; user still waits for timer.
      };

      // Auto-prompt open once
      setTimeout(() => { try { openBtn.click(); } catch (e) {} }, 300);

      const iv = setInterval(() => {
        seconds--;
        if (timerEl) timerEl.textContent = seconds;
        if (seconds <= 0) {
          clearInterval(iv);
          btn.disabled = false;
          btn.textContent = remaining > 1 ? 'Next ad →' : 'Unlock generation';
        }
      }, 1000);

      btn.onclick = () => {
        remaining--;
        if (remaining > 0) showOneAd();
        else grantOne();
      };
    }

    showOneAd();
  }

  function gate(type, doExport) {
    if (!sessionUser) { showAuthModal('login'); return; }
    const check = canGenerate(type);
    if (check.allowed) {
      doExport();
      incrementUsage(type).then(() => renderAuthBar());
      return;
    }
    showPaywall(type, (how) => {
      doExport();
      incrementUsage(type).then(() => renderAuthBar());
    });
  }

  function esc(str) {
    return (str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function renderAuthBar() {
    ensureStyles();
    let bar = document.getElementById('ct-auth-bar');
    if (!bar) {
      const header = document.querySelector('.app-header') || document.querySelector('.hero');
      bar = document.createElement('div');
      bar.id = 'ct-auth-bar';
      bar.className = 'ct-auth-bar';
      if (header) {
        const host = header.querySelector('a[href="index.html"]')?.parentElement || header;
        host.appendChild(bar);
      } else {
        bar.style.cssText = 'position:fixed;top:12px;right:16px;z-index:100;';
        document.body.appendChild(bar);
      }
    }
    if (!sessionUser) {
      bar.innerHTML = `<button id="ct-btn-login">Log in</button><button class="primary" id="ct-btn-signup">Sign up</button>`;
      document.getElementById('ct-btn-login').onclick = () => showAuthModal('login');
      document.getElementById('ct-btn-signup').onclick = () => showAuthModal('signup');
      return;
    }
    const premium = isPremium();
    const usage = getUsage();
    const cvLeft = premium ? '∞' : Math.max(0, 1 - (usage.cv || 0));
    const idLeft = premium ? '∞' : Math.max(0, 1 - (usage.id || 0));
    bar.innerHTML = `
      <span class="ct-user">${esc(sessionUser.name)}
        ${premium ? '<span class="ct-badge">Unlimited</span>' : `<span class="ct-badge free">Free · CV ${cvLeft} · ID ${idLeft}</span>`}
      </span>
      ${!premium ? '<button id="ct-btn-upgrade">Upgrade ₦1,000</button>' : ''}
      <button id="ct-btn-logout">Log out</button>
    `;
    document.getElementById('ct-btn-logout').onclick = async () => {
      await logout();
      renderAuthBar();
      if (global.CTAuth.onAuthChange) global.CTAuth.onAuthChange();
    };
    const up = document.getElementById('ct-btn-upgrade');
    if (up) up.onclick = () => showPaywall('cv', () => {});
  }

  // Boot
  async function init() {
    ensureStyles();
    await refreshSession();
    renderAuthBar();
    const sb = ensureSupabase();
    if (sb) {
      sb.auth.onAuthStateChange(async () => {
        await refreshSession();
        renderAuthBar();
      });
    }
  }

  global.CTAuth = {
    signup, login, logout, currentUser, isPremium, canGenerate, gate,
    showAuthModal, showPaywall, renderAuthBar, init,
    onAuthChange: null
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
