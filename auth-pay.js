/**
 * Career Toolkit — Secure auth, usage limits, Paystack + Edge Function
 * - Client never writes is_premium or usage counts directly
 * - Premium is granted only by the verify-paystack Edge Function after real verification
 * - Usage increments go through a SECURITY DEFINER RPC
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
    if (error) {
      console.warn('profile load', error);
      profile = { is_premium: false, cv_count: 0, id_count: 0 };
      return;
    }
    if (!data) {
      // create row (insert is allowed by RLS)
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

  /** Safe increment via SECURITY DEFINER RPC — client cannot set arbitrary values */
  async function incrementUsage(type) {
    const sb = ensureSupabase();
    if (!sb || !sessionUser) return;
    const { data, error } = await sb.rpc('increment_usage', { p_type: type });
    if (error) {
      console.warn('increment_usage failed', error);
      return;
    }
    // refresh local profile
    await loadProfile();
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

  /**
   * Paystack flow (secure):
   * 1. Open Paystack widget with a unique reference
   * 2. On client success callback → call Edge Function with that reference
   * 3. Edge Function verifies with Paystack secret key and grants premium
   */
  function startPaystack(onUnlocked) {
    const key = cfg.PAYSTACK_PUBLIC_KEY || '';
    const amount = cfg.PRICE_KOBO || 100000;
    const fnUrl = (cfg.VERIFY_FUNCTION_URL || '').trim();

    if (typeof PaystackPop === 'undefined') {
      const scr = document.createElement('script');
      scr.src = 'https://js.paystack.co/v1/inline.js';
      scr.onload = () => startPaystack(onUnlocked);
      document.head.appendChild(scr);
      return;
    }

    if (!key || key.includes('xxxx') || key.includes('YOUR_')) {
      alert('Paystack public key not set in config.js.\nAdd your pk_test_ or pk_live_ key and try again.');
      return;
    }

    if (!fnUrl) {
      alert('VERIFY_FUNCTION_URL is empty in config.js.\nDeploy the Edge Function first and paste its URL.');
      return;
    }

    const reference = 'CT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    const handler = PaystackPop.setup({
      key,
      email: sessionUser.email,
      amount,
      currency: 'NGN',
      ref: reference,
      callback: function (response) {
        // response.reference should match what we sent
        verifyAndGrant(response.reference || reference, onUnlocked);
      },
      onClose: function () {}
    });
    handler.openIframe();
  }

  async function verifyAndGrant(reference, onUnlocked) {
    const sb = ensureSupabase();
    if (!sb || !sessionUser) {
      alert('Session expired. Please log in again.');
      return;
    }

    const fnUrl = (cfg.VERIFY_FUNCTION_URL || '').trim();
    if (!fnUrl) {
      alert('VERIFY_FUNCTION_URL missing.');
      return;
    }

    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session?.access_token) {
        alert('No valid session. Please log in again.');
        return;
      }

      const res = await fetch(fnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': cfg.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ reference })
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        console.error('verify-paystack error', body);
        alert(body.error || 'Payment verification failed. Contact support with reference: ' + reference);
        return;
      }

      // Success — refresh profile so is_premium becomes true
      await loadProfile();
      closeModal();
      if (onUnlocked) onUnlocked('premium');
      renderAuthBar();
      alert('Payment verified! Unlimited unlocked.');
    } catch (e) {
      console.error(e);
      alert('Could not reach verification server. Check your internet and try again.');
    }
  }

  /**
   * Ad unlock (placeholder).
   * This is still a timer-based flow. Replace later with a real rewarded ad SDK
   * that provides a signed callback. For now it decrements the free count via RPC
   * so the user can generate one more time.
   */
  function openDirectAd() {
    const url = (cfg.PROPELLER_DIRECT_LINK || '').trim();
    if (!url) {
      alert('Ad link not configured. Set PROPELLER_DIRECT_LINK in config.js');
      return false;
    }
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (!w) {
      window.location.href = url;
      return true;
    }
    return true;
  }

  function startAdFlow(type, onUnlocked) {
    let remaining = 2;
    const directLink = (cfg.PROPELLER_DIRECT_LINK || '').trim();
    if (!directLink) {
      alert('No ad link set. Add PROPELLER_DIRECT_LINK in config.js.');
      return;
    }

    async function grantOne() {
      // Give one extra free generation via the rate-limited RPC (capped at
      // 3/day server-side — see SETUP.md). We now check the result instead
      // of swallowing errors, so a capped user gets an honest message
      // instead of a false "you're good to go".
      const sb = ensureSupabase();
      let capped = false;
      if (sb && sessionUser) {
        const { error } = await sb.rpc('grant_extra_generation', { p_type: type });
        if (error) {
          capped = /daily ad-credit limit/.test(error.message || '');
          if (!capped) console.warn('grant_extra_generation failed', error);
        }
        await loadProfile();
      }
      closeModal();
      if (capped) {
        alert("You've reached today's ad-credit limit (3/day). Try again tomorrow, or unlock unlimited for ₦1,000.");
        return;
      }
      if (onUnlocked) onUnlocked('ad');
      alert('Ads complete! You can generate one more ' + (type === 'cv' ? 'resume' : 'ID card') + '.');
    }

    function showOneAd() {
      let opened = false;
      let seconds = 8;
      const step = 3 - remaining;
      showModal(`
        <h2>Ad ${step} of 2</h2>
        <p class="sub">Click <strong>Open ad</strong>, view it, then wait for the timer. This is required to unlock one more ${type === 'cv' ? 'resume' : 'ID card'}.</p>
        <div class="ct-ad-box">
          <div style="font-size:13px;opacity:0.8;margin-bottom:10px;">Sponsored</div>
          <button id="ct-open-ad" style="background:#fff;color:#1E2A32;border:none;border-radius:8px;padding:12px 18px;font-weight:700;cursor:pointer;font-size:14px;">
            Open ad ${step}
          </button>
          <div class="timer" id="ct-ad-timer" style="margin-top:12px;">—</div>
          <div id="ct-ad-hint" style="font-size:12px;opacity:0.75;margin-top:6px;">Click “Open ad” to start</div>
        </div>
        <div class="actions"><button id="ct-ad-skip" disabled>Open the ad first</button></div>
      `);

      const openBtn = document.getElementById('ct-open-ad');
      const btn = document.getElementById('ct-ad-skip');
      const timerEl = document.getElementById('ct-ad-timer');
      const hint = document.getElementById('ct-ad-hint');
      let iv = null;

      openBtn.onclick = () => {
        const ok = openDirectAd();
        if (!ok) return;
        if (opened) return;
        opened = true;
        openBtn.textContent = 'Ad opened';
        openBtn.disabled = true;
        hint.textContent = 'Please wait…';
        timerEl.textContent = String(seconds);
        iv = setInterval(() => {
          seconds--;
          timerEl.textContent = String(seconds);
          if (seconds <= 0) {
            clearInterval(iv);
            btn.disabled = false;
            btn.textContent = remaining > 1 ? 'Next ad →' : 'Unlock generation';
            hint.textContent = 'You can continue';
          }
        }, 1000);
      };

      btn.onclick = () => {
        if (!opened) return;
        remaining--;
        if (remaining > 0) showOneAd();
        else grantOne();
      };
    }

    showOneAd();
  }

  /** Soft revenue bar — tool pages only */
  function injectSoftRevenue() {
    if (cfg.SOFT_ADS_ENABLED === false) return;
    const link = (cfg.PROPELLER_DIRECT_LINK || '').trim();
    if (!link) return;
    const page = (location.pathname || '').toLowerCase();
    const onTool = page.includes('cv-builder') || page.includes('id-card');
    if (!onTool) return;
    if (document.getElementById('ct-soft-ad')) return;

    const bar = document.createElement('div');
    bar.id = 'ct-soft-ad';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9000;background:#1E2A32;color:#fff;padding:10px 16px;display:flex;align-items:center;justify-content:center;gap:12px;font-family:Inter,system-ui,sans-serif;font-size:13px;box-shadow:0 -4px 20px rgba(0,0,0,.15);';
    bar.innerHTML = `
      <span style="opacity:.85;">Sponsored</span>
      <button type="button" id="ct-soft-ad-btn" style="background:#B08D57;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-weight:700;cursor:pointer;">View offer</button>
      <button type="button" id="ct-soft-ad-close" style="background:transparent;border:none;color:#fff;opacity:.7;cursor:pointer;font-size:16px;line-height:1;" aria-label="Close">×</button>
    `;
    document.body.appendChild(bar);
    document.getElementById('ct-soft-ad-btn').onclick = () => openDirectAd();
    document.getElementById('ct-soft-ad-close').onclick = () => bar.remove();
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
      // After ad unlock we already adjusted the count; after premium we don't need to increment
      if (how !== 'premium') {
        incrementUsage(type).then(() => renderAuthBar());
      } else {
        renderAuthBar();
      }
    });
  }

  // Block Ctrl+P / Cmd+P while the free limit is active
  function installPrintGuard() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        if (!sessionUser) {
          e.preventDefault();
          showAuthModal('login');
          return;
        }
        // If user is on a tool page and still has free quota left, allow native print
        // Once free quota is used and not premium, block it
        const page = (location.pathname || '').toLowerCase();
        const isCv = page.includes('cv-builder');
        const isId = page.includes('id-card');
        if (!isCv && !isId) return;

        if (isPremium()) return; // unlimited → allow

        const usage = getUsage();
        const used = isCv ? (usage.cv || 0) : (usage.id || 0);
        if (used >= 1) {
          e.preventDefault();
          showPaywall(isCv ? 'cv' : 'id', () => {});
        }
      }
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
    installPrintGuard();
    setTimeout(injectSoftRevenue, 2500);
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
