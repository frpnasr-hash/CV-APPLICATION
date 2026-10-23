const fs = require('node:fs');
const path = require('node:path');

const requiredFiles = [
  'src/server.js',
  'src/db/database.js',
  'src/middleware/auth.js',
  'src/data/glossary-and-questions.js',
  'src/services/seed-service.js',
  'src/services/assistant-service.js',
  'src/services/upload-service.js',
  'src/services/export-service.js',
  'src/services/profile-and-admin-service.js',
  'public/index.html',
  'public/css/styles.css',
  'public/js/app.js',
  '.env.example',
];

let missing = 0;
for (const rel of requiredFiles) {
  const full = path.resolve(process.cwd(), rel);
  if (!fs.existsSync(full)) {
    console.error('Missing required build artifact:', rel);
    missing++;
  }
}

if (missing > 0) {
  process.exit(1);
}
console.log('Build & static verification passed: all required backend and frontend modules present.');
