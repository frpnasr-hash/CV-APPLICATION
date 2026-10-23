# Radiology CV Studio | استوديو السيرة الذاتية للأشعة والتصوير الطبي

A production-minded, bilingual (Arabic RTL & English LTR), multi-user CV and professional profile studio designed exclusively for **radiology, diagnostic imaging, and medical-imaging professionals**.

- **Site Creator / إعداد وتطوير:** Abd-el-Rahman Adel Teba
- **Support Email / بريد الدعم:** `frp.nasr@gmail.com`
- **Support Phone / هاتف الدعم:** `01091874291`

---

## 1. Key Capabilities & Non-Negotiable Truth Rules

1. **13 Guided Stage Pages:**
   - **Stage 1:** Personal Profile, Current Status, and Career Target (with ranked job titles & honest experience breakdown).
   - **Stage 2:** Education and Academic Qualifications (exact diploma wording, blank faculty confirmation prompt, no invented GPA).
   - **Stage 3:** Professional Employment and Career History (repeatable cards, concurrent overlap clarification, no assumed full-time schedule).
   - **Stage 4:** Clinical Training, Rotations, and Internship (strictly separated from independent paid employment; conservative supervised wording).
   - **Stage 5:** Imaging Modalities and Competency Matrix (14+ modalities separating hands-on work from internship-only rotations such as MRI, Ultrasound, and Fluoroscopy).
   - **Stage 6:** Procedures, Technical Workflows, Contrast Scope, PACS/RIS/DICOM, and Radiation Safety.
   - **Stage 7:** Achievements, Problem Solving, Workload, and Impact (Situation–Action–Result templates without fabricated numbers or patient identifiers).
   - **Stage 8:** Licenses, Syndicate Registration, Saudi Classification (SCFHS / DataFlow), and CPD.
   - **Stage 9:** Languages, Digital Skills, Communication, and Evidence-Based Professional Strengths.
   - **Stage 10:** Teaching, Research, Publications, Memberships, and Leadership (optional; cleanly omitted when empty).
   - **Stage 11:** Saudi Arabia Readiness Checklist and Honest Job Description Parser & Match Matrix.
   - **Stage 12:** Professional References and Secure Document/Photo Upload Manager (magic-byte MIME signature validation, size quotas, JPEG EXIF/GPS stripping, small-photo quality warning).
   - **Stage 13:** Final Quality Review, Evidence & Provenance Panel, Live CV Composer, Real Server-Side PDF/DOCX/Workbook Exports, and Expiring Share Links.

2. **Private Runtime Seeding (Section 6 & Section 19.B):**
   - No private personal data or user uploads are hardcoded in committed repository files.
   - At runtime, `npm run seed` (or server startup) reads the private specification file from `PRIVATE_SEED_FILE` and populates the private local SQLite database (`runtime-data/radiology_cv_studio.sqlite`, excluded via `.gitignore`).

---

## 2. Folder & Route Structure

```text
/home/user/webapp
├── .env.example                           # Environment variables template (placeholders only)
├── .gitignore                             # Excludes .env, runtime-data/, *.sqlite, uploads, exports
├── package.json                           # Scripts: start, migrate, seed, backup, restore, test, build
├── src/
│   ├── server.js                          # HTTP & REST API server + static SPA router
│   ├── db/
│   │   └── database.js                    # Normalized 25-table SQLite WAL schema, migrations & PII redaction
│   ├── middleware/
│   │   └── auth.js                        # HttpOnly session auth, RBAC, tenant isolation & audit logger
│   ├── data/
│   │   └── glossary-and-questions.js      # Bilingual AR/EN radiology glossary, 13 stages & question catalog
│   └── services/
│       ├── seed-service.js                # Private runtime parser & database seeder
│       ├── assistant-service.js           # Truth-preserving bullet generator, quality analyzer & JD parser
│       ├── upload-service.js              # Magic-byte MIME verification, EXIF stripper & quota enforcer
│       ├── export-service.js              # Real PDF (LibreOffice Writer + Arabic fonts), Workbook & DOCX engine
│       └── profile-and-admin-service.js   # Profile bundler, integration status checker & notification router
├── public/
│   ├── index.html                         # Bilingual RTL/LTR responsive application shell
│   ├── css/styles.css                     # Healthcare palette, Light/Dark themes, accessible focus styles
│   └── js/app.js                          # 13-stage guided UI, IndexedDB offline draft store & live preview
├── scripts/
│   ├── migrate.js                         # Runs schema migrations
│   ├── seed-runtime.js                    # Seeds definitions and private workspace if local spec is present
│   ├── backup-restore.js                  # Database snapshot backup and verified restore CLI
│   └── verify-build.js                    # Production artifact verification
├── tests/
│   └── acceptance.test.js                 # End-to-end automated acceptance test suite (Section 17)
└── docs/
    ├── GUIDES_AR_EN.md                    # Deployment, Migrations, Backup/Restore, Admin & User Guides (AR/EN)
    └── ACCEPTANCE_AND_PRELAUNCH_REPORT.md # Feature Matrix, Acceptance Test Results & Pre-Launch Checklist
```

---

## 3. Quick Start Commands

```bash
# 1. Run database migrations
npm run migrate

# 2. Seed glossary, question catalog, and private runtime workspace
npm run seed

# 3. Run the automated acceptance test suite
npm test

# 4. Create and test a database backup
npm run backup
npm run restore

# 5. Start the server
npm start
```
