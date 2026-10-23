/**
 * Truth-Preserving Writing Assistant, Quality & Conflict Analyzer, and Job Description Parser
 * (Section 2, Section 5 Stage 11 & Stage 13, Section 7)
 *
 * Strictly enforces non-negotiable truth rules:
 * - Never invents degrees, dates, colleges, GPA, licenses, equipment models, or workload metrics.
 * - Never upgrades supervised training or internship rotations into independent employment.
 * - Flags patient identifier risks if a user accidentally types words like "patient name" or ID numbers.
 */

function checkPatientIdentifierRisk(text) {
  if (!text) return { hasRisk: false, warnings: [] };
  const warnings = [];
  if (/(patient\s*name|mrn|medical\s*record|national\s*id|اسم\s*المريض|رقم\s*الملف|الرقم\s*القومي)/i.test(text)) {
    warnings.push({
      ar: 'تنبيه خصوصية: يُحظر إدخال أسماء المرضى أو أرقام ملفاتهم الطبية أو تواريخ ميلادهم في أمثلة الحالات.',
      en: 'Privacy Warning: Never enter patient names, medical record numbers (MRN), or identifiable patient information.',
    });
  }
  return { hasRisk: warnings.length > 0, warnings };
}

function generateSuggestedBulletsForEmployment(entry, tone = 'standard') {
  const instEn = entry.institution_name_en || 'Healthcare Institution';
  const instAr = entry.institution_name_ar || 'مؤسسة طبية';
  const roleEn = entry.role_title_en || 'Radiology and Medical Imaging Specialist';
  const roleAr = entry.role_title_ar || 'أخصائي أشعة وتصوير طبي';
  const supLevel = entry.supervision_level || 'needs_confirmation';

  let modalities = [];
  try {
    modalities = JSON.parse(entry.modalities_json || '[]');
  } catch (_) {}

  let tasks = [];
  try {
    tasks = JSON.parse(entry.tasks_confirmed_json || '[]');
  } catch (_) {}

  const modListEn = modalities.length > 0 ? modalities.join(', ') : 'assigned diagnostic imaging modalities';
  const modListAr = modalities.length > 0 ? modalities.join('، ') : 'أقسام التصوير الطبي المكلف بها';

  const verbEn =
    supLevel === 'independent'
      ? 'Performed'
      : supLevel === 'supervised'
      ? 'Participated under supervision in'
      : 'Supported clinical workflow for';

  const verbAr =
    supLevel === 'independent'
      ? 'إجراء فحوصات'
      : supLevel === 'supervised'
      ? 'المشاركة تحت الإشراف في فحوصات'
      : 'دعم سير العمل الإكلينيكي في فحوصات';

  const assumptionsAndUnknowns = [];
  if (entry.exact_dates_unknown || !entry.start_date) {
    assumptionsAndUnknowns.push({
      field: 'start_date / end_date',
      note_en: 'Exact employment start/end dates are unknown and omitted from draft wording until confirmed.',
      note_ar: 'تواريخ البداية والنهاية الدقيقة غير محددة ولم تتم إضافتها للمسودة حتى يتم تأكيدها.',
    });
  }
  if (entry.relationship_type === 'needs_confirmation') {
    assumptionsAndUnknowns.push({
      field: 'relationship_type',
      note_en: 'Employment relationship type (full-time, part-time, shift/rotational) requires confirmation.',
      note_ar: 'طبيعة العلاقة الوظيفية (دوام كامل / جزئي / نبطشيات) تحتاج لتأكيد.',
    });
  }
  if (supLevel === 'needs_confirmation') {
    assumptionsAndUnknowns.push({
      field: 'supervision_level',
      note_en: 'Used conservative neutral verb ("Supported clinical workflow") because independence level is not yet confirmed.',
      note_ar: 'تم استخدام صياغة متحفظة لأن مستوى الاستقلالية لم يُؤكد بعد.',
    });
  }

  const bullets = [
    {
      id: 'b1',
      what_you_told_us_en: `Institution: ${instEn} | Role: ${roleEn} | Modalities: ${modListEn}`,
      what_you_told_us_ar: `الجهة: ${instAr} | الدور: ${roleAr} | الأجهزة: ${modListAr}`,
      suggested_en:
        tone === 'concise'
          ? `${verbEn} ${modListEn} examinations at ${instEn} in accordance with departmental protocols.`
          : `${verbEn} diagnostic imaging examinations across ${modListEn} at ${instEn}, adhering to imaging protocols and radiation protection standards.`,
      suggested_ar: `${verbAr} ${modListAr} في ${instAr} وفق البروتوكولات المعتمدة ومعايير الوقاية من الإشعاع.`,
      why_this_wording_ar: 'تعتمد الصياغة فقط على اسم المستشفى والأقسام المحددة دون ادعاء تفرغ كامل أو أرقام حالات غير مدخلة.',
      why_this_wording_en: 'Traces strictly to the stated institution and modalities without inventing patient volume or unconfirmed scope.',
    },
    {
      id: 'b2',
      what_you_told_us_en: tasks.length > 0 ? `Confirmed tasks: ${tasks.join(', ')}` : 'Standard positioning, image quality check, and radiation safety',
      what_you_told_us_ar: tasks.length > 0 ? `المهام المؤكدة: ${tasks.join('، ')}` : 'تحضير وضبط وضعيات المريض ومراجعة جودة الصورة والوقاية الإشعاعية',
      suggested_en:
        tasks.length > 0
          ? `Executed confirmed clinical duties including ${tasks.slice(0, 5).join(', ')} within authorized professional scope.`
          : `Coordinated patient preparation, accurate positioning, preliminary image quality verification, and radiation safety compliance within assigned duties.`,
      suggested_ar:
        tasks.length > 0
          ? `تنفيذ المهام الإكلينيكية المؤكدة شاملة: ${tasks.slice(0, 5).join('، ')} ضمن حدود الصلاحيات المهنية.`
          : `تنسيق تحضير المرضى وضبط الوضعيات الصحيحة والتقييم الأولي لجودة الصور والالتزام بإجراءات السلامة الإشعاعية.`,
      why_this_wording_ar: 'صياغة مهنية متوافقة مع أنظمة التوظيف الطبية (ATS) وتوضح الالتزام بالبروتوكول.',
      why_this_wording_en: 'ATS-friendly clinical terminology calibrated to the confirmed task boundary.',
    },
  ];

  if (entry.pacs_ris_systems) {
    bullets.push({
      id: 'b3',
      what_you_told_us_en: `Digital systems: ${entry.pacs_ris_systems}`,
      what_you_told_us_ar: `الأنظمة الرقمية: ${entry.pacs_ris_systems}`,
      suggested_en: `Managed study archiving, DICOM image transfer, and examination documentation utilizing ${entry.pacs_ris_systems}.`,
      suggested_ar: `إدارة أرشفة الفحوصات ونقل الصور الطبية وتوثيق البيانات باستخدام ${entry.pacs_ris_systems}.`,
      why_this_wording_ar: 'تبرز المهارة الرقمية في بيئة قسم الأشعة بناءً على ما أدخلته.',
      why_this_wording_en: 'Highlights verified PACS/RIS workflow integration.',
    });
  }

  return {
    status: 'suggestion_requires_approval',
    tone,
    bullets,
    assumptionsAndUnknowns,
  };
}

function analyzeProfileQualityAndTruth(profileBundle) {
  const { profile, answersMap, employment, education, training, modalities, licenses } = profileBundle;
  const essentialMissing = [];
  const needsConfirmationFlags = [];
  const conflictsAndWarnings = [];
  const evidenceConfidenceList = [];

  // 1. Check Personal Contact Details (Stage 1)
  const ownerEmail = answersMap.s1_owner_email?.value;
  const ownerPhone = answersMap.s1_owner_phone?.value;
  if (!ownerEmail) {
    essentialMissing.push({
      stage: 1,
      field: 's1_owner_email',
      message_ar: 'البريد الإلكتروني الشخصي لصاحب السيرة غير مُدخل بعد (تم تركه فارغًا بأمان دون خلطه ببريد دعم الموقع).',
      message_en: 'CV owner personal email is not entered yet (safely kept blank; never mixed with site support email).',
    });
  }
  if (!ownerPhone) {
    essentialMissing.push({
      stage: 1,
      field: 's1_owner_phone',
      message_ar: 'رقم الهاتف الشخصي لصاحب السيرة غير مُدخل بعد.',
      message_en: 'CV owner personal phone number is not entered yet.',
    });
  }

  // 2. Check Residence Street Address (Stage 1)
  const resLoc = answersMap.s1_residence_location?.value || {};
  if (resLoc.wants_address_shown && !resLoc.street_address) {
    needsConfirmationFlags.push({
      stage: 1,
      field: 's1_residence_location',
      message_ar: 'المستخدم يرغب في إظهار العنوان ولكن لم يتم تزويد عنوان شارع تفصيلي — الحقل متروك فارغًا ولن يتم اختلاق عنوان.',
      message_en: 'Owner requested address visibility on CV, but exact street address was not provided — kept empty without guessing.',
    });
  }

  // 3. Check 7-Year Experience Breakdown (Stage 1 & 3)
  const expBreak = answersMap.s1_experience_summary_breakdown?.value || {};
  if (expBreak.reported_total_years === 7 && expBreak.includes_pre_graduation && !expBreak.post_graduation_paid_years) {
    needsConfirmationFlags.push({
      stage: 1,
      field: 's1_experience_summary_breakdown',
      message_ar: 'إجمالي الخبرة المبلغ عنها (7 سنوات) يشمل ما قبل التخرج وما بعده. النظام يفصل التدريب والامتياز عن العمل الفعلي وينتظر تأكيد تواريخ العمل بعد التخرج (يونيو 2020).',
      message_en: 'Reported 7-year total includes pre- and post-graduation exposure. System strictly prevents claiming 7 years of post-graduation employment until dates are confirmed.',
    });
  }

  // 4. Check Education College/Faculty & GPA (Stage 2)
  for (const edu of education) {
    if (!edu.college_faculty_en && !edu.college_faculty_ar) {
      needsConfirmationFlags.push({
        stage: 2,
        field: 'college_faculty',
        message_ar: `اسم الكلية أو المعهد داخل (${edu.institution_ar}) غير مُدخل — يرجى تأكيده من الشهادة الرسمية دون تخمين.`,
        message_en: `College/Faculty name at ${edu.institution_en} is blank — requires owner confirmation from printed certificate.`,
      });
    }
    evidenceConfidenceList.push({
      section: 'Education',
      fact_en: `${edu.qualification_en} in ${edu.specialty_en} (${edu.institution_en}, ${edu.graduation_date}) — Grade: ${edu.final_grade_en} (No GPA issued)`,
      fact_ar: `${edu.qualification_ar} في ${edu.specialty_ar} (${edu.institution_ar}، ${edu.graduation_date}) — التقدير: ${edu.final_grade_ar} (بدون معدل تراكمي GPA)`,
      source: edu.source,
      status: edu.college_needs_confirmation ? 'needs_confirmation' : 'user_confirmed',
      has_document: Boolean(edu.supporting_upload_id),
    });
  }

  // 5. Check Employment History Dates, Relationships & Concurrent Overlaps (Stage 3)
  const unknownDateWorkplaces = employment.filter((e) => e.exact_dates_unknown || !e.start_date);
  if (unknownDateWorkplaces.length > 0) {
    needsConfirmationFlags.push({
      stage: 3,
      field: 'employment_dates',
      message_ar: `يوجد عدد (${unknownDateWorkplaces.length}) جهات عمل مبلغ عنها بدون تواريخ بداية/نهاية أو طبيعة تعاقد مؤكدة. لن يفترض النظام دوامًا كاملًا في كل جهة.`,
      message_en: `${unknownDateWorkplaces.length} reported workplaces have unknown start/end dates or unconfirmed relationship types. Full-time status is not assumed.`,
    });
  }

  const currentWorkplaces = employment.filter((e) => e.is_current);
  if (currentWorkplaces.length > 1) {
    conflictsAndWarnings.push({
      stage: 3,
      type: 'concurrent_workplaces_clarification',
      message_ar: `تم إدراج (${currentWorkplaces.length}) جهات عمل حالية متزامنة. هل العمل بنظام النبطشيات / دوام جزئي / تعاقد بالتناوب؟ يرجى التوضيح بدلًا من تركها غامضة.`,
      message_en: `${currentWorkplaces.length} concurrent workplaces listed. Please clarify whether roles are shift-based, part-time, rotational, or occasional.`,
      resolution_options: [
        'Shift-based / Rotational across institutions (عمل بنظام النبطشيات والتناوب)',
        'Primary full-time at Benha University Hospital + part-time/on-call elsewhere (دوام أساسي بمستشفى بنها الجامعي ونبطشيات بالجهات الأخرى)',
        'Some institutions are previous employers — update status to Former (بعض الجهات سابقة وليست حالية)',
      ],
    });
  }

  // 6. Check Training vs Employment Separation & Unconfirmed Training Tasks (Stage 4)
  for (const trn of training) {
    if (trn.draft_approval_status === 'pending_review') {
      needsConfirmationFlags.push({
        stage: 4,
        field: `training_${trn.id}`,
        message_ar: `الصياغة المقترحة لقسم (${trn.institution_ar}) بانتظار موافقة صاحب السيرة قبل اعتمادها النهائي.`,
        message_en: `Suggested CV wording for ${trn.institution_en} is marked as a suggestion awaiting owner review and approval.`,
      });
    }
    evidenceConfidenceList.push({
      section: 'Clinical Training & Internship',
      fact_en: `${trn.institution_en} (${trn.total_duration_en}) — Supervised training/internship`,
      fact_ar: `${trn.institution_ar} (${trn.total_duration_ar}) — تدريب سريري/امتياز تحت الإشراف`,
      source: trn.source,
      status: trn.draft_approval_status === 'approved' ? 'user_confirmed' : 'draft_wording',
      has_document: Boolean(trn.supporting_upload_id),
    });
  }

  // 7. Check Modality Competency Separation (MRI, Ultrasound, Fluoroscopy) (Stage 5)
  const internshipModalities = modalities.filter((m) => m.experience_category === 'internship_exposure');
  const workModalitiesUnconfirmed = modalities.filter(
    (m) => m.experience_category === 'independent_work' && m.confirmation_state === 'needs_confirmation'
  );

  if (workModalitiesUnconfirmed.length > 0) {
    needsConfirmationFlags.push({
      stage: 5,
      field: 'modality_competencies',
      message_ar: `يوجد (${workModalitiesUnconfirmed.length}) أجهزة/أقسام مختارة كخبرة عملية تحتاج لتأكيد عدد السنوات والجهة ومستوى الاستقلالية.`,
      message_en: `${workModalitiesUnconfirmed.length} work modalities require confirmation of years, workplace setting, and independence level.`,
    });
  }

  // 8. Check Licenses & Saudi Classification (Stage 8 & 11)
  const unconfirmedLicenses = licenses.filter((l) => l.confirmation_state === 'needs_confirmation');
  if (unconfirmedLicenses.length > 0) {
    needsConfirmationFlags.push({
      stage: 8,
      field: 'licenses',
      message_ar: `بيانات جهة الإصدار وتاريخ الترخيص/القيد النقابي وحالة التصنيف السعودي تحتاج إلى مراجعة وتأكيد.`,
      message_en: `License issuing authority details, dates, and Saudi classification status require confirmation.`,
    });
  }

  return {
    readyForFinalCv: essentialMissing.length === 0 && needsConfirmationFlags.length === 0,
    canExportDraftNow: true, // Always allow partial draft export at any completion percentage!
    essentialMissing,
    needsConfirmationFlags,
    conflictsAndWarnings,
    evidenceConfidenceList,
    summaryCounts: {
      essentialMissingCount: essentialMissing.length,
      needsConfirmationCount: needsConfirmationFlags.length,
      conflictsCount: conflictsAndWarnings.length,
      internshipOnlyModalitiesCount: internshipModalities.length,
    },
  };
}

function parseJobDescriptionAgainstProfile(jobDescriptionText, profileBundle) {
  const text = String(jobDescriptionText || '').trim();
  if (!text) {
    return {
      parsed: false,
      keywordsDetected: [],
      matchMatrix: [],
    };
  }

  const { modalities = [], education = [], training = [], answersMap = {} } = profileBundle;
  const modMap = {};
  for (const m of modalities) {
    modMap[m.modality_code] = m;
  }

  const candidateChecks = [
    {
      keyword_en: 'General X-Ray / Radiography (DR/CR)',
      keyword_ar: 'الأشعة السينية العامة (X-Ray)',
      regex: /(x-ray|xray|radiography|أشعة\s*عادية|أشعة\s*سينية)/i,
      modalityCode: 'general_xray',
    },
    {
      keyword_en: 'CT Scan (Computed Tomography)',
      keyword_ar: 'الأشعة المقطعية (CT)',
      regex: /\b(ct|computed\s*tomography|مقطعية)\b/i,
      modalityCode: 'ct',
    },
    {
      keyword_en: 'MRI (Magnetic Resonance Imaging)',
      keyword_ar: 'الرنين المغناطيسي (MRI)',
      regex: /\b(mri|magnetic\s*resonance|رنين)\b/i,
      modalityCode: 'mri',
    },
    {
      keyword_en: 'Ultrasound / Sonography',
      keyword_ar: 'الموجات فوق الصوتية (Ultrasound)',
      regex: /\b(ultrasound|sonograph|سونار|موجات\s*فوق\s*صوتية)\b/i,
      modalityCode: 'ultrasound',
    },
    {
      keyword_en: 'Fluoroscopy / C-Arm',
      keyword_ar: 'التنظير التألقي وغرف العمليات (Fluoroscopy / C-Arm)',
      regex: /\b(fluoroscop|c-arm|تنظير\s*تألقي|عمليات)\b/i,
      modalityCode: 'fluoroscopy',
    },
    {
      keyword_en: 'Mammography',
      keyword_ar: 'تصوير الثدي (Mammography)',
      regex: /\b(mammograph|ماموجرام|تصوير\s*الثدي)\b/i,
      modalityCode: 'mammography',
    },
    {
      keyword_en: 'Interventional Radiology',
      keyword_ar: 'الأشعة التداخلية',
      regex: /\b(interventional|cath\s*lab|تداخلية|قسطرة)\b/i,
      modalityCode: 'interventional',
    },
    {
      keyword_en: 'Emergency & Trauma Imaging',
      keyword_ar: 'أشعة الطوارئ والحوادث',
      regex: /\b(emergency|trauma|er\b|طوارئ|حوادث|إصابات)\b/i,
      modalityCode: 'emergency',
    },
    {
      keyword_en: 'ICU & Portable Radiography',
      keyword_ar: 'الأشعة المتنقلة والعناية المركزة',
      regex: /\b(icu|portable|mobile|bedside|متنقلة|عناية\s*مركزة)\b/i,
      modalityCode: 'icu_bedside',
    },
    {
      keyword_en: 'PACS / RIS / DICOM Systems',
      keyword_ar: 'أنظمة PACS و RIS و DICOM',
      regex: /\b(pacs|ris|dicom|أرشفة)\b/i,
      customCheck: () => ({
        status: 'supported_in_training_needs_work_confirmation',
        evidence_en: 'Selected in Benha University Hospital clinical training; confirm workplace PACS/RIS usage in Stage 6.',
        evidence_ar: 'مؤكدة ضمن التدريب السريري بمستشفى بنها الجامعي؛ يُنصح بتأكيد استخدامها في العمل بالمرحلة 6.',
      }),
    },
    {
      keyword_en: 'Saudi Commission Classification (SCFHS) / DataFlow',
      keyword_ar: 'التصنيف المهني السعودي (SCFHS) / الداتافلو',
      regex: /\b(scfhs|dataflow|saudi\s*commission|classification|تصنيف|هيئة\s*التخصصات|داتافلو)\b/i,
      customCheck: () => ({
        status: 'missing_or_needs_confirmation',
        evidence_en: 'Status is currently marked "Needs Official Confirmation / Not started". Never claim active SCFHS licensing until officially issued.',
        evidence_ar: 'الحالة الحالية "تحتاج لتأكيد رسمي / لم تبدأ". لا تدّعِ وجود تصنيف ساري إلا بعد صدوره رسميًا.',
      }),
    },
  ];

  const matchMatrix = [];
  for (const item of candidateChecks) {
    if (item.regex.test(text)) {
      if (item.customCheck) {
        const res = item.customCheck();
        matchMatrix.push({
          requirement_en: item.keyword_en,
          requirement_ar: item.keyword_ar,
          match_status: res.status,
          evidence_en: res.evidence_en,
          evidence_ar: res.evidence_ar,
          safe_to_claim_independently: false,
        });
      } else if (item.modalityCode) {
        const mod = modMap[item.modalityCode];
        if (!mod || mod.experience_category === 'no_experience') {
          matchMatrix.push({
            requirement_en: item.keyword_en,
            requirement_ar: item.keyword_ar,
            match_status: 'not_recorded',
            evidence_en: 'Not recorded in your profile. Do not add to CV unless you genuinely have this experience.',
            evidence_ar: 'غير مسجلة في ملفك الحالي. لا تضفها للسيرة إلا إذا كانت لديك خبرة حقيقية فيها.',
            safe_to_claim_independently: false,
          });
        } else if (mod.experience_category === 'internship_exposure') {
          matchMatrix.push({
            requirement_en: item.keyword_en,
            requirement_ar: item.keyword_ar,
            match_status: 'internship_exposure_only',
            evidence_en: 'Recorded as 6-month Internship rotation ONLY (El-Shohada Central Hospital). Must NOT be claimed as independent work experience.',
            evidence_ar: 'مسجلة كمرور تدريبي خلال الامتياز فقط (مستشفى الشهداء المركزي). لا يجوز ادعاؤها كخبرة عمل مستقلة.',
            safe_to_claim_independently: false,
          });
        } else {
          matchMatrix.push({
            requirement_en: item.keyword_en,
            requirement_ar: item.keyword_ar,
            match_status: 'experience_recorded',
            evidence_en: `Selected as work experience (${mod.confirmation_state === 'user_confirmed' ? 'Confirmed' : 'Pending Stage 5 detail confirmation'}).`,
            evidence_ar: `مختارة ضمن مجالات الخبرة العملية (${mod.confirmation_state === 'user_confirmed' ? 'مؤكدة' : 'بانتظار استكمال تفاصيل المرحلة 5'}).`,
            safe_to_claim_independently: true,
          });
        }
      }
    }
  }

  return {
    parsed: true,
    totalRequirementsFound: matchMatrix.length,
    matchMatrix,
    honestTailoringAdvice_ar:
      'تم استخراج الكلمات المفتاحية ومقارنتها ببياناتك المؤكدة فقط. لن يقوم النظام بإضافة أي جهاز أو ترخيص غير مؤكد إلى سيرتك الذاتية.',
    honestTailoringAdvice_en:
      'Keywords were matched strictly against your recorded evidence. Unconfirmed skills or internship-only rotations will never be auto-claimed as independent competencies.',
  };
}

module.exports = {
  checkPatientIdentifierRisk,
  generateSuggestedBulletsForEmployment,
  analyzeProfileQualityAndTruth,
  parseJobDescriptionAgainstProfile,
};
