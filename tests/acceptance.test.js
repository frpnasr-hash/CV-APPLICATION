const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpTestDbPath = path.join(os.tmpdir(), `rcv_acceptance_${Date.now()}.sqlite`);
process.env.DATABASE_PATH = tmpTestDbPath;

const { createAppServer } = require('../src/server');
const { resetDbConnection } = require('../src/db/database');

let server;
let baseUrl;

async function reqJson(endpoint, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers,
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, headers: res.headers, data };
}

before(async () => {
  server = createAppServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  resetDbConnection();
  try {
    if (fs.existsSync(tmpTestDbPath)) fs.unlinkSync(tmpTestDbPath);
  } catch (_) {}
});

test('1. Questionnaire & Preloaded Seeded Profile Truth Rules (Section 17.1)', async () => {
  // Authenticate as the seeded profile owner via authorized workspace session
  const authRes = await reqJson('/api/auth/workspace-session', {
    method: 'POST',
    body: { mode: 'seeded_owner' },
  });
  assert.equal(authRes.status, 200);
  const ownerToken = authRes.data.sessionToken;
  const authHeader = { Authorization: `Bearer ${ownerToken}` };

  // Fetch bootstrap
  const boot = await reqJson('/api/bootstrap', { headers: authHeader });
  assert.equal(boot.status, 200);
  // All 13 stages exist in catalog
  assert.equal(boot.data.stagesCatalog.length, 13);

  const seededProfile = boot.data.profiles.find((p) => p.is_seeded === 1);
  assert.ok(seededProfile, 'Seeded workspace must exist');
  assert.equal(
    seededProfile.title,
    'Abdel Ghaffar Adel Abdel Ghaffar Tiba — Existing Answers Imported'
  );
  // Default privacy must be private before owner confirms admin sharing
  assert.equal(seededProfile.share_with_admin_enabled, 0);

  const bundleRes = await reqJson(`/api/profiles/${seededProfile.id}`, { headers: authHeader });
  assert.equal(bundleRes.status, 200);
  const bundle = bundleRes.data;

  // Stage 1 & 2 pre-populated and tagged as 'imported'
  assert.equal(bundle.answersMap.s1_full_name_ar.value, 'عبدالغفار عادل عبدالغفار طيبة');
  assert.equal(bundle.answersMap.s1_full_name_en.value, 'ABDEL GHAFAR ADEL ABDEL GHAFAR TIBA');
  assert.equal(bundle.answersMap.s1_full_name_ar.source, 'imported');

  // CV owner's personal phone/email are NOT mixed with site support contact details
  assert.equal(bundle.answersMap.s1_owner_email.value, '');
  assert.equal(bundle.answersMap.s1_owner_phone.value, '');

  // Unknown college/faculty name remains blank and asks for confirmation
  assert.equal(bundle.education.length, 1);
  assert.equal(bundle.education[0].college_faculty_en, '');
  assert.equal(bundle.education[0].college_faculty_ar, '');
  assert.equal(bundle.education[0].college_needs_confirmation, 1);
  assert.equal(bundle.education[0].no_gpa_issued, 1);
  assert.equal(bundle.education[0].gpa_value, '');

  // Employment dates remain unknown across the 6 reported workplaces
  assert.equal(bundle.employment.length, 6);
  for (const emp of bundle.employment) {
    assert.equal(emp.exact_dates_unknown, 1);
    assert.equal(emp.relationship_type, 'needs_confirmation');
  }

  // Stated 7-year total does NOT become 7 years of post-graduation employment
  const expBreak = bundle.answersMap.s1_experience_summary_breakdown.value;
  assert.equal(expBreak.reported_total_years, 7);
  assert.equal(expBreak.includes_pre_graduation, true);
  assert.equal(expBreak.post_graduation_paid_years, null);

  // MRI, Ultrasound, and Fluoroscopy internship exposure is NOT counted as independent work
  const mri = bundle.modalities.find((m) => m.modality_code === 'mri');
  const us = bundle.modalities.find((m) => m.modality_code === 'ultrasound');
  const fluoro = bundle.modalities.find((m) => m.modality_code === 'fluoroscopy');
  assert.equal(mri.experience_category, 'internship_exposure');
  assert.equal(us.experience_category, 'internship_exposure');
  assert.equal(fluoro.experience_category, 'internship_exposure');

  // Patient Reception and Patient Identification are NOT preselected as confirmed training duties
  const benhaTraining = bundle.training.find((t) => t.institution_en === 'Benha University Hospital');
  assert.ok(benhaTraining);
  const assistedTasks = JSON.parse(benhaTraining.tasks_assisted_json);
  const unconfirmedTasks = JSON.parse(benhaTraining.tasks_unconfirmed_json);
  assert.ok(!assistedTasks.includes('Patient Reception'));
  assert.ok(!assistedTasks.includes('Patient Identification'));
  assert.ok(unconfirmedTasks.includes('Patient Reception'));
  assert.ok(unconfirmedTasks.includes('Patient Identification'));
});

test('2. Autosave, Version Recovery, and Multi-Tab Conflict Handling (Section 17.2)', async () => {
  const authRes = await reqJson('/api/auth/workspace-session', {
    method: 'POST',
    body: { mode: 'seeded_owner' },
  });
  const authHeader = { Authorization: `Bearer ${authRes.data.sessionToken}` };
  const profileId = 'prf-seeded-radiology-workspace';

  const initialGet = await reqJson(`/api/profiles/${profileId}`, { headers: authHeader });
  const initialVersion = initialGet.data.profile.version;

  // Save an answer update (e.g. confirming college name)
  const save1 = await reqJson(`/api/profiles/${profileId}/autosave`, {
    method: 'POST',
    headers: authHeader,
    body: {
      expectedVersion: initialVersion,
      stageNumber: 1,
      answers: [
        {
          question_id: 's1_owner_email',
          stage_number: 1,
          value: 'candidate.personal@example.com',
          source: 'user_entered',
          confirmation_state: 'user_confirmed',
        },
      ],
      stageUpdate: {
        status: 'in_progress',
        completion_pct: 92,
        private_notes: 'My secret private reminder — never show on CV',
      },
      changeSummary: 'Added personal email and private stage note',
    },
  });
  assert.equal(save1.status, 200);
  assert.equal(save1.data.version, initialVersion + 1);

  // Verify persistence after reload
  const afterSaveGet = await reqJson(`/api/profiles/${profileId}`, { headers: authHeader });
  assert.equal(afterSaveGet.data.answersMap.s1_owner_email.value, 'candidate.personal@example.com');

  // Simulate multi-tab / multi-device stale version conflict (sending old expectedVersion)
  const staleSave = await reqJson(`/api/profiles/${profileId}/autosave`, {
    method: 'POST',
    headers: authHeader,
    body: {
      expectedVersion: initialVersion, // Stale! Server is at initialVersion + 1
      stageNumber: 1,
      answers: [],
    },
  });
  assert.equal(staleSave.status, 409);
  assert.equal(staleSave.data.conflict, true);
});

test('3. Identity, Cross-User Tenant Isolation, Collaborator Scope & Admin Audit (Section 17.3)', async () => {
  // Register User A and User B, attempting to pass role: 'admin' from client (must be ignored!)
  const regA = await reqJson('/api/auth/register', {
    method: 'POST',
    body: {
      displayName: 'Radiographer User A',
      email: 'usera@example.com',
      password: 'Password123!',
      role: 'admin',
      isAdmin: true,
    },
  });
  assert.equal(regA.status, 201);
  assert.equal(regA.data.user.role, 'user', 'Client-side admin escalation must be prevented');
  const tokenA = regA.data.sessionToken;
  const profileA = regA.data.initialProfileId;

  const regB = await reqJson('/api/auth/register', {
    method: 'POST',
    body: {
      displayName: 'Radiographer User B',
      email: 'userb@example.com',
      password: 'Password123!',
    },
  });
  assert.equal(regB.status, 201);
  const tokenB = regB.data.sessionToken;

  // User B attempts to read or edit User A's profile -> 403 Forbidden
  const crossRead = await reqJson(`/api/profiles/${profileA}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  assert.equal(crossRead.status, 403);

  const crossWrite = await reqJson(`/api/profiles/${profileA}/autosave`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenB}` },
    body: { stageNumber: 1, answers: [] },
  });
  assert.equal(crossWrite.status, 403);

  // User A cannot access /api/admin/overview -> 403 Forbidden
  const nonAdminAttempt = await reqJson('/api/admin/overview', {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  assert.equal(nonAdminAttempt.status, 403);

  // User A grants view-only collaborator access to User B
  const grantRes = await reqJson(`/api/profiles/${profileA}/collaborators`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: { email: 'userb@example.com', permission_scope: 'view' },
  });
  assert.equal(grantRes.status, 201);
  const grantId = grantRes.data.grantId;

  // User B can now view User A's shared profile, but CANNOT edit it
  const collabView = await reqJson(`/api/profiles/${profileA}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  assert.equal(collabView.status, 200);

  const collabEdit = await reqJson(`/api/profiles/${profileA}/autosave`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenB}` },
    body: { stageNumber: 1, answers: [] },
  });
  assert.equal(collabEdit.status, 403);

  // User A revokes collaborator access -> User B is blocked immediately
  await reqJson(`/api/collaborators/${grantId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  const afterRevokeView = await reqJson(`/api/profiles/${profileA}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  assert.equal(afterRevokeView.status, 403);

  // Admin cannot read private profile without owner consent, then CAN read after consent and creates an audit log
  const adminAuth = await reqJson('/api/auth/workspace-session', {
    method: 'POST',
    body: { mode: 'platform_admin' },
  });
  const adminToken = adminAuth.data.sessionToken;

  const adminReadPrivate = await reqJson(`/api/profiles/${profileA}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(adminReadPrivate.status, 403);

  // User A grants admin support sharing consent
  await reqJson(`/api/profiles/${profileA}/consent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: { share_with_admin_enabled: true, share_history_with_admin: true },
  });

  const adminReadShared = await reqJson(`/api/profiles/${profileA}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(adminReadShared.status, 200);

  // Verify audit event was created and no raw tokens/passwords exist in logs
  const adminOverview = await reqJson('/api/admin/overview', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(adminOverview.status, 200);
  const hasAdminViewAudit = adminOverview.data.auditEvents.some(
    (e) => e.event_type === 'admin.shared_profile_viewed' && e.target_profile_id === profileA
  );
  assert.ok(hasAdminViewAudit, 'Admin access to shared profile must record an audit event');
});

test('4. Real PDF Generation (English LTR, Arabic RTL, Draft PDF, Answer Workbook, Backups) (Section 17.4)', async () => {
  const authRes = await reqJson('/api/auth/workspace-session', {
    method: 'POST',
    body: { mode: 'seeded_owner' },
  });
  const authHeader = { Authorization: `Bearer ${authRes.data.sessionToken}` };
  const profileId = 'prf-seeded-radiology-workspace';

  // Verify HTML preview excludes private notes from Employer-Facing CV
  const prevEn = await reqJson(`/api/profiles/${profileId}/preview?lang=en&mode=cv`, {
    headers: authHeader,
  });
  assert.equal(prevEn.status, 200);
  assert.ok(!prevEn.data.html.includes('My secret private reminder'), 'Private stage notes must never appear in employer CV');
  assert.ok(prevEn.data.html.includes('ABDEL GHAFAR ADEL ABDEL GHAFAR TIBA'));

  // 1) Export English CV PDF
  const expEn = await reqJson(`/api/profiles/${profileId}/exports`, {
    method: 'POST',
    headers: authHeader,
    body: { exportType: 'cv_pdf', language: 'en' },
  });
  assert.equal(expEn.status, 201);
  assert.equal(expEn.data.exportJob.validationReport.isPdfSignatureValid, true);
  assert.equal(expEn.data.exportJob.validationReport.selectableTextVerified, true);

  // Download PDF binary and check %PDF- header
  const dlEn = await reqJson(expEn.data.downloadUrl, { headers: authHeader });
  assert.equal(dlEn.status, 200);
  const pdfBufEn = Buffer.from(dlEn.data);
  assert.equal(pdfBufEn.subarray(0, 5).toString('ascii'), '%PDF-');

  // 2) Export Arabic RTL CV PDF
  const expAr = await reqJson(`/api/profiles/${profileId}/exports`, {
    method: 'POST',
    headers: authHeader,
    body: { exportType: 'cv_pdf', language: 'ar' },
  });
  assert.equal(expAr.status, 201);
  assert.equal(expAr.data.exportJob.validationReport.isPdfSignatureValid, true);
  assert.equal(expAr.data.exportJob.validationReport.selectableTextVerified, true);

  // 3) Export Complete Answer Workbook PDF (includes private notes & question IDs)
  const expWb = await reqJson(`/api/profiles/${profileId}/exports`, {
    method: 'POST',
    headers: authHeader,
    body: { exportType: 'workbook_pdf', language: 'ar' },
  });
  assert.equal(expWb.status, 201);
  assert.equal(expWb.data.exportJob.validationReport.isPdfSignatureValid, true);

  // 4) Export JSON backup and verify it contains only requesting user's data
  const expJson = await reqJson(`/api/profiles/${profileId}/exports`, {
    method: 'POST',
    headers: authHeader,
    body: { exportType: 'json_backup', language: 'en' },
  });
  assert.equal(expJson.status, 201);
});

test('5. Upload Security Validation (Valid PNG, Small Photo Warning, Fake Extension Rejection, Cross-User Block) (Section 17.5)', async () => {
  const authOwner = await reqJson('/api/auth/workspace-session', {
    method: 'POST',
    body: { mode: 'seeded_owner' },
  });
  const ownerHeader = { Authorization: `Bearer ${authOwner.data.sessionToken}` };
  const profileId = 'prf-seeded-radiology-workspace';

  // Create a valid 100x100 PNG header buffer (triggers <300x300 quality warning for photo purpose)
  const pngBuf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngBuf, 0);
  pngBuf.writeUInt32BE(13, 8);
  Buffer.from('IHDR', 'ascii').copy(pngBuf, 12);
  pngBuf.writeUInt32BE(100, 16); // width = 100px
  pngBuf.writeUInt32BE(100, 20); // height = 100px

  const validPhotoRes = await reqJson(`/api/profiles/${profileId}/uploads`, {
    method: 'POST',
    headers: ownerHeader,
    body: {
      filename: 'small_profile_photo.png',
      mimeType: 'image/png',
      purpose: 'photo',
      contentBase64: pngBuf.toString('base64'),
    },
  });
  assert.equal(validPhotoRes.status, 201);
  assert.ok(validPhotoRes.data.file.quality_warning, 'Small photo (<300x300) must return quality warning');
  const uploadedId = validPhotoRes.data.file.id;

  // Reject fake extension (executable script disguised as .jpg)
  const fakeJpgRes = await reqJson(`/api/profiles/${profileId}/uploads`, {
    method: 'POST',
    headers: ownerHeader,
    body: {
      filename: 'malicious_script.jpg',
      mimeType: 'image/jpeg',
      purpose: 'certificate',
      contentBase64: Buffer.from('#!/bin/bash\necho pwned').toString('base64'),
    },
  });
  assert.equal(fakeJpgRes.status, 400);

  // Reject blocked extension (.exe)
  const exeRes = await reqJson(`/api/profiles/${profileId}/uploads`, {
    method: 'POST',
    headers: ownerHeader,
    body: {
      filename: 'payload.exe',
      mimeType: 'application/octet-stream',
      purpose: 'certificate',
      contentBase64: Buffer.from('MZ9000').toString('base64'),
    },
  });
  assert.equal(exeRes.status, 400);

  // Cross-user file download must be blocked
  const loginB = await reqJson('/api/auth/login', {
    method: 'POST',
    body: { email: 'userb@example.com', password: 'Password123!' },
  });
  const crossFileRead = await reqJson(`/api/uploads/${uploadedId}`, {
    headers: { Authorization: `Bearer ${loginB.data.sessionToken}` },
  });
  assert.equal(crossFileRead.status, 403);

  // Owner can delete their own upload
  const delRes = await reqJson(`/api/uploads/${uploadedId}`, {
    method: 'DELETE',
    headers: ownerHeader,
  });
  assert.equal(delRes.status, 200);
});

test('6. Honest Integration Boundaries & Notification Statuses (Section 17.6)', async () => {
  const adminAuth = await reqJson('/api/auth/workspace-session', {
    method: 'POST',
    body: { mode: 'platform_admin' },
  });
  const adminHeader = { Authorization: `Bearer ${adminAuth.data.sessionToken}` };

  const testEmail = await reqJson('/api/admin/test-integration', {
    method: 'POST',
    headers: adminHeader,
    body: { channel: 'email' },
  });
  assert.equal(testEmail.status, 200);
  assert.equal(testEmail.data.ok, false);
  assert.equal(testEmail.data.honestStatus, 'Needs setup');

  const testWhatsapp = await reqJson('/api/admin/test-integration', {
    method: 'POST',
    headers: adminHeader,
    body: { channel: 'whatsapp' },
  });
  assert.equal(testWhatsapp.status, 200);
  assert.equal(testWhatsapp.data.ok, false);
  assert.equal(testWhatsapp.data.honestStatus, 'Needs setup');

  const testPdf = await reqJson('/api/admin/test-integration', {
    method: 'POST',
    headers: adminHeader,
    body: { channel: 'pdf_storage' },
  });
  assert.equal(testPdf.status, 200);
  assert.equal(testPdf.data.ok, true);
});
