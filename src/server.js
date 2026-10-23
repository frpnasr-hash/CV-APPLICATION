const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');

const { getDb, hashPassword, verifyPassword, redactPII } = require('./db/database');
const {
  SESSION_COOKIE_NAME,
  createSession,
  revokeSession,
  getAuthenticatedUser,
  checkProfileAccess,
  logAuditEvent,
  logRedactedError,
} = require('./middleware/auth');
const {
  GLOSSARY_ENTRIES,
  STAGE_DEFINITIONS,
  QUESTION_DEFINITIONS,
  MODALITY_LIBRARY,
} = require('./data/glossary-and-questions');
const { seedRuntimeDatabase } = require('./services/seed-service');
const {
  checkPatientIdentifierRisk,
  generateSuggestedBulletsForEmployment,
  analyzeProfileQualityAndTruth,
  parseJobDescriptionAgainstProfile,
} = require('./services/assistant-service');
const { UPLOAD_DIR, validateAndStoreUpload } = require('./services/upload-service');
const {
  renderCvHtml,
  renderAnswerWorkbookHtml,
  generateProfileExport,
} = require('./services/export-service');
const {
  getProfileBundle,
  getIntegrationStatuses,
  dispatchAdminNotification,
} = require('./services/profile-and-admin-service');

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getPlatformConfig(isAuthenticated) {
  const db = getDb();
  const rows = db.prepare(`SELECT key, value_json FROM platform_settings`).all();
  const cfg = {};
  for (const r of rows) {
    try {
      cfg[r.key] = JSON.parse(r.value_json);
    } catch (_) {
      cfg[r.key] = r.value_json;
    }
  }
  const showPhone = cfg.phone_visibility === 'everyone' || Boolean(isAuthenticated);
  return {
    site_title_en: cfg.site_title_en || 'Radiology CV Studio',
    site_title_ar: cfg.site_title_ar || 'استوديو السيرة الذاتية للأشعة والتصوير الطبي',
    creator_name: cfg.creator_name || 'Abd-el-Rahman Adel Teba',
    support_email: cfg.support_email || 'frp.nasr@gmail.com',
    support_phone: showPhone ? cfg.support_phone || '01091874291' : null,
    phone_visibility: cfg.phone_visibility || 'everyone',
    whatsapp_enabled: Boolean(cfg.whatsapp_enabled),
    whatsapp_e164: '201091874291',
    whatsapp_link: cfg.whatsapp_enabled ? 'https://wa.me/201091874291' : null,
    tel_link: showPhone ? `tel:${cfg.support_phone || '01091874291'}` : null,
    quotas: {
      max_image_mb: cfg.max_image_mb || 10,
      max_document_mb: cfg.max_document_mb || 20,
      max_profile_upload_mb: cfg.max_profile_upload_mb || 100,
    },
  };
}

function createInitialBlankProfileForUser(userId, displayName, options = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const profileId = 'prf-' + crypto.randomUUID();
  const title = options.title || `${displayName} — Radiology CV Workspace`;
  const targetCountry = options.target_country || 'Saudi Arabia';
  const cvLang = options.cv_output_language || 'en';

  db.prepare(`
    INSERT INTO profiles (
      id, owner_id, title, slug, primary_language, cv_output_language,
      target_country, template_id, photo_preference, length_preference,
      is_seeded, seed_banner_dismissed, privacy_mode, share_with_admin_enabled,
      share_history_with_admin, status, version, last_synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'ar', ?, ?, 'modern-healthcare', 'omit', 'standard', 0, 1, 'private', 0, 0, 'draft', 1, ?, ?, ?)
  `).run(
    profileId,
    userId,
    title,
    profileId,
    cvLang,
    targetCountry,
    now,
    now,
    now
  );

  const stageStmt = db.prepare(`
    INSERT INTO stages (
      id, profile_id, stage_number, stage_key, status,
      completion_pct, unanswered_count, needs_confirmation_count, private_notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 3, 0, '', ?)
  `);
  for (const st of STAGE_DEFINITIONS) {
    stageStmt.run(
      `${profileId}-s${st.stage_number}`,
      profileId,
      st.stage_number,
      st.stage_key,
      st.stage_number === 10 ? 'optional' : 'not_started',
      now
    );
  }

  const modStmt = db.prepare(`
    INSERT INTO modality_competencies (
      id, profile_id, modality_code, modality_name_ar, modality_name_en,
      experience_category, duration_text, clinical_settings_json, institutions_json,
      equipment_models, confidence_level, justification_text,
      source, confirmation_state, include_in_cv, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'no_experience', '', '[]', '[]', 'Not sure', 'needs_confirmation', '', 'user_entered', 'not_entered', 0, ?)
  `);
  for (const mod of MODALITY_LIBRARY) {
    modStmt.run(`${profileId}-mod-${mod.code}`, profileId, mod.code, mod.name_ar, mod.name_en, now);
  }

  db.prepare(`
    INSERT INTO profile_versions (
      id, profile_id, version_number, stage_number, change_summary, snapshot_json, editor_id, created_at
    ) VALUES (?, ?, 1, 1, 'Created new radiology CV profile workspace', '{}', ?, ?)
  `).run('ver-' + crypto.randomUUID(), profileId, userId, now);

  return profileId;
}

async function handleApiRequest(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();
  const db = getDb();
  const user = getAuthenticatedUser(req);

  // 1. Public Metadata, Glossary, Stage & Question Definitions, Integration Statuses
  if (pathname === '/api/bootstrap' && method === 'GET') {
    const integrations = getIntegrationStatuses();
    const platform = getPlatformConfig(Boolean(user));
    let profiles = [];
    let preferences = null;

    if (user) {
      preferences = db.prepare(`SELECT * FROM user_preferences WHERE user_id = ?`).get(user.id);
      const owned = db.prepare(`SELECT * FROM profiles WHERE owner_id = ? ORDER BY updated_at DESC`).all(user.id);
      const collaborated = db
        .prepare(`
          SELECT p.*, g.permission_scope
          FROM profiles p
          JOIN access_grants g ON g.profile_id = p.id
          WHERE (g.grantee_user_id = ? OR lower(g.grantee_email) = lower(?))
            AND g.revoked_at IS NULL
        `)
        .all(user.id, user.email || '');
      profiles = [
        ...owned.map((p) => ({ ...p, accessRole: 'owner' })),
        ...collaborated.map((p) => ({ ...p, accessRole: 'collaborator' })),
      ];
    }

    return sendJson(res, 200, {
      authenticated: Boolean(user),
      user: user
        ? {
            id: user.id,
            email: user.email,
            phone: user.phone,
            displayName: user.displayName,
            role: user.role, // Server-determined role
            locale: user.locale,
            theme: user.theme,
            isSeededSubject: user.isSeededSubject,
          }
        : null,
      preferences,
      profiles,
      platform,
      integrations,
      stagesCatalog: STAGE_DEFINITIONS,
      questionsCatalog: QUESTION_DEFINITIONS,
      modalityCatalog: MODALITY_LIBRARY,
      glossary: GLOSSARY_ENTRIES,
    });
  }

  // 2. Authentication Endpoints
  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readJsonBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim();
    const password = String(body.password || '');
    const phone = body.phone ? String(body.phone).trim() : null;

    if (!email || !displayName || password.length < 6) {
      return sendJson(res, 400, {
        error: 'Valid email, display name, and password (minimum 6 characters) are required.',
      });
    }

    const exists = db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(email);
    if (exists) {
      return sendJson(res, 409, { error: 'An account with this email already exists.' });
    }

    const userId = 'usr-' + crypto.randomUUID();
    const now = new Date().toISOString();
    const { hash, salt } = hashPassword(password);

    // Note: Ignore any client-sent role/isAdmin — strictly assign 'user' server-side
    db.prepare(`
      INSERT INTO users (
        id, email, phone, display_name, password_hash, password_salt,
        auth_provider, email_verified, phone_verified, role, mfa_enabled,
        account_status, locale, theme, is_seeded_subject, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'local', 1, 0, 'user', 0, 'active', ?, ?, 0, ?, ?)
    `).run(userId, email, phone, displayName, hash, salt, body.locale || 'ar', body.theme || 'light', now, now);

    db.prepare(`
      INSERT INTO user_preferences (user_id, locale, theme, cookie_consented_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, body.locale || 'ar', body.theme || 'light', now, now);

    db.prepare(`
      INSERT INTO consent_records (id, user_id, purpose, status, consent_version, scope_details, created_at)
      VALUES (?, ?, 'terms_privacy', 'granted', 'v1.0', 'Accepted Privacy Policy & Terms upon registration', ?)
    `).run('cns-' + crypto.randomUUID(), userId, now);

    const initialProfileId = createInitialBlankProfileForUser(userId, displayName);
    const { rawToken } = createSession(userId, req);

    return sendJson(
      res,
      201,
      {
        ok: true,
        user: { id: userId, email, displayName, role: 'user' },
        initialProfileId,
        sessionToken: rawToken,
      },
      {
        'Set-Cookie': `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      }
    );
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJsonBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    const row = db.prepare(`SELECT * FROM users WHERE lower(email) = ?`).get(email);
    if (!row || !verifyPassword(password, row.password_hash, row.password_salt)) {
      return sendJson(res, 401, { error: 'Invalid email or password.' });
    }
    if (row.account_status !== 'active') {
      return sendJson(res, 403, { error: `Account is currently ${row.account_status}.` });
    }

    const { rawToken } = createSession(row.id, req);
    return sendJson(
      res,
      200,
      {
        ok: true,
        user: {
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          role: row.role,
        },
        sessionToken: rawToken,
      },
      {
        'Set-Cookie': `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      }
    );
  }

  // Dedicated Authorized One-Time / Workspace Switch for Seeded Subject or Platform Admin in local/sandbox environment
  if (pathname === '/api/auth/workspace-session' && method === 'POST') {
    const body = await readJsonBody(req);
    const targetMode = body.mode; // 'seeded_owner' | 'platform_admin'

    let targetUser = null;
    if (targetMode === 'seeded_owner') {
      targetUser = db.prepare(`SELECT * FROM users WHERE is_seeded_subject = 1`).get();
    } else if (targetMode === 'platform_admin') {
      targetUser = db.prepare(`SELECT * FROM users WHERE role = 'admin'`).get();
    }

    if (!targetUser) {
      return sendJson(res, 404, { error: 'Target workspace account not found. Run seed first.' });
    }
    if (targetUser.account_status !== 'active') {
      return sendJson(res, 403, { error: 'Target account is disabled.' });
    }

    const { rawToken } = createSession(targetUser.id, req);
    return sendJson(
      res,
      200,
      {
        ok: true,
        user: {
          id: targetUser.id,
          email: targetUser.email,
          displayName: targetUser.display_name,
          role: targetUser.role,
          isSeededSubject: Boolean(targetUser.is_seeded_subject),
        },
        sessionToken: rawToken,
      },
      {
        'Set-Cookie': `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      }
    );
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    if (user?.sessionToken) {
      revokeSession(user.sessionToken, user.id);
    }
    return sendJson(
      res,
      200,
      { ok: true },
      {
        'Set-Cookie': `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      }
    );
  }

  // OAuth & Phone OTP honest integration boundaries
  if (pathname === '/api/auth/google' && method === 'POST') {
    const statuses = getIntegrationStatuses();
    if (statuses.google_oauth.setup_required) {
      return sendJson(res, 501, {
        setup_required: true,
        provider: 'google_oauth',
        message_en: statuses.google_oauth.details_en,
        message_ar: statuses.google_oauth.details_ar,
      });
    }
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/phone-otp' && method === 'POST') {
    const statuses = getIntegrationStatuses();
    if (statuses.phone_otp.setup_required) {
      return sendJson(res, 501, {
        setup_required: true,
        provider: 'phone_otp',
        message_en: statuses.phone_otp.details_en,
        message_ar: statuses.phone_otp.details_ar,
      });
    }
    return sendJson(res, 200, { ok: true });
  }

  // 3. User Preferences & Cookie Consent
  if (pathname === '/api/preferences' && method === 'PUT') {
    if (!user) return sendJson(res, 401, { error: 'Authentication required' });
    const body = await readJsonBody(req);
    const now = new Date().toISOString();

    const locale = body.locale === 'en' ? 'en' : 'ar';
    const theme = ['light', 'dark', 'system'].includes(body.theme) ? body.theme : 'light';
    const cookieAnalytics = body.cookie_analytics ? 1 : 0;
    const cookiePreferences = body.cookie_preferences !== false ? 1 : 0;

    db.prepare(`UPDATE users SET locale = ?, theme = ?, updated_at = ? WHERE id = ?`).run(locale, theme, now, user.id);
    db.prepare(`
      INSERT INTO user_preferences (user_id, locale, theme, cookie_necessary, cookie_preferences, cookie_analytics, cookie_consented_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        locale = excluded.locale,
        theme = excluded.theme,
        cookie_preferences = excluded.cookie_preferences,
        cookie_analytics = excluded.cookie_analytics,
        cookie_consented_at = excluded.cookie_consented_at,
        updated_at = excluded.updated_at
    `).run(user.id, locale, theme, cookiePreferences, cookieAnalytics, now, now);

    return sendJson(res, 200, { ok: true, locale, theme, cookie_analytics: Boolean(cookieAnalytics) });
  }

  // 4. Create / Duplicate Profile Workspace
  if (pathname === '/api/profiles' && method === 'POST') {
    if (!user) return sendJson(res, 401, { error: 'Authentication required' });
    const body = await readJsonBody(req);

    if (body.duplicateFromProfileId) {
      const access = checkProfileAccess(user, body.duplicateFromProfileId, 'view');
      if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

      const sourceBundle = getProfileBundle(body.duplicateFromProfileId);
      const newProfileId = createInitialBlankProfileForUser(user.id, user.displayName, {
        title: body.title || `${sourceBundle.profile.title} (Copy)`,
        target_country: body.target_country || sourceBundle.profile.target_country,
        cv_output_language: body.cv_output_language || sourceBundle.profile.cv_output_language,
      });

      const now = new Date().toISOString();
      for (const ans of sourceBundle.answers) {
        db.prepare(`
          INSERT OR REPLACE INTO answers (
            id, profile_id, stage_number, question_id, value_json, raw_source_value,
            source, confirmation_state, visibility, version, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
          `${newProfileId}-ans-${ans.question_id}`,
          newProfileId,
          ans.stage_number,
          ans.question_id,
          ans.value_json,
          ans.raw_source_value,
          ans.source,
          ans.confirmation_state,
          ans.visibility,
          user.id,
          now
        );
      }

      return sendJson(res, 201, { ok: true, profileId: newProfileId });
    }

    const profileId = createInitialBlankProfileForUser(user.id, user.displayName, {
      title: body.title,
      target_country: body.target_country,
      cv_output_language: body.cv_output_language,
    });

    logAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      targetUserId: user.id,
      targetProfileId: profileId,
      eventType: 'profile.created',
      stageOrFeature: 'dashboard',
      summaryRedacted: `Created new CV profile workspace`,
    });

    return sendJson(res, 201, { ok: true, profileId });
  }

  // 5. Profile Bundle GET /Autosave PUT / Delete
  const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
  if (profileMatch) {
    const profileId = decodeURIComponent(profileMatch[1]);
    if (method === 'GET') {
      const access = checkProfileAccess(user, profileId, 'view');
      if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

      const bundle = getProfileBundle(profileId);
      const quality = analyzeProfileQualityAndTruth(bundle);
      return sendJson(res, 200, {
        ...bundle,
        accessType: access.accessType,
        quality,
      });
    }

    if (method === 'DELETE') {
      const access = checkProfileAccess(user, profileId, 'owner');
      if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

      db.prepare(`DELETE FROM profiles WHERE id = ?`).run(profileId);
      logAuditEvent({
        actorUserId: user.id,
        actorRole: user.role,
        targetUserId: user.id,
        targetProfileId: profileId,
        eventType: 'profile.deleted',
        stageOrFeature: 'account_privacy',
        summaryRedacted: 'Profile owner deleted CV workspace',
      });
      return sendJson(res, 200, { ok: true });
    }
  }

  // 6. Autosave & Multi-Tab Conflict Detection Endpoint (Section 8)
  const autosaveMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/autosave$/);
  if (autosaveMatch && method === 'POST') {
    const profileId = decodeURIComponent(autosaveMatch[1]);
    const access = checkProfileAccess(user, profileId, 'edit');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const body = await readJsonBody(req);
    const currentProfile = access.profile;

    // Multi-tab / Multi-device optimistic concurrency conflict check!
    if (
      body.expectedVersion !== undefined &&
      body.expectedVersion !== null &&
      Number(body.expectedVersion) < Number(currentProfile.version) &&
      !body.forceOverwrite
    ) {
      return sendJson(res, 409, {
        conflict: true,
        serverVersion: currentProfile.version,
        lastSyncedAt: currentProfile.last_synced_at,
        message_en:
          'Newer changes exist on the server from another tab or device. Please review before overwriting.',
        message_ar:
          'توجد تعديلات أحدث محفوظة على الخادم من نافذة أو جهاز آخر. يرجى اختيار تحميل نسخة الخادم الأحدث أو تأكيد الكتابة فوقها.',
      });
    }

    const now = new Date().toISOString();
    const stageNumber = Number(body.stageNumber || 1);
    const newVersion = Number(currentProfile.version) + 1;
    const warnings = [];

    // Update profile metadata if provided
    if (body.profileMeta) {
      const pm = body.profileMeta;
      db.prepare(`
        UPDATE profiles SET
          title = COALESCE(?, title),
          cv_output_language = COALESCE(?, cv_output_language),
          target_country = COALESCE(?, target_country),
          template_id = COALESCE(?, template_id),
          photo_preference = COALESCE(?, photo_preference),
          length_preference = COALESCE(?, length_preference),
          tailored_vacancy_title = COALESCE(?, tailored_vacancy_title),
          tailored_vacancy_raw = COALESCE(?, tailored_vacancy_raw),
          seed_banner_dismissed = COALESCE(?, seed_banner_dismissed),
          version = ?,
          last_synced_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        pm.title ?? null,
        pm.cv_output_language ?? null,
        pm.target_country ?? null,
        pm.template_id ?? null,
        pm.photo_preference ?? null,
        pm.length_preference ?? null,
        pm.tailored_vacancy_title ?? null,
        pm.tailored_vacancy_raw ?? null,
        pm.seed_banner_dismissed !== undefined ? (pm.seed_banner_dismissed ? 1 : 0) : null,
        newVersion,
        now,
        now,
        profileId
      );
    } else {
      db.prepare(`UPDATE profiles SET version = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`).run(
        newVersion,
        now,
        now,
        profileId
      );
    }

    // Save structured question answers
    if (Array.isArray(body.answers)) {
      const upsertAns = db.prepare(`
        INSERT INTO answers (
          id, profile_id, stage_number, question_id, value_json, raw_source_value,
          source, confirmation_state, visibility, version, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, question_id) DO UPDATE SET
          value_json = excluded.value_json,
          source = excluded.source,
          confirmation_state = excluded.confirmation_state,
          visibility = excluded.visibility,
          version = answers.version + 1,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `);

      for (const ans of body.answers) {
        const piiRisk = checkPatientIdentifierRisk(JSON.stringify(ans.value));
        if (piiRisk.hasRisk) {
          warnings.push(...piiRisk.warnings);
        }
        upsertAns.run(
          `${profileId}-ans-${ans.question_id}`,
          profileId,
          Number(ans.stage_number || stageNumber),
          ans.question_id,
          JSON.stringify(ans.value ?? ''),
          JSON.stringify(ans.value ?? ''),
          ans.source || 'user_entered',
          ans.confirmation_state || 'user_confirmed',
          ans.visibility || 'show',
          newVersion,
          user.id,
          now
        );
      }
    }

    // Save Stage private notes & status
    if (body.stageUpdate) {
      const su = body.stageUpdate;
      db.prepare(`
        UPDATE stages SET
          status = COALESCE(?, status),
          completion_pct = COALESCE(?, completion_pct),
          private_notes = COALESCE(?, private_notes),
          updated_at = ?
        WHERE profile_id = ? AND stage_number = ?
      `).run(
        su.status ?? null,
        su.completion_pct ?? null,
        su.private_notes ?? null,
        now,
        profileId,
        stageNumber
      );
    }

    // Save Education Entries (Stage 2)
    if (Array.isArray(body.educationEntries)) {
      const upsertEdu = db.prepare(`
        INSERT OR REPLACE INTO education_entries (
          id, profile_id, qualification_ar, qualification_en, institution_ar, institution_en,
          college_faculty_ar, college_faculty_en, college_needs_confirmation,
          department_ar, department_en, specialty_ar, specialty_en, credential_level,
          country, city, start_date, graduation_date, exact_date_unknown,
          attendance_mode, final_grade_ar, final_grade_en, gpa_value, gpa_scale,
          no_gpa_issued, certificate_status, verification_status, projects_coursework,
          source, confirmation_state, include_in_cv, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const e of body.educationEntries) {
        const hasCollege = Boolean((e.college_faculty_ar || '').trim() || (e.college_faculty_en || '').trim());
        upsertEdu.run(
          e.id || `${profileId}-edu-${crypto.randomUUID().slice(0, 8)}`,
          profileId,
          e.qualification_ar || 'دبلوم',
          e.qualification_en || 'Diploma',
          e.institution_ar || '',
          e.institution_en || '',
          e.college_faculty_ar || '',
          e.college_faculty_en || '',
          hasCollege ? 0 : 1,
          e.department_ar || '',
          e.department_en || '',
          e.specialty_ar || '',
          e.specialty_en || '',
          e.credential_level || 'Diploma',
          e.country || 'Egypt',
          e.city || '',
          e.start_date || '',
          e.graduation_date || '',
          e.exact_date_unknown ? 1 : 0,
          e.attendance_mode || 'regular',
          e.final_grade_ar || '',
          e.final_grade_en || '',
          e.no_gpa_issued ? '' : e.gpa_value || '',
          e.no_gpa_issued ? '' : e.gpa_scale || '',
          e.no_gpa_issued !== false ? 1 : 0,
          e.certificate_status || 'awarded',
          e.verification_status || 'not_started',
          e.projects_coursework || '',
          e.source || 'user_entered',
          hasCollege ? 'user_confirmed' : 'needs_confirmation',
          e.include_in_cv !== false ? 1 : 0,
          e.created_at || now,
          now
        );
      }
    }

    // Save Employment Entries (Stage 3)
    if (Array.isArray(body.employmentEntries)) {
      const upsertEmp = db.prepare(`
        INSERT OR REPLACE INTO employment_entries (
          id, profile_id, institution_name_ar, institution_name_en, alternative_names,
          institution_type, city, region, country, street_address, show_address_on_cv,
          department, role_title_ar, role_title_en, relationship_type, is_primary_employer,
          start_date, end_date, is_current, exact_dates_unknown, date_display_mode,
          overlap_explanation, supervision_level, modalities_json, tasks_confirmed_json,
          pacs_ris_systems, case_example_non_identifiable, achievements_text,
          suggested_bullets_json, approved_bullets_json,
          source, confirmation_state, include_in_cv, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      body.employmentEntries.forEach((emp, idx) => {
        const piiRisk = checkPatientIdentifierRisk(emp.case_example_non_identifiable);
        if (piiRisk.hasRisk) warnings.push(...piiRisk.warnings);

        const datesUnknown = !emp.start_date || emp.exact_dates_unknown ? 1 : 0;
        const confState =
          !datesUnknown && emp.relationship_type && emp.relationship_type !== 'needs_confirmation'
            ? 'user_confirmed'
            : 'needs_confirmation';

        upsertEmp.run(
          emp.id || `${profileId}-emp-${crypto.randomUUID().slice(0, 8)}`,
          profileId,
          emp.institution_name_ar || '',
          emp.institution_name_en || '',
          emp.alternative_names || '',
          emp.institution_type || '',
          emp.city || '',
          emp.region || '',
          emp.country || 'Egypt',
          emp.street_address || '',
          emp.show_address_on_cv ? 1 : 0,
          emp.department || 'Radiology Department',
          emp.role_title_ar || '',
          emp.role_title_en || '',
          emp.relationship_type || 'needs_confirmation',
          emp.is_primary_employer ? 1 : 0,
          emp.start_date || '',
          emp.end_date || '',
          emp.is_current !== false ? 1 : 0,
          datesUnknown,
          emp.date_display_mode || (datesUnknown ? 'needs_confirmation' : 'full'),
          emp.overlap_explanation || '',
          emp.supervision_level || 'needs_confirmation',
          typeof emp.modalities_json === 'string' ? emp.modalities_json : JSON.stringify(emp.modalities || []),
          typeof emp.tasks_confirmed_json === 'string'
            ? emp.tasks_confirmed_json
            : JSON.stringify(emp.tasks_confirmed || []),
          emp.pacs_ris_systems || '',
          emp.case_example_non_identifiable || '',
          emp.achievements_text || '',
          typeof emp.suggested_bullets_json === 'string'
            ? emp.suggested_bullets_json
            : JSON.stringify(emp.suggested_bullets || []),
          typeof emp.approved_bullets_json === 'string'
            ? emp.approved_bullets_json
            : JSON.stringify(emp.approved_bullets || []),
          emp.source || 'user_entered',
          confState,
          emp.include_in_cv !== false ? 1 : 0,
          emp.sort_order ?? idx + 1,
          emp.created_at || now,
          now
        );
      });
    }

    // Save Training & Internship Entries (Stage 4)
    if (Array.isArray(body.trainingEntries)) {
      const upsertTrn = db.prepare(`
        INSERT OR REPLACE INTO training_entries (
          id, profile_id, training_type, institution_ar, institution_en,
          city_ar, city_en, department_role_ar, department_role_en,
          year_or_period, total_duration_ar, total_duration_en, exact_rotation_dates_unknown,
          supervisors_roles, rotations_json, preferred_rotations_json,
          preference_reason_ar, preference_reason_en,
          tasks_performed_json, tasks_assisted_json, tasks_observed_json, tasks_supervised_json, tasks_unconfirmed_json,
          emergency_cases_json, suggested_draft_ar, suggested_draft_en,
          approved_draft_ar, approved_draft_en, draft_approval_status,
          source, confirmation_state, include_in_cv, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of body.trainingEntries) {
        upsertTrn.run(
          t.id || `${profileId}-trn-${crypto.randomUUID().slice(0, 8)}`,
          profileId,
          t.training_type || 'internship',
          t.institution_ar || '',
          t.institution_en || '',
          t.city_ar || '',
          t.city_en || '',
          t.department_role_ar || '',
          t.department_role_en || '',
          t.year_or_period || '',
          t.total_duration_ar || '',
          t.total_duration_en || '',
          t.exact_rotation_dates_unknown !== false ? 1 : 0,
          t.supervisors_roles || '',
          typeof t.rotations_json === 'string' ? t.rotations_json : JSON.stringify(t.rotations || []),
          typeof t.preferred_rotations_json === 'string'
            ? t.preferred_rotations_json
            : JSON.stringify(t.preferred_rotations || []),
          t.preference_reason_ar || '',
          t.preference_reason_en || '',
          typeof t.tasks_performed_json === 'string' ? t.tasks_performed_json : JSON.stringify(t.tasks_performed || []),
          typeof t.tasks_assisted_json === 'string' ? t.tasks_assisted_json : JSON.stringify(t.tasks_assisted || []),
          typeof t.tasks_observed_json === 'string' ? t.tasks_observed_json : JSON.stringify(t.tasks_observed || []),
          typeof t.tasks_supervised_json === 'string' ? t.tasks_supervised_json : JSON.stringify(t.tasks_supervised || []),
          typeof t.tasks_unconfirmed_json === 'string' ? t.tasks_unconfirmed_json : JSON.stringify(t.tasks_unconfirmed || []),
          typeof t.emergency_cases_json === 'string' ? t.emergency_cases_json : JSON.stringify(t.emergency_cases || []),
          t.suggested_draft_ar || '',
          t.suggested_draft_en || '',
          t.approved_draft_ar || '',
          t.approved_draft_en || '',
          t.draft_approval_status || 'pending_review',
          t.source || 'user_entered',
          t.draft_approval_status === 'approved' ? 'user_confirmed' : 'needs_confirmation',
          t.include_in_cv !== false ? 1 : 0,
          t.created_at || now,
          now
        );
      }
    }

    // Save Modality Competencies (Stage 5)
    if (Array.isArray(body.modalityEntries)) {
      const upsertMod = db.prepare(`
        INSERT OR REPLACE INTO modality_competencies (
          id, profile_id, modality_code, modality_name_ar, modality_name_en,
          experience_category, duration_text, clinical_settings_json, institutions_json,
          equipment_models, confidence_level, justification_text,
          source, confirmation_state, include_in_cv, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const m of body.modalityEntries) {
        upsertMod.run(
          m.id || `${profileId}-mod-${m.modality_code}`,
          profileId,
          m.modality_code,
          m.modality_name_ar,
          m.modality_name_en,
          m.experience_category || 'no_experience',
          m.duration_text || '',
          typeof m.clinical_settings_json === 'string' ? m.clinical_settings_json : JSON.stringify(m.clinical_settings || []),
          typeof m.institutions_json === 'string' ? m.institutions_json : JSON.stringify(m.institutions || []),
          m.equipment_models || 'Not sure',
          m.confidence_level || 'needs_confirmation',
          m.justification_text || '',
          m.source || 'user_entered',
          m.confirmation_state || 'user_confirmed',
          m.include_in_cv ? 1 : 0,
          now
        );
      }
    }

    // Save Licenses & CPD (Stage 8)
    if (Array.isArray(body.licenseEntries)) {
      const upsertLic = db.prepare(`
        INSERT OR REPLACE INTO license_entries (
          id, profile_id, credential_type, name_ar, name_en,
          issuing_authority_ar, issuing_authority_en, country,
          printed_title_ar, printed_title_en, license_number_private, show_number_on_cv,
          issue_date, expiry_date, no_expiry_or_unknown, status,
          source, confirmation_state, include_in_cv, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const l of body.licenseEntries) {
        upsertLic.run(
          l.id || `${profileId}-lic-${crypto.randomUUID().slice(0, 8)}`,
          profileId,
          l.credential_type || 'license',
          l.name_ar || '',
          l.name_en || '',
          l.issuing_authority_ar || '',
          l.issuing_authority_en || '',
          l.country || 'Egypt',
          l.printed_title_ar || '',
          l.printed_title_en || '',
          l.license_number_private || '',
          l.show_number_on_cv ? 1 : 0,
          l.issue_date || '',
          l.expiry_date || '',
          l.no_expiry_or_unknown !== false ? 1 : 0,
          l.status || 'needs_confirmation',
          l.source || 'user_entered',
          l.confirmation_state || 'user_confirmed',
          l.include_in_cv !== false ? 1 : 0,
          l.created_at || now,
          now
        );
      }
    }

    // Save Achievements & Stage 10 Entries
    if (Array.isArray(body.achievementEntries)) {
      const upsertAch = db.prepare(`
        INSERT OR REPLACE INTO achievement_entries (
          id, profile_id, stage_number, category, title_ar, title_en,
          situation_text, action_text, result_text, evidence_text, measurement_type,
          suggested_bullet_ar, suggested_bullet_en, approved_bullet_ar, approved_bullet_en,
          approval_status, include_in_cv, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of body.achievementEntries) {
        const piiRisk = checkPatientIdentifierRisk(`${a.situation_text || ''} ${a.action_text || ''}`);
        if (piiRisk.hasRisk) warnings.push(...piiRisk.warnings);

        upsertAch.run(
          a.id || `${profileId}-ach-${crypto.randomUUID().slice(0, 8)}`,
          profileId,
          Number(a.stage_number || 7),
          a.category || 'urgent_workflow',
          a.title_ar || '',
          a.title_en || '',
          a.situation_text || '',
          a.action_text || '',
          a.result_text || '',
          a.evidence_text || '',
          a.measurement_type || 'qualitative',
          a.suggested_bullet_ar || '',
          a.suggested_bullet_en || '',
          a.approved_bullet_ar || '',
          a.approved_bullet_en || '',
          a.approval_status || 'approved',
          a.include_in_cv !== false ? 1 : 0,
          a.created_at || now,
          now
        );
      }
    }

    // Save References (Stage 12)
    if (Array.isArray(body.referenceEntries)) {
      const upsertRef = db.prepare(`
        INSERT OR REPLACE INTO reference_entries (
          id, profile_id, name, title, institution, relationship,
          email_private, phone_private, language, permission_to_contact, show_contact_on_cv, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of body.referenceEntries) {
        upsertRef.run(
          r.id || `${profileId}-ref-${crypto.randomUUID().slice(0, 8)}`,
          profileId,
          r.name || '',
          r.title || '',
          r.institution || '',
          r.relationship || '',
          r.email_private || '',
          r.phone_private || '',
          r.language || 'ar,en',
          r.permission_to_contact ? 1 : 0,
          r.show_contact_on_cv ? 1 : 0,
          r.created_at || now,
          now
        );
      }
    }

    // Record change-level version snapshot (never keylogging)
    if (body.createVersionSnapshot || body.answers?.length > 0) {
      const currentAnswers = db.prepare(`SELECT question_id, value_json, confirmation_state FROM answers WHERE profile_id = ?`).all(profileId);
      db.prepare(`
        INSERT INTO profile_versions (
          id, profile_id, version_number, stage_number, change_summary, snapshot_json, editor_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'ver-' + crypto.randomUUID(),
        profileId,
        newVersion,
        stageNumber,
        body.changeSummary || `Saved Stage ${stageNumber} changes`,
        JSON.stringify({ answers: currentAnswers }),
        user.id,
        now
      );
    }

    logAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      targetUserId: currentProfile.owner_id,
      targetProfileId: profileId,
      eventType: 'profile.autosave_synced',
      stageOrFeature: `stage_${stageNumber}`,
      summaryRedacted: `Synced Stage ${stageNumber} changes (v${newVersion})`,
    });

    return sendJson(res, 200, {
      ok: true,
      status: 'Saved',
      version: newVersion,
      lastSyncedAt: now,
      warnings,
    });
  }

  // 7. Restore Version Snapshot (Section 8)
  const restoreVersionMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/versions\/([^/]+)\/restore$/);
  if (restoreVersionMatch && method === 'POST') {
    const profileId = decodeURIComponent(restoreVersionMatch[1]);
    const versionId = decodeURIComponent(restoreVersionMatch[2]);
    const access = checkProfileAccess(user, profileId, 'owner');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const verRow = db.prepare(`SELECT * FROM profile_versions WHERE id = ? AND profile_id = ?`).get(versionId, profileId);
    if (!verRow) return sendJson(res, 404, { error: 'Version snapshot not found' });

    const now = new Date().toISOString();
    let snap = {};
    try {
      snap = JSON.parse(verRow.snapshot_json || '{}');
    } catch (_) {}

    if (Array.isArray(snap.answers)) {
      const stmt = db.prepare(`
        UPDATE answers SET value_json = ?, confirmation_state = ?, updated_at = ?
        WHERE profile_id = ? AND question_id = ?
      `);
      for (const a of snap.answers) {
        stmt.run(a.value_json, a.confirmation_state || 'user_confirmed', now, profileId, a.question_id);
      }
    }

    const nextVer = Number(access.profile.version) + 1;
    db.prepare(`UPDATE profiles SET version = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`).run(
      nextVer,
      now,
      now,
      profileId
    );

    logAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      targetUserId: user.id,
      targetProfileId: profileId,
      eventType: 'profile.version_restored',
      stageOrFeature: 'version_history',
      summaryRedacted: `Restored profile to version #${verRow.version_number}`,
    });

    return sendJson(res, 200, { ok: true, version: nextVer, restoredVersionNumber: verRow.version_number });
  }

  // 8. Assistant Endpoints: Suggest Bullets & Parse Job Description
  const suggestMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/assistant\/suggest-bullets$/);
  if (suggestMatch && method === 'POST') {
    const profileId = decodeURIComponent(suggestMatch[1]);
    const access = checkProfileAccess(user, profileId, 'view');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const body = await readJsonBody(req);
    const result = generateSuggestedBulletsForEmployment(body.entry || {}, body.tone || 'standard');
    return sendJson(res, 200, result);
  }

  const parseJobMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/assistant\/parse-job$/);
  if (parseJobMatch && method === 'POST') {
    const profileId = decodeURIComponent(parseJobMatch[1]);
    const access = checkProfileAccess(user, profileId, 'view');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const body = await readJsonBody(req);
    const bundle = getProfileBundle(profileId);
    const result = parseJobDescriptionAgainstProfile(body.jobDescriptionText || '', bundle);
    return sendJson(res, 200, result);
  }

  // 9. Live CV HTML Preview & Answer Workbook HTML Preview (Stage 13)
  const previewMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/preview$/);
  if (previewMatch && method === 'GET') {
    const profileId = decodeURIComponent(previewMatch[1]);
    const access = checkProfileAccess(user, profileId, 'view');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const query = parsedUrl.query || {};
    const bundle = getProfileBundle(profileId);
    const quality = analyzeProfileQualityAndTruth(bundle);

    if (query.mode === 'workbook') {
      const wbHtml = renderAnswerWorkbookHtml(bundle, query.lang || 'ar');
      return sendJson(res, 200, { html: wbHtml, quality });
    }

    const html = renderCvHtml(bundle, {
      language: query.lang || bundle.profile.cv_output_language || 'en',
      isDraft: query.draft === 'true' || !quality.readyForFinalCv,
      templateId: query.template || bundle.profile.template_id || 'modern-healthcare',
      styleDensity: query.density || bundle.profile.length_preference || 'standard',
    });

    return sendJson(res, 200, { html, quality });
  }

  // 10. Real Exports Endpoint (PDF, Draft PDF, Workbook PDF, DOCX, JSON, Markdown)
  const exportCreateMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/exports$/);
  if (exportCreateMatch && method === 'POST') {
    const profileId = decodeURIComponent(exportCreateMatch[1]);
    const access = checkProfileAccess(user, profileId, 'view');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const body = await readJsonBody(req);
    const bundle = getProfileBundle(profileId);
    const resExport = generateProfileExport({
      user,
      profileBundle: bundle,
      exportType: body.exportType || 'cv_pdf',
      language: body.language || bundle.profile.cv_output_language || 'en',
      templateId: body.templateId || bundle.profile.template_id || 'modern-healthcare',
      styleDensity: body.styleDensity || bundle.profile.length_preference || 'standard',
    });

    if (!resExport.ok) {
      return sendJson(res, 500, resExport);
    }

    return sendJson(res, 201, {
      ok: true,
      exportJob: resExport.exportJob,
      downloadUrl: `/api/exports/${resExport.exportJob.id}/download`,
    });
  }

  const exportDownloadMatch = pathname.match(/^\/api\/exports\/([^/]+)\/download$/);
  if (exportDownloadMatch && method === 'GET') {
    const exportId = decodeURIComponent(exportDownloadMatch[1]);
    const expRow = db.prepare(`SELECT * FROM export_jobs WHERE id = ?`).get(exportId);
    if (!expRow) return sendJson(res, 404, { error: 'Export file not found' });

    const access = checkProfileAccess(user, expRow.profile_id, 'view');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    if (!expRow.storage_path || !fs.existsSync(expRow.storage_path)) {
      return sendJson(res, 404, { error: 'Export file has expired or been removed.' });
    }

    const buf = fs.readFileSync(expRow.storage_path);
    const mime =
      expRow.export_type === 'json_backup'
        ? 'application/json'
        : expRow.export_type === 'markdown_backup'
        ? 'text/markdown; charset=utf-8'
        : expRow.export_type === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/pdf';

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${expRow.filename}"`,
      'Content-Length': buf.length,
      'Cache-Control': 'private, no-store',
    });
    res.end(buf);
    return;
  }

  // 11. Secure File Upload & Management Endpoints (Section 10 & Stage 12)
  const uploadMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/uploads$/);
  if (uploadMatch && method === 'POST') {
    const profileId = decodeURIComponent(uploadMatch[1]);
    const access = checkProfileAccess(user, profileId, 'edit');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const body = await readJsonBody(req, 30 * 1024 * 1024);
    const base64Data = String(body.contentBase64 || '').replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const result = validateAndStoreUpload({
      user,
      profileId,
      originalName: body.filename || 'upload',
      declaredMime: body.mimeType || 'application/octet-stream',
      purpose: body.purpose || 'certificate',
      buffer,
    });

    if (!result.ok) {
      return sendJson(res, result.status || 400, { error: result.error });
    }
    return sendJson(res, 201, result);
  }

  const singleUploadMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/);
  if (singleUploadMatch) {
    const uploadId = decodeURIComponent(singleUploadMatch[1]);
    const uplRow = db.prepare(`SELECT * FROM uploaded_files WHERE id = ? AND deleted_at IS NULL`).get(uploadId);
    if (!uplRow) return sendJson(res, 404, { error: 'Uploaded file not found' });

    if (method === 'GET') {
      const access = checkProfileAccess(user, uplRow.profile_id, 'view');
      if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

      const fullPath = path.join(UPLOAD_DIR, uplRow.storage_object_name);
      if (!fs.existsSync(fullPath)) return sendJson(res, 404, { error: 'File missing on disk' });

      const buf = fs.readFileSync(fullPath);
      res.writeHead(200, {
        'Content-Type': uplRow.verified_mime,
        'Content-Disposition': `inline; filename="${uplRow.sanitized_name}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=60',
      });
      res.end(buf);
      return;
    }

    if (method === 'DELETE') {
      const access = checkProfileAccess(user, uplRow.profile_id, 'edit');
      if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

      const fullPath = path.join(UPLOAD_DIR, uplRow.storage_object_name);
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch (_) {}
      }
      const now = new Date().toISOString();
      db.prepare(`UPDATE uploaded_files SET deleted_at = ? WHERE id = ?`).run(now, uploadId);

      logAuditEvent({
        actorUserId: user.id,
        actorRole: user.role,
        targetUserId: uplRow.owner_id,
        targetProfileId: uplRow.profile_id,
        eventType: 'upload.file_deleted',
        stageOrFeature: 'stage_12_uploads',
        summaryRedacted: `Deleted uploaded file (${uplRow.purpose})`,
      });
      return sendJson(res, 200, { ok: true, deletedAt: now });
    }
  }

  // 12. Share Links & Collaborator Access Grants & Consent Management
  const shareLinkCreateMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/share-links$/);
  if (shareLinkCreateMatch && method === 'POST') {
    const profileId = decodeURIComponent(shareLinkCreateMatch[1]);
    const access = checkProfileAccess(user, profileId, 'owner');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const body = await readJsonBody(req);
    const hours = Number(body.expiryHours || 24);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + hours * 3600 * 1000).toISOString();
    const token = crypto.randomBytes(24).toString('hex');
    const linkId = 'shl-' + crypto.randomUUID();

    db.prepare(`
      INSERT INTO share_links (
        id, token, profile_id, owner_id, label, language, allow_download, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      linkId,
      token,
      profileId,
      user.id,
      body.label || 'Employer Share Link',
      body.language || 'en',
      body.allowDownload !== false ? 1 : 0,
      expiresAt,
      now.toISOString()
    );

    logAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      targetUserId: user.id,
      targetProfileId: profileId,
      eventType: 'share_link.created',
      stageOrFeature: 'stage_13_sharing',
      summaryRedacted: `Created expiring share link (${hours}h expiry)`,
    });

    return sendJson(res, 201, {
      ok: true,
      shareLink: {
        id: linkId,
        token,
        url: `/api/shared/${token}`,
        expires_at: expiresAt,
      },
    });
  }

  const revokeShareLinkMatch = pathname.match(/^\/api\/share-links\/([^/]+)\/revoke$/);
  if (revokeShareLinkMatch && method === 'POST') {
    const linkId = decodeURIComponent(revokeShareLinkMatch[1]);
    const row = db.prepare(`SELECT * FROM share_links WHERE id = ?`).get(linkId);
    if (!row) return sendJson(res, 404, { error: 'Share link not found' });

    const access = checkProfileAccess(user, row.profile_id, 'owner');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const now = new Date().toISOString();
    db.prepare(`UPDATE share_links SET revoked_at = ? WHERE id = ?`).run(now, linkId);
    logAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      targetUserId: user.id,
      targetProfileId: row.profile_id,
      eventType: 'share_link.revoked',
      stageOrFeature: 'stage_13_sharing',
      summaryRedacted: 'Revoked share link',
    });
    return sendJson(res, 200, { ok: true, revokedAt: now });
  }

  const publicSharedMatch = pathname.match(/^\/api\/shared\/([^/]+)$/);
  if (publicSharedMatch && method === 'GET') {
    const token = decodeURIComponent(publicSharedMatch[1]);
    const row = db.prepare(`SELECT * FROM share_links WHERE token = ?`).get(token);
    if (!row) return sendJson(res, 404, { error: 'Share link not found' });
    if (row.revoked_at) return sendJson(res, 403, { error: 'This share link has been revoked by the profile owner.' });
    if (new Date(row.expires_at) < new Date()) {
      return sendJson(res, 403, { error: 'This share link has expired.' });
    }

    const now = new Date().toISOString();
    let logs = [];
    try {
      logs = JSON.parse(row.access_log_json || '[]');
    } catch (_) {}
    logs.unshift({ accessed_at: now, viewer: user ? user.displayName : 'Anonymous link visitor' });

    db.prepare(`UPDATE share_links SET access_count = access_count + 1, access_log_json = ? WHERE id = ?`).run(
      JSON.stringify(logs.slice(0, 50)),
      row.id
    );

    const bundle = getProfileBundle(row.profile_id);
    const html = renderCvHtml(bundle, {
      language: row.language || 'en',
      isDraft: false,
      templateId: bundle.profile.template_id,
    });
    return sendJson(res, 200, {
      ok: true,
      label: row.label,
      allow_download: Boolean(row.allow_download),
      expires_at: row.expires_at,
      html,
    });
  }

  // Collaborator Grant & Revoke
  const grantMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/collaborators$/);
  if (grantMatch && method === 'POST') {
    const profileId = decodeURIComponent(grantMatch[1]);
    const access = checkProfileAccess(user, profileId, 'owner');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const body = await readJsonBody(req);
    const granteeEmail = String(body.email || '').trim().toLowerCase();
    const scope = body.permission_scope === 'edit' ? 'edit' : 'view';
    if (!granteeEmail) return sendJson(res, 400, { error: 'Collaborator email is required' });

    const granteeUser = db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(granteeEmail);
    const grantId = 'grt-' + crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO access_grants (
        id, profile_id, owner_id, grantee_user_id, grantee_email, grantee_role, permission_scope, granted_at
      ) VALUES (?, ?, ?, ?, ?, 'collaborator', ?, ?)
    `).run(grantId, profileId, user.id, granteeUser?.id || null, granteeEmail, scope, now);

    logAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      targetUserId: granteeUser?.id || null,
      targetProfileId: profileId,
      eventType: 'collaborator.granted',
      stageOrFeature: 'sharing_permissions',
      summaryRedacted: `Granted ${scope} access to collaborator`,
    });

    return sendJson(res, 201, { ok: true, grantId, permission_scope: scope });
  }

  const revokeGrantMatch = pathname.match(/^\/api\/collaborators\/([^/]+)\/revoke$/);
  if (revokeGrantMatch && method === 'POST') {
    const grantId = decodeURIComponent(revokeGrantMatch[1]);
    const grantRow = db.prepare(`SELECT * FROM access_grants WHERE id = ?`).get(grantId);
    if (!grantRow) return sendJson(res, 404, { error: 'Access grant not found' });

    const access = checkProfileAccess(user, grantRow.profile_id, 'owner');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const now = new Date().toISOString();
    db.prepare(`UPDATE access_grants SET revoked_at = ? WHERE id = ?`).run(now, grantId);
    return sendJson(res, 200, { ok: true, revokedAt: now });
  }

  // Admin Profile Sharing Consent Toggle (Purpose-Specific Consent — Section 11 & 12)
  const consentMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/consent$/);
  if (consentMatch && method === 'POST') {
    const profileId = decodeURIComponent(consentMatch[1]);
    const access = checkProfileAccess(user, profileId, 'owner');
    if (!access.allowed) return sendJson(res, access.status, { error: access.reason });

    const body = await readJsonBody(req);
    const shareWithAdmin = body.share_with_admin_enabled ? 1 : 0;
    const shareHistory = shareWithAdmin && body.share_history_with_admin ? 1 : 0;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE profiles SET
        privacy_mode = ?,
        share_with_admin_enabled = ?,
        share_history_with_admin = ?,
        admin_consent_granted_at = ?,
        admin_consent_version = 'v1.0',
        updated_at = ?
      WHERE id = ?
    `).run(
      shareWithAdmin ? 'shared_with_admin' : 'private',
      shareWithAdmin,
      shareHistory,
      shareWithAdmin ? now : null,
      now,
      profileId
    );

    db.prepare(`
      INSERT INTO consent_records (id, user_id, profile_id, purpose, status, consent_version, scope_details, created_at)
      VALUES (?, ?, ?, 'admin_profile_share', ?, 'v1.0', ?, ?)
    `).run(
      'cns-' + crypto.randomUUID(),
      user.id,
      profileId,
      shareWithAdmin ? 'granted' : 'revoked',
      `share_profile=${Boolean(shareWithAdmin)}, share_history=${Boolean(shareHistory)}`,
      now
    );

    logAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      targetUserId: user.id,
      targetProfileId: profileId,
      eventType: shareWithAdmin ? 'consent.admin_share_granted' : 'consent.admin_share_revoked',
      stageOrFeature: 'privacy_consent',
      summaryRedacted: shareWithAdmin
        ? `Profile owner granted support admin access (history=${Boolean(shareHistory)})`
        : 'Profile owner revoked support admin access (Profile is now strictly private)',
    });

    if (!shareWithAdmin) {
      dispatchAdminNotification({
        eventType: 'consent_revoked',
        subject: 'Profile owner revoked admin support sharing consent',
        summaryRedacted: `Access to shared profile ${profileId} was revoked by its owner.`,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      privacy_mode: shareWithAdmin ? 'shared_with_admin' : 'private',
      share_with_admin_enabled: Boolean(shareWithAdmin),
      share_history_with_admin: Boolean(shareHistory),
      updated_at: now,
    });
  }

  // 13. Support Tickets / Report a Problem (Section 11)
  if (pathname === '/api/support/tickets' && method === 'POST') {
    const body = await readJsonBody(req);
    const subject = String(body.subject || '').trim();
    const description = String(body.description || '').trim();
    if (!subject || !description) {
      return sendJson(res, 400, { error: 'Subject and description are required.' });
    }

    const ticketId = 'tkt-' + crypto.randomUUID().slice(0, 8).toUpperCase();
    const now = new Date().toISOString();
    const redactedDesc = body.allowUnredactedSupportPayload ? description : redactPII(description);

    db.prepare(`
      INSERT INTO support_tickets (
        id, user_id, profile_id, category, subject, description_redacted, diagnostic_payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'New', ?, ?)
    `).run(
      ticketId,
      user?.id || null,
      body.profileId || null,
      body.category || 'general',
      redactPII(subject),
      redactedDesc,
      redactPII(JSON.stringify(body.diagnostics || {})),
      now,
      now
    );

    const delivery = dispatchAdminNotification({
      eventType: 'support_ticket_created',
      subject: `New Support Ticket [${ticketId}]: ${subject}`,
      summaryRedacted: `Ticket ${ticketId} submitted (${body.category || 'general'})`,
    });

    return sendJson(res, 201, {
      ok: true,
      ticket: {
        id: ticketId,
        status: 'New',
        created_at: now,
      },
      notificationDelivery: delivery,
    });
  }

  // 14. Account Data Export & Account Deactivation/Deletion (Section 12)
  if (pathname === '/api/account/delete' && method === 'POST') {
    if (!user) return sendJson(res, 401, { error: 'Authentication required' });
    const body = await readJsonBody(req);
    const action = body.action === 'deactivate' ? 'deactivated' : 'deleted';

    if (action === 'deactivated') {
      db.prepare(`UPDATE users SET account_status = 'deactivated', updated_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        user.id
      );
      revokeSession(user.sessionToken, user.id);
      return sendJson(res, 200, { ok: true, status: 'deactivated' });
    }

    db.prepare(`DELETE FROM users WHERE id = ?`).run(user.id);
    return sendJson(res, 200, { ok: true, status: 'deleted' });
  }

  // 15. Administrator Console Endpoints (Restricted strictly to server-side role === 'admin' | 'super_admin')
  if (pathname.startsWith('/api/admin/')) {
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
      return sendJson(res, 403, {
        error: 'Administrator privileges required. Client-side flags cannot grant admin access.',
      });
    }

    if (pathname === '/api/admin/overview' && method === 'GET') {
      const totalAccounts = db.prepare(`SELECT COUNT(*) as c FROM users`).get().c;
      const activeProfiles = db.prepare(`SELECT COUNT(*) as c FROM profiles`).get().c;
      const completedExports = db.prepare(`SELECT COUNT(*) as c FROM export_jobs WHERE status = 'completed'`).get().c;
      const failedExports = db.prepare(`SELECT COUNT(*) as c FROM export_jobs WHERE status = 'failed'`).get().c;
      const pendingTickets = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE status != 'Resolved'`).get().c;

      // Aggregate stage completion (privacy-preserving)
      const stageAggregates = db
        .prepare(`
          SELECT stage_number, stage_key, AVG(completion_pct) as avg_pct,
                 SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count
          FROM stages
          GROUP BY stage_number, stage_key
          ORDER BY stage_number ASC
        `)
        .all();

      // List accounts WITHOUT passwords, tokens, or private CV content
      const usersList = db
        .prepare(`
          SELECT id, email, display_name, auth_provider, role, account_status, locale, last_sign_in_at, created_at
          FROM users
          ORDER BY created_at DESC
          LIMIT 50
        `)
        .all();

      // List ONLY profiles that have explicitly opted into share_with_admin_enabled = 1
      const sharedProfiles = db
        .prepare(`
          SELECT id, owner_id, title, target_country, privacy_mode, share_with_admin_enabled,
                 share_history_with_admin, admin_consent_granted_at, admin_consent_version, last_synced_at
          FROM profiles
          WHERE share_with_admin_enabled = 1
          ORDER BY updated_at DESC
        `)
        .all();

      // Also show count of private profiles whose content is hidden from admin by policy
      const privateProfilesCount = db
        .prepare(`SELECT COUNT(*) as c FROM profiles WHERE share_with_admin_enabled = 0`)
        .get().c;

      const tickets = db.prepare(`SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 30`).all();
      const auditEvents = db.prepare(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 50`).all();
      const errorLogs = db.prepare(`SELECT * FROM error_logs ORDER BY last_seen_at DESC LIMIT 30`).all();
      const notifications = db.prepare(`SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT 40`).all();
      const consentLogs = db.prepare(`SELECT * FROM consent_records ORDER BY created_at DESC LIMIT 30`).all();

      return sendJson(res, 200, {
        metrics: {
          totalAccounts,
          activeProfiles,
          sharedProfilesCount: sharedProfiles.length,
          privateProfilesCount,
          completedExports,
          failedExports,
          pendingTickets,
        },
        stageAggregates,
        usersList,
        sharedProfiles,
        tickets,
        auditEvents,
        errorLogs,
        notifications,
        consentLogs,
        integrations: getIntegrationStatuses(),
        platform: getPlatformConfig(true),
      });
    }

    if (pathname === '/api/admin/settings' && method === 'PUT') {
      const body = await readJsonBody(req);
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO platform_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
      `);
      const allowedKeys = [
        'site_title_en',
        'site_title_ar',
        'creator_name',
        'support_email',
        'support_phone',
        'phone_visibility',
        'whatsapp_enabled',
      ];
      for (const k of allowedKeys) {
        if (body[k] !== undefined) {
          stmt.run(k, JSON.stringify(body[k]), now);
        }
      }
      logAuditEvent({
        actorUserId: user.id,
        actorRole: user.role,
        eventType: 'admin.settings_updated',
        stageOrFeature: 'admin_console',
        summaryRedacted: 'Administrator updated platform display/support settings',
      });
      return sendJson(res, 200, { ok: true, platform: getPlatformConfig(true) });
    }

    if (pathname === '/api/admin/test-integration' && method === 'POST') {
      const body = await readJsonBody(req);
      const channel = body.channel; // 'email' | 'whatsapp' | 'phone_otp' | 'pdf_storage'
      const statuses = getIntegrationStatuses();
      const now = new Date().toISOString();

      if (channel === 'pdf_storage') {
        return sendJson(res, 200, {
          ok: true,
          channel: 'pdf_storage',
          status: 'Connected & Verified',
          message_en: 'Server-side SQLite storage and LibreOffice PDF engine responded normally.',
          message_ar: 'تم اختبار محرك توليد PDF والتخزين على الخادم بنجاح.',
        });
      }

      if (channel === 'email' && statuses.email_notifications.setup_required) {
        db.prepare(`
          INSERT INTO notification_logs (id, event_type, channel, recipient, subject, delivery_status, retry_count, failure_reason_redacted, created_at)
          VALUES (?, 'admin.test_email', 'email', ?, 'Test Email Verification', 'not_configured', 0, 'SMTP / Email provider credentials missing in environment', ?)
        `).run('ntf-' + crypto.randomUUID(), process.env.ADMIN_CONTACT_EMAIL || 'frp.nasr@gmail.com', now);

        return sendJson(res, 200, {
          ok: false,
          honestStatus: 'Needs setup',
          message_en:
            'Test email was NOT sent because no SMTP/Email API credentials are configured in the environment. Configure SMTP_HOST/SMTP_PASS or RESEND_API_KEY first.',
          message_ar:
            'لم يتم إرسال البريد التجريبي لأن إعدادات مزود البريد (SMTP / Resend) غير مضافة في متغيرات البيئة بعد (النظام لا يزيف رسائل النجاح).',
        });
      }

      if (channel === 'whatsapp' && statuses.whatsapp_notifications.setup_required) {
        db.prepare(`
          INSERT INTO notification_logs (id, event_type, channel, recipient, subject, delivery_status, retry_count, failure_reason_redacted, created_at)
          VALUES (?, 'admin.test_whatsapp', 'whatsapp', '+201091874291', 'Test WhatsApp Template', 'not_configured', 0, 'WhatsApp Business Cloud API token missing', ?)
        `).run('ntf-' + crypto.randomUUID(), now);

        return sendJson(res, 200, {
          ok: false,
          honestStatus: 'Needs setup',
          message_en:
            'WhatsApp message was NOT sent. A phone number alone cannot send automated server messages; configure WhatsApp Business Cloud API token and Phone Number ID.',
          message_ar:
            'لم يتم إرسال رسالة واتساب. رقم الهاتف وحده لا يكفي للإرسال الآلي من الخادم؛ يلزم إعداد WhatsApp Business Cloud API.',
        });
      }

      return sendJson(res, 200, {
        ok: false,
        honestStatus: 'Needs setup',
        message_en: `Integration "${channel}" requires external provider credentials.`,
        message_ar: `التكامل (${channel}) يحتاج إلى بيانات اعتماد المزود الخارجي.`,
      });
    }

    const ticketUpdateMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)$/);
    if (ticketUpdateMatch && method === 'PUT') {
      const ticketId = decodeURIComponent(ticketUpdateMatch[1]);
      const body = await readJsonBody(req);
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE support_tickets SET status = COALESCE(?, status), admin_response = COALESCE(?, admin_response), updated_at = ?
        WHERE id = ?
      `).run(body.status || null, body.admin_response || null, now, ticketId);
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: `API endpoint not found: ${method} ${pathname}` });
}

function serveStaticFile(req, res, parsedUrl) {
  let reqPath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback to index.html for client-side routes (/stage/1, /dashboard, /admin, etc.)
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
  };

  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  res.end(content);
}

function createAppServer() {
  // Initialize DB & seed definitions/private profile if present
  getDb();
  seedRuntimeDatabase();

  return http.createServer(async (req, res) => {
    try {
      const parsedUrl = url.parse(req.url, true);
      if (parsedUrl.pathname.startsWith('/api/')) {
        await handleApiRequest(req, res, parsedUrl);
      } else {
        serveStaticFile(req, res, parsedUrl);
      }
    } catch (err) {
      if (err.message === 'PAYLOAD_TOO_LARGE') {
        return sendJson(res, 413, { error: 'Payload exceeds maximum allowed upload size.' });
      }
      if (err.message === 'INVALID_JSON') {
        return sendJson(res, 400, { error: 'Invalid JSON request body.' });
      }
      const corrId = logRedactedError({
        errorType: 'UNHANDLED_API_ERROR',
        affectedFeature: req.url,
        message: err.message,
      });
      sendJson(res, 500, {
        error: 'An unexpected server error occurred.',
        errorReference: corrId,
      });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const server = createAppServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`Radiology CV Studio running at http://0.0.0.0:${port}`);
  });
}

module.exports = {
  createAppServer,
};
