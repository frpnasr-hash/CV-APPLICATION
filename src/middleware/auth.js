const crypto = require('node:crypto');
const { getDb, redactPII } = require('../db/database');

const SESSION_COOKIE_NAME = 'rcv_session';

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    if (!value) return;
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(userId, req) {
  const db = getDb();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const ip = req?.socket?.remoteAddress || '127.0.0.1';
  const ua = req?.headers?.['user-agent'] || 'unknown';

  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, ip_address, user_agent, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tokenHash, userId, ip, ua.slice(0, 200), now.toISOString(), expiresAt);

  db.prepare(`UPDATE users SET last_sign_in_at = ?, updated_at = ? WHERE id = ?`)
    .run(now.toISOString(), now.toISOString(), userId);

  logAuditEvent({
    actorUserId: userId,
    actorRole: 'user',
    targetUserId: userId,
    eventType: 'auth.sign_in',
    stageOrFeature: 'authentication',
    summaryRedacted: 'User signed in and established a server-managed session',
  });

  return { rawToken, expiresAt };
}

function revokeSession(rawToken, userId) {
  if (!rawToken) return;
  const db = getDb();
  const tokenHash = hashSessionToken(rawToken);
  const now = new Date().toISOString();
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE token_hash = ?`).run(now, tokenHash);
  if (userId) {
    logAuditEvent({
      actorUserId: userId,
      actorRole: 'user',
      targetUserId: userId,
      eventType: 'auth.sign_out',
      stageOrFeature: 'authentication',
      summaryRedacted: 'User signed out and revoked session token',
    });
  }
}

function getAuthenticatedUser(req) {
  const db = getDb();
  const cookies = parseCookies(req.headers.cookie);
  let rawToken = cookies[SESSION_COOKIE_NAME];

  if (!rawToken && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    rawToken = req.headers.authorization.slice(7).trim();
  }

  if (!rawToken) return null;

  const tokenHash = hashSessionToken(rawToken);
  const session = db.prepare(`
    SELECT s.*, u.id as uid, u.email, u.phone, u.display_name, u.role, u.account_status, u.locale, u.theme, u.is_seeded_subject, u.mfa_enabled
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL
  `).get(tokenHash);

  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) return null;
  if (session.account_status !== 'active') return null;

  return {
    id: session.uid,
    email: session.email,
    phone: session.phone,
    displayName: session.display_name,
    role: session.role, // Server-side role only; never trust client isAdmin
    accountStatus: session.account_status,
    locale: session.locale,
    theme: session.theme,
    isSeededSubject: Boolean(session.is_seeded_subject),
    mfaEnabled: Boolean(session.mfa_enabled),
    sessionToken: rawToken,
  };
}

/**
 * Checks whether `user` can access `profileId` for `requiredPermission` ('view' | 'edit' | 'owner').
 * Enforces strict tenant isolation and logs administrator access to shared profiles.
 */
function checkProfileAccess(user, profileId, requiredPermission = 'view') {
  if (!user) return { allowed: false, status: 401, reason: 'Authentication required' };

  const db = getDb();
  const profile = db.prepare(`SELECT * FROM profiles WHERE id = ?`).get(profileId);
  if (!profile) {
    return { allowed: false, status: 404, reason: 'Profile not found or access denied' };
  }

  // 1. Profile Owner has full access
  if (profile.owner_id === user.id) {
    return { allowed: true, accessType: 'owner', profile };
  }

  // 2. Check explicit Collaborator Grant
  const grant = db.prepare(`
    SELECT * FROM access_grants
    WHERE profile_id = ?
      AND (grantee_user_id = ? OR (grantee_email IS NOT NULL AND lower(grantee_email) = lower(?)))
      AND revoked_at IS NULL
  `).get(profileId, user.id, user.email || '');

  if (grant) {
    if (requiredPermission === 'owner') {
      return { allowed: false, status: 403, reason: 'Only the profile owner can perform this action' };
    }
    if (requiredPermission === 'edit' && grant.permission_scope !== 'edit') {
      return { allowed: false, status: 403, reason: 'Collaborator has view-only access to this profile' };
    }
    logAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      targetUserId: profile.owner_id,
      targetProfileId: profileId,
      eventType: `collaborator.profile_${requiredPermission}`,
      stageOrFeature: 'profile_access',
      summaryRedacted: `Collaborator (${user.displayName}) accessed shared profile (${grant.permission_scope})`,
    });
    return { allowed: true, accessType: 'collaborator', permissionScope: grant.permission_scope, profile };
  }

  // 3. Check Platform Administrator / Super Admin access — ONLY if owner explicitly opted into share_with_admin_enabled
  if (user.role === 'admin' || user.role === 'super_admin') {
    if (requiredPermission === 'owner') {
      return { allowed: false, status: 403, reason: 'Only the profile owner can change ownership or consent settings' };
    }
    if (!profile.share_with_admin_enabled) {
      logAuditEvent({
        actorUserId: user.id,
        actorRole: user.role,
        targetUserId: profile.owner_id,
        targetProfileId: profileId,
        eventType: 'admin.profile_access_denied_no_consent',
        stageOrFeature: 'admin_console',
        summaryRedacted: 'Administrator attempted to view a private profile without owner consent — blocked by policy',
      });
      return {
        allowed: false,
        status: 403,
        reason: 'This profile is private. Platform administrators cannot view CV content unless the profile owner explicitly grants admin sharing consent.',
      };
    }

    if (requiredPermission === 'edit') {
      return { allowed: false, status: 403, reason: 'Administrators have read-only support access to shared profiles' };
    }

    // Audit every administrator access to a shared profile
    logAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      targetUserId: profile.owner_id,
      targetProfileId: profileId,
      eventType: 'admin.shared_profile_viewed',
      stageOrFeature: 'admin_console',
      summaryRedacted: `Administrator viewed consent-shared profile "${profile.title}"`,
    });

    return {
      allowed: true,
      accessType: 'admin_shared',
      canViewHistory: Boolean(profile.share_history_with_admin),
      profile,
    };
  }

  // 4. Otherwise strictly denied
  return { allowed: false, status: 403, reason: 'Cross-user access denied by tenant isolation policy' };
}

function logAuditEvent({
  actorUserId = null,
  actorRole = 'system',
  targetUserId = null,
  targetProfileId = null,
  eventType,
  stageOrFeature = 'general',
  summaryRedacted,
  metadata = {},
}) {
  try {
    const db = getDb();
    const cleanSummary = redactPII(summaryRedacted);
    const cleanMeta = redactPII(JSON.stringify(metadata || {}));
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_role, target_user_id, target_profile_id,
        event_type, stage_or_feature, summary_redacted, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      actorUserId,
      actorRole,
      targetUserId,
      targetProfileId,
      eventType,
      stageOrFeature,
      cleanSummary,
      cleanMeta,
      new Date().toISOString()
    );
  } catch (_) {
    // Non-fatal
  }
}

function logRedactedError({ errorType, affectedFeature, message }) {
  try {
    const db = getDb();
    const cleanMsg = redactPII(message || 'Unknown error');
    const now = new Date().toISOString();
    // Rate-limit / deduplicate repeated errors of same type + feature
    const existing = db.prepare(`
      SELECT * FROM error_logs WHERE error_type = ? AND affected_feature = ? AND redacted_message = ?
    `).get(errorType, affectedFeature, cleanMsg);

    if (existing) {
      db.prepare(`
        UPDATE error_logs SET occurrence_count = occurrence_count + 1, last_seen_at = ? WHERE id = ?
      `).run(now, existing.id);
      return existing.correlation_id;
    }

    const correlationId = 'ERR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    db.prepare(`
      INSERT INTO error_logs (id, correlation_id, error_type, affected_feature, app_version, redacted_message, occurrence_count, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, '1.0.0', ?, 1, ?, ?)
    `).run(crypto.randomUUID(), correlationId, errorType, affectedFeature, cleanMsg, now, now);
    return correlationId;
  } catch (_) {
    return 'ERR-FALLBACK';
  }
}

module.exports = {
  SESSION_COOKIE_NAME,
  parseCookies,
  createSession,
  revokeSession,
  getAuthenticatedUser,
  checkProfileAccess,
  logAuditEvent,
  logRedactedError,
};
