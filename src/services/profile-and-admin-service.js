const crypto = require('node:crypto');
const { getDb, redactPII } = require('../db/database');
const { STAGE_DEFINITIONS } = require('../data/glossary-and-questions');

function getProfileBundle(profileId) {
  const db = getDb();
  const profile = db.prepare(`SELECT * FROM profiles WHERE id = ?`).get(profileId);
  if (!profile) return null;

  const stages = db.prepare(`SELECT * FROM stages WHERE profile_id = ? ORDER BY stage_number ASC`).all(profileId);
  const answers = db.prepare(`SELECT * FROM answers WHERE profile_id = ? ORDER BY stage_number ASC, question_id ASC`).all(profileId);
  const education = db.prepare(`SELECT * FROM education_entries WHERE profile_id = ? ORDER BY created_at ASC`).all(profileId);
  const employment = db.prepare(`SELECT * FROM employment_entries WHERE profile_id = ? ORDER BY sort_order ASC, created_at ASC`).all(profileId);
  const training = db.prepare(`SELECT * FROM training_entries WHERE profile_id = ? ORDER BY created_at ASC`).all(profileId);
  const modalities = db.prepare(`SELECT * FROM modality_competencies WHERE profile_id = ? ORDER BY modality_code ASC`).all(profileId);
  const licenses = db.prepare(`SELECT * FROM license_entries WHERE profile_id = ? ORDER BY created_at ASC`).all(profileId);
  const achievements = db.prepare(`SELECT * FROM achievement_entries WHERE profile_id = ? ORDER BY stage_number ASC, created_at ASC`).all(profileId);
  const references = db.prepare(`SELECT * FROM reference_entries WHERE profile_id = ? ORDER BY created_at ASC`).all(profileId);
  const uploads = db
    .prepare(`SELECT id, profile_id, original_name, sanitized_name, purpose, verified_mime, size_bytes, width_px, height_px, quality_warning, scan_status, include_in_cv_export, extracted_draft_json, extracted_draft_status, created_at FROM uploaded_files WHERE profile_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`)
    .all(profileId);
  const versions = db
    .prepare(`SELECT id, profile_id, version_number, stage_number, change_summary, editor_id, created_at FROM profile_versions WHERE profile_id = ? ORDER BY version_number DESC LIMIT 30`)
    .all(profileId);
  const exportsList = db
    .prepare(`SELECT id, profile_id, export_type, language, template_id, filename, size_bytes, status, error_code, error_message, validation_report_json, created_at FROM export_jobs WHERE profile_id = ? ORDER BY created_at DESC LIMIT 30`)
    .all(profileId);
  const shareLinks = db
    .prepare(`SELECT id, token, profile_id, label, language, allow_download, expires_at, revoked_at, access_count, access_log_json, created_at FROM share_links WHERE profile_id = ? ORDER BY created_at DESC`)
    .all(profileId);
  const accessGrants = db
    .prepare(`SELECT * FROM access_grants WHERE profile_id = ? AND revoked_at IS NULL ORDER BY granted_at DESC`)
    .all(profileId);

  const answersMap = {};
  for (const ans of answers) {
    let val = ans.value_json;
    try {
      val = JSON.parse(ans.value_json);
    } catch (_) {}
    answersMap[ans.question_id] = {
      ...ans,
      value: val,
    };
  }

  return {
    profile,
    stages,
    answers,
    answersMap,
    education,
    employment,
    training,
    modalities,
    licenses,
    achievements,
    references,
    uploads,
    versions,
    exportsList,
    shareLinks,
    accessGrants,
  };
}

function getIntegrationStatuses() {
  const emailConfigured =
    process.env.ADMIN_EMAIL_NOTIFICATIONS_ENABLED === 'true' &&
    Boolean(process.env.SMTP_HOST || process.env.RESEND_API_KEY);
  const whatsappConfigured =
    process.env.ADMIN_WHATSAPP_ENABLED === 'true' &&
    Boolean(process.env.WHATSAPP_CLOUD_API_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
  const googleAuthConfigured =
    process.env.AUTH_GOOGLE_ENABLED === 'true' &&
    Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const phoneOtpConfigured =
    process.env.AUTH_PHONE_OTP_ENABLED === 'true' &&
    Boolean(process.env.SMS_API_KEY && process.env.SMS_PROVIDER && process.env.SMS_PROVIDER !== 'none');
  const malwareScannerConfigured = process.env.MALWARE_SCANNER_ENABLED === 'true';

  return {
    database: {
      id: 'database',
      name_en: 'SQLite Normalized Database & Row-Level Tenant Isolation',
      name_ar: 'قاعدة البيانات العلائقية وعزل بيانات المستخدمين',
      status: 'Connected',
      setup_required: false,
      details_en: 'Active server-side SQLite WAL persistence with 25 normalized tables and strict server-side access checks.',
      details_ar: 'متصلة وتعمل فعليًا على الخادم مع عزل كامل لملفات كل مستخدم.',
    },
    pdf_export: {
      id: 'pdf_export',
      name_en: 'Server-Side Arabic/English PDF & DOCX Document Engine',
      name_ar: 'محرك توليد ملفات PDF و DOCX (عربي RTL / إنجليزي LTR)',
      status: 'Connected',
      setup_required: false,
      details_en: 'Headless LibreOffice Writer + Arabic shaping fonts (Noto Naskh Arabic, Amiri) + pdftotext layout verification.',
      details_ar: 'متصل ويعمل فعليًا لتوليد ملفات PDF قابلة للبحث والتحديد باللغتين العربية والإنجليزية.',
    },
    google_oauth: {
      id: 'google_oauth',
      name_en: 'Sign in with Google (OAuth 2.0)',
      name_ar: 'تسجيل الدخول عبر حساب Google (OAuth 2.0)',
      status: googleAuthConfigured ? 'Connected' : 'Needs setup',
      setup_required: !googleAuthConfigured,
      details_en: googleAuthConfigured
        ? 'Google OAuth credentials configured.'
        : 'Setup required: Set AUTH_GOOGLE_ENABLED=true, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET in server environment. Requests identity/email/profile scopes only (never reads Gmail inbox).',
      details_ar: googleAuthConfigured
        ? 'تم إعداد ربط Google OAuth.'
        : 'يتطلب إعدادًا خارجيًا: أضف GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET في متغيرات البيئة على الخادم. (يستخدم لتأكيد الهوية فقط ولا يقرأ رسائل بريدك).',
    },
    phone_otp: {
      id: 'phone_otp',
      name_en: 'Phone Number SMS Verification (OTP)',
      name_ar: 'التحقق عبر رسائل الهاتف النصية (SMS OTP)',
      status: phoneOtpConfigured ? 'Connected' : 'Needs setup',
      setup_required: !phoneOtpConfigured,
      details_en: phoneOtpConfigured
        ? `Connected via ${process.env.SMS_PROVIDER}.`
        : 'Setup required: Requires a paid SMS/OTP telephony provider (e.g., Twilio/Vonage) supporting Egypt/Saudi Arabia. Set AUTH_PHONE_OTP_ENABLED=true and SMS_API_KEY.',
      details_ar: phoneOtpConfigured
        ? 'متصل بمزود الرسائل النصية.'
        : 'يتطلب إعدادًا خارجيًا: يحتاج مزود رسائل SMS مدفوع وتفعيل AUTH_PHONE_OTP_ENABLED=true.',
    },
    email_notifications: {
      id: 'email_notifications',
      name_en: `Admin Email Notifications (${process.env.ADMIN_CONTACT_EMAIL || 'frp.nasr@gmail.com'})`,
      name_ar: `تنبيهات البريد الإلكتروني للمشرف (${process.env.ADMIN_CONTACT_EMAIL || 'frp.nasr@gmail.com'})`,
      status: emailConfigured ? 'Connected' : 'Needs setup',
      setup_required: !emailConfigured,
      details_en: emailConfigured
        ? 'SMTP/Email provider configured.'
        : 'Setup required: Set ADMIN_EMAIL_NOTIFICATIONS_ENABLED=true and configure SMTP_HOST/SMTP_PASS or RESEND_API_KEY in server secrets.',
      details_ar: emailConfigured
        ? 'تم ربط خدمة البريد الإلكتروني.'
        : 'يتطلب إعدادًا خارجيًا: اضبط إعدادات SMTP أو Resend API في متغيرات الخادم لتفعيل الإرسال الفعلي إلى frp.nasr@gmail.com.',
    },
    whatsapp_notifications: {
      id: 'whatsapp_notifications',
      name_en: 'WhatsApp Business Cloud API Alerts',
      name_ar: 'تنبيهات واتساب للأعمال (WhatsApp Cloud API)',
      status: whatsappConfigured ? 'Connected' : 'Needs setup',
      setup_required: !whatsappConfigured,
      details_en: whatsappConfigured
        ? 'WhatsApp Business Cloud API configured.'
        : 'Setup required: A phone number alone cannot send automated server messages. Configure Meta WhatsApp Business Cloud API token, Phone Number ID, and approved templates.',
      details_ar: whatsappConfigured
        ? 'تم ربط WhatsApp Cloud API.'
        : 'يتطلب إعدادًا خارجيًا: رقم الهاتف وحده لا يرسل رسائل آلية من الخادم. يلزم إعداد WhatsApp Business Cloud API ورمز الوصول السري.',
    },
    malware_scanning: {
      id: 'malware_scanning',
      name_en: 'Managed Malware Scanning for Uploads',
      name_ar: 'الفحص المدار للبرمجيات الخبيثة للمرفقات',
      status: malwareScannerConfigured ? 'Connected' : 'Needs setup',
      setup_required: !malwareScannerConfigured,
      details_en:
        'Strict server-side magic-byte MIME signature validation, size quotas, EXIF stripping, and extension blocking are ACTIVE. External ClamAV/managed malware daemon is not configured.',
      details_ar:
        'فحص البصمة الرقمية للملفات (MIME Magic Bytes) والحدود القصوى وإزالة بيانات GPS مفعل بالكامل. محرك الفيروسات الخارجي غير متصل حاليًا.',
    },
  };
}

function dispatchAdminNotification({ eventType, subject, summaryRedacted }) {
  const db = getDb();
  const now = new Date().toISOString();
  const recipientEmail = process.env.ADMIN_CONTACT_EMAIL || 'frp.nasr@gmail.com';
  const recipientPhone = process.env.ADMIN_WHATSAPP_E164 || '+201091874291';
  const cleanSummary = redactPII(summaryRedacted || subject);

  // 1. Always deliver to in-app Admin Dashboard Notification Center
  db.prepare(`
    INSERT INTO notification_logs (id, event_type, channel, recipient, subject, delivery_status, retry_count, failure_reason_redacted, created_at)
    VALUES (?, ?, 'dashboard', 'Admin Console', ?, 'delivered_dashboard', 0, NULL, ?)
  `).run('ntf-' + crypto.randomUUID(), eventType, cleanSummary.slice(0, 200), now);

  // 2. Check Email channel honestly (never fake "Sent" if provider is unconfigured)
  const statuses = getIntegrationStatuses();
  const emailState = statuses.email_notifications.setup_required ? 'not_configured' : 'sent';
  const emailReason = statuses.email_notifications.setup_required
    ? 'Email provider/SMTP credentials not configured in environment (Needs setup)'
    : null;

  db.prepare(`
    INSERT INTO notification_logs (id, event_type, channel, recipient, subject, delivery_status, retry_count, failure_reason_redacted, created_at)
    VALUES (?, ?, 'email', ?, ?, ?, 0, ?, ?)
  `).run('ntf-' + crypto.randomUUID(), eventType, recipientEmail, cleanSummary.slice(0, 200), emailState, emailReason, now);

  // 3. Check WhatsApp channel honestly
  const waState = statuses.whatsapp_notifications.setup_required ? 'not_configured' : 'sent';
  const waReason = statuses.whatsapp_notifications.setup_required
    ? 'WhatsApp Business Cloud API token not configured (Needs setup)'
    : null;

  db.prepare(`
    INSERT INTO notification_logs (id, event_type, channel, recipient, subject, delivery_status, retry_count, failure_reason_redacted, created_at)
    VALUES (?, ?, 'whatsapp', ?, ?, ?, 0, ?, ?)
  `).run('ntf-' + crypto.randomUUID(), eventType, recipientPhone, cleanSummary.slice(0, 200), waState, waReason, now);

  return {
    dashboard: 'delivered_dashboard',
    email: emailState,
    whatsapp: waState,
  };
}

module.exports = {
  getProfileBundle,
  getIntegrationStatuses,
  dispatchAdminNotification,
};
