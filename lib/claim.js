'use strict';

const crypto = require('crypto');

const DISPLAY_NAME_RE = /^[\p{Script=Latin}\p{M}0-9 ._@-]*$/u;
const MARIA_ADDRESS_RE = /^M[1-9A-HJ-NP-Za-km-z]{25,49}$/;
const RESERVED_TERMS = /\b(admin(?:istrator)?|exchange|explorer|maria\s*coin|mariacoin|moderator|official|staff|stakers\s*forum|stakersforum|support|team)\b/iu;
const RESERVED_SKELETON = /(admin(?:istrator)?|exchange|explorer|mariacoin|moderator|official|staff|stakersforum|support|team)/u;

function claimError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function newCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function csrfMatches(cookieToken, submittedToken) {
  if (typeof cookieToken !== 'string' || typeof submittedToken !== 'string' || !/^[a-f0-9]{64}$/.test(cookieToken) || !/^[a-f0-9]{64}$/.test(submittedToken))
    return false;

  return crypto.timingSafeEqual(Buffer.from(cookieToken, 'ascii'), Buffer.from(submittedToken, 'ascii'));
}

function createRateLimiter({limit, windowMs, maxEntries, now}) {
  const entries = new Map();
  const clock = now || Date.now;
  const capacity = maxEntries || 10000;
  let nextSweep = 0;

  return {
    take: function(key) {
      const currentTime = clock();

      if (currentTime >= nextSweep || entries.size >= capacity) {
        for (const [entryKey, storedEntry] of entries) {
          if (currentTime >= storedEntry.resetAt)
            entries.delete(entryKey);
        }

        nextSweep = currentTime + windowMs;
      }

      let entry = entries.get(key);

      if (!entry) {
        if (entries.size >= capacity)
          return false;

        entry = {count: 0, resetAt: currentTime + windowMs};
        entries.set(key, entry);
      }

      if (entry.count >= limit)
        return false;

      entry.count += 1;
      return true;
    },
    size: function() {
      return entries.size;
    }
  };
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string')
    throw claimError('Display name must be text', 'invalid_display_name');

  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');

  if (normalized.length > 40)
    throw claimError('Display name must be 40 characters or fewer', 'invalid_display_name');

  if (!DISPLAY_NAME_RE.test(normalized))
    throw claimError('Display name may contain Latin letters, numbers, spaces, periods, underscores, hyphens and @ only', 'invalid_display_name');

  if (normalized !== '' && !/[\p{Script=Latin}0-9]/u.test(normalized))
    throw claimError('Display name must contain at least one letter or number', 'invalid_display_name');

  const reservedSkeleton = normalized.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

  if (RESERVED_TERMS.test(normalized) || RESERVED_SKELETON.test(reservedSkeleton))
    throw claimError('Display name contains a reserved term', 'reserved_display_name');

  return normalized;
}

function normalizeAddress(value) {
  if (typeof value !== 'string')
    throw claimError('Wallet address must be text', 'invalid_address');

  const normalized = value.trim();

  if (!MARIA_ADDRESS_RE.test(normalized))
    throw claimError('Enter a valid transparent MariaCoin address beginning with M', 'invalid_address');

  return normalized;
}

function normalizeClaimHostname(value, allowedHosts) {
  if (typeof value !== 'string')
    throw claimError('Explorer hostname is invalid', 'invalid_hostname');

  const hostname = value.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(hostname))
    throw claimError('Explorer hostname is invalid', 'invalid_hostname');

  if (!Array.isArray(allowedHosts) || !allowedHosts.includes(hostname))
    throw claimError('Explorer hostname is not approved', 'invalid_hostname');

  return hostname;
}

function buildSigningMessage({hostname, address, displayName, challengeId, expiresAt}) {
  if (typeof hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(hostname))
    throw claimError('Explorer hostname is invalid', 'invalid_hostname');

  const action = displayName === '' ? 'Remove self-claimed display name' : 'Set self-claimed display name';

  return [
    'MariaCoin Explorer address claim',
    'Explorer: ' + hostname,
    'Action: ' + action,
    'Address: ' + address,
    'Display name: ' + (displayName === '' ? '[remove claim]' : displayName),
    'Challenge: ' + challengeId,
    'Expires: ' + expiresAt.toISOString(),
    '',
    'This signature proves control of the address. It does not transfer coins or verify identity.'
  ].join('\n');
}

function createClaimService(deps) {
  const now = deps.now || function() { return new Date(); };
  const randomId = deps.randomId || function() { return crypto.randomBytes(32).toString('hex'); };

  return {
    issueChallenge: async function({hostname, address, displayName}) {
      const normalizedHostname = normalizeClaimHostname(hostname, deps.allowedHosts);
      const normalizedAddress = normalizeAddress(address);
      const normalizedDisplayName = normalizeDisplayName(displayName);

      if (!await deps.addressExists(normalizedAddress))
        throw claimError('Address is not indexed by this explorer', 'address_not_found');

      const challengeId = randomId();
      const expiresAt = new Date(now().getTime() + (10 * 60 * 1000));
      const message = buildSigningMessage({
        hostname: normalizedHostname,
        address: normalizedAddress,
        displayName: normalizedDisplayName,
        challengeId: challengeId,
        expiresAt: expiresAt
      });

      await deps.challengeStore.create({
        hostname: normalizedHostname,
        challenge_id: challengeId,
        address: normalizedAddress,
        display_name: normalizedDisplayName,
        message: message,
        expires_at: expiresAt
      });

      return {
        hostname: normalizedHostname,
        challengeId: challengeId,
        address: normalizedAddress,
        displayName: normalizedDisplayName,
        message: message,
        expiresAt: expiresAt.toISOString()
      };
    },

    submitClaim: async function({hostname, challengeId, address, displayName, signature}) {
      const normalizedHostname = hostname === undefined ? null : normalizeClaimHostname(hostname, deps.allowedHosts);
      const normalizedAddress = normalizeAddress(address);
      const normalizedDisplayName = normalizeDisplayName(displayName);

      if (typeof challengeId !== 'string' || !/^[a-f0-9]{64}$/.test(challengeId))
        throw claimError('Claim challenge is invalid', 'invalid_challenge');

      if (typeof signature !== 'string' || signature.length < 40 || signature.length > 128 || !/^[A-Za-z0-9+/=]+$/.test(signature))
        throw claimError('Wallet signature is invalid', 'invalid_signature');

      const challenge = await deps.challengeStore.consume({
        ...(normalizedHostname === null ? {} : {hostname: normalizedHostname}),
        challenge_id: challengeId,
        address: normalizedAddress,
        display_name: normalizedDisplayName,
        now: now()
      });

      if (!challenge)
        throw claimError('Claim challenge has expired or was already used', 'expired_challenge');

      const verified = await deps.verifyMessage(normalizedAddress, signature, challenge.message);

      if (verified !== true)
        throw claimError('Wallet signature could not be verified', 'invalid_signature');

      await deps.updateClaim(normalizedAddress, normalizedDisplayName);

      return {
        address: normalizedAddress,
        displayName: normalizedDisplayName,
        removed: normalizedDisplayName === ''
      };
    }
  };
}

module.exports = {
  claimError,
  newCsrfToken,
  csrfMatches,
  createRateLimiter,
  normalizeAddress,
  normalizeClaimHostname,
  normalizeDisplayName,
  buildSigningMessage,
  createClaimService
};
