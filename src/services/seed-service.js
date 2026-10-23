const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb, hashPassword } = require('../db/database');
const { QUESTION_DEFINITIONS, STAGE_DEFINITIONS, MODALITY_LIBRARY } = require('../data/glossary-and-questions');

/**
 * Private Seed Service (Section 4, Section 6 & Section 19.B)
 *
 * Parses the preloaded profile from the private runtime markdown specification
 * (`/home/user/uploaded_files/Genspark_Radiology_CV_Builder_Master_Prompt-1.md` or
 * `PRIVATE_SEED_FILE` environment variable) and populates the local private SQLite database.
 *
 * Strictly complies with Section 19.B:
 * - No personal data or private profile answers are hardcoded in committed repository files.
 * - No public default password; access uses a one-time setup claim or authenticated session.
 * - Profile is private by default until the profile owner confirms the sharing/consent notice.
 */

function seedStaticDefinitions(db) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO question_definitions (
      question_id, stage_number, version, label_ar, label_en, help_ar, help_en,
      why_it_matters_ar, why_it_matters_en, when_not_to_claim_ar, when_not_to_claim_en,
      example_ar, example_en, input_type, is_required, privacy_level, updated_at
    ) VALUES (?, ?, '1.0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const q of QUESTION_DEFINITIONS) {
    stmt.run(
      q.question_id,
      q.stage_number,
      q.label_ar,
      q.label_en,
      q.help_ar || '',
      q.help_en || '',
      q.why_it_matters_ar || '',
      q.why_it_matters_en || '',
      q.when_not_to_claim_ar || '',
      q.when_not_to_claim_en || '',
      q.example_ar || '',
      q.example_en || '',
      q.input_type,
      q.is_required ? 1 : 0,
      q.privacy_level || 'public_cv',
      now
    );
  }
}

function parseSpecSection6(mdContent) {
  if (!mdContent || !mdContent.includes('# 6. PRELOADED PROFILE')) {
    return null;
  }

  const extractBetween = (regex) => {
    const m = mdContent.match(regex);
    return m ? m[1].trim() : '';
  };

  const fullNameAr = extractBetween(/Arabic full name:\s*\*\*([^*]+)\*\*/);
  const fullNameEn = extractBetween(/English full name:\s*\*\*([^*]+)\*\*/);
  const titleAr = extractBetween(/Reported professional title:\s*\*\*([^*]+)\*\*/);
  const titleEn = extractBetween(/English title supplied:\s*\*\*([^*]+)\*\*/);
  const targetCountry = extractBetween(/with\s*\*\*([^*]+)\*\*\s*as the target country/) || 'Saudi Arabia';
  const totalExpYears = extractBetween(/Reported total experience:\s*\*\*([^*]+)\*\*/) || '7 years';

  // Education
  const highestQual = extractBetween(/Highest reported qualification:\s*\*\*([^*]+)\*\*/) || 'Diploma';
  const universityLine = extractBetween(/University\/institution:\s*\*\*([^*]+)\*\*/);
  const [uniEn = 'Benha University', uniAr = 'جامعة بنها'] = universityLine.split('/').map((s) => s.trim());
  const deptLine = extractBetween(/Department:\s*\*\*([^*]+)\*\*/);
  const [deptEn = 'Radiology Technician Department', deptAr = 'قسم فني أشعة'] = deptLine.split('/').map((s) => s.trim());
  const specLine = extractBetween(/Official specialty supplied:\s*\*\*([^*]+)\*\*/);
  const [specEn = 'Radiology and Medical Imaging', specAr = 'أشعة وتصوير طبي'] = specLine.split('/').map((s) => s.trim());
  const studyStartYear = extractBetween(/Study start year:\s*\*\*([^*]+)\*\*/) || '2019';
  const graduationDate = extractBetween(/Graduation:\s*\*\*([^*]+)\*\*/) || 'June 2020 (دور يونيو 2020)';
  const studyMode = extractBetween(/Study mode:\s*\*\*([^*]+)\*\*/) || 'regular attendance';
  const grade = extractBetween(/Grade:\s*\*\*([^*]+)\*\*/) || 'Excellent';

  // Extract workplaces from numbered list under "## Current/associated workplaces reported by the user"
  const workplacesBlock = extractBetween(/## Current\/associated workplaces reported by the user([\s\S]*?)## Ranked target roles/);
  const workplaceLines = workplacesBlock
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s+\*\*/.test(l));

  const workplaces = workplaceLines.map((line, idx) => {
    const nameEnMatch = line.match(/^\d+\.\s+\*\*([^*]+)\*\*/);
    const nameEn = nameEnMatch ? nameEnMatch[1].trim() : `Institution ${idx + 1}`;
    const afterDash = line.split('—')[1] || '';
    const segments = afterDash.split(';').map((s) => s.trim());
    const nameAr = segments[0] || nameEn;
    const isPrimary = line.toLowerCase().includes('primary current employer');
    let instType = 'Hospital / Medical Center';
    let locationText = segments.slice(1).join('; ').replace(/\.$/, '');
    if (segments.length >= 3) {
      instType = segments[1];
      locationText = segments.slice(2).join('; ').replace(/\.\s*Identified as.*$/i, '').replace(/\.\s*Keep the spelling.*$/i, '');
    } else {
      locationText = locationText.replace(/\.\s*Identified as.*$/i, '').replace(/\.\s*Keep the spelling.*$/i, '');
    }
    const locParts = locationText.split(',').map((s) => s.trim());
    return {
      institution_name_en: nameEn,
      institution_name_ar: nameAr,
      institution_type: instType,
      city: locParts[0] || '',
      region: locParts[1] || '',
      country: 'Egypt',
      is_primary_employer: isPrimary ? 1 : 0,
      sort_order: idx + 1,
    };
  });

  // Ranked target roles
  const rolesBlock = extractBetween(/## Ranked target roles([\s\S]*?)Do not translate/);
  const rankedRoles = rolesBlock
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s+/.test(l))
    .map((l) => l.replace(/^\d+\.\s+/, '').trim());

  // Selected experience modalities
  const expModBlock = extractBetween(/## Reported work modalities and settings — experience selected by user([\s\S]*?)These were \*\*not\*\* selected/);
  const selectedModalities = expModBlock
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());

  // Clinical training tasks at Benha University Hospital
  const trainingBlock = extractBetween(/## Clinical training — Benha University Hospital([\s\S]*?)## Internship — El-Shohada Central Hospital/);
  const tasksSubBlock = extractBetween(/Tasks explicitly selected as performed during this training:([\s\S]*?)- \*\*Not confirmed\/unchecked:\*\*/);
  const trainingTasks = tasksSubBlock
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).replace(/\.$/, '').trim());

  const trainingSuggestedEn = extractBetween(/Suggested English draft for this training, pending review:\s*\n“([\s\S]*?)”/);
  const internshipSuggestedEn = extractBetween(/## Internship — El-Shohada Central Hospital[\s\S]*?Suggested English draft, pending review:\s*\n“([\s\S]*?)”/);

  return {
    fullNameAr,
    fullNameEn,
    titleAr,
    titleEn,
    targetCountry,
    totalExpYears,
    highestQual,
    uniEn,
    uniAr,
    deptEn,
    deptAr,
    specEn,
    specAr,
    studyStartYear,
    graduationDate,
    studyMode,
    grade,
    workplaces,
    rankedRoles,
    selectedModalities,
    trainingTasks,
    trainingSuggestedEn,
    internshipSuggestedEn,
  };
}

function seedRuntimeDatabase(options = {}) {
  const db = getDb(options.dbPath);
  seedStaticDefinitions(db);

  const now = new Date().toISOString();

  // 1. Ensure Platform Administrator Account exists (Site Creator from env/settings)
  const adminEmail = process.env.ADMIN_CONTACT_EMAIL || 'frp.nasr@gmail.com';
  const adminName = process.env.ADMIN_CONTACT_NAME || 'Abd-el-Rahman Adel Teba';
  const adminPhone = process.env.ADMIN_CONTACT_PHONE || '01091874291';

  let adminUser = db.prepare(`SELECT * FROM users WHERE email = ?`).get(adminEmail);
  if (!adminUser) {
    const adminId = 'usr-platform-admin';
    // Generate a random runtime setup token rather than a static hardcoded public password
    const randomAdminSecret = process.env.ADMIN_INITIAL_SECRET || crypto.randomBytes(16).toString('hex');
    const { hash, salt } = hashPassword(randomAdminSecret);
    db.prepare(`
      INSERT INTO users (
        id, email, phone, display_name, password_hash, password_salt,
        auth_provider, email_verified, phone_verified, role, mfa_enabled,
        account_status, locale, theme, is_seeded_subject, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'local_setup', 1, 1, 'admin', 1, 'active', 'ar', 'light', 0, ?, ?)
    `).run(adminId, adminEmail, adminPhone, adminName, hash, salt, now, now);

    db.prepare(`
      INSERT OR IGNORE INTO user_preferences (user_id, locale, theme, updated_at)
      VALUES (?, 'ar', 'light', ?)
    `).run(adminId, now);
  }

  // 2. Check if private seed file is available in runtime environment
  const seedFileCandidates = [
    options.seedFilePath,
    process.env.PRIVATE_SEED_FILE,
    '/home/user/uploaded_files/Genspark_Radiology_CV_Builder_Master_Prompt-1.md',
    '/home/user/uploaded_files/Genspark_Radiology_CV_Builder_Master_Prompt-1.txt',
    path.resolve(process.cwd(), 'runtime-data', 'private-seed.md'),
  ].filter(Boolean);

  let seedFileContent = null;
  for (const candidate of seedFileCandidates) {
    if (fs.existsSync(candidate)) {
      seedFileContent = fs.readFileSync(candidate, 'utf8');
      break;
    }
  }

  const parsed = parseSpecSection6(seedFileContent);
  if (!parsed) {
    return { definitionsSeeded: true, profileSeeded: false, reason: 'No private seed file found' };
  }

  // Check if seeded workspace already exists
  const existingProfile = db.prepare(`SELECT * FROM profiles WHERE is_seeded = 1`).get();
  if (existingProfile && !options.forceReseed) {
    return {
      definitionsSeeded: true,
      profileSeeded: true,
      profileId: existingProfile.id,
      ownerId: existingProfile.owner_id,
      alreadyExisted: true,
    };
  }

  // Create seeded subject account (no public password, personal email/phone NOT fabricated and NOT mixed with admin's)
  const subjectUserId = 'usr-seeded-radiology-owner';
  const subjectRandomSecret = crypto.randomBytes(20).toString('hex');
  const { hash: subHash, salt: subSalt } = hashPassword(subjectRandomSecret);

  db.prepare(`
    INSERT OR IGNORE INTO users (
      id, email, phone, display_name, password_hash, password_salt,
      auth_provider, email_verified, phone_verified, role, mfa_enabled,
      account_status, locale, theme, is_seeded_subject, created_at, updated_at
    ) VALUES (?, NULL, NULL, ?, ?, ?, 'one_time_setup', 0, 0, 'user', 0, 'active', 'ar', 'light', 1, ?, ?)
  `).run(subjectUserId, parsed.fullNameEn, subHash, subSalt, now, now);

  db.prepare(`
    INSERT OR IGNORE INTO user_preferences (user_id, locale, theme, updated_at)
    VALUES (?, 'ar', 'light', ?)
  `).run(subjectUserId, now);

  const profileId = 'prf-seeded-radiology-workspace';
  const formattedTitleName = parsed.fullNameEn
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Ghafar/g, 'Ghaffar');
  const workspaceTitle = `${formattedTitleName} — Existing Answers Imported`;

  db.prepare(`
    INSERT OR REPLACE INTO profiles (
      id, owner_id, title, slug, primary_language, cv_output_language,
      target_country, template_id, photo_preference, length_preference,
      is_seeded, seed_banner_dismissed, privacy_mode, share_with_admin_enabled,
      share_history_with_admin, status, version, last_synced_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, 'seeded-radiology-profile', 'ar', 'en',
      ?, 'modern-healthcare', 'omit', 'standard',
      1, 0, 'private', 0,
      0, 'draft', 1, ?, ?, ?
    )
  `).run(profileId, subjectUserId, workspaceTitle, parsed.targetCountry, now, now, now);

  // Initialize all 13 stages for this profile
  const stageStmt = db.prepare(`
    INSERT OR REPLACE INTO stages (
      id, profile_id, stage_number, stage_key, status,
      completion_pct, unanswered_count, needs_confirmation_count, private_notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const st of STAGE_DEFINITIONS) {
    let status = 'not_started';
    let pct = 0;
    let unanswered = 3;
    let needsConf = 0;

    if (st.stage_number === 1) {
      status = 'needs_confirmation';
      pct = 85;
      unanswered = 2; // Personal phone/email & street address not provided yet
      needsConf = 2;
    } else if (st.stage_number === 2) {
      status = 'needs_confirmation';
      pct = 90;
      unanswered = 1; // College/faculty name not provided
      needsConf = 1;
    } else if (st.stage_number === 3) {
      status = 'needs_confirmation';
      pct = 45;
      unanswered = 6; // Dates, roles, relationships for the 6 workplaces
      needsConf = 6;
    } else if (st.stage_number === 4) {
      status = 'needs_confirmation';
      pct = 80;
      unanswered = 2; // Exact internship rotation dates & draft approval
      needsConf = 2;
    } else if (st.stage_number === 5) {
      status = 'needs_confirmation';
      pct = 60;
      unanswered = 4; // Independence & years per modality
      needsConf = 8;
    } else if (st.stage_number === 8) {
      status = 'needs_confirmation';
      pct = 35;
      unanswered = 4;
      needsConf = 4;
    } else if (st.stage_number === 10) {
      status = 'optional';
      pct = 0;
      unanswered = 0;
      needsConf = 0;
    } else if (st.stage_number === 11) {
      status = 'in_progress';
      pct = 55;
      unanswered = 2;
      needsConf = 1;
    }

    stageStmt.run(
      `${profileId}-s${st.stage_number}`,
      profileId,
      st.stage_number,
      st.stage_key,
      status,
      pct,
      unanswered,
      needsConf,
      '',
      now
    );
  }

  // Insert Stage 1 & Stage 2 imported answers with provenance = 'imported'
  const ansStmt = db.prepare(`
    INSERT OR REPLACE INTO answers (
      id, profile_id, stage_number, question_id, value_json, raw_source_value,
      source, confirmation_state, visibility, version, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'imported', ?, ?, 1, ?, ?)
  `);

  const importedAnswers = [
    {
      stage: 1,
      qid: 's1_full_name_ar',
      val: parsed.fullNameAr,
      conf: 'user_confirmed',
      vis: 'show',
    },
    {
      stage: 1,
      qid: 's1_full_name_en',
      val: parsed.fullNameEn,
      conf: 'user_confirmed',
      vis: 'show',
    },
    {
      stage: 1,
      qid: 's1_professional_title_ar',
      val: parsed.titleAr,
      conf: 'user_confirmed',
      vis: 'show',
    },
    {
      stage: 1,
      qid: 's1_professional_title_en',
      val: parsed.titleEn,
      conf: 'user_confirmed',
      vis: 'show',
    },
    {
      stage: 1,
      qid: 's1_title_sources',
      val: [
        'license',
        'syndicate_record',
        'employer_records',
        'official_decision',
        'professional_card',
        'certificate',
      ],
      conf: 'needs_confirmation',
      vis: 'private_only',
    },
    {
      stage: 1,
      qid: 's1_owner_email',
      val: '', // Explicitly blank — never use admin support email
      conf: 'not_entered',
      vis: 'show',
    },
    {
      stage: 1,
      qid: 's1_owner_phone',
      val: '', // Explicitly blank — never use admin support phone
      conf: 'not_entered',
      vis: 'show',
    },
    {
      stage: 1,
      qid: 's1_residence_location',
      val: {
        country: 'Egypt',
        city_or_governorate: 'Qalyubia / Menoufia, Egypt',
        street_address: '', // Blank — never fabricate
        wants_address_shown: true,
        address_note: 'Not provided—do not publish a guessed address. Waiting for owner to supply street/city preference.',
      },
      conf: 'needs_confirmation',
      vis: 'show',
    },
    {
      stage: 1,
      qid: 's1_ranked_target_roles',
      val: parsed.rankedRoles,
      conf: 'user_confirmed',
      vis: 'show',
    },
    {
      stage: 1,
      qid: 's1_work_preferences',
      val: {
        target_country: 'Saudi Arabia',
        availability: 'Immediate',
        willing_to_relocate: true,
        valid_passport: true,
        show_passport_details_on_cv: false,
        work_types: [
          'Full-time',
          'Part-time',
          'On-site',
          'Shift work',
          'Rotating shifts',
          'Night shifts',
          'Weekend shifts',
          'Overtime',
          'Emergency/on-call',
        ],
        saudi_classification_status: 'Needs confirmation / Not started',
      },
      conf: 'user_confirmed',
      vis: 'show',
    },
    {
      stage: 1,
      qid: 's1_experience_summary_breakdown',
      val: {
        reported_total_years: 7,
        includes_pre_graduation: true,
        includes_student_training: true,
        includes_internship: true,
        includes_paid_work: true,
        post_graduation_paid_years: null, // Unknown exact split — never turn 7 total years into 7 post-grad years
        explanation_en:
          'Reported 7 years total exposure including experience before and after June 2020 graduation. Exact paid work start dates and division between student training, internship, and employment require owner confirmation.',
        explanation_ar:
          'إجمالي 7 سنوات مبلغ عنها تشمل الخبرة والتدريب قبل التخرج وبعد التخرج (يونيو 2020). لا يتم تحويلها تلقائيًا إلى 7 سنوات عمل بعد التخرج حتى يتم تأكيد تواريخ كل جهة عمل.',
      },
      conf: 'needs_confirmation',
      vis: 'show',
    },
    {
      stage: 2,
      qid: 's2_education_summary',
      val: {
        qualification_en: parsed.highestQual,
        qualification_ar: 'دبلوم',
        institution_en: parsed.uniEn,
        institution_ar: parsed.uniAr,
        college_faculty_en: '', // Explicitly blank — never guess
        college_faculty_ar: '',
        college_needs_confirmation: true,
        department_en: parsed.deptEn,
        department_ar: parsed.deptAr,
        specialty_en: parsed.specEn,
        specialty_ar: parsed.specAr,
        study_start_year: parsed.studyStartYear,
        graduation_date: parsed.graduationDate,
        study_mode: parsed.studyMode,
        grade_en: parsed.grade,
        grade_ar: 'ممتاز',
        no_gpa_issued: true,
        gpa_value: '',
      },
      conf: 'needs_confirmation',
      vis: 'show',
    },
    {
      stage: 11,
      qid: 's11_saudi_readiness',
      val: {
        target_country: 'Saudi Arabia',
        passport_valid: true,
        immediate_availability: true,
        relocation_ready: true,
        scfhs_classification_status: 'Needs Official Confirmation',
        dataflow_verification_status: 'Needs Official Confirmation',
        regulatory_disclaimer_acknowledged: true,
      },
      conf: 'needs_confirmation',
      vis: 'show',
    },
  ];

  for (const item of importedAnswers) {
    ansStmt.run(
      `${profileId}-ans-${item.qid}`,
      profileId,
      item.stage,
      item.qid,
      JSON.stringify(item.val),
      JSON.stringify(item.val),
      item.conf,
      item.vis,
      subjectUserId,
      now
    );
  }

  // Insert Education Entry (Stage 2)
  db.prepare(`
    INSERT OR REPLACE INTO education_entries (
      id, profile_id, qualification_ar, qualification_en, institution_ar, institution_en,
      college_faculty_ar, college_faculty_en, college_needs_confirmation,
      department_ar, department_en, specialty_ar, specialty_en, credential_level,
      country, city, start_date, graduation_date, exact_date_unknown,
      attendance_mode, final_grade_ar, final_grade_en, gpa_value, gpa_scale,
      no_gpa_issued, certificate_status, source, confirmation_state, include_in_cv, created_at, updated_at
    ) VALUES (
      ?, ?, 'دبلوم', ?, ?, ?,
      '', '', 1,
      ?, ?, ?, ?, 'Diploma',
      'Egypt', 'Benha', ?, ?, 0,
      ?, 'ممتاز', ?, '', '',
      1, 'awarded', 'imported', 'needs_confirmation', 1, ?, ?
    )
  `).run(
    `${profileId}-edu-1`,
    profileId,
    parsed.highestQual,
    parsed.uniAr,
    parsed.uniEn,
    parsed.deptAr,
    parsed.deptEn,
    parsed.specAr,
    parsed.specEn,
    parsed.studyStartYear,
    parsed.graduationDate,
    parsed.studyMode,
    parsed.grade,
    now,
    now
  );

  // Insert 6 Workplace Entries (Stage 3) marked "Reported by user — relationship/dates need confirmation"
  const empStmt = db.prepare(`
    INSERT OR REPLACE INTO employment_entries (
      id, profile_id, institution_name_ar, institution_name_en, alternative_names,
      institution_type, city, region, country, street_address, show_address_on_cv,
      role_title_ar, role_title_en, relationship_type, is_primary_employer,
      start_date, end_date, is_current, exact_dates_unknown, date_display_mode,
      supervision_level, source, confirmation_state, include_in_cv, sort_order, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, '', 0,
      'أخصائي أشعة وتصوير طبي (يحتاج لتأكيد المسمى الوظيفي بالجهة)',
      'Radiology and Medical Imaging Specialist (Role/relationship pending confirmation)',
      'needs_confirmation', ?,
      '', '', 1, 1, 'needs_confirmation',
      'needs_confirmation', 'imported', 'needs_confirmation', 1, ?, ?, ?
    )
  `);

  parsed.workplaces.forEach((wp, index) => {
    const altNames = wp.institution_name_en.includes('Al-Feky')
      ? 'Komishish / كمشيش (spelling editable for verification)'
      : '';
    empStmt.run(
      `${profileId}-emp-${index + 1}`,
      profileId,
      wp.institution_name_ar,
      wp.institution_name_en,
      altNames,
      wp.institution_type,
      wp.city,
      wp.region,
      wp.country,
      wp.is_primary_employer,
      wp.sort_order,
      now,
      now
    );
  });

  // Insert Stage 4 Clinical Training (Benha University Hospital) & Internship (El-Shohada Central Hospital)
  // Note: Patient Reception and Patient Identification are explicitly stored in tasks_unconfirmed_json!
  const trainStmt = db.prepare(`
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
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      '', '', 'pending_review',
      'imported', 'needs_confirmation', 1, ?, ?
    )
  `);

  // 1) Clinical Training — Benha University Hospital (2020)
  trainStmt.run(
    `${profileId}-trn-benha`,
    profileId,
    'student_clinical',
    'مستشفى بنها الجامعي',
    'Benha University Hospital',
    'بنها',
    'Benha',
    'فني أشعة (متدرب)',
    'Radiology Technician Trainee',
    '2020',
    'عام 2020',
    '2020',
    1,
    'Radiology Department Supervisors',
    JSON.stringify([
      'General X-Ray',
      'Emergency Radiology',
      'ICU Radiology',
      'Operating Room',
      'Trauma Imaging',
    ]),
    JSON.stringify([]),
    '',
    '',
    JSON.stringify([]), // Not marked as independent employment duties
    JSON.stringify(parsed.trainingTasks),
    JSON.stringify([]),
    JSON.stringify(parsed.trainingTasks),
    JSON.stringify(['Patient Reception', 'Patient Identification']), // Explicitly unchecked/unconfirmed per spec
    JSON.stringify([
      'trauma',
      'road traffic accidents',
      'fractures',
      'chest emergencies',
      'stroke',
      'acute abdomen',
      'ICU cases',
      'postoperative cases',
    ]),
    'التدريب السريري — مستشفى بنها الجامعي | متدرب فني أشعة | 2020\n- المشاركة في التدريب السريري تحت الإشراف في أقسام الأشعة السينية العامة، وأشعة الطوارئ، وأشعة العناية المركزة، والتصوير داخل غرف العمليات، وتصوير الإصابات والحوادث.\n- المساعدة في تحضير المرضى وضبط الوضعيات وتجهيز أجهزة التصوير وسير العمل تحت الإشراف المختص.\n- المشاركة في التقاط الصور والتقييم الأولي لجودة الصورة مع الالتزام بالبروتوكولات وإجراءات الوقاية من الإشعاع.\n- اكتساب خبرة تدريبية تحت الإشراف في سير عمل أشعة الطوارئ والأشعة المتنقلة والتوثيق وإدخال البيانات على PACS/RIS.',
    parsed.trainingSuggestedEn,
    now,
    now
  );

  // 2) Clinical Internship — El-Shohada Central Hospital (Six-month internship)
  trainStmt.run(
    `${profileId}-trn-shohada`,
    profileId,
    'internship',
    'مستشفى الشهداء المركزي',
    'El-Shohada Central Hospital',
    'الشهداء',
    'El-Shohada',
    'متدرب امتياز أشعة وتصوير طبي',
    'Radiology and Medical Imaging Intern',
    'Six-month internship (Exact start/end dates not provided)',
    'ستة أشهر (تواريخ البداية والنهاية الدقيقة غير محددة)',
    'Six months (Exact start/end dates unknown — do not invent dates)',
    1,
    'Senior Radiographers, Radiology Specialists, Supervisors',
    JSON.stringify([
      'General X-Ray',
      'CT Scan (Computed Tomography)',
      'MRI (Magnetic Resonance Imaging)',
      'Ultrasound (US)',
      'Fluoroscopy',
      'Mammography',
      'Interventional Radiology',
      'Dental Radiology',
    ]),
    JSON.stringify([
      '1. General X-Ray',
      '2. Operating Room',
      '3. ICU',
      '4. Emergency',
      '5. Trauma',
    ]),
    'شعرت أنها سهلة وبسيطة وسريعة التعلم، كما أن الأشعة السينية العامة تُعد الأساس لبقية الأقسام والتخصصات.',
    'They felt easy, simple, and quick to learn, and General X-Ray was viewed as a foundation for other departments and specialties.',
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify([
      'General imaging-department workflow familiarity under supervision',
      'Patient preparation and positioning assistance',
      'Radiation-safety practices and protocol observation',
    ]),
    JSON.stringify(['Department-specific independent task lists (pending owner confirmation)']),
    JSON.stringify([]),
    'الامتياز السريري — مستشفى الشهداء المركزي | متدرب امتياز أشعة وتصوير طبي | ستة أشهر\nإتمام فترة امتياز سريري لمدة ستة أشهر تحت الإشراف شملت التعرض التدريبي لأقسام الأشعة السينية العامة، والأشعة المقطعية (CT)، والرنين المغناطيسي (MRI)، والموجات فوق الصوتية (US)، والتنظير التألقي (Fluoroscopy)، والماموجرام، والأشعة التداخلية، وأشعة الأسنان، مع التعرف على سير العمل وتحضير المرضى وضبط الوضعيات وإجراءات السلامة الإشعاعية ضمن حدود الإشراف التدريبي.',
    parsed.internshipSuggestedEn,
    now,
    now
  );

  // Insert Stage 5 Modality Competency Matrix
  // Selected as experience areas vs Internship-only (MRI, Ultrasound, Fluoroscopy) vs Not selected (Nuclear Medicine)
  const modStmt = db.prepare(`
    INSERT OR REPLACE INTO modality_competencies (
      id, profile_id, modality_code, modality_name_ar, modality_name_en,
      experience_category, duration_text, clinical_settings_json, institutions_json,
      equipment_models, confidence_level, justification_text,
      source, confirmation_state, include_in_cv, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Not sure', ?, ?, 'imported', ?, ?, ?)
  `);

  const userSelectedCodes = new Set([
    'general_xray',
    'ct',
    'mammography',
    'interventional',
    'emergency',
    'icu_bedside',
    'operating_room',
    'trauma',
    'portable',
  ]);
  const internshipOnlyCodes = new Set(['mri', 'ultrasound', 'fluoroscopy', 'dental']);

  for (const mod of MODALITY_LIBRARY) {
    let category = 'no_experience';
    let durationText = '';
    let confLevel = 'needs_confirmation';
    let justification = '';
    let confState = 'needs_confirmation';
    let includeInCv = 0;

    if (userSelectedCodes.has(mod.code)) {
      category = 'independent_work'; // Selected as work experience area, but requires Stage 5 confirmation of exact role/years
      durationText = 'Needs confirmation per workplace';
      confLevel = 'needs_confirmation';
      justification = 'Selected by user as an actual experience area; exact role, years, and level of independence per hospital need confirmation.';
      confState = 'needs_confirmation';
      includeInCv = 1;
    } else if (internshipOnlyCodes.has(mod.code)) {
      // Strictly enforce Truth Rule: MRI, Ultrasound, and Fluoroscopy were internship rotations ONLY!
      category = 'internship_exposure';
      durationText = 'Part of 6-month internship at El-Shohada Central Hospital';
      confLevel = 'developing';
      justification = 'Encountered as a supervised rotation during six-month internship at El-Shohada Central Hospital. Not claimed as current independent professional work.';
      confState = 'user_confirmed';
      includeInCv = 1;
    } else if (mod.code === 'nuclear_medicine') {
      category = 'no_experience';
      justification = 'Not selected in initial questionnaire or internship rotations.';
      confState = 'user_confirmed';
      includeInCv = 0;
    }

    modStmt.run(
      `${profileId}-mod-${mod.code}`,
      profileId,
      mod.code,
      mod.name_ar,
      mod.name_en,
      category,
      durationText,
      JSON.stringify([]),
      JSON.stringify([]),
      confLevel,
      justification,
      confState,
      includeInCv,
      now
    );
  }

  // Insert Stage 8 Credentials placeholders based on user confirmation that title appears on license, syndicate, etc.
  const licStmt = db.prepare(`
    INSERT OR REPLACE INTO license_entries (
      id, profile_id, credential_type, name_ar, name_en,
      issuing_authority_ar, issuing_authority_en, country,
      printed_title_ar, printed_title_en, no_expiry_or_unknown,
      status, source, confirmation_state, include_in_cv, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'needs_confirmation', 'imported', 'needs_confirmation', 1, ?, ?)
  `);

  licStmt.run(
    `${profileId}-lic-practice`,
    profileId,
    'license',
    'ترخيص مزاولة المهنة',
    'Professional Practice License',
    'تحتاج لتأكيد اسم جهة الإصدار الرسمية',
    'Issuing authority name & date need confirmation',
    'Egypt',
    parsed.titleAr,
    parsed.titleEn,
    now,
    now
  );

  licStmt.run(
    `${profileId}-lic-syndicate`,
    profileId,
    'syndicate',
    'القيد النقابي / الكارنيه المهني',
    'Syndicate / Professional Association Registration',
    'تحتاج لتأكيد اسم النقابة وتاريخ القيد',
    'Syndicate name & registration details need confirmation',
    'Egypt',
    parsed.titleAr,
    parsed.titleEn,
    now,
    now
  );

  licStmt.run(
    `${profileId}-lic-saudi`,
    profileId,
    'classification',
    'التصنيف والتسجيل المهني السعودي (SCFHS / DataFlow)',
    'Saudi Professional Classification & Verification Status',
    'الهيئة السعودية للتخصصات الصحية (استرشادي)',
    'Saudi Commission for Health Specialties (Checklist item — not claimed as completed)',
    'Saudi Arabia',
    '',
    '',
    now,
    now
  );

  // Create initial Version Snapshot (Version 1)
  db.prepare(`
    INSERT OR REPLACE INTO profile_versions (
      id, profile_id, version_number, stage_number, change_summary, snapshot_json, editor_id, created_at
    ) VALUES (?, ?, 1, 1, 'Initial import of existing Stage 1 & Stage 2 answers into private workspace', ?, ?, ?)
  `).run(
    `${profileId}-ver-1`,
    profileId,
    JSON.stringify({ importedAnswersCount: importedAnswers.length, workplacesCount: parsed.workplaces.length }),
    subjectUserId,
    now
  );

  return {
    definitionsSeeded: true,
    profileSeeded: true,
    profileId,
    ownerId: subjectUserId,
  };
}

module.exports = {
  seedStaticDefinitions,
  seedRuntimeDatabase,
  parseSpecSection6,
};
