/* ==========================================================================
   Radiology CV Studio — Complete Bilingual Frontend Application
   Supports all 13 Guided Stage Pages, Live CV Preview, Real PDF/DOCX/Workbook
   Exports, Offline IndexedDB Draft Recovery, Conflict Resolution, Upload
   Manager, Glossary, Privacy & Consent Center, and Admin Console.
   ========================================================================== */

(function () {
  'use strict';

  const STATE = {
    locale: localStorage.getItem('rcv_locale') || 'ar',
    theme: localStorage.getItem('rcv_theme') || 'light',
    route: 'landing', // landing | auth | dashboard | stage | preview | exports | uploads | glossary | support | about | privacy | admin
    activeStage: 1,
    authenticated: false,
    user: null,
    preferences: null,
    profiles: [],
    activeProfileId: localStorage.getItem('rcv_active_profile_id') || null,
    bundle: null,
    platform: {},
    integrations: {},
    stagesCatalog: [],
    questionsCatalog: [],
    modalityCatalog: [],
    glossary: [],
    syncStatus: 'Saved', // Saving | Saved | Offline | Failed | Conflict
    lastSyncedAt: null,
    conflictData: null,
    previewHtml: '',
    previewMode: 'cv', // 'cv' | 'workbook'
    previewLang: 'en',
    previewTemplate: 'modern-healthcare',
    previewDensity: 'standard',
    glossarySearch: '',
    adminData: null,
    jobMatchResult: null,
    toastMessage: null,
    cookieBannerDismissed: localStorage.getItem('rcv_cookie_consented') === '1',
  };

  let autosaveTimer = null;

  // --- IndexedDB Resilient Local Draft Store (Section 8 & 13) ---
  const IDB_NAME = 'RadiologyCVStudioDrafts';
  const IDB_STORE = 'draft_snapshots';

  function openDraftDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return resolve(null);
      const req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'profileId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  async function saveLocalDraftSnapshot(profileId, payload) {
    try {
      const db = await openDraftDb();
      if (!db) return;
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({
        profileId,
        payload,
        savedAt: new Date().toISOString(),
      });
    } catch (_) {}
  }

  async function clearLocalDraftSnapshot(profileId) {
    try {
      const db = await openDraftDb();
      if (!db) return;
      const tx = db.transaction(IDB_STORE, 'readwrite');
      if (profileId) {
        tx.objectStore(IDB_STORE).delete(profileId);
      } else {
        tx.objectStore(IDB_STORE).clear();
      }
    } catch (_) {}
  }

  // --- Localization Helper ---
  function t(arText, enText) {
    return STATE.locale === 'ar' ? arText : enText;
  }

  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applyDocumentDirectionAndTheme() {
    const htmlEl = document.documentElement;
    htmlEl.lang = STATE.locale === 'ar' ? 'ar' : 'en';
    htmlEl.dir = STATE.locale === 'ar' ? 'rtl' : 'ltr';
    const effectiveTheme =
      STATE.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : STATE.theme;
    htmlEl.setAttribute('data-theme', effectiveTheme);
  }

  function showToast(arMsg, enMsg) {
    STATE.toastMessage = t(arMsg, enMsg);
    renderApp();
    setTimeout(() => {
      STATE.toastMessage = null;
      renderApp();
    }, 4500);
  }

  // --- API Helper ---
  async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
    });
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error(data?.error || data?.message_en || `HTTP ${res.status}`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  // --- Bootstrap & Profile Loading ---
  async function bootstrapApplication() {
    applyDocumentDirectionAndTheme();
    try {
      const data = await apiFetch('/api/bootstrap');
      STATE.authenticated = data.authenticated;
      STATE.user = data.user;
      STATE.preferences = data.preferences;
      STATE.profiles = data.profiles || [];
      STATE.platform = data.platform || {};
      STATE.integrations = data.integrations || {};
      STATE.stagesCatalog = data.stagesCatalog || [];
      STATE.questionsCatalog = data.questionsCatalog || [];
      STATE.modalityCatalog = data.modalityCatalog || [];
      STATE.glossary = data.glossary || [];

      if (STATE.authenticated && STATE.profiles.length > 0) {
        const chosenId =
          STATE.profiles.find((p) => p.id === STATE.activeProfileId)?.id || STATE.profiles[0].id;
        await loadProfileBundle(chosenId);
        if (STATE.route === 'landing' || STATE.route === 'auth') {
          STATE.route = 'dashboard';
        }
      }
    } catch (e) {
      STATE.syncStatus = navigator.onLine ? 'Failed' : 'Offline';
    }
    renderApp();
  }

  async function loadProfileBundle(profileId) {
    if (!profileId) return;
    STATE.activeProfileId = profileId;
    localStorage.setItem('rcv_active_profile_id', profileId);
    const bundle = await apiFetch(`/api/profiles/${encodeURIComponent(profileId)}`);
    STATE.bundle = bundle;
    STATE.lastSyncedAt = bundle.profile?.last_synced_at;
    STATE.syncStatus = 'Saved';
    STATE.conflictData = null;
  }

  // --- Debounced Autosave Engine (Section 8) ---
  function scheduleAutosave(payloadUpdater, immediate = false) {
    if (!STATE.bundle) return;
    STATE.syncStatus = navigator.onLine ? 'Saving' : 'Offline';
    renderTopbarOnly();

    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(
      async () => {
        await executeAutosave(payloadUpdater);
      },
      immediate ? 50 : 500
    );
  }

  async function executeAutosave(payloadOptions = {}) {
    if (!STATE.bundle || !STATE.activeProfileId) return;
    const b = STATE.bundle;

    const payload = {
      expectedVersion: b.profile.version,
      forceOverwrite: Boolean(payloadOptions.forceOverwrite),
      stageNumber: STATE.activeStage,
      profileMeta: {
        title: b.profile.title,
        cv_output_language: b.profile.cv_output_language,
        target_country: b.profile.target_country,
        template_id: b.profile.template_id,
        photo_preference: b.profile.photo_preference,
        length_preference: b.profile.length_preference,
        tailored_vacancy_title: b.profile.tailored_vacancy_title,
        tailored_vacancy_raw: b.profile.tailored_vacancy_raw,
        seed_banner_dismissed: b.profile.seed_banner_dismissed,
      },
      answers: Object.values(b.answersMap || {}).map((a) => ({
        question_id: a.question_id,
        stage_number: a.stage_number || STATE.activeStage,
        value: a.value,
        source: a.source || 'user_entered',
        confirmation_state: a.confirmation_state || 'user_confirmed',
        visibility: a.visibility || 'show',
      })),
      stageUpdate: (b.stages || []).find((s) => s.stage_number === STATE.activeStage),
      educationEntries: b.education,
      employmentEntries: b.employment,
      trainingEntries: b.training,
      modalityEntries: b.modalities,
      licenseEntries: b.licenses,
      achievementEntries: b.achievements,
      referenceEntries: b.references,
      changeSummary: payloadOptions.changeSummary || `Stage ${STATE.activeStage} autosave`,
    };

    // Always persist to local IndexedDB draft store first
    await saveLocalDraftSnapshot(STATE.activeProfileId, payload);

    if (!navigator.onLine) {
      STATE.syncStatus = 'Offline';
      renderTopbarOnly();
      return;
    }

    try {
      const res = await apiFetch(`/api/profiles/${encodeURIComponent(STATE.activeProfileId)}/autosave`, {
        method: 'POST',
        body: payload,
      });
      b.profile.version = res.version;
      b.profile.last_synced_at = res.lastSyncedAt;
      STATE.lastSyncedAt = res.lastSyncedAt;
      STATE.syncStatus = 'Saved';
      STATE.conflictData = null;
      if (res.warnings && res.warnings.length > 0) {
        showToast(res.warnings[0].ar, res.warnings[0].en);
      } else {
        renderTopbarOnly();
      }
    } catch (err) {
      if (err.status === 409 && err.payload?.conflict) {
        STATE.syncStatus = 'Conflict';
        STATE.conflictData = err.payload;
        renderApp();
      } else {
        STATE.syncStatus = 'Failed';
        renderTopbarOnly();
      }
    }
  }

  window.addEventListener('online', () => {
    if (STATE.bundle && (STATE.syncStatus === 'Offline' || STATE.syncStatus === 'Failed')) {
      executeAutosave({ changeSummary: 'Reconnected online sync' });
    }
  });
  window.addEventListener('offline', () => {
    STATE.syncStatus = 'Offline';
    renderTopbarOnly();
  });

  function renderTopbarOnly() {
    const pill = document.getElementById('autosave-status-pill');
    if (!pill) return;
    const statusMap = {
      Saved: {
        cls: 'saved',
        txt: t('تم الحفظ والمزامنة للتو ✓', 'Saved just now ✓'),
      },
      Saving: {
        cls: 'saving',
        txt: t('جاري الحفظ التلقائي…', 'Saving…'),
      },
      Offline: {
        cls: 'offline',
        txt: t('غير متصل — محفوظ محليًا وسيتم المزامنة عند الاتصال', 'Offline — saved locally, will sync'),
      },
      Failed: {
        cls: 'failed',
        txt: t('فشلت المزامنة — اضغط لإعادة المحاولة', 'Sync failed — click to retry'),
      },
      Conflict: {
        cls: 'failed',
        txt: t('تعارض نسخ — يرجى المراجعة', 'Version conflict — review needed'),
      },
    };
    const info = statusMap[STATE.syncStatus] || statusMap.Saved;
    pill.className = `sync-pill ${info.cls}`;
    pill.textContent = info.txt;
  }

  // --- Answer Mutation Helper ---
  function setAnswerValue(questionId, stageNumber, value, confirmationState = 'user_confirmed', visibility = 'show') {
    if (!STATE.bundle) return;
    if (!STATE.bundle.answersMap) STATE.bundle.answersMap = {};
    const existing = STATE.bundle.answersMap[questionId] || {};
    STATE.bundle.answersMap[questionId] = {
      ...existing,
      question_id: questionId,
      stage_number: stageNumber,
      value,
      source: existing.source === 'imported' ? 'user_entered' : existing.source || 'user_entered',
      confirmation_state: confirmationState,
      visibility,
      updated_at: new Date().toISOString(),
    };
    scheduleAutosave();
  }

  function getAnswerValue(questionId, fallback = '') {
    if (!STATE.bundle || !STATE.bundle.answersMap || !STATE.bundle.answersMap[questionId]) {
      return fallback;
    }
    const v = STATE.bundle.answersMap[questionId].value;
    return v !== undefined && v !== null ? v : fallback;
  }

  function getAnswerMeta(questionId) {
    return STATE.bundle?.answersMap?.[questionId] || { source: 'not_entered', confirmation_state: 'not_entered', visibility: 'show' };
  }

  // --- Workspace Session Quick Switch (Seeded Abdel Ghaffar or Admin) ---
  async function enterQuickWorkspace(mode) {
    try {
      await apiFetch('/api/auth/workspace-session', {
        method: 'POST',
        body: { mode },
      });
      await bootstrapApplication();
      if (mode === 'platform_admin') {
        STATE.route = 'admin';
        await loadAdminOverview();
      } else {
        STATE.route = 'dashboard';
      }
      renderApp();
    } catch (e) {
      showToast('تعذر فتح مساحة العمل: ' + e.message, 'Failed to open workspace: ' + e.message);
    }
  }

  async function loadAdminOverview() {
    try {
      STATE.adminData = await apiFetch('/api/admin/overview');
      renderApp();
    } catch (e) {
      showToast('غير مصرح بالوصول للوحة المشرف: ' + e.message, 'Admin access denied: ' + e.message);
    }
  }

  async function refreshPreviewHtml() {
    if (!STATE.activeProfileId) return;
    try {
      const q = new URLSearchParams({
        mode: STATE.previewMode,
        lang: STATE.previewLang,
        template: STATE.previewTemplate,
        density: STATE.previewDensity,
      });
      const data = await apiFetch(`/api/profiles/${encodeURIComponent(STATE.activeProfileId)}/preview?${q.toString()}`);
      STATE.previewHtml = data.html;
      if (STATE.bundle) STATE.bundle.quality = data.quality;
      renderApp();
    } catch (e) {
      showToast('تعذر تحديث المعاينة: ' + e.message, 'Failed to refresh preview: ' + e.message);
    }
  }

  async function triggerExportDownload(exportType, language) {
    if (!STATE.activeProfileId) return;
    showToast('جاري توليد الملف على الخادم وفحص التنسيق…', 'Generating document on server and verifying layout…');
    try {
      const res = await apiFetch(`/api/profiles/${encodeURIComponent(STATE.activeProfileId)}/exports`, {
        method: 'POST',
        body: {
          exportType,
          language: language || STATE.previewLang || 'en',
          templateId: STATE.previewTemplate || 'modern-healthcare',
          styleDensity: STATE.previewDensity || 'standard',
        },
      });
      await loadProfileBundle(STATE.activeProfileId);
      renderApp();
      window.open(res.downloadUrl, '_blank');
    } catch (e) {
      showToast('فشل التصدير (إجاباتك محفوظة بأمان): ' + e.message, 'Export failed (your answers are safe): ' + e.message);
    }
  }

  // =========================================================================
  // UI RENDERERS FOR EACH SCREEN & ALL 13 STAGES
  // =========================================================================

  function renderTopbar() {
    const siteTitle = t(
      STATE.platform.site_title_ar || 'استوديو السيرة الذاتية للأشعة والتصوير الطبي',
      STATE.platform.site_title_en || 'Radiology CV Studio'
    );
    return `
      <header class="app-topbar" role="banner">
        <div class="brand-group">
          <div class="brand-badge" aria-hidden="true">Rx</div>
          <div>
            <h1 class="brand-title">${esc(siteTitle)}</h1>
            <p class="brand-subtitle">${t(
              'منصة متخصصة لأخصائيي وفنيي الأشعة والتصوير الطبي — بإشراف وتطوير Abd-el-Rahman Adel Teba',
              'Dedicated CV Platform for Radiology & Medical Imaging Professionals'
            )}</p>
          </div>
        </div>

        <div class="topbar-controls">
          ${
            STATE.authenticated && STATE.bundle
              ? `<button type="button" id="autosave-status-pill" class="sync-pill saved" data-action="manual-save" title="${t('اضغط للحفظ الفوري', 'Click to save now')}">
                  ${t('تم الحفظ والمزامنة للتو ✓', 'Saved just now ✓')}
                </button>`
              : ''
          }

          <button type="button" class="btn btn-sm" data-action="toggle-locale" aria-label="Switch Language">
            ${STATE.locale === 'ar' ? 'English (LTR)' : 'العربية (RTL)'}
          </button>

          <button type="button" class="btn btn-sm" data-action="toggle-theme" aria-label="Switch Theme">
            ${STATE.theme === 'dark' ? t('☀ وضع نهاري', '☀ Light Mode') : t('☾ وضع ليلي', '☾ Dark Mode')}
          </button>

          ${
            STATE.authenticated
              ? `
                <span class="badge">${esc(STATE.user?.displayName || '')} (${esc(STATE.user?.role)})</span>
                <button type="button" class="btn btn-sm" data-action="logout">${t('تسجيل الخروج', 'Sign Out')}</button>
              `
              : `
                <button type="button" class="btn btn-sm btn-primary" data-nav="auth">${t('تسجيل الدخول / حساب جديد', 'Sign In / Create Account')}</button>
              `
          }
        </div>
      </header>
    `;
  }

  function renderSidebar() {
    const stages = STATE.bundle?.stages || [];
    const stageItemsHtml = STATE.stagesCatalog
      .map((st) => {
        const stRow = stages.find((s) => s.stage_number === st.stage_number) || {};
        const isActive = STATE.route === 'stage' && STATE.activeStage === st.stage_number;
        const badgeCls =
          stRow.status === 'completed'
            ? 'completed'
            : stRow.status === 'needs_confirmation'
            ? 'needs_confirmation'
            : '';
        return `
          <li>
            <button type="button" class="nav-btn ${isActive ? 'active' : ''}" data-stage-nav="${st.stage_number}">
              <span>${st.stage_number}. ${esc(t(st.title_ar.replace(/^المرحلة \d+:\s*/, ''), st.title_en.replace(/^Stage \d+:\s*/, '')))}</span>
              <span class="stage-step-badge ${badgeCls}">${stRow.completion_pct ?? 0}%</span>
            </button>
          </li>
        `;
      })
      .join('');

    return `
      <aside class="app-sidebar" aria-label="${t('القائمة الرئيسية', 'Main Navigation')}">
        <div>
          <div class="nav-section-title">${t('التنقل الرئيسي', 'Main Workspace')}</div>
          <ul class="nav-list">
            <li><button type="button" class="nav-btn ${STATE.route === 'landing' ? 'active' : ''}" data-nav="landing">${t('الرئيسية والتعريف', 'Overview & Home')}</button></li>
            <li><button type="button" class="nav-btn ${STATE.route === 'dashboard' ? 'active' : ''}" data-nav="dashboard">${t('لوحة التحكم وملفات السيرة', 'Dashboard & My CV Profiles')}</button></li>
            <li><button type="button" class="nav-btn ${STATE.route === 'stage' ? 'active' : ''}" data-stage-nav="${STATE.activeStage}">${t('متابعة إنشاء السيرة (13 مرحلة)', 'Continue My CV (13 Stages)')}</button></li>
            <li><button type="button" class="nav-btn ${STATE.route === 'preview' ? 'active' : ''}" data-nav="preview">${t('معاينة السيرة وتنسيق القالب', 'CV Live Preview & Composer')}</button></li>
            <li><button type="button" class="nav-btn ${STATE.route === 'exports' ? 'active' : ''}" data-nav="exports">${t('مركز التصدير والمشاركة (PDF)', 'Exports & Share Links')}</button></li>
            <li><button type="button" class="nav-btn ${STATE.route === 'uploads' ? 'active' : ''}" data-nav="uploads">${t('إدارة الوثائق والمرفقات', 'Upload Manager')}</button></li>
            <li><button type="button" class="nav-btn ${STATE.route === 'glossary' ? 'active' : ''}" data-nav="glossary">${t('قاموس مصطلحات الأشعة والتوظيف', 'Radiology & CV Glossary')}</button></li>
            <li><button type="button" class="nav-btn ${STATE.route === 'privacy' ? 'active' : ''}" data-nav="privacy">${t('الحساب والخصوصية والموافقات', 'Account, Privacy & Consent')}</button></li>
            <li><button type="button" class="nav-btn ${STATE.route === 'support' ? 'active' : ''}" data-nav="support">${t('المساعدة والإبلاغ عن مشكلة', 'Help, Support & Report Issue')}</button></li>
            <li><button type="button" class="nav-btn ${STATE.route === 'about' ? 'active' : ''}" data-nav="about">${t('عن المنصة والتواصل', 'Creator & About')}</button></li>
            ${
              STATE.user?.role === 'admin' || STATE.user?.role === 'super_admin'
                ? `<li><button type="button" class="nav-btn ${STATE.route === 'admin' ? 'active' : ''}" data-nav="admin">${t('لوحة مشرف النظام (Admin)', 'Admin Console')}</button></li>`
                : ''
            }
          </ul>
        </div>

        ${
          STATE.authenticated && STATE.bundle
            ? `
              <div>
                <div class="nav-section-title">${t('المراحل الـ 13 الموجهة', '13 Guided Stages')}</div>
                <ul class="nav-list">
                  ${stageItemsHtml}
                </ul>
              </div>
            `
            : ''
        }
      </aside>
    `;
  }

  // --- Screen 1: Landing Page ---
  function renderLandingPage() {
    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">${t(
              'مرحبًا بك في استوديو السيرة الذاتية للأشعة والتصوير الطبي (Radiology CV Studio)',
              'Welcome to Radiology CV Studio — Built Exclusively for Medical Imaging Professionals'
            )}</h2>
            <p class="form-sublabel">${t(
              'مستشار مهني ذكي، ومقابلة منظمة من 13 مرحلة، ومحرك توليد PDF ثنائي اللغة (عربي/إنجليزي) مع حفظ تلقائي فوري وعزل كامل للخصوصية.',
              'An intelligent CV consultant, 13-stage structured clinical interview, and bilingual Arabic/English PDF studio with real-time autosave and strict data accuracy rules.'
            )}</p>
          </div>
        </div>

        <div class="banner banner-info">
          <strong>${t('الوصول السريع لمساحات العمل المجهزة:', 'Authorized Quick Workspace Access:')}</strong>
          <p style="margin: 0.4rem 0 0.8rem 0;">
            ${t(
              'إذا تم تهيئة ملف السيرة المستورد في قاعدة البيانات الخاصة على الخادم، يمكنك فتح مساحة العمل المستوردة مباشرة مع الحفاظ الكامل على الحقول التي تحتاج لتأكيد (دون تخمين اسم الكلية أو تواريخ الوظائف أو خلط تدريب الامتياز بالعمل المستقل).',
              'If a preloaded profile workspace has been seeded in the private server database, you can open it directly with all uncertainty flags preserved without guessing missing dates or faculty names.'
            )}
          </p>
          <div style="display:flex; gap:0.75rem; flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" data-action="quick-workspace" data-mode="seeded_owner">
              ${t('فتح مساحة العمل المستوردة (الإجابات المستوردة للمرحلتين 1 و 2)', 'Open Imported Seeded Workspace (Stages 1 & 2 Preloaded)')}
            </button>
            <button type="button" class="btn" data-action="quick-workspace" data-mode="platform_admin">
              ${t('فتح لوحة مشرف النظام (Abd-el-Rahman Adel Teba)', 'Open Platform Admin Console (Abd-el-Rahman Adel Teba)')}
            </button>
            <button type="button" class="btn" data-nav="auth">
              ${t('إنشاء حساب لمستخدم جديد مستقل', 'Register a Separate New User Account')}
            </button>
          </div>
        </div>

        <div class="grid-3">
          <div class="card" style="margin-bottom:0;">
            <h3 style="margin-top:0; font-size:1rem;">${t('1. مصداقية مهنية صارمة (لا اختلاق للبيانات)', '1. Non-Negotiable Truth & Clinical Scope')}</h3>
            <p class="form-sublabel">${t(
              'يفصل النظام بدقة بين العمل المهني المستقل، والتدريب السريري، وفترة الامتياز (مثل مرور الرنين المغناطيسي والسونار والتنظير التألقي في الامتياز).',
              'Strictly distinguishes independent work, supervised clinical training, and internship exposure (e.g., MRI, Ultrasound, and Fluoroscopy rotations).'
            )}</p>
          </div>
          <div class="card" style="margin-bottom:0;">
            <h3 style="margin-top:0; font-size:1rem;">${t('2. حفظ تلقائي واستكمال من حيث توقفت', '2. Real Autosave & Cross-Device Continuity')}</h3>
            <p class="form-sublabel">${t(
              'يتم حفظ كل إجابة تلقائيًا في قاعدة البيانات على الخادم مع نسخة احتياطية محلية (IndexedDB) عند انقطاع الإنترنت واكتشاف تعارض النوافذ.',
              'Every answer auto-saves to the server database with local IndexedDB fallback when offline and multi-tab version conflict protection.'
            )}</p>
          </div>
          <div class="card" style="margin-bottom:0;">
            <h3 style="margin-top:0; font-size:1rem;">${t('3. تصدير PDF احترافي + كراسة الإجابات', '3. Selectable Arabic/English PDF & Workbook')}</h3>
            <p class="form-sublabel">${t(
              'تصدير السيرة الذاتية بالعربية أو الإنجليزية في أي مرحلة (حتى كمسودة)، بالإضافة إلى كراسة إجابات كاملة منفصلة خاصة بصاحب السيرة.',
              'One-click export of employer-facing PDF CVs, partial Draft PDFs at any completion level, and a private Question & Answer Workbook PDF.'
            )}</p>
          </div>
        </div>
      </div>
    `;
  }

  // --- Screen 2: Sign In / Create Account ---
  function renderAuthPage() {
    const googleStatus = STATE.integrations?.google_oauth;
    const otpStatus = STATE.integrations?.phone_otp;

    return `
      <div class="grid-2">
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">${t('تسجيل الدخول إلى حسابك', 'Sign In to Your Account')}</h2>
          </div>
          <form id="login-form">
            <div class="form-group">
              <label class="form-label" for="login-email">${t('البريد الإلكتروني', 'Email Address')}</label>
              <input id="login-email" name="email" type="email" class="form-input" required placeholder="user@example.com">
            </div>
            <div class="form-group">
              <label class="form-label" for="login-password">${t('كلمة المرور', 'Password')}</label>
              <input id="login-password" name="password" type="password" class="form-input" required>
            </div>
            <button type="submit" class="btn btn-primary">${t('تسجيل الدخول', 'Sign In')}</button>
          </form>

          <hr style="margin:1.25rem 0; border:0; border-top:1px solid var(--border-subtle);">
          <h3 style="font-size:0.95rem;">${t('خيارات الدخول عبر مزودي الهوية الخارجيين', 'External Identity Providers (Honest Integration Status)')}</h3>
          <div style="display:flex; flex-direction:column; gap:0.6rem;">
            <div>
              <button type="button" class="btn" data-action="try-google-auth" style="width:100%; justify-content:space-between;">
                <span>${t('تسجيل الدخول باستخدام Google (Gmail OAuth)', 'Sign in with Google (Gmail OAuth)')}</span>
                <span class="badge badge-setup">${esc(googleStatus?.status || 'Needs setup')}</span>
              </button>
              <small class="form-sublabel">${t(
                'ملاحظة خصوصية: تسجيل الدخول عبر Google يستخدم لتأكيد الهوية والبريد فقط ولا يمنح الموقع أي صلاحية لقراءة رسائل بريدك (Gmail Inbox).',
                'Privacy note: Google sign-in requests minimum identity/email/profile scopes only and never reads your Gmail inbox.'
              )}</small>
            </div>

            <div>
              <button type="button" class="btn" data-action="try-phone-otp" style="width:100%; justify-content:space-between;">
                <span>${t('التحقق عبر رقم الهاتف (SMS OTP)', 'Sign in with Phone Number (SMS OTP)')}</span>
                <span class="badge badge-setup">${esc(otpStatus?.status || 'Needs setup')}</span>
              </button>
              <small class="form-sublabel">${esc(t(otpStatus?.details_ar, otpStatus?.details_en))}</small>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2 class="card-title">${t('إنشاء حساب مستقل جديد', 'Create a New Independent Account')}</h2>
          </div>
          <form id="register-form">
            <div class="form-group">
              <label class="form-label" for="reg-name">${t('الاسم الكامل', 'Full Display Name')}</label>
              <input id="reg-name" name="displayName" type="text" class="form-input" required placeholder="${t('مثال: أحمد محمد — أخصائي أشعة', 'e.g., Ahmed Mohamed')}">
            </div>
            <div class="form-group">
              <label class="form-label" for="reg-email">${t('البريد الإلكتروني الشخصي', 'Personal Email Address')}</label>
              <input id="reg-email" name="email" type="email" class="form-input" required placeholder="radiologist@example.com">
            </div>
            <div class="form-group">
              <label class="form-label" for="reg-phone">${t('رقم الهاتف (اختياري)', 'Phone Number (Optional)')}</label>
              <input id="reg-phone" name="phone" type="tel" class="form-input" placeholder="+2010XXXXXXXX">
            </div>
            <div class="form-group">
              <label class="form-label" for="reg-password">${t('كلمة المرور (6 أحرف على الأقل)', 'Password (Min 6 characters)')}</label>
              <input id="reg-password" name="password" type="password" class="form-input" required minlength="6">
            </div>
            <div class="form-group">
              <label style="display:flex; align-items:center; gap:0.5rem; font-size:0.86rem;">
                <input type="checkbox" required checked>
                <span>${t(
                  'أوافق على سياسة الخصوصية وشروط الاستخدام، وأتفهم أن حسابي خاص بي افتراضيًا ولا يطلع المشرف على سيرتي إلا بموافقتي الصريحة.',
                  'I agree to the Privacy Policy & Terms, and understand my CV workspaces are private by default.'
                )}</span>
              </label>
            </div>
            <button type="submit" class="btn btn-primary">${t('إنشاء الحساب وبدء السيرة الذاتية', 'Create Account & Start CV')}</button>
          </form>
        </div>
      </div>
    `;
  }

  // --- Screen 3: User Dashboard & Profile Workspaces ---
  function renderDashboardPage() {
    if (!STATE.authenticated) return renderLandingPage();

    const b = STATE.bundle;
    const p = b?.profile;
    const stages = b?.stages || [];
    const avgCompletion =
      stages.length > 0
        ? Math.round(stages.reduce((acc, s) => acc + (s.completion_pct || 0), 0) / stages.length)
        : 0;

    return `
      ${
        p?.is_seeded && !p?.seed_banner_dismissed
          ? `
            <div class="banner banner-info">
              <strong>${t(
                'تم استيراد إجابات المرحلتين الأولى والثانية من إجاباتك السابقة. راجعها مرة واحدة؛ لا تحتاج لإعادة إدخالها من جديد.',
                'Your first two stages were imported from previous answers. Review them once; you do not need to enter them again.'
              )}</strong>
              <p style="margin:0.35rem 0;">
                ${t(
                  'عنوان مساحة العمل: ' + p.title + ' — تم الحفاظ على جميع الإجابات المستوردة وتحديد الحقول التي تحتاج إلى تأكيد (مثل اسم الكلية وتواريخ الوظائف الست).',
                  'Workspace: ' + p.title + ' — All imported facts and uncertainty flags are preserved accurately.'
                )}
              </p>
            </div>
          `
          : ''
      }

      ${
        p && !p.share_with_admin_enabled
          ? `
            <div class="banner banner-warn">
              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem;">
                <div>
                  <strong>${t('حالة الخصوصية: هذا الملف خاص تمامًا (Private by Default)', 'Privacy Status: Strictly Private by Default')}</strong>
                  <div style="font-size:0.84rem;">
                    ${t(
                      'لا يستطيع مشرف الموقع (Abd-el-Rahman Adel Teba) رؤية محتوى سيرتك الذاتية إلا إذا منحته موافقة صريحة لمشاركة هذا الملف المحدد.',
                      'The site administrator cannot view your CV answers unless you explicitly grant consent to share this specific profile.'
                    )}
                  </div>
                </div>
                <button type="button" class="btn btn-sm" data-nav="privacy">
                  ${t('إدارة موافقة المشاركة مع المشرف', 'Manage Admin Sharing Consent')}
                </button>
              </div>
            </div>
          `
          : ''
      }

      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">${t('ملفات السيرة الذاتية الخاصة بي (My CV Workspaces)', 'My CV Profiles & Workspaces')}</h2>
            <p class="form-sublabel">${t(
              'يمكنك إنشاء أكثر من ملف سيرة ذاتية مستقل (مثل نسخة إنجليزية للسعودية، ونسخة عربية، ونسخة مخصصة لإعلان وظيفي محدد).',
              'Create multiple separate CV profiles (e.g., English CV for Saudi Arabia, Arabic CV, or vacancy-tailored CV).'
            )}</p>
          </div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" data-action="create-profile">${t('+ إنشاء ملف سيرة جديد', '+ Create New CV Profile')}</button>
            ${
              p
                ? `<button type="button" class="btn" data-action="duplicate-profile">${t('نسخ الملف الحالي', 'Duplicate Current Profile')}</button>`
                : ''
            }
          </div>
        </div>

        <div class="grid-2">
          ${STATE.profiles
            .map(
              (prof) => `
              <div class="card" style="margin-bottom:0; border-color:${prof.id === STATE.activeProfileId ? 'var(--brand-teal)' : 'var(--border-color)'};">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.5rem;">
                  <strong>${esc(prof.title)}</strong>
                  <span class="badge ${prof.share_with_admin_enabled ? 'badge-imported' : 'badge-confirmed'}">
                    ${prof.share_with_admin_enabled ? t('مشارك مع المشرف بموافقتك', 'Shared with Admin') : t('خاص (Private)', 'Private')}
                  </span>
                </div>
                <p class="form-sublabel" style="margin:0.4rem 0;">
                  ${t('الدولة المستهدفة:', 'Target:')} ${esc(prof.target_country)} |
                  ${t('لغة التصدير:', 'CV Lang:')} ${esc(prof.cv_output_language.toUpperCase())} |
                  ${t('النسخة:', 'v')}${esc(prof.version)}
                </p>
                <div style="display:flex; gap:0.5rem; margin-top:0.65rem; flex-wrap:wrap;">
                  <button type="button" class="btn btn-sm btn-primary" data-select-profile="${esc(prof.id)}">
                    ${prof.id === STATE.activeProfileId ? t('متابعة العمل في هذا الملف', 'Continue This Workspace') : t('التبديل إلى هذا الملف', 'Switch to Workspace')}
                  </button>
                  <button type="button" class="btn btn-sm" data-nav="preview">${t('معاينة السيرة', 'Live Preview')}</button>
                  <button type="button" class="btn btn-sm" data-action="quick-export-draft">${t('تصدير PDF الآن', 'Export PDF Now')}</button>
                </div>
              </div>
            `
            )
            .join('')}
        </div>
      </div>

      ${
        b
          ? `
            <div class="card">
              <div class="card-header">
                <div>
                  <h3 class="card-title">${t('ملخص التقدم وجودة البيانات للملف النشط', 'Active Workspace Progress & Quality Summary')}</h3>
                  <small class="form-sublabel">${t('آخر مزامنة ناجحة مع الخادم:', 'Last server sync:')} ${esc(STATE.lastSyncedAt || p.last_synced_at)}</small>
                </div>
                <span class="badge badge-imported">${t('إجمالي التقدم:', 'Overall Progress:')} ${avgCompletion}%</span>
              </div>
              <div class="progress-track" style="margin-bottom:1rem;">
                <div class="progress-fill" style="width:${avgCompletion}%;"></div>
              </div>

              <div class="grid-3">
                <div class="explain-box">
                  <strong>${t('عناصر أساسية غير مدخلة بعد:', 'Missing Essentials:')} (${b.quality?.summaryCounts?.essentialMissingCount || 0})</strong>
                  <ul style="margin:0.4rem 0 0 0; padding-inline-start:1.1rem;">
                    ${(b.quality?.essentialMissing || [])
                      .map((m) => `<li>${esc(t(m.message_ar, m.message_en))}</li>`)
                      .join('')}
                  </ul>
                </div>
                <div class="explain-box">
                  <strong>${t('بيانات تحتاج إلى تأكيد:', 'Needs Confirmation:')} (${b.quality?.summaryCounts?.needsConfirmationCount || 0})</strong>
                  <ul style="margin:0.4rem 0 0 0; padding-inline-start:1.1rem;">
                    ${(b.quality?.needsConfirmationFlags || [])
                      .slice(0, 4)
                      .map((m) => `<li>${esc(t(m.message_ar, m.message_en))}</li>`)
                      .join('')}
                  </ul>
                </div>
                <div class="explain-box">
                  <strong>${t('سجل النسخ والاسترجاع (Version History):', 'Version Snapshots & Recovery:')}</strong>
                  <p style="margin:0.3rem 0;">${t('عدد النسخ المحفوظة:', 'Saved snapshots:')} ${(b.versions || []).length}</p>
                  <button type="button" class="btn btn-sm" data-stage-nav="13">${t('مراجعة السجل والفحص النهائي (المرحلة 13)', 'Open Stage 13 Final Review')}</button>
                </div>
              </div>
            </div>
          `
          : ''
      }
    `;
  }

  // =========================================================================
  // THE 13 GUIDED STAGE PAGES (Section 5)
  // =========================================================================
  function renderGuidedStagePage() {
    if (!STATE.authenticated || !STATE.bundle) return renderAuthPage();

    const stNum = STATE.activeStage;
    const stDef = STATE.stagesCatalog.find((s) => s.stage_number === stNum) || STATE.stagesCatalog[0];
    const stRow = (STATE.bundle.stages || []).find((s) => s.stage_number === stNum) || {};

    return `
      ${
        STATE.conflictData
          ? `
            <div class="banner banner-danger">
              <strong>${t('تنبيه تعارض نسخ (Multi-Tab / Device Conflict):', 'Version Conflict Detected:')}</strong>
              <p>${esc(t(STATE.conflictData.message_ar, STATE.conflictData.message_en))}</p>
              <div style="display:flex; gap:0.5rem;">
                <button type="button" class="btn btn-sm" data-action="reload-server-version">${t('تحميل نسخة الخادم الأحدث (موصى به)', 'Load Latest Server Version')}</button>
                <button type="button" class="btn btn-sm btn-danger" data-action="force-overwrite-version">${t('الكتابة فوق نسخة الخادم بتعديلاتي الحالية', 'Force Overwrite with My Edits')}</button>
              </div>
            </div>
          `
          : ''
      }

      <div class="card">
        <div class="card-header">
          <div>
            <span class="badge badge-imported">${t(`المرحلة ${stNum} من 13`, `Stage ${stNum} of 13`)}</span>
            <h2 class="card-title" style="margin-top:0.35rem;">${esc(t(stDef.title_ar, stDef.title_en))}</h2>
            <p class="form-sublabel" style="margin-bottom:0;">${esc(t(stDef.purpose_ar, stDef.purpose_en))}</p>
          </div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            ${
              stNum > 1
                ? `<button type="button" class="btn btn-sm" data-stage-nav="${stNum - 1}">${t('← المرحلة السابقة', '← Previous Stage')}</button>`
                : ''
            }
            <button type="button" class="btn btn-sm" data-action="manual-save">${t('حفظ الآن', 'Save Now')}</button>
            <button type="button" class="btn btn-sm" data-action="save-and-exit">${t('حفظ وخروج للوحة التحكم', 'Save & Exit')}</button>
            ${
              stNum < 13
                ? `<button type="button" class="btn btn-sm btn-primary" data-stage-nav="${stNum + 1}">${t('المرحلة التالية →', 'Next Stage →')}</button>`
                : `<button type="button" class="btn btn-sm btn-primary" data-nav="exports">${t('الانتقال لمركز التصدير →', 'Go to Exports →')}</button>`
            }
          </div>
        </div>

        ${renderStageSpecificContent(stNum)}

        <hr style="margin:1.5rem 0; border:0; border-top:1px solid var(--border-subtle);">

        <div class="form-group">
          <label class="form-label" for="stage-private-notes">
            ${t('ملاحظات خاصة بهذه المرحلة (Private Notes — لا تظهر في السيرة الذاتية الموجهة لجهات العمل):', 'Private Stage Notes (Never included in employer-facing CV):')}
          </label>
          <textarea id="stage-private-notes" class="form-textarea" data-stage-notes="${stNum}" placeholder="${t('اكتب أي ملاحظات تذكيرية خاصة بك هنا...', 'Add private context or reminders for yourself...')}">${esc(stRow.private_notes || '')}</textarea>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem; margin-top:1rem;">
          <div>
            <button type="button" class="btn btn-sm" data-action="quick-export-draft">
              ${t('تصدير مسودة PDF بالحالة الحالية', 'Export Partial Draft PDF Now')}
            </button>
          </div>
          <div style="display:flex; gap:0.5rem;">
            ${
              stNum > 1
                ? `<button type="button" class="btn" data-stage-nav="${stNum - 1}">${t('السابق', 'Previous')}</button>`
                : ''
            }
            ${
              stNum < 13
                ? `<button type="button" class="btn btn-primary" data-stage-nav="${stNum + 1}">${t('حفظ والانتقال للمرحلة التالية', 'Save & Continue to Next Stage')}</button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }

  function renderStageSpecificContent(stageNumber) {
    switch (stageNumber) {
      case 1:
        return renderStage1Content();
      case 2:
        return renderStage2Content();
      case 3:
        return renderStage3Content();
      case 4:
        return renderStage4Content();
      case 5:
        return renderStage5Content();
      case 6:
        return renderStage6Content();
      case 7:
        return renderStage7Content();
      case 8:
        return renderStage8Content();
      case 9:
        return renderStage9Content();
      case 10:
        return renderStage10Content();
      case 11:
        return renderStage11Content();
      case 12:
        return renderStage12Content();
      case 13:
        return renderStage13Content();
      default:
        return renderStage1Content();
    }
  }

  // --- STAGE 1: Personal Profile, Current Status, and Career Target ---
  function renderStage1Content() {
    const nameAr = getAnswerValue('s1_full_name_ar', '');
    const nameEn = getAnswerValue('s1_full_name_en', '');
    const titleAr = getAnswerValue('s1_professional_title_ar', '');
    const titleEn = getAnswerValue('s1_professional_title_en', '');
    const ownerEmail = getAnswerValue('s1_owner_email', '');
    const ownerPhone = getAnswerValue('s1_owner_phone', '');
    const resLoc = getAnswerValue('s1_residence_location', {
      country: 'Egypt',
      city_or_governorate: '',
      street_address: '',
      wants_address_shown: true,
    });
    const rankedRoles = getAnswerValue('s1_ranked_target_roles', [
      'Radiology Specialist',
      'Medical Imaging Specialist',
      'Diagnostic Imaging Specialist',
      'Radiologic Technologist',
      'X-Ray Technician',
      'CT Technologist',
      'MRI Technologist',
    ]);
    const expBreak = getAnswerValue('s1_experience_summary_breakdown', {
      reported_total_years: 7,
      includes_pre_graduation: true,
      post_graduation_paid_years: null,
    });
    const workPrefs = getAnswerValue('s1_work_preferences', {
      target_country: 'Saudi Arabia',
      availability: 'Immediate',
      willing_to_relocate: true,
      valid_passport: true,
      saudi_classification_status: 'Needs confirmation / Not started',
    });

    return `
      <div class="banner banner-info">
        <strong>${t('شرح المرحلة الأولى:', 'Explain Stage 1:')}</strong>
        ${t(
          'تُثبّت هذه المرحلة اسمك الرسمي بالعربية والإنجليزية، ومسمّاك المهني، وبيانات التواصل الخاصة بك وحدك، وترتيب الوظائف المستهدفة.',
          'Establishes your legal Arabic/English names, verified professional title, personal contact info, and ranked target job titles.'
        )}
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${t('الاسم الرباعي بالعربية (مطابق للوثائق الرسمية)', 'Arabic Full Name (As on official documents)')} <span class="badge badge-imported">${esc(getAnswerMeta('s1_full_name_ar').source)}</span></label>
          <input type="text" class="form-input" data-ans-input="s1_full_name_ar" value="${esc(nameAr)}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('الاسم الكامل بالإنجليزية (مطابق لجواز السفر)', 'English Full Name (As on passport)')} <span class="badge badge-imported">${esc(getAnswerMeta('s1_full_name_en').source)}</span></label>
          <input type="text" class="form-input" data-ans-input="s1_full_name_en" value="${esc(nameEn)}">
        </div>
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${t('المسمى المهني بالعربية', 'Professional Title in Arabic')}</label>
          <input type="text" class="form-input" data-ans-input="s1_professional_title_ar" value="${esc(titleAr)}">
          <div class="explain-box">${t('مؤكد ظهوره في: الترخيص، القيد النقابي، سجلات جهة العمل، القرار الرسمي، الكارنيه المهني، والشهادة.', 'Confirmed on license, syndicate record, employer record, official decision, professional card, and certificate.')}</div>
        </div>
        <div class="form-group">
          <label class="form-label">${t('المسمى المهني بالإنجليزية', 'Professional Title in English')}</label>
          <input type="text" class="form-input" data-ans-input="s1_professional_title_en" value="${esc(titleEn)}">
          <div class="explain-box">${t('تنبيه تنظيمي: لا يتم تحويل كلمة Specialist إلى درجة تصنيف قانونية في دولة أخرى تلقائيًا إلا بعد صدور قرار التصنيف الرسمي.', 'Regulatory guardrail: Specialist is not automatically translated into foreign regulatory equivalence without official confirmation.')}</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${t('البريد الإلكتروني الشخصي لصاحب السيرة الذاتية', 'CV Owner Personal Contact Email')} <span class="badge badge-needs-conf">${ownerEmail ? t('مؤكد', 'Confirmed') : t('غير مدخل بعد', 'Not entered')}</span></label>
          <input type="email" class="form-input" data-ans-input="s1_owner_email" value="${esc(ownerEmail)}" placeholder="${t('أدخل بريد صاحب السيرة الشخصي (وليس بريد دعم الموقع)', 'Enter CV owner personal email (never site support email)')}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('رقم الهاتف الشخصي لصاحب السيرة الذاتية', 'CV Owner Personal Phone Number')} <span class="badge badge-needs-conf">${ownerPhone ? t('مؤكد', 'Confirmed') : t('غير مدخل بعد', 'Not entered')}</span></label>
          <input type="tel" class="form-input" data-ans-input="s1_owner_phone" value="${esc(ownerPhone)}" placeholder="+20 10XXXXXXXX">
        </div>
      </div>

      <div class="card" style="background:var(--bg-subtle);">
        <h3 style="margin-top:0; font-size:1rem;">${t('العنوان ومحل الإقامة (قاعدة عدم اختلاق العنوان)', 'Residence & Address (Strict Anti-Fabrication Rule)')}</h3>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">${t('المدينة / المحافظة / الدولة', 'City / Governorate / Country')}</label>
            <input type="text" class="form-input" data-res-field="city_or_governorate" value="${esc(resLoc.city_or_governorate || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">${t('عنوان الشارع التفصيلي (متروك فارغًا حتى يدخله صاحب السيرة)', 'Exact Street Address (Kept blank — never guessed)')}</label>
            <input type="text" class="form-input" data-res-field="street_address" value="${esc(resLoc.street_address || '')}" placeholder="${t('لم يتم إدخاله — لن ينشر النظام عنوانًا مخمنًا', 'Not provided—do not publish a guessed address')}">
          </div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h3 style="margin-top:0; font-size:1rem;">${t('ترتيب المسميات الوظيفية المستهدفة (استخدم أزرار الأعلى/الأسفل للترتيب)', 'Ranked Target Job Titles (Use Up/Down to Rank)')}</h3>
          <ol style="margin:0; padding-inline-start:1.25rem;">
            ${rankedRoles
              .map(
                (role, idx) => `
                <li style="margin-bottom:0.45rem; display:flex; justify-content:space-between; align-items:center; gap:0.5rem;">
                  <span><strong>${esc(role)}</strong></span>
                  <span>
                    <button type="button" class="btn btn-sm" data-rank-up="${idx}" ${idx === 0 ? 'disabled' : ''}>↑</button>
                    <button type="button" class="btn btn-sm" data-rank-down="${idx}" ${idx === rankedRoles.length - 1 ? 'disabled' : ''}>↓</button>
                  </span>
                </li>
              `
              )
              .join('')}
          </ol>
        </div>

        <div class="card">
          <h3 style="margin-top:0; font-size:1rem;">${t('إجمالي الخبرة المبلغ عنها وتفصيلها الصادق', 'Reported Total Experience & Honest Breakdown')}</h3>
          <p style="font-size:0.88rem;">
            <strong>${t('إجمالي الخبرة المبلغ عنها:', 'Reported Total Experience:')}</strong> ${esc(expBreak.reported_total_years || 7)} ${t('سنوات (تشمل ما قبل التخرج وما بعده)', 'years (includes pre- and post-graduation exposure)')}
          </p>
          <div class="explain-box">
            ${t(
              'قاعدة عدم التضخيم: بما أن التخرج في يونيو 2020، لا يقوم النظام أبدًا بتحويل الـ 7 سنوات الكلية إلى 7 سنوات عمل بعد التخرج. يتم عرض العمل الفعلي منفصلًا عن التدريب والامتياز.',
              'Truth Guardrail: Because graduation was in June 2020, the platform never turns the 7-year total into 7 years of post-graduation employment.'
            )}
          </div>
          <div class="form-group" style="margin-top:0.75rem;">
            <label class="form-label">${t('عدد سنوات العمل الفعلي المدفوع بعد التخرج (إذا أردت تحديدها بدقة):', 'Confirmed Post-Graduation Paid Work Years (Optional if known):')}</label>
            <input type="text" class="form-input" data-exp-postgrad value="${esc(expBreak.post_graduation_paid_years || '')}" placeholder="${t('يحتاج لتأكيد تواريخ البداية في المرحلة 3', 'Pending Stage 3 start date confirmation')}">
          </div>
          <div class="form-group">
            <label class="form-label">${t('حالة التصنيف المهني السعودي الحالية (دون افتراض الأهلية):', 'Current Saudi Professional Classification Status:')}</label>
            <select class="form-select" data-workpref-saudi>
              ${['Needs confirmation / Not started', 'Not started', 'In progress', 'Completed', 'Unsure', 'Not applicable']
                .map(
                  (opt) => `<option value="${esc(opt)}" ${workPrefs.saudi_classification_status === opt ? 'selected' : ''}>${esc(opt)}</option>`
                )
                .join('')}
            </select>
          </div>
        </div>
      </div>
    `;
  }

  // --- STAGE 2: Education and Academic Qualifications ---
  function renderStage2Content() {
    const eduList = STATE.bundle.education || [];
    const edu = eduList[0] || {
      qualification_ar: 'دبلوم',
      qualification_en: 'Diploma',
      institution_ar: 'جامعة بنها',
      institution_en: 'Benha University',
      college_faculty_ar: '',
      college_faculty_en: '',
      department_ar: 'قسم فني أشعة',
      department_en: 'Radiology Technician Department',
      specialty_ar: 'أشعة وتصوير طبي',
      specialty_en: 'Radiology and Medical Imaging',
      start_date: '2019',
      graduation_date: 'June 2020 (دور يونيو 2020)',
      final_grade_ar: 'ممتاز',
      final_grade_en: 'Excellent',
      no_gpa_issued: 1,
      gpa_value: '',
    };

    return `
      <div class="banner banner-info">
        <strong>${t('مساعد توثيق المؤهل الدراسي:', 'Education Verification Assistant:')}</strong>
        ${t(
          'تم تحميل بيانات المؤهل (دبلوم — جامعة بنها — قسم فني أشعة — تخصص أشعة وتصوير طبي — خريج يونيو 2020 — تقدير ممتاز). اسم الكلية/المعهد لم يُذكر في البيانات السابقة لذا تُرك فارغًا بانتظار تأكيدك من الشهادة المطبوعة.',
          'Preloaded Diploma from Benha University (Radiology Technician Department, June 2020, Grade: Excellent). College/Faculty name was not provided and remains blank until you confirm it from your certificate.'
        )}
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${t('مسمى المؤهل بالعربية (كما طُبع في الشهادة)', 'Qualification Name in Arabic')}</label>
          <input type="text" class="form-input" data-edu-field="qualification_ar" value="${esc(edu.qualification_ar)}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('مسمى المؤهل بالإنجليزية (يُحفظ Diploma حتى تُراجع الشهادة)', 'Qualification Name in English')}</label>
          <input type="text" class="form-input" data-edu-field="qualification_en" value="${esc(edu.qualification_en)}">
        </div>
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${t('الجامعة / المؤسسة المانحة (عربي)', 'Awarding University / Institution (Arabic)')}</label>
          <input type="text" class="form-input" data-edu-field="institution_ar" value="${esc(edu.institution_ar)}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('الجامعة / المؤسسة المانحة (إنجليزي)', 'Awarding University / Institution (English)')}</label>
          <input type="text" class="form-input" data-edu-field="institution_en" value="${esc(edu.institution_en)}">
        </div>
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">
            ${t('اسم الكلية أو المعهد بالعربية (متروك فارغًا — لا تخمّنه من اسم الجامعة)', 'College / Faculty / Institute Name (Arabic)')}
            <span class="badge ${edu.college_faculty_ar ? 'badge-confirmed' : 'badge-needs-conf'}">${edu.college_faculty_ar ? t('مؤكد', 'Confirmed') : t('يحتاج لتأكيد من الشهادة', 'Needs Confirmation')}</span>
          </label>
          <input type="text" class="form-input" data-edu-field="college_faculty_ar" value="${esc(edu.college_faculty_ar || '')}" placeholder="${t('غير مُدخل — اكتب اسم الكلية أو المعهد كما في الشهادة', 'Blank until confirmed from printed certificate')}">
        </div>
        <div class="form-group">
          <label class="form-label">
            ${t('اسم الكلية أو المعهد بالإنجليزية', 'College / Faculty / Institute Name (English)')}
            <span class="badge ${edu.college_faculty_en ? 'badge-confirmed' : 'badge-needs-conf'}">${edu.college_faculty_en ? t('مؤكد', 'Confirmed') : t('يحتاج لتأكيد', 'Needs Confirmation')}</span>
          </label>
          <input type="text" class="form-input" data-edu-field="college_faculty_en" value="${esc(edu.college_faculty_en || '')}" placeholder="${t('غير مُدخل — لا يتم افتراضه تلقائيًا', 'Not provided — do not guess')}">
        </div>
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">${t('القسم (عربي / إنجليزي)', 'Department (Arabic / English)')}</label>
          <input type="text" class="form-input" data-edu-field="department_en" value="${esc(edu.department_en)}">
          <small class="form-sublabel">${esc(edu.department_ar)}</small>
        </div>
        <div class="form-group">
          <label class="form-label">${t('التخصص الرسمي (عربي / إنجليزي)', 'Official Specialty (Arabic / English)')}</label>
          <input type="text" class="form-input" data-edu-field="specialty_en" value="${esc(edu.specialty_en)}">
          <small class="form-sublabel">${esc(edu.specialty_ar)}</small>
        </div>
      </div>

      <div class="grid-3">
        <div class="form-group">
          <label class="form-label">${t('سنة بدء الدراسة', 'Study Start Year')}</label>
          <input type="text" class="form-input" data-edu-field="start_date" value="${esc(edu.start_date)}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('تاريخ التخرج / الدور', 'Graduation Date')}</label>
          <input type="text" class="form-input" data-edu-field="graduation_date" value="${esc(edu.graduation_date)}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('التقدير العام (Grade)', 'Final Grade')}</label>
          <input type="text" class="form-input" data-edu-field="final_grade_en" value="${esc(edu.final_grade_en)}">
        </div>
      </div>

      <div class="explain-box">
        <label style="display:flex; align-items:center; gap:0.5rem; font-weight:600;">
          <input type="checkbox" data-edu-nogpa ${edu.no_gpa_issued ? 'checked' : ''}>
          <span>${t('لم يصدر معدل تراكمي رقمي (No GPA was issued — التقدير ممتاز فقط)', 'No numeric GPA was issued on the certificate (Grade: Excellent only)')}</span>
        </label>
        <div style="margin-top:0.3rem;">
          ${t(
            'توضيح: "ممتاز (Excellent)" هو تقدير لفظي، بينما GPA هو نظام نقاط رقمي. لا تقم أبدًا باختلاق رقم GPA إذا لم يكن مطبوعًا في الشهادة.',
            'Explanation: "Excellent" is a descriptive grade while GPA is numeric. Never invent a numeric GPA when none was issued.'
          )}
        </div>
      </div>
    `;
  }

  // --- STAGE 3: Professional Employment and Career History ---
  function renderStage3Content() {
    const empList = STATE.bundle.employment || [];
    return `
      <div class="banner banner-warn">
        <strong>${t('ضوابط التاريخ الوظيفي وجهات العمل الست المبلغ عنها:', 'Employment History Guardrails (6 Reported Workplaces):')}</strong>
        <p style="margin:0.35rem 0 0 0;">
          ${t(
            'تم إدراج المستشفيات والمراكز الستة التي ذكرتها، مع تمييز كل بطاقة بعلامة "مبلغ عنها — طبيعة العلاقة والتواريخ تحتاج لتأكيد". لا يفترض النظام أنك تعمل بدوام كامل في الـ 6 جهات في وقت واحد. حدد لكل جهة: هل هي حالية أم سابقة، ونوع الدوام (أساسي / جزئي / نبطشيات)، والتواريخ.',
            'Each of the 6 reported hospitals/centers is loaded as a separate card marked "Reported by user — relationship/dates need confirmation." Full-time employment at all 6 simultaneously is never assumed.'
          )}
        </p>
      </div>

      ${empList
        .map(
          (emp, idx) => `
          <div class="card" style="border-inline-start: 4px solid ${emp.is_primary_employer ? 'var(--brand-teal)' : 'var(--accent-amber)'};">
            <div class="card-header">
              <div>
                <h3 class="card-title">
                  ${idx + 1}. ${esc(emp.institution_name_ar)} — ${esc(emp.institution_name_en)}
                  ${emp.is_primary_employer ? `<span class="badge badge-confirmed">${t('جهة العمل الأساسية المبلغ عنها', 'Primary Reported Employer')}</span>` : ''}
                </h3>
                <small class="form-sublabel">${esc(emp.institution_type || '')} | ${esc(emp.city || '')} ${emp.alternative_names ? `(${esc(emp.alternative_names)})` : ''}</small>
              </div>
              <span class="badge ${emp.confirmation_state === 'user_confirmed' ? 'badge-confirmed' : 'badge-needs-conf'}">
                ${emp.confirmation_state === 'user_confirmed' ? t('مؤكدة ✓', 'Confirmed ✓') : t('مبلغ عنها — التواريخ والعلاقة تحتاج لتأكيد', 'Reported — relationship/dates need confirmation')}
              </span>
            </div>

            <div class="grid-3">
              <div class="form-group">
                <label class="form-label">${t('طبيعة العلاقة الوظيفية', 'Employment Relationship Type')}</label>
                <select class="form-select" data-emp-idx="${idx}" data-emp-field="relationship_type">
                  ${[
                    ['needs_confirmation', t('تحتاج لتأكيد (Needs confirmation)', 'Needs confirmation')],
                    ['full_time', t('دوام كامل حالي (Current Full-Time)', 'Current Full-Time')],
                    ['part_time', t('دوام جزئي / نبطشيات (Part-Time / Shifts)', 'Part-Time / Shift-based')],
                    ['on_call', t('تعاقد بنظام الطوارئ/الاستدعاء (On-Call / Rotational)', 'Occasional / On-Call')],
                    ['former', t('جهة عمل سابقة (Former Employer)', 'Former Employer')],
                  ]
                    .map(
                      ([val, lbl]) => `<option value="${val}" ${emp.relationship_type === val ? 'selected' : ''}>${esc(lbl)}</option>`
                    )
                    .join('')}
                </select>
              </div>

              <div class="form-group">
                <label class="form-label">${t('تاريخ البداية (أو اتركه فارغًا إذا غير معروف)', 'Start Month/Year (Leave blank if unknown)')}</label>
                <input type="month" class="form-input" data-emp-idx="${idx}" data-emp-field="start_date" value="${esc(emp.start_date || '')}">
              </div>

              <div class="form-group">
                <label class="form-label">${t('تاريخ النهاية (أو مستمر حتى الآن)', 'End Month/Year (if former)')}</label>
                <input type="month" class="form-input" data-emp-idx="${idx}" data-emp-field="end_date" value="${esc(emp.end_date || '')}">
              </div>
            </div>

            <div class="grid-2">
              <div class="form-group">
                <label class="form-label">${t('المسمى الوظيفي في هذه الجهة (إنجليزي)', 'Role / Title at This Institution (English)')}</label>
                <input type="text" class="form-input" data-emp-idx="${idx}" data-emp-field="role_title_en" value="${esc(emp.role_title_en || '')}">
              </div>
              <div class="form-group">
                <label class="form-label">${t('المدينة / الموقع (قابل للتعديل للتحقق مثل كمشيش/Komishish)', 'City / Location (Editable for verification)')}</label>
                <input type="text" class="form-input" data-emp-idx="${idx}" data-emp-field="city" value="${esc(emp.city || '')}">
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">${t('توضيح التداخل الزمني أو نظام النبطشيات (في حال العمل في أكثر من جهة):', 'Schedule / Concurrent Overlap Clarification:')}</label>
              <input type="text" class="form-input" data-emp-idx="${idx}" data-emp-field="overlap_explanation" value="${esc(emp.overlap_explanation || '')}" placeholder="${t('مثال: نبطشيات مسائية / يومان أسبوعيًا بجانب العمل الأساسي', 'e.g., Rotational evening shifts alongside primary hospital role')}">
            </div>

            <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
              <button type="button" class="btn btn-sm" data-action="suggest-emp-bullets" data-emp-idx="${idx}">
                ${t('✨ ساعدني في صياغة المهام الوظيفية (Help me write this)', '✨ Help me write professional bullets from my answers')}
              </button>
              <small class="form-sublabel">${t('تظهر الصياغة المقترحة للمراجعة والاعتماد ولا تُضاف قسرًا.', 'Draft bullets require your explicit review and approval.')}</small>
            </div>

            ${renderSuggestedBulletsPanel(emp, idx)}
          </div>
        `
        )
        .join('')}

      <button type="button" class="btn" data-action="add-workplace">+ ${t('إضافة جهة عمل أخرى', 'Add Another Workplace Entry')}</button>
    `;
  }

  function renderSuggestedBulletsPanel(emp, idx) {
    let suggested = [];
    let approved = [];
    try {
      suggested = JSON.parse(emp.suggested_bullets_json || '[]');
    } catch (_) {}
    try {
      approved = JSON.parse(emp.approved_bullets_json || '[]');
    } catch (_) {}

    if (suggested.length === 0 && approved.length === 0) return '';

    return `
      <div class="explain-box" style="margin-top:0.75rem;">
        <strong>${t('مقارنة: ما أخبرتنا به مقابل الصياغة المهنية المقترحة (لا تُعتمد إلا بموافقتك):', 'Two-Column Review: What You Told Us vs. Suggested CV Wording:')}</strong>
        ${suggested
          .map(
            (b, bIdx) => `
            <div class="grid-2" style="margin-top:0.5rem; padding:0.5rem; background:var(--bg-surface); border:1px solid var(--border-color); border-radius:6px;">
              <div>
                <small class="badge">${t('ما أدخلته (المصدر):', 'What you told us:')}</small>
                <p style="margin:0.25rem 0; font-size:0.84rem;">${esc(t(b.what_you_told_us_ar, b.what_you_told_us_en))}</p>
              </div>
              <div>
                <small class="badge badge-needs-conf">${t('صياغة مقترحة — تحتاج لموافقتك:', 'Suggested wording — requires approval:')}</small>
                <p style="margin:0.25rem 0; font-size:0.86rem; font-weight:600;">${esc(t(b.suggested_ar, b.suggested_en))}</p>
                <small class="form-sublabel">${t('لماذا هذه الصياغة؟', 'Why this wording?')} ${esc(t(b.why_this_wording_ar, b.why_this_wording_en))}</small>
                <div style="margin-top:0.4rem; display:flex; gap:0.4rem;">
                  <button type="button" class="btn btn-sm btn-primary" data-approve-bullet="${idx}:${bIdx}">${t('اعتماد وإضافة للسيرة ✓', 'Use Suggestion ✓')}</button>
                </div>
              </div>
            </div>
          `
          )
          .join('')}
        ${
          approved.length > 0
            ? `<div style="margin-top:0.5rem;"><strong>${t('النقاط المعتمدة في السيرة:', 'Approved CV Bullets:')}</strong><ul>${approved
                .map((ab) => `<li>${esc(t(ab.text_ar, ab.text_en))}</li>`)
                .join('')}</ul></div>`
            : ''
        }
      </div>
    `;
  }

  // --- STAGE 4: Clinical Training, Rotations, and Internship ---
  function renderStage4Content() {
    const trainings = STATE.bundle.training || [];

    return `
      <div class="banner banner-info">
        <strong>${t('الفصل الصارم بين التدريب السريري/الامتياز وبين العمل المهني المستقل:', 'Strict Separation of Supervised Training & Internship from Employment:')}</strong>
        <p style="margin:0.35rem 0 0 0;">
          ${t(
            'تم تحميل التدريب السريري في مستشفى بنها الجامعي (2020) وفترة الامتياز السريري لمدة 6 أشهر في مستشفى الشهداء المركزي. لم يتم اختلاق تواريخ بداية/نهاية لكل قسم في الامتياز، ولم يتم تحديد "استقبال المرضى" أو "التحقق من هوية المريض" كمهام مؤكدة لأنها لم تُختر في البيانات الأصلية.',
            'Preloaded Clinical Training at Benha University Hospital (2020) and the 6-month Clinical Internship at El-Shohada Central Hospital. Rotation dates are not invented, and Patient Reception & Patient Identification remain unchecked/unconfirmed.'
          )}
        </p>
      </div>

      ${trainings
        .map((trn, idx) => {
          let rotations = [];
          let assisted = [];
          let unconfirmed = [];
          try {
            rotations = JSON.parse(trn.rotations_json || '[]');
            assisted = JSON.parse(trn.tasks_assisted_json || '[]');
            unconfirmed = JSON.parse(trn.tasks_unconfirmed_json || '[]');
          } catch (_) {}

          return `
            <div class="card">
              <div class="card-header">
                <div>
                  <h3 class="card-title">${esc(trn.institution_ar)} — ${esc(trn.institution_en)}</h3>
                  <small class="form-sublabel">${esc(trn.department_role_ar)} (${esc(trn.department_role_en)}) | ${esc(trn.total_duration_en)}</small>
                </div>
                <span class="badge ${trn.draft_approval_status === 'approved' ? 'badge-confirmed' : 'badge-needs-conf'}">
                  ${
                    trn.draft_approval_status === 'approved'
                      ? t('تم اعتماد الصياغة من صاحب السيرة ✓', 'Wording Approved by Owner ✓')
                      : t('صياغة مقترحة — بانتظار المراجعة والاعتماد', 'Suggested Wording — Pending Review')
                  }
                </span>
              </div>

              <p style="font-size:0.88rem;">
                <strong>${t('الأقسام المشمولة بالتدريب/الامتياز (تحت الإشراف):', 'Supervised Rotations Encountered:')}</strong>
                ${esc(rotations.join(' • '))}
              </p>

              ${
                assisted.length > 0
                  ? `<p style="font-size:0.85rem;"><strong>${t('المهام المختارة خلال التدريب (تحت الإشراف):', 'Tasks Performed/Assisted During Training:')}</strong> ${esc(assisted.join(', '))}</p>`
                  : ''
              }

              ${
                unconfirmed.length > 0
                  ? `<div class="banner banner-warn" style="padding:0.55rem 0.85rem; margin-bottom:0.75rem;">
                      <strong>${t('مهام غير مؤكدة (لم يتم اختيارها تلقائيًا):', 'Unconfirmed / Unchecked Tasks (Not claimed automatically):')}</strong>
                      ${esc(unconfirmed.join(' , '))}
                    </div>`
                  : ''
              }

              <div class="grid-2">
                <div class="form-group">
                  <label class="form-label">${t('الصياغة العربية المقترحة للسيرة الذاتية (قابلة للتعديل والاعتماد):', 'Suggested Arabic CV Wording (Editable):')}</label>
                  <textarea class="form-textarea" data-trn-idx="${idx}" data-trn-field="suggested_draft_ar">${esc(trn.approved_draft_ar || trn.suggested_draft_ar)}</textarea>
                </div>
                <div class="form-group">
                  <label class="form-label">${t('الصياغة الإنجليزية المقترحة للسيرة الذاتية (محافظة ودقيقة):', 'Suggested English CV Wording (Conservative & Accurate):')}</label>
                  <textarea class="form-textarea" data-trn-idx="${idx}" data-trn-field="suggested_draft_en">${esc(trn.approved_draft_en || trn.suggested_draft_en)}</textarea>
                </div>
              </div>

              <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                <button type="button" class="btn btn-sm btn-primary" data-trn-approve="${idx}">
                  ${t('اعتماد هذه الصياغة للسيرة الذاتية ✓ (Use Suggestion)', 'Approve & Use Wording ✓')}
                </button>
                <button type="button" class="btn btn-sm" data-trn-reject="${idx}">
                  ${t('إبقاء كمسودة تحتاج لمراجعة (Keep as Draft)', 'Keep as Pending Review')}
                </button>
              </div>
            </div>
          `;
        })
        .join('')}
    `;
  }

  // --- STAGE 5: Imaging Modalities and Competency Matrix ---
  function renderStage5Content() {
    const modalities = STATE.bundle.modalities || [];

    return `
      <div class="banner banner-info">
        <strong>${t('مصفوفة الكفاءة الصادقة لأجهزة التصوير الطبي (Stage 5):', 'Honest Modality Competency Matrix:')}</strong>
        <p style="margin:0.35rem 0 0 0;">
          ${t(
            'الأقسام التي اخترتها كخبرة عمل (الأشعة العادية، المقطعية CT، الماموجرام، التداخلية، الطوارئ، العناية المركزة، العمليات، الحوادث) مفصولة تمامًا عن الأقسام التي مررت عليها في الامتياز فقط (الرنين المغناطيسي MRI، الموجات فوق الصوتية US، التنظير التألقي Fluoroscopy، أشعة الأسنان).',
            'Modalities selected as work experience are strictly separated from modalities encountered only during your 6-month internship (MRI, Ultrasound, Fluoroscopy, Dental).'
          )}
        </p>
      </div>

      <table class="data-table">
        <thead>
          <tr>
            <th>${t('الجهاز / القسم (Modality)', 'Imaging Modality')}</th>
            <th>${t('تصنيف الخبرة الفعلي (Experience Category)', 'Experience Category')}</th>
            <th>${t('مستوى الثقة / الكفاءة', 'Competency Confidence')}</th>
            <th>${t('طراز الجهاز (اختياري — اتركه Not sure إذا غير متأكد)', 'Known Equipment Make/Model')}</th>
            <th>${t('إظهار في السيرة؟', 'Show on CV')}</th>
          </tr>
        </thead>
        <tbody>
          ${modalities
            .map(
              (m, idx) => `
              <tr>
                <td>
                  <strong>${esc(m.modality_name_en)}</strong><br>
                  <small class="form-sublabel">${esc(m.modality_name_ar)}</small>
                </td>
                <td>
                  <select class="form-select" data-mod-idx="${idx}" data-mod-field="experience_category">
                    ${[
                      ['independent_work', t('عمل مهني عملي (Professional Work)', 'Independent Hands-on Work')],
                      ['supervised_work', t('عمل تحت الإشراف (Supervised Work)', 'Supervised Hands-on Work')],
                      ['internship_exposure', t('تعرض تدريبي بالامتياز فقط (Internship Exposure Only)', 'Internship Rotation Exposure Only')],
                      ['observation_only', t('مشاهدة فقط (Observation Only)', 'Observation Only')],
                      ['theoretical', t('معرفة نظرية (Theoretical Knowledge)', 'Theoretical Knowledge')],
                      ['no_experience', t('لا توجد خبرة (No Experience)', 'No Experience')],
                    ]
                      .map(
                        ([val, lbl]) => `<option value="${val}" ${m.experience_category === val ? 'selected' : ''}>${esc(lbl)}</option>`
                      )
                      .join('')}
                  </select>
                </td>
                <td>
                  <select class="form-select" data-mod-idx="${idx}" data-mod-field="confidence_level">
                    ${[
                      ['needs_confirmation', t('يحتاج لتأكيد', 'Needs Confirmation')],
                      ['beginner', t('مبتدئ (Beginner)', 'Beginner')],
                      ['developing', t('قيد التطور (Developing)', 'Developing')],
                      ['competent_routine', t('متمكن في الفحوصات الروتينية (Competent in Routine Cases)', 'Competent in Routine Cases')],
                      ['experienced_complex', t('متمرس في الحالات المتقدمة (Experienced)', 'Experienced in Complex Cases')],
                    ]
                      .map(
                        ([val, lbl]) => `<option value="${val}" ${m.confidence_level === val ? 'selected' : ''}>${esc(lbl)}</option>`
                      )
                      .join('')}
                  </select>
                </td>
                <td>
                  <input type="text" class="form-input" data-mod-idx="${idx}" data-mod-field="equipment_models" value="${esc(m.equipment_models || 'Not sure')}">
                </td>
                <td style="text-align:center;">
                  <input type="checkbox" data-mod-idx="${idx}" data-mod-field="include_in_cv" ${m.include_in_cv ? 'checked' : ''}>
                </td>
              </tr>
            `
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  // --- STAGE 6: Procedures, Technical Workflows, Equipment, and Safety ---
  function renderStage6Content() {
    const wf = getAnswerValue('s6_workflow_and_safety_matrix', {
      patient_workflow: [
        'Patient preparation and communication',
        'Patient positioning and immobilization within authorized scope',
        'Reviewing relevant patient history and examination requests',
        'Selecting/confirming imaging protocols within local policy',
        'Image acquisition and preliminary image quality assessment',
        'Portable imaging and safe transport coordination',
      ],
      patient_id_confirmed: false,
      contrast_scope: 'supervised_assistance',
      pacs_ris_dicom: ['PACS image uploading and study verification', 'RIS data entry', 'DICOM transfer'],
      software_names: 'Not sure (Standard hospital PACS/RIS)',
      radiation_safety: ['Collimation & dose optimization awareness', 'Lead shielding according to policy', 'Controlled-area safety'],
    });

    return `
      <div class="banner banner-info">
        <strong>${t('الإجراءات الفنية والصبغات والوقاية الإشعاعية (Stage 6):', 'Workflows, Contrast Scope, PACS/RIS & Safety:')}</strong>
        ${t(
          'حدد بدقة حدود مسؤوليتك في التعامل مع الصبغات وأنظمة PACS/RIS. تذكر أن التحقق من هوية المريض واستقبال المرضى لم يتم تفعيلهما تلقائيًا إلا إذا أكدت ممارستهما.',
          'Specify your exact operational scope for contrast procedures, PACS/RIS, and radiation protection.'
        )}
      </div>

      <div class="grid-2">
        <div class="card">
          <h3 style="margin-top:0; font-size:1rem;">${t('نطاق التعامل مع الصبغات الطبية (Contrast Scope)', 'Contrast Media Responsibility Scope')}</h3>
          <div class="form-group">
            <label class="form-label">${t('ما هو دورك الفعلي المصرح به في فحوصات الصبغة؟', 'What was your authorized scope for contrast studies?')}</label>
            <select class="form-select" data-s6-contrast>
              ${[
                ['supervised_assistance', t('تحضير الصبغة والمساعدة وملاحظة المريض تحت الإشراف (During training/supervision)', 'Contrast preparation, assistance & post-procedure observation under supervision')],
                ['authorized_protocol', t('ضمن بروتوكول القسم المعتمد وبإشراف طبيب الأشعة', 'Within authorized departmental protocol & physician oversight')],
                ['observation_only', t('مشاهدة فقط', 'Observation only')],
              ]
                .map(([v, l]) => `<option value="${v}" ${wf.contrast_scope === v ? 'selected' : ''}>${esc(l)}</option>`)
                .join('')}
            </select>
          </div>

          <div class="form-group">
            <label style="display:flex; align-items:center; gap:0.5rem;">
              <input type="checkbox" data-s6-patientid ${wf.patient_id_confirmed ? 'checked' : ''}>
              <span>${t('أؤكد أنني أقوم بالتحقق من هوية المريض واستقبال المرضى في عملي الحالي (غير مفعلة افتراضيًا)', 'I confirm performing Patient Reception & Patient Identification in my current role (Unchecked by default)')}</span>
            </label>
          </div>
        </div>

        <div class="card">
          <h3 style="margin-top:0; font-size:1rem;">${t('أنظمة PACS و RIS و DICOM', 'PACS, RIS & DICOM Digital Systems')}</h3>
          <div class="form-group">
            <label class="form-label">${t('اسم برنامج PACS/RIS (اتركه Not sure إذا كنت لا تتذكر اسم الشركة المصنعة):', 'Specific PACS/RIS Software Name (Keep "Not sure" if unknown):')}</label>
            <input type="text" class="form-input" data-s6-software value="${esc(wf.software_names || 'Not sure')}">
          </div>
          <div class="explain-box">
            <strong>PACS:</strong> نظام أرشفة ونقل الصور الطبية | <strong>RIS:</strong> نظام معلومات الأشعة | <strong>DICOM:</strong> المعيار الرقمي لتبادل الصور الطبية.
          </div>
        </div>
      </div>
    `;
  }

  // --- STAGE 7: Achievements, Problem Solving, Workload, and Impact ---
  function renderStage7Content() {
    const achs = (STATE.bundle.achievements || []).filter((a) => a.stage_number === 7);

    return `
      <div class="banner banner-warn">
        <strong>${t('قاعدة عدم اختلاق الأرقام وحماية خصوصية المرضى (Stage 7):', 'Anti-Fabrication & Patient Privacy Guardrail (Stage 7):')}</strong>
        ${t(
          'لا تخترع نسبًا مئوية أو أعداد مرضى غير حقيقية؛ الإنجاز النوعي الصادق مقبول وممتاز مهنيًا. ويُحظر تمامًا ذكر أسماء مرضى أو أرقام ملفاتهم الطبية.',
          'Never invent percentages or workload numbers; qualitative achievements are welcomed. Never enter patient names, IDs, or medical record numbers.'
        )}
      </div>

      ${achs
        .map(
          (a, idx) => `
          <div class="card">
            <strong>${esc(a.title_ar || a.title_en)}</strong>
            <p style="font-size:0.88rem; margin:0.3rem 0;">${esc(a.approved_bullet_en || a.suggested_bullet_en)}</p>
          </div>
        `
        )
        .join('')}

      <div class="card">
        <h3 style="margin-top:0; font-size:1rem;">${t('إضافة موقف مهني أو إنجاز عملي (نموذج الموقف — الإجراء — النتيجة)', 'Add Evidence-Based Clinical Achievement (Situation — Action — Result)')}</h3>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">${t('1. الموقف العام (بدون أي بيانات تعريفية للمريض):', '1. Situation (No patient identifiers):')}</label>
            <input type="text" id="ach-situation" class="form-input" placeholder="${t('مثال: ضغط حالات طوارئ وحوادث خلال النبطشية', 'e.g., High-volume emergency trauma imaging shift')}">
          </div>
          <div class="form-group">
            <label class="form-label">${t('2. الإجراء الذي قمت به شخصيًا:', '2. Action You Personally Took:')}</label>
            <input type="text" id="ach-action" class="form-input" placeholder="${t('مثال: تنظيم أولويات التصوير المتنقل وضبط جودة الصورة من المرة الأولى', 'e.g., Prioritized portable ICU/ER requests and ensured accurate first-time positioning')}">
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">${t('3. النتيجة (وصفية أو رقم تقريبي واضح):', '3. Result (Qualitative or clearly labeled estimate):')}</label>
            <input type="text" id="ach-result" class="form-input" placeholder="${t('مثال: تسريع تسليم صور الطوارئ وتقليل الحاجة لإعادة التصوير', 'e.g., Supported timely emergency imaging workflow and reduced avoidable repeat exposures')}">
          </div>
          <div class="form-group">
            <label class="form-label">${t('4. نوع القياس:', '4. Measurement Type:')}</label>
            <select id="ach-measure" class="form-select">
              <option value="qualitative">${t('وصفي / نوعي (Qualitative — بدون أرقام مخترعة)', 'Qualitative (No invented metrics)')}</option>
              <option value="approximate">${t('تقديري موضح (Approximate & labeled)', 'Approximate & clearly labeled')}</option>
              <option value="exact">${t('رقم موثق رسميًا (Verified exact number)', 'Verified exact number')}</option>
            </select>
          </div>
        </div>
        <button type="button" class="btn btn-primary" data-action="add-achievement">${t('+ حفظ وإضافة الإنجاز للسيرة', '+ Save & Add Achievement')}</button>
      </div>
    `;
  }

  // --- STAGE 8: Licenses, Registration, Professional Classification, CPD, and Certificates ---
  function renderStage8Content() {
    const licenses = STATE.bundle.licenses || [];

    return `
      <div class="banner banner-info">
        <strong>${t('التراخيص المهنية والقيد النقابي والتصنيف السعودي (Stage 8):', 'Licenses, Syndicate Registration & Saudi Classification:')}</strong>
        ${t(
          'أرقام التراخيص والوثائق تُحفظ بشكل خاص ولا تُنشر في السيرة الذاتية العامة افتراضيًا إلا إذا اخترت إظهارها. ولا يدّعي النظام أهليتك القانونية للعمل في السعودية إلا بعد صدور قرار التصنيف الرسمي.',
          'Sensitive license numbers are hidden from the public CV by default. The platform never claims legal eligibility to practise in Saudi Arabia without official regulatory confirmation.'
        )}
      </div>

      ${licenses
        .map(
          (lic, idx) => `
          <div class="card">
            <div class="card-header">
              <strong>${esc(lic.name_ar)} — ${esc(lic.name_en)}</strong>
              <span class="badge ${lic.confirmation_state === 'user_confirmed' ? 'badge-confirmed' : 'badge-needs-conf'}">${esc(lic.status)}</span>
            </div>
            <div class="grid-3">
              <div class="form-group">
                <label class="form-label">${t('جهة الإصدار الرسمية (إنجليزي/عربي)', 'Issuing Authority')}</label>
                <input type="text" class="form-input" data-lic-idx="${idx}" data-lic-field="issuing_authority_en" value="${esc(lic.issuing_authority_en || '')}">
              </div>
              <div class="form-group">
                <label class="form-label">${t('الحالة الحالية', 'Current Status')}</label>
                <select class="form-select" data-lic-idx="${idx}" data-lic-field="status">
                  ${['needs_confirmation', 'active', 'in_progress', 'not_started', 'completed', 'not_applicable']
                    .map((st) => `<option value="${st}" ${lic.status === st ? 'selected' : ''}>${esc(st)}</option>`)
                    .join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">${t('رقم الترخيص (خاص — مخفي افتراضيًا عن السيرة العامة)', 'License Number (Private by default)')}</label>
                <input type="text" class="form-input" data-lic-idx="${idx}" data-lic-field="license_number_private" value="${esc(lic.license_number_private || '')}" placeholder="${t('اختياري وخاص', 'Optional & kept private')}">
              </div>
            </div>
          </div>
        `
        )
        .join('')}
    `;
  }

  // --- STAGE 9: Languages, Digital Skills, Communication, and Professional Strengths ---
  function renderStage9Content() {
    const langSkills = getAnswerValue('s9_languages_and_skills', {
      arabic_level: 'Native (لغة أم)',
      english_spoken: 'Needs confirmation (Intermediate / Professional working)',
      english_written: 'Professional medical imaging terminology & reporting workflow',
      digital_skills: ['PACS / RIS workflow', 'DICOM handling', 'Electronic medical documentation'],
      strengths: [
        'Calmness under emergency & trauma workload pressure',
        'Strict adherence to radiation safety protocols',
        'Clear communication with patients and multidisciplinary teams',
      ],
    });

    return `
      <div class="card">
        <h3 style="margin-top:0; font-size:1rem;">${t('إجادة اللغات والمهارات الرقمية (بدون مبالغة تلقائية)', 'Calibrated Languages & Digital Skills')}</h3>
        <div class="grid-3">
          <div class="form-group">
            <label class="form-label">${t('اللغة العربية', 'Arabic Proficiency')}</label>
            <input type="text" class="form-input" data-s9-field="arabic_level" value="${esc(langSkills.arabic_level)}">
          </div>
          <div class="form-group">
            <label class="form-label">${t('اللغة الإنجليزية (تحدثًا)', 'English (Spoken Level)')}</label>
            <select class="form-select" data-s9-field="english_spoken">
              ${[
                'Needs confirmation (Intermediate / Professional working)',
                'Basic',
                'Intermediate',
                'Professional working',
                'Fluent',
              ]
                .map((l) => `<option value="${esc(l)}" ${langSkills.english_spoken === l ? 'selected' : ''}>${esc(l)}</option>`)
                .join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">${t('اللغة الإنجليزية (كتابةً ومصطلحات طبية)', 'English (Written & Medical Terminology)')}</label>
            <input type="text" class="form-input" data-s9-field="english_written" value="${esc(langSkills.english_written)}">
          </div>
        </div>
      </div>
    `;
  }

  // --- STAGE 10: Teaching, Research, Publications, Memberships (Optional) ---
  function renderStage10Content() {
    const stage10Achs = (STATE.bundle.achievements || []).filter((a) => a.stage_number === 10);
    return `
      <div class="banner banner-info">
        <strong>${t('المرحلة 10 (اختيارية تمامًا):', 'Stage 10 (Completely Optional):')}</strong>
        ${t(
          'إذا لم تكن لديك أبحاث منشورة أو مشاركات تدريسية رسمية، اترك هذا القسم فارغًا بأمان ولن يقوم النظام باختلاق أي بحث أو عضوية.',
          'If you have no publications or formal teaching roles, leave this section empty—nothing is ever fabricated.'
        )}
      </div>
      ${
        stage10Achs.length === 0
          ? `<div class="explain-box">${t('لا توجد أبحاث أو منشورات مضافة حاليًا (سيتم إخفاء هذا القسم تلقائيًا من السيرة الذاتية حتى لا يظهر فارغًا).', 'No information added yet — this optional section will be cleanly omitted from the published CV.')}</div>`
          : ''
      }
    `;
  }

  // --- STAGE 11: Saudi Arabia Readiness and Targeted Application Preferences ---
  function renderStage11Content() {
    const sr = getAnswerValue('s11_saudi_readiness', {
      target_country: 'Saudi Arabia',
      passport_valid: true,
      immediate_availability: true,
      relocation_ready: true,
      scfhs_classification_status: 'Needs Official Confirmation',
      dataflow_verification_status: 'Needs Official Confirmation',
    });

    return `
      <div class="banner banner-warn">
        <strong>${t('تنبيه تنظيمي هام خاص بالمملكة العربية السعودية:', 'Important Regulatory Notice for Saudi Arabia:')}</strong>
        ${t(
          'هذه القائمة استرشادية لتجهيز أوراقك للتوظيف، وليست قرارًا رسميًا بالأهلية أو التصنيف المهني. الجهة الوحيدة المخولة بإصدار التصنيف المهني هي الهيئة السعودية للتخصصات الصحية (SCFHS).',
          'This checklist is for recruitment preparation guidance only and does not constitute an official licensing or classification decision.'
        )}
      </div>

      <div class="grid-2">
        <div class="card">
          <h3 style="margin-top:0; font-size:1rem;">${t('قائمة جاهزية التقديم والعمل في السعودية', 'Saudi Arabia Recruitment Readiness Checklist')}</h3>
          <div class="form-group">
            <label class="form-label">${t('حالة التحقق من الوثائق (DataFlow / Primary Source Verification):', 'Document Verification (DataFlow) Status:')}</label>
            <select class="form-select" data-s11-field="dataflow_verification_status">
              ${['Needs Official Confirmation', 'Not Started', 'In Progress', 'Completed', 'Not Applicable']
                .map((s) => `<option value="${s}" ${sr.dataflow_verification_status === s ? 'selected' : ''}>${esc(s)}</option>`)
                .join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">${t('حالة التسجيل والتصنيف المهني (SCFHS):', 'Saudi Professional Classification (SCFHS) Status:')}</label>
            <select class="form-select" data-s11-field="scfhs_classification_status">
              ${['Needs Official Confirmation', 'Not Started', 'In Progress', 'Completed', 'Not Applicable']
                .map((s) => `<option value="${s}" ${sr.scfhs_classification_status === s ? 'selected' : ''}>${esc(s)}</option>`)
                .join('')}
            </select>
          </div>
          <p class="form-sublabel">
            ✓ ${t('جواز السفر: ساري (لا يتم نشر رقم الجواز في السيرة العامة)', 'Passport: Valid (Passport number is kept private and omitted from CV)')}<br>
            ✓ ${t('التفرغ والانتقال: جاهز للانتقال والعمل فورًا', 'Relocation & Availability: Immediate readiness')}
          </p>
        </div>

        <div class="card">
          <h3 style="margin-top:0; font-size:1rem;">${t('محلل الوصف الوظيفي الصادق (Job Description Parser & Match Matrix)', 'Honest Job Description Parser & Match Matrix')}</h3>
          <div class="form-group">
            <label class="form-label">${t('الصق نص الإعلان الوظيفي المستهدف هنا لمقارنته ببياناتك الحقيقية:', 'Paste a target hospital job description to compare against your confirmed skills:')}</label>
            <textarea id="jd-input-text" class="form-textarea" placeholder="${t('مثال: مطلوب أخصائي أشعة للعمل في مستشفى بالرياض خبرة في X-Ray و CT و MRI ونظام PACS...', 'e.g., Seeking Radiology Specialist in Riyadh with experience in General X-Ray, CT, MRI, Ultrasound, and PACS...')}"></textarea>
          </div>
          <button type="button" class="btn btn-primary" data-action="parse-job-description">
            ${t('تحليل الإعلان الوظيفي ومطابقة الأدلة', 'Parse Job Description & Check Evidence Match')}
          </button>

          ${
            STATE.jobMatchResult
              ? `
                <div class="explain-box" style="margin-top:0.85rem;">
                  <strong>${esc(t(STATE.jobMatchResult.honestTailoringAdvice_ar, STATE.jobMatchResult.honestTailoringAdvice_en))}</strong>
                  <table class="data-table" style="margin-top:0.5rem;">
                    <thead>
                      <tr>
                        <th>${t('المتطلب في الإعلان', 'Requirement')}</th>
                        <th>${t('حالة المطابقة الصادقة في ملفك', 'Honest Evidence Status in Your Profile')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${(STATE.jobMatchResult.matchMatrix || [])
                        .map(
                          (row) => `
                          <tr>
                            <td><strong>${esc(t(row.requirement_ar, row.requirement_en))}</strong></td>
                            <td>
                              <span class="badge ${row.safe_to_claim_independently ? 'badge-confirmed' : 'badge-needs-conf'}">${esc(row.match_status)}</span>
                              <div style="font-size:0.8rem; margin-top:2px;">${esc(t(row.evidence_ar, row.evidence_en))}</div>
                            </td>
                          </tr>
                        `
                        )
                        .join('')}
                    </tbody>
                  </table>
                </div>
              `
              : ''
          }
        </div>
      </div>
    `;
  }

  // --- STAGE 12: References, Supporting Documents, and Portfolio Uploads ---
  function renderStage12Content() {
    return `
      ${renderUploadManagerSection()}
      <div class="card">
        <h3 style="margin-top:0; font-size:1rem;">${t('المعرّفون المهنيون (References — اختياري تمامًا)', 'Professional References (Optional — Private by Default)')}</h3>
        <p class="form-sublabel">${t(
          'لا يتم نشر أرقام هواتف أو بريد المعرّفين في السيرة العامة إلا بعد تأكيد موافقتهم.',
          'Reference phone numbers and emails are never published on the public CV without explicit permission.'
        )}</p>
      </div>
    `;
  }

  // --- STAGE 13: Final Review, CV Composer, Quality Check, Export, and Sharing ---
  function renderStage13Content() {
    const q = STATE.bundle.quality || {};
    return `
      <div class="banner banner-info">
        <strong>${t('المراجعة النهائية وفحص الجودة والتصدير الفوري (Stage 13):', 'Stage 13 Final Quality Review, CV Composer & Export:')}</strong>
        ${t(
          'يُظهر هذا الفحص الفرق بين الحقائق المؤكدة منك، والصياغات المقترحة، والحقول التي تحتاج لتأكيد. يمكنك تصدير السيرة الذاتية الآن (حتى كمسودة) أو تصدير كراسة الإجابات الكاملة.',
          'Separates user-confirmed facts, suggested wording, and items needing confirmation. You can export your CV PDF or Answer Workbook PDF immediately.'
        )}
      </div>

      <div class="grid-2">
        <div class="card">
          <h3 style="margin-top:0; font-size:1rem;">${t('تنبيهات الفجوات والتعارضات (دون تعديل صامت للبيانات)', 'Missing Essentials, Uncertainty Flags & Overlap Checks')}</h3>
          <ul style="font-size:0.88rem; padding-inline-start:1.2rem;">
            ${(q.essentialMissing || []).map((m) => `<li><span class="badge badge-needs-conf">${t('مفقود', 'Missing')}</span> ${esc(t(m.message_ar, m.message_en))}</li>`).join('')}
            ${(q.needsConfirmationFlags || []).map((m) => `<li><span class="badge badge-needs-conf">${t('يحتاج لتأكيد', 'Needs Confirmation')}</span> ${esc(t(m.message_ar, m.message_en))}</li>`).join('')}
            ${(q.conflictsAndWarnings || []).map((c) => `<li><span class="badge badge-setup">${t('استفسار تداخل', 'Overlap Clarification')}</span> ${esc(t(c.message_ar, c.message_en))}</li>`).join('')}
          </ul>
        </div>

        <div class="card">
          <h3 style="margin-top:0; font-size:1rem;">${t('لوحة الأدلة ومصدر البيانات (Evidence & Confidence Panel)', 'Evidence & Provenance Panel')}</h3>
          <ul style="font-size:0.86rem; padding-inline-start:1.2rem;">
            ${(q.evidenceConfidenceList || [])
              .map(
                (ev) => `
                <li style="margin-bottom:0.45rem;">
                  <strong>${esc(ev.section)}:</strong> ${esc(t(ev.fact_ar, ev.fact_en))}
                  <span class="badge badge-imported">${esc(ev.source)}</span>
                  <span class="badge ${ev.status === 'user_confirmed' ? 'badge-confirmed' : 'badge-needs-conf'}">${esc(ev.status)}</span>
                </li>
              `
              )
              .join('')}
          </ul>
        </div>
      </div>

      ${renderExportCenterSection()}
    `;
  }

  // --- Live CV Preview & Composer Page ---
  function renderPreviewPage() {
    if (!STATE.authenticated || !STATE.bundle) return renderAuthPage();
    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">${t('معاينة السيرة الذاتية وتخصيص القالب واللغة', 'Live CV Composer & Preview (Arabic RTL / English LTR / Bilingual)')}</h2>
            <p class="form-sublabel">${t('تستخدم السيرة الإنجليزية تخطيط LTR صحيحًا حتى لو تم إدخال الإجابات بالعربية.', 'English CV output uses strict LTR layout while Arabic uses native RTL layout.')}</p>
          </div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <select id="prev-mode-select" class="form-select" style="width:auto;">
              <option value="cv" ${STATE.previewMode === 'cv' ? 'selected' : ''}>${t('السيرة الذاتية الموجهة لجهات العمل (Employer CV)', 'Employer-Facing CV')}</option>
              <option value="workbook" ${STATE.previewMode === 'workbook' ? 'selected' : ''}>${t('كراسة الإجابات الكاملة الخاصة (Answer Workbook)', 'Complete Answer Workbook')}</option>
            </select>
            <select id="prev-lang-select" class="form-select" style="width:auto;">
              <option value="en" ${STATE.previewLang === 'en' ? 'selected' : ''}>English CV (LTR)</option>
              <option value="ar" ${STATE.previewLang === 'ar' ? 'selected' : ''}>السيرة بالعربية (RTL)</option>
              <option value="bilingual" ${STATE.previewLang === 'bilingual' ? 'selected' : ''}>ثنائية اللغة (Bilingual)</option>
            </select>
            <select id="prev-tpl-select" class="form-select" style="width:auto;">
              <option value="modern-healthcare" ${STATE.previewTemplate === 'modern-healthcare' ? 'selected' : ''}>Modern Healthcare</option>
              <option value="classic-medical" ${STATE.previewTemplate === 'classic-medical' ? 'selected' : ''}>Classic Healthcare</option>
              <option value="ats-clean" ${STATE.previewTemplate === 'ats-clean' ? 'selected' : ''}>ATS-Friendly Clean</option>
            </select>
            <button type="button" class="btn btn-primary" data-action="refresh-preview">${t('تحديث المعاينة', 'Refresh Preview')}</button>
            <button type="button" class="btn" data-action="export-current-preview-pdf">${t('تنزيل PDF الآن', 'Download PDF')}</button>
          </div>
        </div>

        <iframe class="cv-preview-frame" title="CV Live Preview" srcdoc="${esc(STATE.previewHtml || '<p style="padding:2rem;font-family:sans-serif;">Click Refresh Preview to render live document...</p>')}"></iframe>
      </div>
    `;
  }

  // --- Export Center & Share Links Section ---
  function renderExportCenterSection() {
    if (!STATE.authenticated || !STATE.bundle) return renderAuthPage();
    const exportsList = STATE.bundle.exportsList || [];
    const shareLinks = STATE.bundle.shareLinks || [];

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">${t('مركز التصدير الفعلي والنسخ الاحتياطي والمشاركة الآمنة', 'Real Document Export Center, Backups & Expiring Share Links')}</h2>
            <p class="form-sublabel">${t('جميع الأزرار تولّد ملفات حقيقية قابلة للبحث والتحديد (PDF / DOCX / JSON / Markdown) مفصولة الصلاحيات.', 'Every export generates a real, verified file on the server.')}</p>
          </div>
        </div>

        <div class="grid-3">
          <div class="card" style="margin-bottom:0;">
            <h3 style="margin-top:0; font-size:0.98rem;">1. ${t('السيرة الذاتية النهائية / مسودة المراجعة (PDF)', 'Professional CV PDF / Draft PDF')}</h3>
            <p class="form-sublabel">${t('تتضمن فقط المحتوى المعتمد للنشر بدون الملاحظات الخاصة.', 'Includes only CV-approved sections; excludes private stage notes.')}</p>
            <div style="display:flex; flex-direction:column; gap:0.45rem;">
              <button type="button" class="btn btn-primary btn-sm" data-export-type="cv_pdf" data-export-lang="en">
                ${t('تصدير السيرة بالإنجليزية (PDF EN — LTR)', 'Export English CV PDF (LTR)')}
              </button>
              <button type="button" class="btn btn-primary btn-sm" data-export-type="cv_pdf" data-export-lang="ar">
                ${t('تصدير السيرة بالعربية (PDF AR — RTL)', 'Export Arabic CV PDF (RTL)')}
              </button>
              <button type="button" class="btn btn-sm" data-export-type="draft_pdf" data-export-lang="en">
                ${t('تصدير مسودة مراجعة موسومة (DRAFT PDF)', 'Export Labeled Partial Draft PDF')}
              </button>
            </div>
          </div>

          <div class="card" style="margin-bottom:0;">
            <h3 style="margin-top:0; font-size:0.98rem;">2. ${t('كراسة الإجابات الكاملة الخاصة (Workbook PDF)', 'Complete Question & Answer Workbook PDF')}</h3>
            <p class="form-sublabel">${t('تحفظ كل سؤال مع إجابته ومصدره وتاريخ الحفظ والملاحظات الخاصة (للاحتفاظ الشخصي).', 'Preserves every question label, saved answer, confirmation status, and timestamp.')}</p>
            <div style="display:flex; flex-direction:column; gap:0.45rem;">
              <button type="button" class="btn btn-primary btn-sm" data-export-type="workbook_pdf" data-export-lang="ar">
                ${t('تصدير كراسة الإجابات الكاملة (PDF عربي/إنجليزي)', 'Export Complete Answer Workbook PDF')}
              </button>
              <button type="button" class="btn btn-sm" data-export-type="docx" data-export-lang="en">
                ${t('تصدير ملف Word قابل للتعديل (DOCX)', 'Export Editable Word Document (DOCX)')}
              </button>
            </div>
          </div>

          <div class="card" style="margin-bottom:0;">
            <h3 style="margin-top:0; font-size:0.98rem;">3. ${t('نسخة احتياطية وروابط مشاركة مؤقتة', 'Data Portability Backups & Share Links')}</h3>
            <div style="display:flex; flex-direction:column; gap:0.45rem;">
              <button type="button" class="btn btn-sm" data-export-type="json_backup" data-export-lang="en">
                ${t('تنزيل نسخة احتياطية كاملة (JSON Backup)', 'Download JSON Data Backup')}
              </button>
              <button type="button" class="btn btn-sm" data-export-type="markdown_backup" data-export-lang="en">
                ${t('تنزيل نسخة نصية منظمة (Markdown Backup)', 'Download Markdown Text Backup')}
              </button>
              <button type="button" class="btn btn-sm" data-action="create-share-link">
                ${t('+ إنشاء رابط مشاركة مؤقت قابل للإلغاء (24 ساعة)', '+ Create Expiring Share Link (24h)')}
              </button>
            </div>
          </div>
        </div>

        ${
          exportsList.length > 0
            ? `
              <h3 style="font-size:1rem; margin-top:1.25rem;">${t('سجل الملفات المُصدّرة وفحص سلامة الـ PDF:', 'Generated Exports History & Layout Verification:')}</h3>
              <table class="data-table">
                <thead>
                  <tr>
                    <th>${t('اسم الملف', 'Filename')}</th>
                    <th>${t('النوع واللغة', 'Type & Lang')}</th>
                    <th>${t('الحجم وفحص النص القابل للتحديد', 'Size & Selectable Text Check')}</th>
                    <th>${t('التاريخ', 'Created At')}</th>
                    <th>${t('التحميل', 'Action')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${exportsList
                    .map(
                      (ex) => `
                      <tr>
                        <td><strong>${esc(ex.filename)}</strong></td>
                        <td>${esc(ex.export_type)} (${esc(ex.language)})</td>
                        <td>${Math.round((ex.size_bytes || 0) / 1024)} KB — <span class="badge badge-confirmed">Verified ✓</span></td>
                        <td>${esc(ex.created_at)}</td>
                        <td><a class="btn btn-sm btn-primary" href="/api/exports/${encodeURIComponent(ex.id)}/download" target="_blank">${t('تنزيل', 'Download')}</a></td>
                      </tr>
                    `
                    )
                    .join('')}
                </tbody>
              </table>
            `
            : ''
        }

        ${
          shareLinks.length > 0
            ? `
              <h3 style="font-size:1rem; margin-top:1.25rem;">${t('روابط المشاركة وسجل الوصول:', 'Active/Revoked Share Links & Access Log:')}</h3>
              <table class="data-table">
                <thead>
                  <tr>
                    <th>${t('الرابط', 'Share Endpoint')}</th>
                    <th>${t('تاريخ الانتهاء', 'Expires At')}</th>
                    <th>${t('عدد المشاهدات', 'Views')}</th>
                    <th>${t('الحالة / الإجراء', 'Status / Action')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${shareLinks
                    .map(
                      (sl) => `
                      <tr>
                        <td><a href="/api/shared/${encodeURIComponent(sl.token)}" target="_blank">/api/shared/${esc(sl.token.slice(0, 12))}...</a></td>
                        <td>${esc(sl.expires_at)}</td>
                        <td>${esc(sl.access_count)}</td>
                        <td>
                          ${
                            sl.revoked_at
                              ? `<span class="badge">${t('ملغى (Revoked)', 'Revoked')}</span>`
                              : `<button type="button" class="btn btn-sm btn-danger" data-revoke-link="${esc(sl.id)}">${t('إلغاء الرابط فورًا', 'Revoke Link')}</button>`
                          }
                        </td>
                      </tr>
                    `
                    )
                    .join('')}
                </tbody>
              </table>
            `
            : ''
        }
      </div>
    `;
  }

  // --- Upload Manager Section (Stage 12 & Cross-Stage) ---
  function renderUploadManagerSection() {
    if (!STATE.authenticated || !STATE.bundle) return renderAuthPage();
    const uploads = STATE.bundle.uploads || [];

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">${t('إدارة الوثائق والمرفقات الآمنة (Upload Manager)', 'Secure Document & Photo Upload Manager')}</h2>
            <p class="form-sublabel">${t(
              'الصيغ المدعومة بأمان: الصور (JPG, PNG, WebP حتى 10MB) والمستندات (PDF, DOCX, TXT حتى 20MB). يتم التحقق من البصمة الرقمية الحقيقية للملف (MIME Magic Bytes) وحظر الملفات التنفيذية أو الامتدادات المزيفة.',
              'Accepted formats: JPG, PNG, WebP (max 10 MB) and PDF, DOCX, TXT (max 20 MB). Server validates actual magic-byte signatures and strips JPEG EXIF/GPS metadata.'
            )}</p>
          </div>
        </div>

        <form id="upload-file-form" class="grid-3" style="align-items:end;">
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label" for="upload-purpose">${t('الغرض من الملف', 'Document Purpose')}</label>
            <select id="upload-purpose" class="form-select">
              <option value="certificate">${t('شهادة علمية / دبلوم (Certificate)', 'Academic Certificate / Diploma')}</option>
              <option value="license">${t('ترخيص مزاولة / كارنيه نقابة (License)', 'Practice License / Syndicate Card')}</option>
              <option value="training_certificate">${t('شهادة تدريب / امتياز (Training Proof)', 'Clinical Training / Internship Proof')}</option>
              <option value="photo">${t('صورة شخصية مهنية (Profile Photo — يفضل 600×600)', 'Professional Profile Photo (600x600+ recommended)')}</option>
              <option value="existing_cv">${t('سيرة ذاتية سابقة لاستخراج مسودة (Existing CV Text)', 'Existing CV for Side-by-Side Draft Review')}</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label" for="upload-file-input">${t('اختر الملف', 'Choose File')}</label>
            <input id="upload-file-input" type="file" class="form-input" required>
          </div>
          <div>
            <button type="submit" class="btn btn-primary">${t('رفع وفحص الملف', 'Upload & Verify File')}</button>
          </div>
        </form>

        ${
          uploads.length > 0
            ? `
              <table class="data-table" style="margin-top:1.25rem;">
                <thead>
                  <tr>
                    <th>${t('اسم الملف', 'File Name')}</th>
                    <th>${t('الغرض والصيغة المحققة', 'Purpose & Verified MIME')}</th>
                    <th>${t('الحجم / الأبعاد / التنبيهات', 'Size, Dimensions & Quality Warnings')}</th>
                    <th>${t('حالة الفحص', 'Scan Status')}</th>
                    <th>${t('إجراءات', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${uploads
                    .map(
                      (u) => `
                      <tr>
                        <td><strong>${esc(u.original_name)}</strong></td>
                        <td>${esc(u.purpose)}<br><small>${esc(u.verified_mime)}</small></td>
                        <td>
                          ${Math.round(u.size_bytes / 1024)} KB
                          ${u.width_px ? `(${u.width_px}×${u.height_px}px)` : ''}
                          ${u.quality_warning ? `<div class="badge badge-needs-conf" style="display:block;margin-top:4px;">${esc(u.quality_warning)}</div>` : ''}
                        </td>
                        <td><span class="badge badge-setup">${esc(u.scan_status)}</span></td>
                        <td>
                          <a class="btn btn-sm" href="/api/uploads/${encodeURIComponent(u.id)}" target="_blank">${t('معاينة', 'Preview')}</a>
                          <button type="button" class="btn btn-sm btn-danger" data-delete-upload="${esc(u.id)}">${t('حذف', 'Delete')}</button>
                        </td>
                      </tr>
                    `
                    )
                    .join('')}
                </tbody>
              </table>
            `
            : `<p class="form-sublabel" style="margin-top:1rem;">${t('لا توجد مرفقات مرفوعة في هذا الملف حتى الآن.', 'No files uploaded to this workspace yet.')}</p>`
        }
      </div>
    `;
  }

  // --- Glossary Page ---
  function renderGlossaryPage() {
    const q = (STATE.glossarySearch || '').toLowerCase();
    const filtered = STATE.glossary.filter(
      (g) =>
        !q ||
        g.term_en.toLowerCase().includes(q) ||
        g.term_ar.includes(q) ||
        g.explanation_ar.includes(q) ||
        g.explanation_en.toLowerCase().includes(q)
    );

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">${t('قاموس مصطلحات الأشعة والتصوير الطبي والتوظيف (عربي – إنجليزي)', 'Bilingual Radiology, Licensing & CV Glossary')}</h2>
            <p class="form-sublabel">${t('يشرح كل مصطلح بلغة عربية واضحة، ولماذا يهم في السيرة الذاتية، ومتى يجب عدم ادعائه.', 'Explains every specialized term in plain Arabic and English, why it matters, and when NOT to claim it.')}</p>
          </div>
          <input type="search" id="glossary-search-input" class="form-input" style="max-width:300px;" value="${esc(STATE.glossarySearch)}" placeholder="${t('ابحث عن مصطلح (مثل PACS, MRI, ATS)...', 'Search terms (e.g. PACS, MRI, ATS)...')}">
        </div>

        <div class="grid-2">
          ${filtered
            .map(
              (item) => `
              <div class="card" style="margin-bottom:0;">
                <h3 style="margin-top:0; font-size:1rem; color:var(--brand-navy);">
                  ${esc(item.term_en)} <br>
                  <span style="color:var(--brand-teal);">${esc(item.term_ar)}</span>
                </h3>
                <p style="font-size:0.88rem; margin:0.35rem 0;"><strong>${t('الشرح المبسط:', 'Explanation:')}</strong> ${esc(t(item.explanation_ar, item.explanation_en))}</p>
                <p style="font-size:0.85rem; margin:0.35rem 0;"><strong>${t('لماذا يهم في السيرة؟', 'Why it matters:')}</strong> ${esc(t(item.why_it_matters_ar, item.why_it_matters_en))}</p>
                <p style="font-size:0.85rem; margin:0.35rem 0;"><strong>${t('مثال مقبول:', 'Acceptable Example:')}</strong> ${esc(t(item.example_ar, item.example_en))}</p>
                <div class="explain-box" style="border-inline-start-color:var(--danger-red);">
                  <strong>${t('متى لا يجوز ادعاء هذه المهارة؟', 'When NOT to claim:')}</strong> ${esc(t(item.when_not_to_claim_ar, item.when_not_to_claim_en))}
                </div>
              </div>
            `
            )
            .join('')}
        </div>
      </div>
    `;
  }

  // --- Account, Privacy, Cookie Preferences & Consent Center (Section 12 & 13) ---
  function renderPrivacyPage() {
    const p = STATE.bundle?.profile;
    return `
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">${t('الحساب والخصوصية وإدارة الموافقات والنسخ المحلية', 'Account, Privacy Policy, Consent Controls & Local Draft Storage')}</h2>
        </div>

        ${
          p
            ? `
              <div class="card" style="background:var(--bg-subtle);">
                <h3 style="margin-top:0; font-size:1rem;">${t('موافقة مشاركة ملف السيرة الذاتية مع مشرف النظام (Purpose-Specific Consent)', 'Purpose-Specific Consent: Sharing Selected CV Profile with Site Support Administrator')}</h3>
                <p style="font-size:0.88rem;">
                  ${t(
                    'جميع الحسابات والملفات خاصة افتراضيًا. إذا رغبت في أن يطلع مشرف الدعم (Abd-el-Rahman Adel Teba) على هذا الملف لمراجعته أو مساعدتك، يمكنك تفعيل الخيار أدناه، ويمكنك إلغاء المشاركة في أي لحظة.',
                    'All profiles are private by default. You may explicitly grant or revoke read access for the platform support administrator (Abd-el-Rahman Adel Teba) on this specific workspace.'
                  )}
                </p>
                <div style="display:flex; flex-direction:column; gap:0.5rem; margin:0.75rem 0;">
                  <label style="display:flex; align-items:center; gap:0.5rem; font-weight:600;">
                    <input type="checkbox" id="consent-share-admin" ${p.share_with_admin_enabled ? 'checked' : ''}>
                    <span>${t('مشاركة ملف السيرة الذاتية الحالي مع مشرف الدعم الفني للمنصة', 'Share this selected CV profile with the site support administrator')}</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:0.5rem;">
                    <input type="checkbox" id="consent-share-history" ${p.share_history_with_admin ? 'checked' : ''}>
                    <span>${t('السماح بالاطلاع على سجل تغييرات الإجابات لأغراض الدعم الفني واستكشاف الأخطاء', 'Allow access to saved answer version history for troubleshooting')}</span>
                  </label>
                </div>
                <button type="button" class="btn btn-primary btn-sm" data-action="save-admin-consent">
                  ${t('حفظ إعدادات موافقة المشاركة', 'Save Sharing Consent Choice')}
                </button>
              </div>
            `
            : ''
        }

        <div class="grid-2">
          <div class="card">
            <h3 style="margin-top:0; font-size:1rem;">${t('الفرق بين مسح المسودة المحلية وحذف الحساب السحابي (Section 13)', 'Local Device Cache vs. Cloud Account Persistence')}</h3>
            <p class="form-sublabel">${t(
              'يستخدم المتصفح قاعدة بيانات محلية (IndexedDB) لحفظ مسودتك مؤقتًا عند انقطاع الإنترنت، بينما تُحفظ بياناتك الأساسية على الخادم. مسح ملفات تعريف الارتباط (Cookies) يؤدي فقط لتسجيل خروجك ولا يحذف ملف السيرة المحفوظ على الخادم.',
              'Clearing browser cookies signs you out of your current session but NEVER deletes your server-saved CV profile.'
            )}</p>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
              <button type="button" class="btn btn-sm" data-action="clear-local-draft">
                ${t('مسح المسودة المحلية من هذا الجهاز فقط', 'Clear This Device’s Local Draft Only')}
              </button>
              ${
                STATE.authenticated
                  ? `<button type="button" class="btn btn-sm btn-danger" data-action="delete-current-profile">${t('حذف ملف السيرة الحالي من الخادم', 'Delete Current Cloud Profile')}</button>`
                  : ''
              }
            </div>
          </div>

          <div class="card">
            <h3 style="margin-top:0; font-size:1rem;">${t('تفضيلات ملفات تعريف الارتباط (Cookie Preferences)', 'Cookie & Privacy Preferences')}</h3>
            <p class="form-sublabel">${t('لا نستخدم ملفات تعريف الارتباط لتخزين السيرة الذاتية، ولا نلتقط ضغطات لوحة المفاتيح.', 'We never store full CVs in cookies and never log keystrokes.')}</p>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
              <button type="button" class="btn btn-sm btn-primary" data-cookie-choice="essential">${t('رفض الاختيارية (الضرورية فقط)', 'Reject Optional Cookies')}</button>
              <button type="button" class="btn btn-sm" data-cookie-choice="all">${t('قبول الكل', 'Accept All')}</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // --- Support & Report a Problem Page (Section 11) ---
  function renderSupportPage() {
    const plat = STATE.platform || {};
    return `
      <div class="grid-2">
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">${t('الإبلاغ عن مشكلة أو طلب دعم فني (مع معاينة البيانات المرسلة)', 'Report a Problem / Request Support (With Redaction Preview)')}</h2>
          </div>
          <form id="support-ticket-form">
            <div class="form-group">
              <label class="form-label" for="tkt-category">${t('نوع المشكلة', 'Issue Category')}</label>
              <select id="tkt-category" class="form-select">
                <option value="save_sync">${t('مشكلة في الحفظ أو المزامنة', 'Save / Sync Issue')}</option>
                <option value="pdf_export">${t('مشكلة في تصدير ملف PDF', 'PDF Export Issue')}</option>
                <option value="upload">${t('مشكلة في رفع الملفات', 'File Upload Issue')}</option>
                <option value="general">${t('استفسار عام أو طلب مساعدة', 'General Support Request')}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="tkt-subject">${t('عنوان الطلب', 'Subject')}</label>
              <input id="tkt-subject" type="text" class="form-input" required placeholder="${t('مثال: استفسار حول المرحلة 3', 'e.g., Question regarding Stage 3 dates')}">
            </div>
            <div class="form-group">
              <label class="form-label" for="tkt-desc">${t('تفاصيل المشكلة (يتم إخفاء البيانات الشخصية الحساسة تلقائيًا من السجلات التقنية):', 'Description (Personal identifiers are automatically redacted in technical logs):')}</label>
              <textarea id="tkt-desc" class="form-textarea" required></textarea>
            </div>
            <button type="submit" class="btn btn-primary">${t('إرسال طلب الدعم للمشرف', 'Submit Support Ticket')}</button>
          </form>
        </div>

        <div class="card">
          <div class="card-header">
            <h2 class="card-title">${t('بيانات التواصل المباشر مع مشرف المنصة', 'Direct Platform Support Contact Details')}</h2>
          </div>
          <p><strong>${t('مؤسس ومشرف الموقع (Site Creator):', 'Site Creator:')}</strong> ${esc(plat.creator_name || 'Abd-el-Rahman Adel Teba')}</p>
          <p><strong>${t('البريد الإلكتروني للدعم (Support Email):', 'Support Email:')}</strong> <a href="mailto:${esc(plat.support_email || 'frp.nasr@gmail.com')}">${esc(plat.support_email || 'frp.nasr@gmail.com')}</a></p>
          ${
            plat.support_phone
              ? `<p><strong>${t('هاتف الدعم (Support Phone):', 'Support Phone:')}</strong> <a href="tel:${esc(plat.support_phone)}">${esc(plat.support_phone)}</a></p>`
              : `<p class="form-sublabel">${t('رقم الهاتف متاح للمستخدمين المسجلين حسب إعدادات الخصوصية.', 'Phone number is visible to signed-in users per platform setting.')}</p>`
          }
          ${
            plat.whatsapp_enabled
              ? `<p><a class="btn btn-sm btn-primary" href="https://wa.me/201091874291" target="_blank" rel="noopener">WhatsApp (+20 1091874291)</a></p>`
              : `<div class="explain-box">${t('رابط واتساب اختياري ومعطل افتراضيًا حتى يقوم مالك الموقع بالتحقق من تفعيله من لوحة المشرف؛ يمكنك استخدام الاتصال الهاتفي المباشر أو البريد الإلكتروني.', 'WhatsApp link is feature-flagged until verified by the site owner; direct tel: calling and email are active.')}</div>`
          }
        </div>
      </div>
    `;
  }

  // --- Creator / About Page (Section 11 & 16.12) ---
  function renderAboutPage() {
    const plat = STATE.platform || {};
    return `
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">${t('عن المنصة ومطوّرها (Creator & About)', 'About Radiology CV Studio & Site Attribution')}</h2>
        </div>
        <p>${t(
          'تم تصميم وتطوير منصة Radiology CV Studio خصيصًا لأخصائيي وفنيي الأشعة والتصوير الطبي لبناء سيرة ذاتية موثوقة، دقيقة علميًا ومهنيًا، ومتوافقة مع معايير التوظيف الطبي في مصر والمملكة العربية السعودية.',
          'Radiology CV Studio is dedicated exclusively to diagnostic imaging and radiology professionals to create verifiable, ATS-ready Arabic and English CVs.'
        )}</p>
        <div class="explain-box">
          <p style="margin:0.25rem 0;"><strong>Site Creator / إعداد وإشراف:</strong> ${esc(plat.creator_name || 'Abd-el-Rahman Adel Teba')}</p>
          <p style="margin:0.25rem 0;"><strong>Support Email / بريد الدعم:</strong> <a href="mailto:${esc(plat.support_email || 'frp.nasr@gmail.com')}">${esc(plat.support_email || 'frp.nasr@gmail.com')}</a></p>
          ${
            plat.support_phone
              ? `<p style="margin:0.25rem 0;"><strong>Support Phone / هاتف الدعم:</strong> <a href="tel:${esc(plat.support_phone)}">${esc(plat.support_phone)}</a></p>`
              : ''
          }
        </div>
      </div>
    `;
  }

  // --- Admin Console Page (Section 11 & 15) ---
  function renderAdminPage() {
    if (!STATE.authenticated || (STATE.user?.role !== 'admin' && STATE.user?.role !== 'super_admin')) {
      return `
        <div class="card">
          <h2>${t('غير مصرح بالوصول (Permission Denied)', 'Permission Denied (403)')}</h2>
          <p>${t('هذه الصفحة مخصصة لمشرفي النظام المصرح لهم على الخادم فقط.', 'Restricted to server-authorized Platform Administrators.')}</p>
          <button type="button" class="btn btn-primary" data-action="quick-workspace" data-mode="platform_admin">
            ${t('التبديل لحساب مشرف النظام (Abd-el-Rahman Adel Teba)', 'Switch to Platform Admin Session')}
          </button>
        </div>
      `;
    }

    const adm = STATE.adminData;
    if (!adm) {
      loadAdminOverview();
      return `<div class="card"><p>${t('جاري تحميل بيانات لوحة المشرف...', 'Loading Admin Console...')}</p></div>`;
    }

    const m = adm.metrics || {};
    const integrations = Object.values(adm.integrations || {});

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">${t('لوحة مشرف النظام (Admin Console — Abd-el-Rahman Adel Teba)', 'Platform Administrator Console')}</h2>
            <p class="form-sublabel">${t('تُحترم خصوصية المستخدمين بالكامل: لا تظهر هنا إلا الملفات التي وافق أصحابها صراحةً على مشاركتها مع المشرف، ويتم تسجيل كل عملية وصول في سجل التدقيق (Audit Log).', 'Enforces privacy-by-default: Only CV profiles with explicit owner sharing consent can be inspected, and every access creates an immutable audit event.')}</p>
          </div>
          <button type="button" class="btn btn-sm" data-action="reload-admin">${t('تحديث البيانات', 'Refresh Console')}</button>
        </div>

        <div class="grid-3">
          <div class="explain-box">
            <strong>${t('إجمالي الحسابات والملفات:', 'Accounts & Workspaces:')}</strong>
            <div>${t('الحسابات:', 'Total Accounts:')} ${m.totalAccounts || 0}</div>
            <div>${t('ملفات السيرة النشطة:', 'Active Profiles:')} ${m.activeProfiles || 0}</div>
            <div>${t('ملفات خاصة (محجوبة عن المشرف):', 'Private Profiles (Protected):')} ${m.privateProfilesCount || 0}</div>
            <div>${t('ملفات مشاركة بموافقة أصحابها:', 'Opted-in Shared Profiles:')} ${m.sharedProfilesCount || 0}</div>
          </div>
          <div class="explain-box">
            <strong>${t('عمليات التصدير والدعم:', 'Exports & Support:')}</strong>
            <div>${t('عمليات التصدير الناجحة:', 'Completed Exports:')} ${m.completedExports || 0}</div>
            <div>${t('عمليات التصدير الفاشلة:', 'Failed Exports:')} ${m.failedExports || 0}</div>
            <div>${t('تذاكر الدعم المفتوحة:', 'Open Support Tickets:')} ${m.pendingTickets || 0}</div>
          </div>
          <div class="explain-box">
            <strong>${t('إعدادات ظهور هاتف الدعم:', 'Support Phone Visibility:')}</strong>
            <div style="margin-top:0.35rem;">
              <button type="button" class="btn btn-sm" data-action="toggle-phone-vis">
                ${t('الحالي:', 'Current:')} ${esc(adm.platform?.phone_visibility || 'everyone')} (${t('اضغط للتبديل', 'Toggle')})
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3 class="card-title">${t('حالة التكاملات والخدمات الخارجية (Integrations & Real Setup Status)', 'Integrations Status & Honest Test Controls')}</h3>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>${t('الخدمة / التكامل', 'Integration')}</th>
              <th>${t('الحالة الفعلية', 'True Status')}</th>
              <th>${t('التفاصيل وخطوات الإعداد الآمن', 'Details & Setup Instructions')}</th>
              <th>${t('اختبار فعلي', 'Test Action')}</th>
            </tr>
          </thead>
          <tbody>
            ${integrations
              .map(
                (intg) => `
                <tr>
                  <td><strong>${esc(t(intg.name_ar, intg.name_en))}</strong></td>
                  <td>
                    <span class="badge ${intg.setup_required ? 'badge-setup' : 'badge-confirmed'}">
                      ${esc(intg.status)}
                    </span>
                  </td>
                  <td>${esc(t(intg.details_ar, intg.details_en))}</td>
                  <td>
                    ${
                      intg.id === 'email_notifications'
                        ? `<button type="button" class="btn btn-sm" data-test-integration="email">${t('إرسال بريد اختبار', 'Send Test Email')}</button>`
                        : intg.id === 'whatsapp_notifications'
                        ? `<button type="button" class="btn btn-sm" data-test-integration="whatsapp">${t('اختبار قالب واتساب', 'Test WhatsApp')}</button>`
                        : intg.id === 'pdf_export'
                        ? `<button type="button" class="btn btn-sm btn-primary" data-test-integration="pdf_storage">${t('اختبار PDF والتخزين', 'Test Storage/PDF')}</button>`
                        : ''
                    }
                  </td>
                </tr>
              `
              )
              .join('')}
          </tbody>
        </table>
      </div>

      <div class="grid-2">
        <div class="card">
          <h3 style="margin-top:0; font-size:1rem;">${t('ملفات السيرة المشاركة بموافقة أصحابها (Opted-In Shared Profiles)', 'Opted-In Shared Profiles')}</h3>
          ${
            (adm.sharedProfiles || []).length === 0
              ? `<p class="form-sublabel">${t('لا يوجد ملف مشارك حاليًا. جميع الملفات (بما فيها ملف عبدالغفار) خاصة افتراضيًا حتى يمنح صاحب الملف موافقة المشاركة من صفحة الخصوصية.', 'No profiles currently shared. All profiles remain strictly private until the profile owner grants sharing consent.')}</p>`
              : `<ul style="padding-inline-start:1.2rem;">
                  ${adm.sharedProfiles
                    .map(
                      (sp) => `
                      <li style="margin-bottom:0.5rem;">
                        <strong>${esc(sp.title)}</strong> (${esc(sp.admin_consent_granted_at)})
                        <button type="button" class="btn btn-sm" data-select-profile="${esc(sp.id)}">${t('فتح للمراجعة (يُسجل في Audit Log)', 'Inspect (Audited)')}</button>
                      </li>
                    `
                    )
                    .join('')}
                </ul>`
          }
        </div>

        <div class="card">
          <h3 style="margin-top:0; font-size:1rem;">${t('تذاكر الدعم الفني والبلاغات (Support Tickets)', 'Support Tickets')}</h3>
          ${
            (adm.tickets || []).length === 0
              ? `<p class="form-sublabel">${t('لا توجد تذاكر دعم حاليًا.', 'No support tickets yet.')}</p>`
              : `<table class="data-table">
                  <thead><tr><th>ID</th><th>Subject</th><th>Status</th></tr></thead>
                  <tbody>
                    ${adm.tickets
                      .map((tk) => `<tr><td>${esc(tk.id)}</td><td>${esc(tk.subject)}</td><td><span class="badge">${esc(tk.status)}</span></td></tr>`)
                      .join('')}
                  </tbody>
                </table>`
          }
        </div>
      </div>

      <div class="card">
        <h3 style="margin-top:0; font-size:1rem;">${t('سجل التدقيق الأمني والتشغيلي الخالي من البيانات الحساسة (Redacted Audit & Notification Logs)', 'Redacted Security Audit & Notification Delivery Logs')}</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>${t('الوقت', 'Timestamp')}</th>
              <th>${t('نوع الحدث', 'Event Type')}</th>
              <th>${t('الميزة / المرحلة', 'Feature')}</th>
              <th>${t('الملخص (مخفي البيانات الحساسة)', 'Redacted Summary')}</th>
            </tr>
          </thead>
          <tbody>
            ${(adm.auditEvents || [])
              .slice(0, 15)
              .map(
                (ev) => `
                <tr>
                  <td>${esc(ev.created_at)}</td>
                  <td><code>${esc(ev.event_type)}</code></td>
                  <td>${esc(ev.stage_or_feature)}</td>
                  <td>${esc(ev.summary_redacted)}</td>
                </tr>
              `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderFooter() {
    const plat = STATE.platform || {};
    return `
      <footer class="app-footer" role="contentinfo">
        <div>
          <strong>${esc(t(plat.site_title_ar || 'استوديو السيرة الذاتية للأشعة والتصوير الطبي', plat.site_title_en || 'Radiology CV Studio'))}</strong>
          — ${t('إعداد وتطوير:', 'Site Creator:')} <strong>${esc(plat.creator_name || 'Abd-el-Rahman Adel Teba')}</strong>
          | <a href="mailto:${esc(plat.support_email || 'frp.nasr@gmail.com')}">${esc(plat.support_email || 'frp.nasr@gmail.com')}</a>
          ${plat.support_phone ? `| <a href="tel:${esc(plat.support_phone)}">${esc(plat.support_phone)}</a>` : ''}
        </div>
        <div>
          <small>${t('المسؤولية النهائية عن صحة البيانات والتراخيص تقع على عاتق صاحب السيرة الذاتية عند التقديم لأي جهة عمل.', 'Profile owners remain responsible for verifying all final CV claims and licensing status.')}</small>
        </div>
      </footer>
    `;
  }

  function renderMainRouteContent() {
    switch (STATE.route) {
      case 'landing':
        return renderLandingPage();
      case 'auth':
        return renderAuthPage();
      case 'dashboard':
        return renderDashboardPage();
      case 'stage':
        return renderGuidedStagePage();
      case 'preview':
        return renderPreviewPage();
      case 'exports':
        return renderExportCenterSection();
      case 'uploads':
        return renderUploadManagerSection();
      case 'glossary':
        return renderGlossaryPage();
      case 'privacy':
        return renderPrivacyPage();
      case 'support':
        return renderSupportPage();
      case 'about':
        return renderAboutPage();
      case 'admin':
        return renderAdminPage();
      default:
        return renderLandingPage();
    }
  }

  function renderApp() {
    applyDocumentDirectionAndTheme();
    const root = document.getElementById('app-root');
    if (!root) return;

    root.innerHTML = `
      ${renderTopbar()}
      ${
        STATE.toastMessage
          ? `<div style="background:var(--brand-navy); color:#fff; padding:0.65rem 1.25rem; text-align:center; font-weight:600;" role="status">${esc(STATE.toastMessage)}</div>`
          : ''
      }
      <div class="app-shell">
        ${renderSidebar()}
        <main class="app-main" role="main">
          ${renderMainRouteContent()}
          ${renderFooter()}
        </main>
      </div>
    `;

    bindInteractiveEvents();
  }

  // =========================================================================
  // EVENT DELEGATION & FORM BINDINGS
  // =========================================================================
  function bindInteractiveEvents() {
    // Navigation buttons
    document.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.onclick = async () => {
        const target = btn.getAttribute('data-nav');
        STATE.route = target;
        if (target === 'preview') {
          await refreshPreviewHtml();
        } else if (target === 'admin') {
          await loadAdminOverview();
        } else {
          renderApp();
        }
      };
    });

    // Stage Navigation buttons
    document.querySelectorAll('[data-stage-nav]').forEach((btn) => {
      btn.onclick = () => {
        STATE.activeStage = Number(btn.getAttribute('data-stage-nav'));
        STATE.route = 'stage';
        renderApp();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    });

    // Select Profile Workspace
    document.querySelectorAll('[data-select-profile]').forEach((btn) => {
      btn.onclick = async () => {
        const pid = btn.getAttribute('data-select-profile');
        await loadProfileBundle(pid);
        STATE.route = 'stage';
        STATE.activeStage = 1;
        renderApp();
      };
    });

    // Action buttons
    document.querySelectorAll('[data-action]').forEach((btn) => {
      btn.onclick = async () => {
        const act = btn.getAttribute('data-action');
        if (act === 'toggle-locale') {
          STATE.locale = STATE.locale === 'ar' ? 'en' : 'ar';
          localStorage.setItem('rcv_locale', STATE.locale);
          if (STATE.authenticated) {
            apiFetch('/api/preferences', { method: 'PUT', body: { locale: STATE.locale, theme: STATE.theme } }).catch(() => {});
          }
          renderApp();
        } else if (act === 'toggle-theme') {
          STATE.theme = STATE.theme === 'dark' ? 'light' : 'dark';
          localStorage.setItem('rcv_theme', STATE.theme);
          if (STATE.authenticated) {
            apiFetch('/api/preferences', { method: 'PUT', body: { locale: STATE.locale, theme: STATE.theme } }).catch(() => {});
          }
          renderApp();
        } else if (act === 'quick-workspace') {
          await enterQuickWorkspace(btn.getAttribute('data-mode'));
        } else if (act === 'logout') {
          await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
          STATE.authenticated = false;
          STATE.user = null;
          STATE.bundle = null;
          STATE.route = 'landing';
          renderApp();
        } else if (act === 'manual-save') {
          await executeAutosave({ changeSummary: 'Manual save triggered by user' });
          showToast('تم حفظ جميع التغييرات على الخادم بنجاح ✓', 'All changes saved and synced to server ✓');
        } else if (act === 'save-and-exit') {
          await executeAutosave({ changeSummary: 'Save & Exit from Stage ' + STATE.activeStage });
          STATE.route = 'dashboard';
          renderApp();
        } else if (act === 'create-profile') {
          const title = window.prompt(
            t('أدخل اسم ملف السيرة الذاتية الجديد:', 'Enter a title for the new CV profile:'),
            t('نسخة السيرة الذاتية المخصصة — المملكة العربية السعودية', 'Tailored Radiology CV — Saudi Arabia')
          );
          if (!title) return;
          const res = await apiFetch('/api/profiles', { method: 'POST', body: { title } });
          await bootstrapApplication();
          await loadProfileBundle(res.profileId);
          renderApp();
        } else if (act === 'duplicate-profile') {
          if (!STATE.activeProfileId) return;
          const res = await apiFetch('/api/profiles', {
            method: 'POST',
            body: { duplicateFromProfileId: STATE.activeProfileId },
          });
          await bootstrapApplication();
          await loadProfileBundle(res.profileId);
          showToast('تم نسخ الملف بنجاح كمساحة عمل مستقلة.', 'Profile duplicated into a separate workspace.');
        } else if (act === 'quick-export-draft' || act === 'export-current-preview-pdf') {
          await triggerExportDownload('draft_pdf', STATE.previewLang || 'en');
        } else if (act === 'refresh-preview') {
          const modeEl = document.getElementById('prev-mode-select');
          const langEl = document.getElementById('prev-lang-select');
          const tplEl = document.getElementById('prev-tpl-select');
          if (modeEl) STATE.previewMode = modeEl.value;
          if (langEl) STATE.previewLang = langEl.value;
          if (tplEl) STATE.previewTemplate = tplEl.value;
          await refreshPreviewHtml();
        } else if (act === 'suggest-emp-bullets') {
          const idx = Number(btn.getAttribute('data-emp-idx'));
          const emp = STATE.bundle.employment[idx];
          const res = await apiFetch(`/api/profiles/${encodeURIComponent(STATE.activeProfileId)}/assistant/suggest-bullets`, {
            method: 'POST',
            body: { entry: emp, tone: 'standard' },
          });
          emp.suggested_bullets_json = JSON.stringify(res.bullets || []);
          scheduleAutosave({}, true);
          renderApp();
        } else if (act === 'add-workplace') {
          STATE.bundle.employment.push({
            id: `${STATE.activeProfileId}-emp-${Date.now()}`,
            institution_name_ar: 'جهة عمل جديدة',
            institution_name_en: 'New Healthcare Institution',
            relationship_type: 'needs_confirmation',
            exact_dates_unknown: 1,
            is_current: 1,
            include_in_cv: 1,
          });
          scheduleAutosave({}, true);
          renderApp();
        } else if (act === 'add-achievement') {
          const sit = document.getElementById('ach-situation')?.value?.trim();
          const actTxt = document.getElementById('ach-action')?.value?.trim();
          const resTxt = document.getElementById('ach-result')?.value?.trim();
          const meas = document.getElementById('ach-measure')?.value || 'qualitative';
          if (!sit || !actTxt) {
            showToast('يرجى إدخال الموقف والإجراء أولًا.', 'Please enter Situation and Action.');
            return;
          }
          const bulletEn = `${actTxt} during ${sit}${resTxt ? `, resulting in ${resTxt}` : ''}.`;
          const bulletAr = `${actTxt} في ظل ${sit}${resTxt ? `، مما أسهم في ${resTxt}` : ''}.`;
          STATE.bundle.achievements.push({
            id: `${STATE.activeProfileId}-ach-${Date.now()}`,
            stage_number: 7,
            category: 'urgent_workflow',
            title_ar: sit,
            title_en: sit,
            situation_text: sit,
            action_text: actTxt,
            result_text: resTxt || '',
            measurement_type: meas,
            suggested_bullet_ar: bulletAr,
            suggested_bullet_en: bulletEn,
            approved_bullet_ar: bulletAr,
            approved_bullet_en: bulletEn,
            approval_status: 'approved',
            include_in_cv: 1,
          });
          scheduleAutosave({}, true);
          renderApp();
        } else if (act === 'parse-job-description') {
          const jdText = document.getElementById('jd-input-text')?.value || '';
          const res = await apiFetch(`/api/profiles/${encodeURIComponent(STATE.activeProfileId)}/assistant/parse-job`, {
            method: 'POST',
            body: { jobDescriptionText: jdText },
          });
          STATE.jobMatchResult = res;
          renderApp();
        } else if (act === 'create-share-link') {
          await apiFetch(`/api/profiles/${encodeURIComponent(STATE.activeProfileId)}/share-links`, {
            method: 'POST',
            body: { expiryHours: 24, language: STATE.previewLang || 'en' },
          });
          await loadProfileBundle(STATE.activeProfileId);
          renderApp();
          showToast('تم إنشاء رابط المشاركة المؤقت (صالح لمدة 24 ساعة).', 'Created expiring share link (24h).');
        } else if (act === 'save-admin-consent') {
          const shareAdmin = document.getElementById('consent-share-admin')?.checked;
          const shareHist = document.getElementById('consent-share-history')?.checked;
          await apiFetch(`/api/profiles/${encodeURIComponent(STATE.activeProfileId)}/consent`, {
            method: 'POST',
            body: {
              share_with_admin_enabled: Boolean(shareAdmin),
              share_history_with_admin: Boolean(shareHist),
            },
          });
          await loadProfileBundle(STATE.activeProfileId);
          await bootstrapApplication();
          showToast('تم تحديث إعدادات موافقة المشاركة بنجاح.', 'Updated sharing consent settings.');
        } else if (act === 'clear-local-draft') {
          await clearLocalDraftSnapshot(STATE.activeProfileId);
          showToast('تم مسح المسودة المحلية من هذا الجهاز فقط دون المساس بنسخة الخادم.', 'Cleared local device draft cache; cloud profile untouched.');
        } else if (act === 'delete-current-profile') {
          if (!window.confirm(t('هل أنت متأكد من حذف ملف السيرة الحالي نهائيًا؟', 'Are you sure you want to delete this CV workspace?'))) return;
          await apiFetch(`/api/profiles/${encodeURIComponent(STATE.activeProfileId)}`, { method: 'DELETE' });
          STATE.activeProfileId = null;
          await bootstrapApplication();
        } else if (act === 'reload-server-version') {
          await loadProfileBundle(STATE.activeProfileId);
          renderApp();
        } else if (act === 'force-overwrite-version') {
          await executeAutosave({ forceOverwrite: true, changeSummary: 'Resolved conflict by overwriting server version' });
          renderApp();
        } else if (act === 'try-google-auth') {
          try {
            await apiFetch('/api/auth/google', { method: 'POST' });
          } catch (e) {
            showToast(e.payload?.message_ar || e.message, e.payload?.message_en || e.message);
          }
        } else if (act === 'try-phone-otp') {
          try {
            await apiFetch('/api/auth/phone-otp', { method: 'POST' });
          } catch (e) {
            showToast(e.payload?.message_ar || e.message, e.payload?.message_en || e.message);
          }
        } else if (act === 'reload-admin') {
          await loadAdminOverview();
        } else if (act === 'toggle-phone-vis') {
          const nextVis = STATE.adminData?.platform?.phone_visibility === 'everyone' ? 'registered_only' : 'everyone';
          await apiFetch('/api/admin/settings', { method: 'PUT', body: { phone_visibility: nextVis } });
          await loadAdminOverview();
        }
      };
    });

    // Export Type Buttons
    document.querySelectorAll('[data-export-type]').forEach((btn) => {
      btn.onclick = () => {
        const expType = btn.getAttribute('data-export-type');
        const expLang = btn.getAttribute('data-export-lang') || 'en';
        triggerExportDownload(expType, expLang);
      };
    });

    // Revoke Share Link Buttons
    document.querySelectorAll('[data-revoke-link]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-revoke-link');
        await apiFetch(`/api/share-links/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
        await loadProfileBundle(STATE.activeProfileId);
        renderApp();
        showToast('تم إلغاء رابط المشاركة فورًا.', 'Share link revoked immediately.');
      };
    });

    // Delete Upload Buttons
    document.querySelectorAll('[data-delete-upload]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-delete-upload');
        await apiFetch(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await loadProfileBundle(STATE.activeProfileId);
        renderApp();
        showToast('تم حذف الملف المرفق بنجاح.', 'Uploaded file deleted.');
      };
    });

    // Test Integration Buttons (Admin)
    document.querySelectorAll('[data-test-integration]').forEach((btn) => {
      btn.onclick = async () => {
        const ch = btn.getAttribute('data-test-integration');
        const res = await apiFetch('/api/admin/test-integration', { method: 'POST', body: { channel: ch } });
        await loadAdminOverview();
        showToast(res.message_ar, res.message_en);
      };
    });

    // Stage 1 Ranked Target Roles Up/Down
    document.querySelectorAll('[data-rank-up]').forEach((btn) => {
      btn.onclick = () => {
        const idx = Number(btn.getAttribute('data-rank-up'));
        const list = [...getAnswerValue('s1_ranked_target_roles', [])];
        if (idx > 0) {
          [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
          setAnswerValue('s1_ranked_target_roles', 1, list);
          renderApp();
        }
      };
    });
    document.querySelectorAll('[data-rank-down]').forEach((btn) => {
      btn.onclick = () => {
        const idx = Number(btn.getAttribute('data-rank-down'));
        const list = [...getAnswerValue('s1_ranked_target_roles', [])];
        if (idx < list.length - 1) {
          [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
          setAnswerValue('s1_ranked_target_roles', 1, list);
          renderApp();
        }
      };
    });

    // Direct Answer Inputs
    document.querySelectorAll('[data-ans-input]').forEach((inp) => {
      inp.oninput = () => {
        const qid = inp.getAttribute('data-ans-input');
        setAnswerValue(qid, STATE.activeStage, inp.value, inp.value.trim() ? 'user_confirmed' : 'not_entered');
      };
    });

    // Residence Fields
    document.querySelectorAll('[data-res-field]').forEach((inp) => {
      inp.oninput = () => {
        const f = inp.getAttribute('data-res-field');
        const cur = { ...getAnswerValue('s1_residence_location', {}) };
        cur[f] = inp.value;
        setAnswerValue('s1_residence_location', 1, cur, cur.street_address ? 'user_confirmed' : 'needs_confirmation');
      };
    });

    // Education Fields (Stage 2)
    document.querySelectorAll('[data-edu-field]').forEach((inp) => {
      inp.oninput = () => {
        const f = inp.getAttribute('data-edu-field');
        if (!STATE.bundle.education[0]) STATE.bundle.education[0] = {};
        STATE.bundle.education[0][f] = inp.value;
        scheduleAutosave();
      };
    });
    const noGpaCheck = document.querySelector('[data-edu-nogpa]');
    if (noGpaCheck) {
      noGpaCheck.onchange = () => {
        if (!STATE.bundle.education[0]) STATE.bundle.education[0] = {};
        STATE.bundle.education[0].no_gpa_issued = noGpaCheck.checked ? 1 : 0;
        scheduleAutosave({}, true);
      };
    }

    // Employment Fields (Stage 3)
    document.querySelectorAll('[data-emp-field]').forEach((inp) => {
      const handler = () => {
        const idx = Number(inp.getAttribute('data-emp-idx'));
        const f = inp.getAttribute('data-emp-field');
        if (STATE.bundle.employment[idx]) {
          STATE.bundle.employment[idx][f] = inp.value;
          if (f === 'start_date' && inp.value) {
            STATE.bundle.employment[idx].exact_dates_unknown = 0;
          }
          scheduleAutosave();
        }
      };
      inp.oninput = handler;
      inp.onchange = handler;
    });

    // Approve Employment Bullet Suggestion
    document.querySelectorAll('[data-approve-bullet]').forEach((btn) => {
      btn.onclick = () => {
        const [eIdx, bIdx] = btn.getAttribute('data-approve-bullet').split(':').map(Number);
        const emp = STATE.bundle.employment[eIdx];
        const suggested = JSON.parse(emp.suggested_bullets_json || '[]');
        const approved = JSON.parse(emp.approved_bullets_json || '[]');
        const chosen = suggested[bIdx];
        if (chosen) {
          approved.push({ text_en: chosen.suggested_en, text_ar: chosen.suggested_ar });
          emp.approved_bullets_json = JSON.stringify(approved);
          scheduleAutosave({}, true);
          renderApp();
        }
      };
    });

    // Training Draft Edits & Approvals (Stage 4)
    document.querySelectorAll('[data-trn-field]').forEach((inp) => {
      inp.oninput = () => {
        const idx = Number(inp.getAttribute('data-trn-idx'));
        const f = inp.getAttribute('data-trn-field');
        if (STATE.bundle.training[idx]) {
          STATE.bundle.training[idx][f] = inp.value;
          scheduleAutosave();
        }
      };
    });
    document.querySelectorAll('[data-trn-approve]').forEach((btn) => {
      btn.onclick = () => {
        const idx = Number(btn.getAttribute('data-trn-approve'));
        const trn = STATE.bundle.training[idx];
        if (trn) {
          trn.approved_draft_ar = trn.suggested_draft_ar;
          trn.approved_draft_en = trn.suggested_draft_en;
          trn.draft_approval_status = 'approved';
          scheduleAutosave({}, true);
          renderApp();
        }
      };
    });

    // Modality Matrix Changes (Stage 5)
    document.querySelectorAll('[data-mod-field]').forEach((inp) => {
      inp.onchange = () => {
        const idx = Number(inp.getAttribute('data-mod-idx'));
        const f = inp.getAttribute('data-mod-field');
        const mod = STATE.bundle.modalities[idx];
        if (mod) {
          mod[f] = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : inp.value;
          mod.confirmation_state = 'user_confirmed';
          scheduleAutosave({}, true);
        }
      };
      if (inp.type === 'text') {
        inp.oninput = inp.onchange;
      }
    });

    // License Fields (Stage 8)
    document.querySelectorAll('[data-lic-field]').forEach((inp) => {
      const fn = () => {
        const idx = Number(inp.getAttribute('data-lic-idx'));
        const f = inp.getAttribute('data-lic-field');
        const lic = STATE.bundle.licenses[idx];
        if (lic) {
          lic[f] = inp.value;
          lic.confirmation_state = 'user_confirmed';
          scheduleAutosave();
        }
      };
      inp.oninput = fn;
      inp.onchange = fn;
    });

    // Private Stage Notes
    const notesArea = document.getElementById('stage-private-notes');
    if (notesArea) {
      notesArea.oninput = () => {
        const stRow = (STATE.bundle.stages || []).find((s) => s.stage_number === STATE.activeStage);
        if (stRow) {
          stRow.private_notes = notesArea.value;
          scheduleAutosave();
        }
      };
    }

    // Glossary Search
    const glSearch = document.getElementById('glossary-search-input');
    if (glSearch) {
      glSearch.oninput = () => {
        STATE.glossarySearch = glSearch.value;
        renderApp();
        const el = document.getElementById('glossary-search-input');
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      };
    }

    // Login Form
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(loginForm);
        try {
          await apiFetch('/api/auth/login', {
            method: 'POST',
            body: { email: fd.get('email'), password: fd.get('password') },
          });
          await bootstrapApplication();
        } catch (err) {
          showToast('فشل تسجيل الدخول: ' + err.message, 'Sign-in failed: ' + err.message);
        }
      };
    }

    // Register Form
    const regForm = document.getElementById('register-form');
    if (regForm) {
      regForm.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(regForm);
        try {
          await apiFetch('/api/auth/register', {
            method: 'POST',
            body: {
              displayName: fd.get('displayName'),
              email: fd.get('email'),
              phone: fd.get('phone'),
              password: fd.get('password'),
              locale: STATE.locale,
              theme: STATE.theme,
            },
          });
          await bootstrapApplication();
        } catch (err) {
          showToast('تعذر إنشاء الحساب: ' + err.message, 'Registration failed: ' + err.message);
        }
      };
    }

    // Upload File Form
    const uplForm = document.getElementById('upload-file-form');
    if (uplForm) {
      uplForm.onsubmit = async (e) => {
        e.preventDefault();
        const fileInp = document.getElementById('upload-file-input');
        const purpose = document.getElementById('upload-purpose')?.value || 'certificate';
        const file = fileInp?.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const res = await apiFetch(`/api/profiles/${encodeURIComponent(STATE.activeProfileId)}/uploads`, {
              method: 'POST',
              body: {
                filename: file.name,
                mimeType: file.type,
                purpose,
                contentBase64: reader.result,
              },
            });
            await loadProfileBundle(STATE.activeProfileId);
            renderApp();
            showToast(
              res.file.quality_warning
                ? `تم رفع الملف مع تنبيه جودة: ${res.file.quality_warning}`
                : 'تم فحص ورفع الملف بنجاح ✓',
              res.file.quality_warning || 'File verified and uploaded ✓'
            );
          } catch (err) {
            showToast('تم رفض الملف لأسباب أمنية: ' + err.message, 'Upload rejected: ' + err.message);
          }
        };
        reader.readAsDataURL(file);
      };
    }

    // Support Ticket Form
    const tktForm = document.getElementById('support-ticket-form');
    if (tktForm) {
      tktForm.onsubmit = async (e) => {
        e.preventDefault();
        const category = document.getElementById('tkt-category')?.value;
        const subject = document.getElementById('tkt-subject')?.value;
        const description = document.getElementById('tkt-desc')?.value;
        try {
          const res = await apiFetch('/api/support/tickets', {
            method: 'POST',
            body: {
              profileId: STATE.activeProfileId,
              category,
              subject,
              description,
            },
          });
          tktForm.reset();
          showToast(
            `تم تسجيل طلب الدعم رقم ${res.ticket.id} وإشعار لوحة المشرف بنجاح.`,
            `Support ticket ${res.ticket.id} created and logged to Admin Dashboard.`
          );
        } catch (err) {
          showToast('تعذر إرسال التذكرة: ' + err.message, 'Failed to submit ticket: ' + err.message);
        }
      };
    }
  }

  // Start application on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapApplication);
  } else {
    bootstrapApplication();
  }
})();
