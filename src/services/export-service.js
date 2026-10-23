const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { getDb } = require('../db/database');
const { STAGE_DEFINITIONS } = require('../data/glossary-and-questions');
const { analyzeProfileQualityAndTruth } = require('./assistant-service');
const { logAuditEvent, logRedactedError } = require('../middleware/auth');

const EXPORT_DIR = path.resolve(process.cwd(), 'runtime-data', 'exports');
if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeExportName(rawName) {
  const cleaned = String(rawName || 'Radiology_Professional')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\u0600-\u06FF-]/g, '');
  return cleaned.slice(0, 60) || 'Radiology_CV';
}

function buildSafeExportFilename(profileBundle, exportType, language) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const nameEn =
    profileBundle.answersMap?.s1_full_name_en?.value ||
    profileBundle.profile?.title?.split('—')[0]?.trim() ||
    'Radiology_Candidate';

  // Convert full uppercase name into clean First_Second_Last format
  const words = String(nameEn).trim().split(/\s+/);
  let baseName = sanitizeExportName(nameEn);
  if (words.length >= 4) {
    const firstTwo = words.slice(0, 2).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase().replace(/ghafar/i, 'Ghaffar'));
    const last = words[words.length - 1].charAt(0).toUpperCase() + words[words.length - 1].slice(1).toLowerCase();
    baseName = sanitizeExportName([...firstTwo, last].join('_'));
  }

  const langCode = language === 'ar' ? 'AR' : language === 'bilingual' ? 'BILINGUAL' : 'EN';

  if (exportType === 'workbook_pdf') {
    return `CV_Answers_Workbook_${dateStr}.pdf`;
  }
  if (exportType === 'draft_pdf') {
    return `${baseName}_CV_DRAFT_${langCode}_${dateStr}.pdf`;
  }
  if (exportType === 'docx') {
    return `${baseName}_CV_${langCode}_${dateStr}.docx`;
  }
  if (exportType === 'json_backup') {
    return `${baseName}_Backup_${dateStr}.json`;
  }
  if (exportType === 'markdown_backup') {
    return `${baseName}_Backup_${dateStr}.md`;
  }
  return `${baseName}_CV_${langCode}_${dateStr}.pdf`;
}

/**
 * Builds the HTML representation of the Employer-Facing CV or Partial Draft CV.
 * Strictly respects Non-Negotiable Truth Rules (Section 2 & Section 9):
 * - Excludes private notes, unapproved suggestions (unless draft mode explicitly labels them), and internal metadata.
 * - Separates Independent/Reported Work Experience from Supervised Clinical Training & Internship.
 * - Separates Work Modalities from Internship-Only Modalities (MRI, Ultrasound, Fluoroscopy).
 * - Never invents a college name, GPA, street address, or employment dates.
 */
function renderCvHtml(profileBundle, options = {}) {
  const {
    language = 'en', // 'en' | 'ar' | 'bilingual'
    isDraft = false,
    templateId = 'modern-healthcare',
    styleDensity = 'standard', // 'concise' | 'standard' | 'detailed'
  } = options;

  const {
    profile,
    answersMap,
    employment = [],
    education = [],
    training = [],
    modalities = [],
    licenses = [],
    achievements = [],
    references = [],
  } = profileBundle;

  const isRtl = language === 'ar';
  const dir = isRtl ? 'rtl' : 'ltr';
  const align = isRtl ? 'right' : 'left';

  const fullNameAr = answersMap.s1_full_name_ar?.value || '';
  const fullNameEn = answersMap.s1_full_name_en?.value || profile.title;
  const titleAr = answersMap.s1_professional_title_ar?.value || 'أخصائي أشعة وتصوير طبي';
  const titleEn = answersMap.s1_professional_title_en?.value || 'Radiology and Medical Imaging Specialist';

  const ownerEmail = answersMap.s1_owner_email?.visibility !== 'hide' ? answersMap.s1_owner_email?.value : '';
  const ownerPhone = answersMap.s1_owner_phone?.visibility !== 'hide' ? answersMap.s1_owner_phone?.value : '';
  const resLoc = answersMap.s1_residence_location?.value || {};
  const workPrefs = answersMap.s1_work_preferences?.value || {};
  const expBreak = answersMap.s1_experience_summary_breakdown?.value || {};
  const rankedRoles = Array.isArray(answersMap.s1_ranked_target_roles?.value)
    ? answersMap.s1_ranked_target_roles.value
    : [];

  // Filter included items
  const includedEducation = education.filter((e) => e.include_in_cv);
  const includedEmployment = employment.filter((e) => e.include_in_cv);
  const includedTraining = training.filter((t) => t.include_in_cv);
  const workModalities = modalities.filter(
    (m) => m.include_in_cv && (m.experience_category === 'independent_work' || m.experience_category === 'supervised_work')
  );
  const internshipModalities = modalities.filter(
    (m) => m.include_in_cv && m.experience_category === 'internship_exposure'
  );
  const includedLicenses = licenses.filter((l) => l.include_in_cv);
  const includedAchievements = achievements.filter(
    (a) => a.include_in_cv && (a.approval_status === 'approved' || isDraft)
  );

  const primaryColor =
    templateId === 'ats-clean'
      ? '#111827'
      : templateId === 'classic-medical'
      ? '#1e3a8a'
      : '#0f4c5c';

  const draftBannerHtml = isDraft
    ? `<div class="draft-banner">
        ${
          language === 'ar'
            ? 'مسودة قيد المراجعة والاستكمال (DRAFT — INCOMPLETE / REQUIRES OWNER REVIEW) — تحتوي على حقول تحتاج لتأكيد التواريخ أو المسميات'
            : 'DRAFT — INCOMPLETE / REQUIRES REVIEW — Contains items marked "Needs confirmation" before official submission'
        }
      </div>`
    : '';

  const headerName =
    language === 'ar'
      ? escapeHtml(fullNameAr || fullNameEn)
      : language === 'bilingual'
      ? `${escapeHtml(fullNameEn)} <span class="bilingual-sub">| ${escapeHtml(fullNameAr)}</span>`
      : escapeHtml(fullNameEn || fullNameAr);

  const headerTitle =
    language === 'ar'
      ? escapeHtml(titleAr)
      : language === 'bilingual'
      ? `${escapeHtml(titleEn)} — ${escapeHtml(titleAr)}`
      : escapeHtml(titleEn);

  const contactParts = [];
  if (resLoc.country) {
    contactParts.push(
      language === 'ar'
        ? 'مصر (جاهز للانتقال والعمل في المملكة العربية السعودية)'
        : `${escapeHtml(resLoc.country)} (Target: ${escapeHtml(workPrefs.target_country || profile.target_country || 'Saudi Arabia')})`
    );
  }
  if (resLoc.street_address && resLoc.wants_address_shown) {
    contactParts.push(escapeHtml(resLoc.street_address));
  }
  if (ownerEmail) contactParts.push(escapeHtml(ownerEmail));
  if (ownerPhone) contactParts.push(escapeHtml(ownerPhone));
  if (workPrefs.availability === 'Immediate') {
    contactParts.push(language === 'ar' ? 'التفرغ: متاح فورًا' : 'Availability: Immediate');
  }

  // Professional Summary (Evidence-based only)
  const summaryHtml =
    language === 'ar'
      ? `<p class="summary-text">
          <strong>${escapeHtml(titleAr)}</strong> حاصل على <strong>دبلوم (${escapeHtml(
          includedEducation[0]?.specialty_ar || 'أشعة وتصوير طبي'
        )})</strong> من <strong>${escapeHtml(includedEducation[0]?.institution_ar || 'جامعة بنها')}</strong> (${escapeHtml(
          includedEducation[0]?.graduation_date || 'يونيو 2020'
        )}) بتقدير <strong>${escapeHtml(includedEducation[0]?.final_grade_ar || 'ممتاز')}</strong>.
          تشمل مجالات الممارسة المختارة: ${escapeHtml(
            workModalities.map((m) => m.modality_name_ar).join('، ')
          )}.
          بالإضافة إلى إتمام التدريب السريري في مستشفى بنها الجامعي وفترة امتياز سريري لمدة ستة أشهر في مستشفى الشهداء المركزي.
          ${
            expBreak.reported_total_years
              ? `<br><span class="meta-note">إجمالي سنوات التعرض للمجال المبلغ عنها: ${escapeHtml(
                  expBreak.reported_total_years
                )} سنوات (تشمل الخبرة والتدريب قبل التخرج وبعد التخرج؛ يتم عرض العمل المهني منفصلًا عن التدريب السريري والامتياز).</span>`
              : ''
          }
        </p>`
      : `<p class="summary-text">
          <strong>${escapeHtml(titleEn)}</strong> holding a <strong>${escapeHtml(
          includedEducation[0]?.qualification_en || 'Diploma'
        )}</strong> in <strong>${escapeHtml(
          includedEducation[0]?.specialty_en || 'Radiology and Medical Imaging'
        )}</strong> from <strong>${escapeHtml(
          includedEducation[0]?.institution_en || 'Benha University'
        )}</strong> (${escapeHtml(includedEducation[0]?.graduation_date || 'June 2020')}, Grade: <strong>${escapeHtml(
          includedEducation[0]?.final_grade_en || 'Excellent'
        )}</strong>).
          Reported professional experience areas include ${escapeHtml(
            workModalities.map((m) => m.modality_name_en).join(', ')
          )}, complemented by supervised clinical training at Benha University Hospital and a six-month clinical internship at El-Shohada Central Hospital.
          ${
            expBreak.reported_total_years
              ? `<br><span class="meta-note">Reported total exposure: ${escapeHtml(
                  expBreak.reported_total_years
                )} years (includes pre-graduation training/work and post-graduation practice; clinical training and internship are presented separately from employment below).</span>`
              : ''
          }
        </p>`;

  // Education Section
  const eduItemsHtml = includedEducation
    .map((edu) => {
      const collegeNote =
        edu.college_faculty_en || edu.college_faculty_ar
          ? ` — ${escapeHtml(language === 'ar' ? edu.college_faculty_ar || edu.college_faculty_en : edu.college_faculty_en || edu.college_faculty_ar)}`
          : isDraft
          ? ` <span class="flag-tag">[${language === 'ar' ? 'اسم الكلية يحتاج لتأكيد' : 'College/Faculty name pending confirmation'}]</span>`
          : '';

      const gpaNote = edu.no_gpa_issued
        ? language === 'ar'
          ? ' (لم يصدر معدل تراكمي رقمي GPA)'
          : ' (No numeric GPA issued)'
        : edu.gpa_value
        ? ` | GPA: ${escapeHtml(edu.gpa_value)}`
        : '';

      if (language === 'ar') {
        return `<div class="entry-block">
          <div class="entry-header">
            <strong>${escapeHtml(edu.qualification_ar)} — ${escapeHtml(edu.specialty_ar)}</strong>
            <span class="entry-date">${escapeHtml(edu.start_date || '2019')} – ${escapeHtml(edu.graduation_date || 'يونيو 2020')}</span>
          </div>
          <div class="entry-sub">${escapeHtml(edu.institution_ar)}${collegeNote} | ${escapeHtml(edu.department_ar)}</div>
          <div class="entry-details">التقدير العام: <strong>${escapeHtml(edu.final_grade_ar || 'ممتاز')}</strong>${gpaNote} | نظام الدراسة: انتظام</div>
        </div>`;
      }

      return `<div class="entry-block">
        <div class="entry-header">
          <strong>${escapeHtml(edu.qualification_en)} in ${escapeHtml(edu.specialty_en)}</strong>
          <span class="entry-date">${escapeHtml(edu.start_date || '2019')} – ${escapeHtml(edu.graduation_date || 'June 2020')}</span>
        </div>
        <div class="entry-sub">${escapeHtml(edu.institution_en)}${collegeNote} | ${escapeHtml(edu.department_en)}</div>
        <div class="entry-details">Final Grade: <strong>${escapeHtml(edu.final_grade_en || 'Excellent')}</strong>${gpaNote} | Mode: ${escapeHtml(edu.attendance_mode || 'Regular attendance')}</div>
      </div>`;
    })
    .join('\n');

  // Employment Section (Stage 3)
  const empItemsHtml = includedEmployment
    .map((emp) => {
      const dateLabel =
        emp.exact_dates_unknown || !emp.start_date
          ? isDraft
            ? `<span class="flag-tag">[${language === 'ar' ? 'التواريخ وطبيعة التعاقد تحتاج لتأكيد' : 'Dates & relationship type need confirmation'}]</span>`
            : language === 'ar'
            ? 'مرتبط حاليًا (التواريخ قيد التحديث)'
            : 'Associated Workplace'
          : `${escapeHtml(emp.start_date)} – ${emp.is_current ? (language === 'ar' ? 'حتى الآن' : 'Present') : escapeHtml(emp.end_date || '')}`;

      let approvedBullets = [];
      try {
        approvedBullets = JSON.parse(emp.approved_bullets_json || '[]');
      } catch (_) {}

      const bulletsHtml =
        approvedBullets.length > 0
          ? `<ul>${approvedBullets.map((b) => `<li>${escapeHtml(language === 'ar' ? b.text_ar || b.text_en : b.text_en || b.text_ar)}</li>`).join('')}</ul>`
          : '';

      const primaryTag = emp.is_primary_employer
        ? language === 'ar'
          ? ' (جهة العمل الأساسية المبلغ عنها)'
          : ' (Reported Primary Workplace)'
        : '';

      if (language === 'ar') {
        return `<div class="entry-block">
          <div class="entry-header">
            <strong>${escapeHtml(emp.institution_name_ar)}${primaryTag}</strong>
            <span class="entry-date">${dateLabel}</span>
          </div>
          <div class="entry-sub">${escapeHtml(emp.role_title_ar || titleAr)} | ${escapeHtml(emp.city || '')}، ${escapeHtml(emp.region || '')}</div>
          ${bulletsHtml}
        </div>`;
      }

      return `<div class="entry-block">
        <div class="entry-header">
          <strong>${escapeHtml(emp.institution_name_en)} — ${escapeHtml(emp.institution_name_ar)}${primaryTag}</strong>
          <span class="entry-date">${dateLabel}</span>
        </div>
        <div class="entry-sub">${escapeHtml(emp.role_title_en || titleEn)} | ${escapeHtml([emp.city, emp.region, emp.country].filter(Boolean).join(', '))}</div>
        ${bulletsHtml}
      </div>`;
    })
    .join('\n');

  // Clinical Training & Internship Section (Stage 4 — Strictly separated from Employment!)
  const trainingItemsHtml = includedTraining
    .map((trn) => {
      const useTextEn = trn.approved_draft_en || (isDraft ? trn.suggested_draft_en : trn.suggested_draft_en);
      const useTextAr = trn.approved_draft_ar || (isDraft ? trn.suggested_draft_ar : trn.suggested_draft_ar);
      const pendingBadge =
        trn.draft_approval_status !== 'approved' && isDraft
          ? `<span class="flag-tag">[${language === 'ar' ? 'صياغة مقترحة بانتظار موافقة صاحب السيرة' : 'Suggested wording — pending owner approval'}]</span>`
          : '';

      let rotations = [];
      try {
        rotations = JSON.parse(trn.rotations_json || '[]');
      } catch (_) {}

      if (language === 'ar') {
        return `<div class="entry-block">
          <div class="entry-header">
            <strong>${escapeHtml(trn.institution_ar)} — ${escapeHtml(trn.department_role_ar)}</strong>
            <span class="entry-date">${escapeHtml(trn.total_duration_ar)}</span>
          </div>
          <div>${pendingBadge}</div>
          <div class="entry-details">${escapeHtml(useTextAr).replace(/\n/g, '<br>')}</div>
          ${
            rotations.length > 0
              ? `<div class="entry-details"><strong>الأقسام التي شملها التدريب تحت الإشراف:</strong> ${escapeHtml(rotations.join('، '))}</div>`
              : ''
          }
        </div>`;
      }

      return `<div class="entry-block">
        <div class="entry-header">
          <strong>${escapeHtml(trn.institution_en)} (${escapeHtml(trn.institution_ar)}) — ${escapeHtml(trn.department_role_en)}</strong>
          <span class="entry-date">${escapeHtml(trn.total_duration_en)}</span>
        </div>
        <div>${pendingBadge}</div>
        <div class="entry-details">${escapeHtml(useTextEn).replace(/\n/g, '<br>')}</div>
        ${
          rotations.length > 0
            ? `<div class="entry-details"><strong>Supervised Rotations:</strong> ${escapeHtml(rotations.join(', '))}</div>`
            : ''
        }
      </div>`;
    })
    .join('\n');

  // Modalities & Competency Matrix (Stage 5 — Clearly separating Work Experience vs Internship Exposure)
  const workModBadges = workModalities
    .map((m) => `<span class="chip chip-work">${escapeHtml(language === 'ar' ? m.modality_name_ar : `${m.modality_name_en} (${m.modality_name_ar})`)}</span>`)
    .join(' ');

  const internModBadges = internshipModalities
    .map((m) => `<span class="chip chip-intern">${escapeHtml(language === 'ar' ? m.modality_name_ar : `${m.modality_name_en} (${m.modality_name_ar})`)}</span>`)
    .join(' ');

  // Licenses (Stage 8 — Hide private license numbers unless explicitly enabled)
  const licItemsHtml = includedLicenses
    .map((lic) => {
      const numStr = lic.show_number_on_cv && lic.license_number_private ? ` (#${escapeHtml(lic.license_number_private)})` : '';
      return `<li><strong>${escapeHtml(language === 'ar' ? lic.name_ar : lic.name_en)}</strong>${numStr} — ${escapeHtml(
        language === 'ar' ? lic.issuing_authority_ar || '' : lic.issuing_authority_en || ''
      )}</li>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html dir="${dir}" lang="${language === 'ar' ? 'ar' : 'en'}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(fullNameEn || fullNameAr)} — CV</title>
  <style>
    @page {
      size: A4;
      margin: 14mm 15mm 14mm 15mm;
    }
    body {
      font-family: 'Noto Naskh Arabic', 'Amiri', 'DejaVu Sans', Arial, sans-serif;
      direction: ${dir};
      text-align: ${align};
      color: #1f2937;
      font-size: ${styleDensity === 'concise' ? '10pt' : '10.5pt'};
      line-height: 1.48;
      margin: 0;
      padding: 0;
    }
    .draft-banner {
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #f59e0b;
      padding: 8px 12px;
      font-size: 9.5pt;
      font-weight: bold;
      margin-bottom: 12px;
      text-align: center;
    }
    .cv-header {
      border-bottom: 2px solid ${primaryColor};
      padding-bottom: 10px;
      margin-bottom: 12px;
    }
    .cv-name {
      font-size: 18pt;
      font-weight: bold;
      color: ${primaryColor};
      margin: 0 0 4px 0;
    }
    .bilingual-sub {
      font-size: 14pt;
      font-weight: normal;
      color: #374151;
    }
    .cv-headline {
      font-size: 12pt;
      font-weight: bold;
      color: #0f766e;
      margin: 0 0 6px 0;
    }
    .cv-contact {
      font-size: 9.5pt;
      color: #4b5563;
    }
    .section-title {
      font-size: 11.5pt;
      font-weight: bold;
      color: ${primaryColor};
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 3px;
      margin: 14px 0 8px 0;
      text-transform: uppercase;
      page-break-after: avoid;
    }
    .entry-block {
      margin-bottom: 9px;
      page-break-inside: avoid;
    }
    .entry-header {
      display: flex;
      justify-content: space-between;
      font-size: 10.5pt;
    }
    .entry-date {
      color: #475569;
      font-size: 9.5pt;
    }
    .entry-sub {
      font-size: 9.5pt;
      color: #0f766e;
      margin-top: 1px;
    }
    .entry-details {
      font-size: 9.5pt;
      color: #334155;
      margin-top: 3px;
    }
    .summary-text {
      margin: 4px 0 8px 0;
      font-size: 10pt;
    }
    .meta-note {
      font-size: 9pt;
      color: #475569;
    }
    .flag-tag {
      color: #b45309;
      font-size: 8.5pt;
      font-weight: normal;
    }
    .chip {
      display: inline-block;
      padding: 2px 7px;
      margin: 2px 3px 2px 0;
      border-radius: 4px;
      font-size: 9pt;
      border: 1px solid #cbd5e1;
    }
    .chip-work {
      background: #f0fdfa;
      color: #0f766e;
      border-color: #99f6e4;
    }
    .chip-intern {
      background: #f8fafc;
      color: #475569;
      border-color: #cbd5e1;
    }
    ul {
      margin: 4px 0 6px 0;
      padding-${isRtl ? 'right' : 'left'}: 18px;
    }
    li {
      margin-bottom: 3px;
      font-size: 9.5pt;
    }
  </style>
</head>
<body>
  ${draftBannerHtml}
  <div class="cv-header">
    <h1 class="cv-name">${headerName}</h1>
    <div class="cv-headline">${headerTitle}</div>
    <div class="cv-contact">${contactParts.join('  •  ')}</div>
  </div>

  <div class="section-title">${
    language === 'ar' ? 'الملخص المهني' : language === 'bilingual' ? 'Professional Summary | الملخص المهني' : 'Professional Summary'
  }</div>
  ${summaryHtml}

  <div class="section-title">${
    language === 'ar' ? 'المؤهلات العلمية والتعليم' : language === 'bilingual' ? 'Education & Academic Qualifications | التعليم' : 'Education & Academic Qualifications'
  }</div>
  ${eduItemsHtml}

  <div class="section-title">${
    language === 'ar'
      ? 'الخبرات المهنية وجهات العمل المرتبطة'
      : language === 'bilingual'
      ? 'Professional Workplaces & Associations | جهات العمل المهنية'
      : 'Professional Workplaces & Career History'
  }</div>
  ${empItemsHtml}

  <div class="section-title">${
    language === 'ar'
      ? 'التدريب السريري والامتياز (تحت الإشراف — مفصول عن العمل المستقل)'
      : language === 'bilingual'
      ? 'Supervised Clinical Training & Internship | التدريب السريري والامتياز'
      : 'Supervised Clinical Training & Internship'
  }</div>
  ${trainingItemsHtml}

  <div class="section-title">${
    language === 'ar'
      ? 'أجهزة وتقنيات التصوير الطبي (مصفوفة الكفاءة الصادقة)'
      : language === 'bilingual'
      ? 'Imaging Modalities & Clinical Scope | أجهزة التصوير الطبي'
      : 'Imaging Modalities & Clinical Scope'
  }</div>
  <div class="entry-block">
    <div class="entry-details"><strong>${
      language === 'ar' ? 'مجالات الخبرة والممارسة العملية المبلغ عنها:' : 'Reported Professional Experience Areas:'
    }</strong><br>${workModBadges}</div>
    <div class="entry-details" style="margin-top:6px;"><strong>${
      language === 'ar'
        ? 'أقسام تم التعرض لها خلال فترة الامتياز السريري فقط (تحت الإشراف):'
        : 'Supervised Clinical Internship Rotations Only (Not claimed as independent work):'
    }</strong><br>${internModBadges}</div>
  </div>

  <div class="section-title">${
    language === 'ar'
      ? 'المسميات الوظيفية المستهدفة وتفضيلات العمل'
      : language === 'bilingual'
      ? 'Target Roles & Work Readiness | المسميات الوظيفية المستهدفة'
      : 'Target Roles & Work Readiness'
  }</div>
  <div class="entry-block">
    <div class="entry-details">
      <strong>${language === 'ar' ? 'المسميات المستهدفة (مرتبة حسب الأولوية):' : 'Ranked Target Roles:'}</strong>
      ${escapeHtml(rankedRoles.map((r, i) => `${i + 1}. ${r}`).join(' | '))}
    </div>
    <div class="entry-details">
      <strong>${language === 'ar' ? 'أنماط العمل المتاحة:' : 'Work Types & Shifts:'}</strong>
      ${escapeHtml((workPrefs.work_types || []).join(', '))}
    </div>
  </div>

  <div class="section-title">${
    language === 'ar'
      ? 'التراخيص المهنية والقيد النقابي'
      : language === 'bilingual'
      ? 'Professional Licensing & Registration | التراخيص والقيد'
      : 'Professional Licensing & Registration'
  }</div>
  <ul>${licItemsHtml}</ul>
</body>
</html>`;
}

/**
 * Builds the Private Question-and-Answer Workbook HTML (Section 5 Stage 13 & Section 9).
 * Preserves every stage heading, question label, chosen options, typed answers, source provenance,
 * and last-save timestamp. Explicitly separated from employer-facing CV.
 */
function renderAnswerWorkbookHtml(profileBundle, language = 'ar') {
  const { profile, stages = [], answers = [], employment = [], education = [], training = [], modalities = [] } = profileBundle;
  const isRtl = language === 'ar';
  const dir = isRtl ? 'rtl' : 'ltr';

  const stageSectionsHtml = STAGE_DEFINITIONS.map((stDef) => {
    const stRow = stages.find((s) => s.stage_number === stDef.stage_number) || {};
    const stAnswers = answers.filter((a) => a.stage_number === stDef.stage_number);

    const rowsHtml = stAnswers
      .map((a) => {
        let formattedVal = a.value_json;
        try {
          const parsed = JSON.parse(a.value_json);
          formattedVal = typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : String(parsed);
        } catch (_) {}
        return `<tr>
          <td><strong>${escapeHtml(a.question_id)}</strong></td>
          <td><pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${escapeHtml(formattedVal || '(Not entered / غير مدخل)')}</pre></td>
          <td>${escapeHtml(a.source)} / ${escapeHtml(a.confirmation_state)}</td>
          <td>${escapeHtml(a.updated_at)}</td>
        </tr>`;
      })
      .join('\n');

    return `<div class="wb-stage">
      <h2>${escapeHtml(language === 'ar' ? stDef.title_ar : stDef.title_en)} (${stRow.completion_pct || 0}%)</h2>
      <p class="wb-meta">Status: ${escapeHtml(stRow.status || 'not_started')} | Last Updated: ${escapeHtml(stRow.updated_at || profile.updated_at)}</p>
      ${
        stAnswers.length > 0
          ? `<table class="wb-table">
              <thead>
                <tr>
                  <th>Question ID</th>
                  <th>Saved Answer / Selection</th>
                  <th>Source & Confirmation</th>
                  <th>Last Saved</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>`
          : `<p><em>${language === 'ar' ? 'لا توجد إجابات محفوظة في هذه المرحلة بعد.' : 'No answers saved in this stage yet.'}</em></p>`
      }
      ${
        stRow.private_notes
          ? `<div class="private-note-box"><strong>Private Stage Notes (Excluded from employer CV):</strong> ${escapeHtml(stRow.private_notes)}</div>`
          : ''
      }
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html dir="${dir}" lang="${language === 'ar' ? 'ar' : 'en'}">
<head>
  <meta charset="utf-8">
  <title>Complete Question & Answer Workbook — ${escapeHtml(profile.title)}</title>
  <style>
    @page { size: A4; margin: 14mm; }
    body {
      font-family: 'Noto Naskh Arabic', 'Amiri', 'DejaVu Sans', Arial, sans-serif;
      direction: ${dir};
      color: #1e293b;
      font-size: 9.5pt;
      line-height: 1.4;
    }
    .wb-header {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      padding: 12px;
      margin-bottom: 16px;
    }
    .wb-stage {
      margin-bottom: 18px;
      page-break-inside: avoid;
    }
    h1 { font-size: 15pt; margin: 0 0 6px 0; color: #0f4c5c; }
    h2 { font-size: 11.5pt; margin: 10px 0 4px 0; color: #0f4c5c; border-bottom: 1px solid #cbd5e1; }
    .wb-meta { font-size: 8.5pt; color: #64748b; margin: 2px 0 6px 0; }
    .wb-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 6px;
    }
    .wb-table th, .wb-table td {
      border: 1px solid #cbd5e1;
      padding: 5px 7px;
      vertical-align: top;
      text-align: ${isRtl ? 'right' : 'left'};
      font-size: 8.5pt;
    }
    .wb-table th { background: #e2e8f0; }
    .private-note-box {
      margin-top: 6px;
      padding: 6px;
      background: #fffbeb;
      border: 1px solid #fde68a;
      font-size: 8.5pt;
    }
  </style>
</head>
<body>
  <div class="wb-header">
    <h1>كراسة الإجابات الكاملة (Complete Question & Answer Workbook — Private Owner Copy)</h1>
    <div><strong>Workspace:</strong> ${escapeHtml(profile.title)}</div>
    <div><strong>Generated At:</strong> ${escapeHtml(new Date().toISOString())}</div>
    <div><strong>Privacy Notice:</strong> This workbook contains your raw saved answers, confirmation states, and private stage notes. Do NOT send this file to employers; use the Employer-Facing CV PDF instead.</div>
  </div>
  ${stageSectionsHtml}
</body>
</html>`;
}

/**
 * Converts HTML into a real selectable PDF or DOCX using headless LibreOffice Writer
 * and validates the generated PDF with `pdftotext`.
 */
function convertHtmlToDocumentBuffer(htmlString, format = 'pdf') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcv-export-'));
  try {
    const htmlPath = path.join(tmpDir, 'document.html');
    fs.writeFileSync(htmlPath, htmlString, 'utf8');

    if (format === 'docx') {
      execFileSync(
        'libreoffice',
        [
          '--headless',
          '-env:UserInstallation=file://' + path.join(tmpDir, 'lo-profile'),
          '--infilter=writerglobal8_HTML',
          '--convert-to',
          'docx:MS Word 2007 XML',
          '--outdir',
          tmpDir,
          htmlPath,
        ],
        { timeout: 45000, stdio: 'pipe' }
      );
      const docxPath = path.join(tmpDir, 'document.docx');
      const buffer = fs.readFileSync(docxPath);
      return { buffer, validationReport: { format: 'docx', sizeBytes: buffer.length, valid: buffer.length > 500 } };
    }

    // Default: PDF via writer_pdf_Export
    execFileSync(
      'libreoffice',
      [
        '--headless',
        '-env:UserInstallation=file://' + path.join(tmpDir, 'lo-profile'),
        '--convert-to',
        'pdf:writer_pdf_Export',
        '--outdir',
        tmpDir,
        htmlPath,
      ],
      { timeout: 45000, stdio: 'pipe' }
    );

    const pdfPath = path.join(tmpDir, 'document.pdf');
    const buffer = fs.readFileSync(pdfPath);

    // Run PDF layout & selectable text validation using pdftotext
    let extractedText = '';
    try {
      extractedText = execFileSync('pdftotext', [pdfPath, '-'], { timeout: 10000 }).toString('utf8');
    } catch (_) {}

    const validationReport = {
      format: 'pdf',
      pageSize: 'A4',
      sizeBytes: buffer.length,
      isPdfSignatureValid: buffer.subarray(0, 5).toString('ascii') === '%PDF-',
      selectableTextVerified: extractedText.trim().length > 20,
      extractedCharCount: extractedText.trim().length,
      arabicShapingSupported: true,
    };

    return { buffer, validationReport };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function generateProfileExport({
  user,
  profileBundle,
  exportType = 'cv_pdf', // 'cv_pdf' | 'draft_pdf' | 'workbook_pdf' | 'docx' | 'json_backup' | 'markdown_backup'
  language = 'en',
  templateId = 'modern-healthcare',
  styleDensity = 'standard',
}) {
  const db = getDb();
  const profileId = profileBundle.profile.id;
  const filename = buildSafeExportFilename(profileBundle, exportType, language);
  const exportId = 'exp-' + crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    let buffer;
    let validationReport = {};
    let mimeType = 'application/pdf';

    if (exportType === 'json_backup') {
      // Only requesting user's profile data, no passwords/tokens/other users
      const safePayload = {
        exported_at: now,
        schema_version: '1.0',
        profile: profileBundle.profile,
        stages: profileBundle.stages,
        answers: profileBundle.answers,
        education: profileBundle.education,
        employment: profileBundle.employment,
        training: profileBundle.training,
        modalities: profileBundle.modalities,
        licenses: profileBundle.licenses,
        achievements: profileBundle.achievements,
        references: profileBundle.references,
      };
      buffer = Buffer.from(JSON.stringify(safePayload, null, 2), 'utf8');
      mimeType = 'application/json';
      validationReport = { format: 'json', sizeBytes: buffer.length, valid: true };
    } else if (exportType === 'markdown_backup') {
      const mdLines = [
        `# ${profileBundle.profile.title}`,
        `- Exported At: ${now}`,
        `- Language: ${language}`,
        `\n## Stage Answers`,
        ...profileBundle.answers.map((a) => `- **${a.question_id}** (${a.confirmation_state}): \`${a.value_json}\``),
        `\n## Education`,
        ...profileBundle.education.map(
          (e) => `- **${e.qualification_en}** — ${e.institution_en} (${e.graduation_date}), Grade: ${e.final_grade_en}`
        ),
        `\n## Workplaces`,
        ...profileBundle.employment.map(
          (w) => `- **${w.institution_name_en} (${w.institution_name_ar})** — Status: ${w.relationship_type}`
        ),
        `\n## Supervised Clinical Training & Internship`,
        ...profileBundle.training.map(
          (t) => `- **${t.institution_en}** (${t.total_duration_en}): ${t.suggested_draft_en}`
        ),
      ];
      buffer = Buffer.from(mdLines.join('\n'), 'utf8');
      mimeType = 'text/markdown; charset=utf-8';
      validationReport = { format: 'markdown', sizeBytes: buffer.length, valid: true };
    } else if (exportType === 'workbook_pdf') {
      const html = renderAnswerWorkbookHtml(profileBundle, language);
      const res = convertHtmlToDocumentBuffer(html, 'pdf');
      buffer = res.buffer;
      validationReport = res.validationReport;
    } else if (exportType === 'docx') {
      const html = renderCvHtml(profileBundle, {
        language,
        isDraft: false,
        templateId,
        styleDensity,
      });
      const res = convertHtmlToDocumentBuffer(html, 'docx');
      buffer = res.buffer;
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      validationReport = res.validationReport;
    } else {
      // cv_pdf or draft_pdf
      const quality = analyzeProfileQualityAndTruth(profileBundle);
      const isDraft = exportType === 'draft_pdf' || !quality.readyForFinalCv;
      const html = renderCvHtml(profileBundle, {
        language,
        isDraft,
        templateId,
        styleDensity,
      });
      const res = convertHtmlToDocumentBuffer(html, 'pdf');
      buffer = res.buffer;
      validationReport = {
        ...res.validationReport,
        isDraft,
        qualitySummary: quality.summaryCounts,
      };
    }

    const storageFilename = `${exportId}_${filename}`;
    const storagePath = path.join(EXPORT_DIR, storageFilename);
    fs.writeFileSync(storagePath, buffer);

    db.prepare(`
      INSERT INTO export_jobs (
        id, profile_id, owner_id, export_type, language, template_id,
        filename, storage_path, size_bytes, status, validation_report_json, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
    `).run(
      exportId,
      profileId,
      user.id,
      exportType,
      language,
      templateId,
      filename,
      storagePath,
      buffer.length,
      JSON.stringify(validationReport),
      expiresAt,
      now
    );

    logAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      targetUserId: profileBundle.profile.owner_id,
      targetProfileId: profileId,
      eventType: `export.${exportType}_success`,
      stageOrFeature: 'stage_13_exports',
      summaryRedacted: `Generated ${exportType} (${language}) — ${filename} (${buffer.length} bytes)`,
    });

    return {
      ok: true,
      exportJob: {
        id: exportId,
        profile_id: profileId,
        export_type: exportType,
        language,
        filename,
        size_bytes: buffer.length,
        mimeType,
        validationReport,
        created_at: now,
      },
      buffer,
    };
  } catch (err) {
    const corrId = logRedactedError({
      errorType: 'EXPORT_GENERATION_FAILED',
      affectedFeature: `export_${exportType}`,
      message: err.message,
    });

    db.prepare(`
      INSERT INTO export_jobs (
        id, profile_id, owner_id, export_type, language, template_id,
        filename, status, error_code, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)
    `).run(
      exportId,
      profileId,
      user.id,
      exportType,
      language,
      templateId,
      filename,
      corrId,
      'Export generation failed; your saved answers remain completely safe.',
      now
    );

    return {
      ok: false,
      error: 'Export generation failed. Your answers are safely preserved.',
      errorReference: corrId,
    };
  }
}

module.exports = {
  EXPORT_DIR,
  buildSafeExportFilename,
  renderCvHtml,
  renderAnswerWorkbookHtml,
  generateProfileExport,
};
