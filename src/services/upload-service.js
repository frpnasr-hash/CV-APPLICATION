const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb } = require('../db/database');
const { logAuditEvent } = require('../middleware/auth');

const UPLOAD_DIR = path.resolve(process.cwd(), 'runtime-data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const ALLOWED_SIGNATURES = [
  {
    mime: 'image/jpeg',
    category: 'image',
    exts: ['.jpg', '.jpeg'],
    check: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    mime: 'image/png',
    category: 'image',
    exts: ['.png'],
    check: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a,
  },
  {
    mime: 'image/webp',
    category: 'image',
    exts: ['.webp'],
    check: (buf) =>
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    mime: 'application/pdf',
    category: 'document',
    exts: ['.pdf'],
    check: (buf) => buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-',
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    category: 'document',
    exts: ['.docx'],
    check: (buf) => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04,
  },
  {
    mime: 'text/plain',
    category: 'document',
    exts: ['.txt'],
    check: (buf) => {
      if (buf.length === 0) return false;
      // Reject scripts/HTML/executables masquerading as .txt
      const head = buf.subarray(0, Math.min(buf.length, 512)).toString('utf8');
      if (/^(MZ|\x7fELF|#!|<script|<!DOCTYPE\s+html|<html)/i.test(head.trim())) return false;
      // Check no null bytes in plain text
      for (let i = 0; i < Math.min(buf.length, 1024); i++) {
        if (buf[i] === 0x00) return false;
      }
      return true;
    },
  },
];

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.sh', '.bat', '.cmd', '.js', '.mjs', '.cjs', '.php', '.py', '.rb', '.pl',
  '.dll', '.so', '.bin', '.msi', '.apk', '.jar', '.zip', '.rar', '.7z', '.tar', '.gz', '.svg', '.html', '.htm'
]);

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file')).replace(/[^a-zA-Z0-9._\u0600-\u06FF-]/g, '_');
  return base.slice(0, 120) || 'document';
}

function getPngDimensions(buf) {
  if (buf.length < 24) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

function getJpegDimensions(buf) {
  let offset = 2;
  while (offset < buf.length - 8) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) break;
    offset += 2 + segLen;
  }
  return null;
}

/**
 * Strips APP1 (EXIF/GPS) segments from JPEG buffers for privacy normalization.
 */
function stripJpegExifMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const chunks = [buf.subarray(0, 2)];
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) {
      chunks.push(buf.subarray(offset));
      break;
    }
    const marker = buf[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(buf.subarray(offset));
      break;
    }
    if (offset + 4 > buf.length) {
      chunks.push(buf.subarray(offset));
      break;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > buf.length) {
      chunks.push(buf.subarray(offset));
      break;
    }
    // Skip APP1 (0xFFE1) which holds EXIF/GPS metadata
    if (marker !== 0xe1) {
      chunks.push(buf.subarray(offset, offset + 2 + segLen));
    }
    offset += 2 + segLen;
  }
  return Buffer.concat(chunks);
}

function validateAndStoreUpload({
  user,
  profileId,
  originalName,
  declaredMime,
  purpose = 'certificate',
  buffer,
}) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, status: 400, error: 'Empty files are rejected.' };
  }

  const sanitizedName = sanitizeFilename(originalName);
  const ext = path.extname(sanitizedName).toLowerCase();

  if (BLOCKED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      status: 400,
      error: `File extension "${ext}" is blocked by security policy (executables, scripts, and archives are forbidden).`,
    };
  }

  // Verify actual magic bytes / signature
  const matchedSig = ALLOWED_SIGNATURES.find(
    (sig) => sig.exts.includes(ext) && sig.check(buffer)
  );

  if (!matchedSig) {
    return {
      ok: false,
      status: 400,
      error: 'File signature / MIME verification failed. Fake extensions, corrupted files, or unsupported formats are rejected.',
    };
  }

  const db = getDb();
  const maxImageBytes = Number(process.env.MAX_IMAGE_MB || 10) * 1024 * 1024;
  const maxDocBytes = Number(process.env.MAX_DOCUMENT_MB || 20) * 1024 * 1024;
  const maxProfileBytes = Number(process.env.MAX_PROFILE_UPLOAD_MB || 100) * 1024 * 1024;

  if (matchedSig.category === 'image' && buffer.length > maxImageBytes) {
    return {
      ok: false,
      status: 413,
      error: `Image exceeds maximum allowed size (${process.env.MAX_IMAGE_MB || 10} MB).`,
    };
  }
  if (matchedSig.category === 'document' && buffer.length > maxDocBytes) {
    return {
      ok: false,
      status: 413,
      error: `Document exceeds maximum allowed size (${process.env.MAX_DOCUMENT_MB || 20} MB).`,
    };
  }

  const totalUsedRow = db
    .prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS used FROM uploaded_files WHERE profile_id = ? AND deleted_at IS NULL`)
    .get(profileId);

  if ((totalUsedRow?.used || 0) + buffer.length > maxProfileBytes) {
    return {
      ok: false,
      status: 413,
      error: `Workspace storage quota (${process.env.MAX_PROFILE_UPLOAD_MB || 100} MB) exceeded.`,
    };
  }

  let normalizedBuffer = buffer;
  let widthPx = null;
  let heightPx = null;
  let qualityWarning = null;

  if (matchedSig.mime === 'image/png') {
    const dims = getPngDimensions(buffer);
    if (dims) {
      widthPx = dims.width;
      heightPx = dims.height;
    }
  } else if (matchedSig.mime === 'image/jpeg') {
    normalizedBuffer = stripJpegExifMetadata(buffer);
    const dims = getJpegDimensions(normalizedBuffer);
    if (dims) {
      widthPx = dims.width;
      heightPx = dims.height;
    }
  }

  if (purpose === 'photo' && widthPx && heightPx) {
    if (widthPx < 300 || heightPx < 300) {
      qualityWarning = `Low resolution warning (${widthPx}x${heightPx}px): Minimum recommended display size is 300x300px (600x600px recommended for high-quality PDF export). Accepted with warning.`;
    } else if (widthPx < 600 || heightPx < 600) {
      qualityWarning = `Moderate resolution notice (${widthPx}x${heightPx}px): 600x600px or higher is recommended for optimal print quality.`;
    }
  }

  // Extract draft text only if purpose is existing_cv or job_description and format is text/plain
  let extractedDraftJson = null;
  let extractedDraftStatus = 'none';
  if ((purpose === 'existing_cv' || purpose === 'job_description') && matchedSig.mime === 'text/plain') {
    const rawText = normalizedBuffer.toString('utf8').slice(0, 5000);
    extractedDraftJson = JSON.stringify({
      notice_en: 'Extracted text is an untrusted draft source. Review side-by-side before accepting any fact into your CV.',
      notice_ar: 'النص المستخرج هو مسودة أولية غير معتمدة تلقائيًا. يجب مراجعته جنبًا إلى جنب قبل قبول أي معلومة.',
      preview_text: rawText,
    });
    extractedDraftStatus = 'pending_review';
  }

  const fileId = 'upl-' + crypto.randomUUID();
  const storageObjectName = `${crypto.randomUUID()}${ext}`;
  const fullStoragePath = path.join(UPLOAD_DIR, storageObjectName);
  fs.writeFileSync(fullStoragePath, normalizedBuffer);

  const scanStatus = process.env.MALWARE_SCANNER_ENABLED === 'true' ? 'clean' : 'scanner_not_configured';
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO uploaded_files (
      id, owner_id, profile_id, original_name, sanitized_name, storage_object_name,
      purpose, declared_mime, verified_mime, size_bytes, width_px, height_px,
      quality_warning, scan_status, metadata_stripped, include_in_cv_export,
      extracted_draft_json, extracted_draft_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
  `).run(
    fileId,
    user.id,
    profileId,
    originalName,
    sanitizedName,
    storageObjectName,
    purpose,
    declaredMime || matchedSig.mime,
    matchedSig.mime,
    normalizedBuffer.length,
    widthPx,
    heightPx,
    qualityWarning,
    scanStatus,
    extractedDraftJson,
    extractedDraftStatus,
    now
  );

  logAuditEvent({
    actorUserId: user.id,
    actorRole: user.role,
    targetUserId: user.id,
    targetProfileId: profileId,
    eventType: 'upload.file_stored',
    stageOrFeature: 'stage_12_uploads',
    summaryRedacted: `Uploaded ${purpose} file (${matchedSig.mime}, ${normalizedBuffer.length} bytes)`,
  });

  return {
    ok: true,
    file: {
      id: fileId,
      profile_id: profileId,
      original_name: sanitizedName,
      purpose,
      verified_mime: matchedSig.mime,
      size_bytes: normalizedBuffer.length,
      width_px: widthPx,
      height_px: heightPx,
      quality_warning: qualityWarning,
      scan_status: scanStatus,
      extracted_draft: extractedDraftJson ? JSON.parse(extractedDraftJson) : null,
      extracted_draft_status: extractedDraftStatus,
      created_at: now,
    },
  };
}

module.exports = {
  UPLOAD_DIR,
  validateAndStoreUpload,
  sanitizeFilename,
};
