const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.cwd(), process.env.DATABASE_PATH)
  : path.resolve(process.cwd(), 'runtime-data', 'radiology_cv_studio.sqlite');

let dbInstance = null;
let currentDbPath = null;

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDb(customPath) {
  const targetPath = customPath || DEFAULT_DB_PATH;
  if (dbInstance && currentDbPath === targetPath) {
    return dbInstance;
  }
  ensureDirForFile(targetPath);
  dbInstance = new DatabaseSync(targetPath);
  currentDbPath = targetPath;
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  dbInstance.exec('PRAGMA busy_timeout = 5000;');
  runMigrations(dbInstance);
  return dbInstance;
}

function resetDbConnection() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
  }
  dbInstance = null;
  currentDbPath = null;
}

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );

    -- 1. Users / Accounts
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      phone TEXT UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT,
      password_salt TEXT,
      auth_provider TEXT NOT NULL DEFAULT 'local',
      email_verified INTEGER NOT NULL DEFAULT 0,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'user', -- guest | user | collaborator | admin | super_admin
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      account_status TEXT NOT NULL DEFAULT 'active', -- active | disabled | deactivated | pending_deletion
      locale TEXT NOT NULL DEFAULT 'ar',
      theme TEXT NOT NULL DEFAULT 'light',
      is_seeded_subject INTEGER NOT NULL DEFAULT 0,
      last_sign_in_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 2. User Preferences & Cookie Consent
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      locale TEXT NOT NULL DEFAULT 'ar',
      theme TEXT NOT NULL DEFAULT 'light',
      cookie_necessary INTEGER NOT NULL DEFAULT 1,
      cookie_preferences INTEGER NOT NULL DEFAULT 1,
      cookie_analytics INTEGER NOT NULL DEFAULT 0,
      cookie_consent_version TEXT NOT NULL DEFAULT 'v1.0',
      cookie_consented_at TEXT,
      updated_at TEXT NOT NULL
    );

    -- 3. Sessions (Server-managed HttpOnly session tokens)
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    -- 4. Profiles / CV Workspaces
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      slug TEXT,
      primary_language TEXT NOT NULL DEFAULT 'ar',
      cv_output_language TEXT NOT NULL DEFAULT 'en', -- ar | en | bilingual
      target_country TEXT NOT NULL DEFAULT 'Saudi Arabia',
      template_id TEXT NOT NULL DEFAULT 'modern-healthcare',
      photo_preference TEXT NOT NULL DEFAULT 'omit', -- include | omit
      length_preference TEXT NOT NULL DEFAULT 'standard', -- concise | standard | detailed
      tailored_vacancy_title TEXT,
      tailored_vacancy_raw TEXT,
      is_seeded INTEGER NOT NULL DEFAULT 0,
      seed_banner_dismissed INTEGER NOT NULL DEFAULT 0,
      privacy_mode TEXT NOT NULL DEFAULT 'private', -- private | shared_with_admin | custom
      share_with_admin_enabled INTEGER NOT NULL DEFAULT 0,
      share_history_with_admin INTEGER NOT NULL DEFAULT 0,
      admin_consent_granted_at TEXT,
      admin_consent_version TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      version INTEGER NOT NULL DEFAULT 1,
      last_synced_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles(owner_id);

    -- 5. Stages Progress Snapshot
    CREATE TABLE IF NOT EXISTS stages (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      stage_number INTEGER NOT NULL,
      stage_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_started', -- not_started | in_progress | completed | needs_confirmation | optional
      completion_pct INTEGER NOT NULL DEFAULT 0,
      unanswered_count INTEGER NOT NULL DEFAULT 0,
      needs_confirmation_count INTEGER NOT NULL DEFAULT 0,
      private_notes TEXT DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE(profile_id, stage_number)
    );
    CREATE INDEX IF NOT EXISTS idx_stages_profile ON stages(profile_id);

    -- 6. Question Definitions (Versioned Metadata)
    CREATE TABLE IF NOT EXISTS question_definitions (
      question_id TEXT PRIMARY KEY,
      stage_number INTEGER NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0',
      label_ar TEXT NOT NULL,
      label_en TEXT NOT NULL,
      help_ar TEXT,
      help_en TEXT,
      why_it_matters_ar TEXT,
      why_it_matters_en TEXT,
      when_not_to_claim_ar TEXT,
      when_not_to_claim_en TEXT,
      example_ar TEXT,
      example_en TEXT,
      input_type TEXT NOT NULL,
      is_required INTEGER NOT NULL DEFAULT 0,
      privacy_level TEXT NOT NULL DEFAULT 'public_cv', -- private_notes | profile_data | sensitive_credential | public_cv
      options_json TEXT,
      branch_rules_json TEXT,
      updated_at TEXT NOT NULL
    );

    -- 7. Answers (Structured per-question answers with provenance & confirmation state)
    CREATE TABLE IF NOT EXISTS answers (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      stage_number INTEGER NOT NULL,
      question_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      raw_source_value TEXT,
      source TEXT NOT NULL DEFAULT 'user_entered', -- user_entered | imported | upload_extracted | ai_suggestion
      confirmation_state TEXT NOT NULL DEFAULT 'user_confirmed', -- not_entered | needs_confirmation | user_confirmed | draft_wording | verified_document
      visibility TEXT NOT NULL DEFAULT 'show', -- show | hide | private_only
      evidence_upload_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(profile_id, question_id)
    );
    CREATE INDEX IF NOT EXISTS idx_answers_profile ON answers(profile_id);

    -- 8. Employment History Entries (Stage 3 & Stage 1 Associated Workplaces)
    CREATE TABLE IF NOT EXISTS employment_entries (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      institution_name_ar TEXT NOT NULL,
      institution_name_en TEXT NOT NULL,
      alternative_names TEXT,
      institution_type TEXT,
      city TEXT,
      region TEXT,
      country TEXT DEFAULT 'Egypt',
      street_address TEXT,
      show_address_on_cv INTEGER NOT NULL DEFAULT 0,
      department TEXT,
      role_title_ar TEXT,
      role_title_en TEXT,
      official_paperwork_title TEXT,
      relationship_type TEXT NOT NULL DEFAULT 'needs_confirmation', -- current | former | occasional | temporary | part_time | full_time | on_call | contracted | trainee | volunteer | needs_confirmation
      is_primary_employer INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      end_date TEXT,
      is_current INTEGER NOT NULL DEFAULT 0,
      exact_dates_unknown INTEGER NOT NULL DEFAULT 1,
      date_display_mode TEXT NOT NULL DEFAULT 'needs_confirmation', -- full | omit_from_cv | needs_confirmation
      overlap_explanation TEXT,
      schedule_notes TEXT,
      supervision_level TEXT DEFAULT 'needs_confirmation', -- independent | supervised | mixed | needs_confirmation
      modalities_json TEXT DEFAULT '[]',
      examinations_json TEXT DEFAULT '[]',
      equipment_models TEXT,
      patient_groups_json TEXT DEFAULT '[]',
      tasks_confirmed_json TEXT DEFAULT '[]',
      contrast_scope_json TEXT DEFAULT '{}',
      pacs_ris_systems TEXT,
      safety_responsibilities_json TEXT DEFAULT '[]',
      case_example_non_identifiable TEXT,
      achievements_text TEXT,
      reason_for_leaving TEXT,
      reference_permission INTEGER NOT NULL DEFAULT 0,
      supporting_upload_id TEXT,
      suggested_bullets_json TEXT DEFAULT '[]',
      approved_bullets_json TEXT DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'user_entered',
      confirmation_state TEXT NOT NULL DEFAULT 'needs_confirmation',
      include_in_cv INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_employment_profile ON employment_entries(profile_id);

    -- 9. Education Entries (Stage 2)
    CREATE TABLE IF NOT EXISTS education_entries (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      qualification_ar TEXT NOT NULL,
      qualification_en TEXT NOT NULL,
      institution_ar TEXT NOT NULL,
      institution_en TEXT NOT NULL,
      college_faculty_ar TEXT DEFAULT '',
      college_faculty_en TEXT DEFAULT '',
      college_needs_confirmation INTEGER NOT NULL DEFAULT 1,
      department_ar TEXT,
      department_en TEXT,
      specialty_ar TEXT,
      specialty_en TEXT,
      credential_level TEXT DEFAULT 'Diploma',
      country TEXT DEFAULT 'Egypt',
      city TEXT,
      start_date TEXT,
      graduation_date TEXT,
      exact_date_unknown INTEGER NOT NULL DEFAULT 0,
      attendance_mode TEXT DEFAULT 'regular',
      final_grade_ar TEXT,
      final_grade_en TEXT,
      gpa_value TEXT DEFAULT '',
      gpa_scale TEXT DEFAULT '',
      no_gpa_issued INTEGER NOT NULL DEFAULT 1,
      certificate_status TEXT DEFAULT 'awarded',
      certificate_number_private TEXT,
      show_cert_number_on_cv INTEGER NOT NULL DEFAULT 0,
      verification_status TEXT DEFAULT 'not_started', -- not_started | in_progress | completed | needs_confirmation
      projects_coursework TEXT,
      supporting_upload_id TEXT,
      source TEXT NOT NULL DEFAULT 'user_entered',
      confirmation_state TEXT NOT NULL DEFAULT 'user_confirmed',
      include_in_cv INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_education_profile ON education_entries(profile_id);

    -- 10. Training & Internship Entries (Stage 4)
    CREATE TABLE IF NOT EXISTS training_entries (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      training_type TEXT NOT NULL, -- student_clinical | internship | workshop_clinical | observation
      institution_ar TEXT NOT NULL,
      institution_en TEXT NOT NULL,
      city_ar TEXT,
      city_en TEXT,
      department_role_ar TEXT,
      department_role_en TEXT,
      year_or_period TEXT,
      total_duration_ar TEXT,
      total_duration_en TEXT,
      exact_rotation_dates_unknown INTEGER NOT NULL DEFAULT 1,
      supervisors_roles TEXT,
      rotations_json TEXT DEFAULT '[]',
      preferred_rotations_json TEXT DEFAULT '[]',
      preference_reason_ar TEXT,
      preference_reason_en TEXT,
      tasks_performed_json TEXT DEFAULT '[]',
      tasks_assisted_json TEXT DEFAULT '[]',
      tasks_observed_json TEXT DEFAULT '[]',
      tasks_supervised_json TEXT DEFAULT '[]',
      tasks_unconfirmed_json TEXT DEFAULT '[]',
      emergency_cases_json TEXT DEFAULT '[]',
      safety_workflows_json TEXT DEFAULT '[]',
      suggested_draft_ar TEXT,
      suggested_draft_en TEXT,
      approved_draft_ar TEXT,
      approved_draft_en TEXT,
      draft_approval_status TEXT NOT NULL DEFAULT 'pending_review', -- pending_review | approved | edited | rejected
      supporting_upload_id TEXT,
      source TEXT NOT NULL DEFAULT 'user_entered',
      confirmation_state TEXT NOT NULL DEFAULT 'needs_confirmation',
      include_in_cv INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_training_profile ON training_entries(profile_id);

    -- 11. Modality Competency Matrix (Stage 5)
    CREATE TABLE IF NOT EXISTS modality_competencies (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      modality_code TEXT NOT NULL,
      modality_name_ar TEXT NOT NULL,
      modality_name_en TEXT NOT NULL,
      experience_category TEXT NOT NULL DEFAULT 'no_experience',
      -- independent_work | supervised_work | internship_exposure | observation_only | theoretical | no_experience
      duration_months INTEGER,
      duration_text TEXT,
      clinical_settings_json TEXT DEFAULT '[]',
      institutions_json TEXT DEFAULT '[]',
      examinations_json TEXT DEFAULT '[]',
      workflow_tasks_json TEXT DEFAULT '[]',
      equipment_models TEXT DEFAULT 'Not sure',
      contrast_scope TEXT DEFAULT 'none',
      confidence_level TEXT DEFAULT 'needs_confirmation', -- beginner | developing | competent_routine | experienced_complex | advanced | needs_confirmation
      justification_text TEXT,
      future_development_interest INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'user_entered',
      confirmation_state TEXT NOT NULL DEFAULT 'needs_confirmation',
      include_in_cv INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      UNIQUE(profile_id, modality_code)
    );
    CREATE INDEX IF NOT EXISTS idx_modalities_profile ON modality_competencies(profile_id);

    -- 12. Licenses, Registration, Professional Classification & CPD (Stage 8)
    CREATE TABLE IF NOT EXISTS license_entries (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      credential_type TEXT NOT NULL DEFAULT 'license', -- license | syndicate | classification | cpd | bls_acls | equivalency | verification
      name_ar TEXT NOT NULL,
      name_en TEXT NOT NULL,
      issuing_authority_ar TEXT,
      issuing_authority_en TEXT,
      country TEXT DEFAULT 'Egypt',
      printed_title_ar TEXT,
      printed_title_en TEXT,
      license_number_private TEXT,
      show_number_on_cv INTEGER NOT NULL DEFAULT 0,
      issue_date TEXT,
      expiry_date TEXT,
      no_expiry_or_unknown INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'needs_confirmation', -- active | expired | pending | under_renewal | not_started | in_progress | completed | not_applicable | needs_confirmation
      verification_url TEXT,
      supporting_upload_id TEXT,
      source TEXT NOT NULL DEFAULT 'user_entered',
      confirmation_state TEXT NOT NULL DEFAULT 'needs_confirmation',
      include_in_cv INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_licenses_profile ON license_entries(profile_id);

    -- 13. Achievements, Research, Teaching, Memberships (Stages 7 & 10)
    CREATE TABLE IF NOT EXISTS achievement_entries (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      stage_number INTEGER NOT NULL DEFAULT 7, -- 7 or 10
      category TEXT NOT NULL, -- image_quality | urgent_workflow | portable_icu | high_workload | radiation_safety | mentoring | troubleshooting | recognition | research | publication | teaching | membership | leadership | award
      title_ar TEXT NOT NULL,
      title_en TEXT NOT NULL,
      situation_text TEXT,
      action_text TEXT,
      result_text TEXT,
      evidence_text TEXT,
      measurement_type TEXT NOT NULL DEFAULT 'qualitative', -- exact | approximate | qualitative | unknown
      suggested_bullet_ar TEXT,
      suggested_bullet_en TEXT,
      approved_bullet_ar TEXT,
      approved_bullet_en TEXT,
      approval_status TEXT NOT NULL DEFAULT 'pending_review',
      include_in_cv INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_achievements_profile ON achievement_entries(profile_id);

    -- 14. References (Stage 12)
    CREATE TABLE IF NOT EXISTS reference_entries (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      title TEXT,
      institution TEXT,
      relationship TEXT,
      email_private TEXT,
      phone_private TEXT,
      language TEXT DEFAULT 'ar,en',
      permission_to_contact INTEGER NOT NULL DEFAULT 0,
      show_contact_on_cv INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 15. Uploaded Files (Stage 12 & Cross-Stage Evidence)
    CREATE TABLE IF NOT EXISTS uploaded_files (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      sanitized_name TEXT NOT NULL,
      storage_object_name TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL DEFAULT 'certificate', -- photo | certificate | license | employment_letter | training_certificate | job_description | existing_cv
      declared_mime TEXT NOT NULL,
      verified_mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width_px INTEGER,
      height_px INTEGER,
      quality_warning TEXT,
      scan_status TEXT NOT NULL DEFAULT 'scanner_not_configured', -- clean | scanner_not_configured | quarantined | rejected
      metadata_stripped INTEGER NOT NULL DEFAULT 1,
      include_in_cv_export INTEGER NOT NULL DEFAULT 0,
      extracted_draft_json TEXT,
      extracted_draft_status TEXT DEFAULT 'none', -- none | pending_review | accepted | rejected
      deleted_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_profile ON uploaded_files(profile_id);

    -- 16. Version History / Snapshots (Section 8)
    CREATE TABLE IF NOT EXISTS profile_versions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      stage_number INTEGER,
      change_summary TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      editor_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_versions_profile ON profile_versions(profile_id);

    -- 17. Exports & Document Jobs (Stage 13 & Section 9)
    CREATE TABLE IF NOT EXISTS export_jobs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      export_type TEXT NOT NULL, -- cv_pdf | draft_pdf | workbook_pdf | docx | json_backup | markdown_backup
      language TEXT NOT NULL DEFAULT 'en', -- ar | en | bilingual
      template_id TEXT NOT NULL DEFAULT 'modern-healthcare',
      filename TEXT NOT NULL,
      storage_path TEXT,
      size_bytes INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed', -- pending | processing | completed | failed
      error_code TEXT,
      error_message TEXT,
      validation_report_json TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exports_profile ON export_jobs(profile_id);

    -- 18. Secure Expiring Share Links (Stage 13 & Section 9)
    CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      allow_download INTEGER NOT NULL DEFAULT 1,
      password_hash TEXT,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      access_log_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);

    -- 19. Collaborators & Access Grants (Section 4 & 11)
    CREATE TABLE IF NOT EXISTS access_grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grantee_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      grantee_email TEXT,
      grantee_role TEXT NOT NULL DEFAULT 'collaborator', -- collaborator | admin_support
      permission_scope TEXT NOT NULL DEFAULT 'view', -- view | edit | view_with_history
      consent_version TEXT NOT NULL DEFAULT 'v1.0',
      granted_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_grants_profile ON access_grants(profile_id);

    -- 20. Consent Records (Section 12)
    CREATE TABLE IF NOT EXISTS consent_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT,
      purpose TEXT NOT NULL, -- terms_privacy | admin_profile_share | admin_history_share | cookie_preferences | document_send
      status TEXT NOT NULL, -- granted | revoked
      consent_version TEXT NOT NULL DEFAULT 'v1.0',
      scope_details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_consents_user ON consent_records(user_id);

    -- 21. Activity & Audit Events (Section 8 & 11)
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      actor_role TEXT,
      target_user_id TEXT,
      target_profile_id TEXT,
      event_type TEXT NOT NULL,
      stage_or_feature TEXT,
      summary_redacted TEXT NOT NULL,
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_profile ON audit_events(target_profile_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);

    -- 22. Support Tickets & Problem Reports (Section 11)
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      profile_id TEXT,
      category TEXT NOT NULL DEFAULT 'general', -- save_sync | pdf_export | upload | profile_data | security | general
      subject TEXT NOT NULL,
      description_redacted TEXT NOT NULL,
      diagnostic_payload_json TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'New', -- New | In review | Waiting for user | Resolved
      admin_response TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 23. Error Monitoring Logs (Redacted, Rate-Limited) (Section 11)
    CREATE TABLE IF NOT EXISTS error_logs (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      error_type TEXT NOT NULL,
      affected_feature TEXT NOT NULL,
      app_version TEXT NOT NULL DEFAULT '1.0.0',
      redacted_message TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    -- 24. Admin Notifications Log (Section 11)
    CREATE TABLE IF NOT EXISTS notification_logs (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      channel TEXT NOT NULL, -- dashboard | email | whatsapp
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      delivery_status TEXT NOT NULL, -- delivered_dashboard | not_configured | failed | sent
      retry_count INTEGER NOT NULL DEFAULT 0,
      failure_reason_redacted TEXT,
      created_at TEXT NOT NULL
    );

    -- 25. Platform Configuration (Configurable Site Title, Support Phone Visibility, Quotas)
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();
  const migStmt = db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  migStmt.run('001_initial_normalized_schema', now);

  // Ensure default platform settings exist
  const defaults = {
    site_title_en: process.env.NEXT_PUBLIC_APP_NAME || 'Radiology CV Studio',
    site_title_ar: 'استوديو السيرة الذاتية للأشعة والتصوير الطبي',
    creator_name: process.env.ADMIN_CONTACT_NAME || 'Abd-el-Rahman Adel Teba',
    support_email: process.env.ADMIN_CONTACT_EMAIL || 'frp.nasr@gmail.com',
    support_phone: process.env.ADMIN_CONTACT_PHONE || '01091874291',
    phone_visibility: process.env.ADMIN_PHONE_PUBLIC_VISIBILITY || 'everyone', // 'everyone' | 'registered_only'
    whatsapp_enabled: process.env.ADMIN_WHATSAPP_ENABLED === 'true',
    whatsapp_e164: '201091874291',
    max_image_mb: Number(process.env.MAX_IMAGE_MB || 10),
    max_document_mb: Number(process.env.MAX_DOCUMENT_MB || 20),
    max_profile_upload_mb: Number(process.env.MAX_PROFILE_UPLOAD_MB || 100),
    share_link_default_expiry_hours: Number(process.env.SHARE_LINK_DEFAULT_EXPIRY_HOURS || 24),
  };

  const settingStmt = db.prepare('INSERT OR IGNORE INTO platform_settings (key, value_json, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(defaults)) {
    settingStmt.run(k, JSON.stringify(v), now);
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const computed = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
}

function redactPII(input) {
  if (!input) return '';
  let str = typeof input === 'string' ? input : JSON.stringify(input);
  // Redact emails
  str = str.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');
  // Redact phone numbers (8-15 digits)
  str = str.replace(/\b\+?\d{8,15}\b/g, '[REDACTED_PHONE]');
  // Redact bearer/session tokens
  str = str.replace(/(bearer|token|password|secret|cookie)["'\s:=]+[^\s"',}]+/gi, '$1:[REDACTED_SECRET]');
  return str;
}

module.exports = {
  getDb,
  resetDbConnection,
  runMigrations,
  hashPassword,
  verifyPassword,
  redactPII,
  DEFAULT_DB_PATH,
};
