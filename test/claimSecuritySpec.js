'use strict';

const claim = require('../lib/claim');
const ClaimChallenge = require('../models/claimchallenge');

describe('MariaCoin address claims', function() {
  it('normalizes a safe public display name and rejects markup', function() {
    expect(claim.normalizeDisplayName('  Alice   Wallet  ')).toBe('Alice Wallet');
    expect(function() { claim.normalizeDisplayName('<img src=x>'); }).toThrowError(/letters, numbers/);
  });

  it('rejects names that could impersonate official services', function() {
    expect(function() { claim.normalizeDisplayName('Official MariaCoin Support'); }).toThrowError(/reserved/);
    expect(function() { claim.normalizeDisplayName('StakersForum Admin'); }).toThrowError(/reserved/);
    expect(function() { claim.normalizeDisplayName('Maria-Coin Exchange'); }).toThrowError(/reserved/);
    expect(function() { claim.normalizeDisplayName('Stakers.Forum Team'); }).toThrowError(/reserved/);
    expect(function() { claim.normalizeDisplayName('МаriaCoin'); }).toThrowError(/Latin letters/);
    expect(function() { claim.normalizeDisplayName('... @ --'); }).toThrowError(/letter or number/);
    expect(claim.normalizeDisplayName('')).toBe('');
  });

  it('allows a real persisted challenge record for removal', async function() {
    const removal = new ClaimChallenge({
      hostname: 'maria.stakersforum.com',
      challenge_id: 'a'.repeat(64),
      address: 'MLtEx8sVEh8R9JQDRMprvoSQ6i3rXvJQ3Z',
      display_name: '',
      message: 'signed removal message',
      expires_at: new Date('2026-07-27T18:00:00.000Z')
    });

    await expectAsync(removal.validate()).toBeResolved();
  });

  it('builds a domain-bound, expiring, one-time signing message', function() {
    const address = 'MLtEx8sVEh8R9JQDRMprvoSQ6i3rXvJQ3Z';
    const message = claim.buildSigningMessage({
      hostname: 'maria.stakersforum.com',
      address: address,
      displayName: 'Alice Wallet',
      challengeId: 'a'.repeat(64),
      expiresAt: new Date('2026-07-27T18:00:00.000Z')
    });

    expect(message).toContain('Explorer: maria.stakersforum.com');
    expect(message).toContain('Address: ' + address);
    expect(message).toContain('Display name: Alice Wallet');
    expect(message).toContain('Challenge: ' + 'a'.repeat(64));
    expect(message).toContain('Expires: 2026-07-27T18:00:00.000Z');
  });

  it('binds a claim signing message to the exact approved explorer hostname', function() {
    const message = claim.buildSigningMessage({
      hostname: 'explorer.mariacoin.com',
      address: 'MLtEx8sVEh8R9JQDRMprvoSQ6i3rXvJQ3Z',
      displayName: 'Alice Wallet',
      challengeId: 'a'.repeat(64),
      expiresAt: new Date('2026-07-27T18:00:00.000Z')
    });

    expect(message).toContain('Explorer: explorer.mariacoin.com');
  });

  it('issues a short-lived challenge only for an indexed address', async function() {
    const created = [];
    const now = new Date('2026-07-27T17:00:00.000Z');
    const service = claim.createClaimService({
      now: function() { return now; },
      randomId: function() { return 'b'.repeat(64); },
      allowedHosts: ['maria.stakersforum.com'],
      addressExists: async function() { return true; },
      challengeStore: {
        create: async function(record) { created.push(record); }
      }
    });

    const result = await service.issueChallenge({
      hostname: 'maria.stakersforum.com',
      address: 'MLtEx8sVEh8R9JQDRMprvoSQ6i3rXvJQ3Z',
      displayName: ' Alice  Wallet '
    });

    expect(result.challengeId).toBe('b'.repeat(64));
    expect(result.displayName).toBe('Alice Wallet');
    expect(result.expiresAt).toBe('2026-07-27T17:10:00.000Z');
    expect(created.length).toBe(1);
    expect(created[0].message).toBe(result.message);
  });

  it('consumes a challenge before verifying and updating a claim', async function() {
    const calls = [];
    const challenge = {
      address: 'MLtEx8sVEh8R9JQDRMprvoSQ6i3rXvJQ3Z',
      display_name: 'Alice Wallet',
      message: 'exact server-issued message'
    };
    const service = claim.createClaimService({
      challengeStore: {
        consume: async function(query) { calls.push(['consume', query]); return challenge; }
      },
      verifyMessage: async function(address, signature, message) {
        calls.push(['verify', address, signature, message]);
        return true;
      },
      updateClaim: async function(address, displayName) {
        calls.push(['update', address, displayName]);
      }
    });

    const result = await service.submitClaim({
      challengeId: 'c'.repeat(64),
      address: challenge.address,
      displayName: challenge.display_name,
      signature: 'A'.repeat(88)
    });

    expect(result).toEqual({address: challenge.address, displayName: 'Alice Wallet', removed: false});
    expect(calls[0][0]).toBe('consume');
    expect(calls[1]).toEqual(['verify', challenge.address, 'A'.repeat(88), challenge.message]);
    expect(calls[2]).toEqual(['update', challenge.address, 'Alice Wallet']);
  });

  it('includes the approved hostname when atomically consuming a challenge', async function() {
    let consumedQuery = null;
    const service = claim.createClaimService({
      allowedHosts: ['maria.stakersforum.com', 'explorer.mariacoin.com'],
      challengeStore: {
        consume: async function(query) {
          consumedQuery = query;
          return {message: 'exact server-issued message'};
        }
      },
      verifyMessage: async function() { return true; },
      updateClaim: async function() {}
    });

    await service.submitClaim({
      hostname: 'explorer.mariacoin.com',
      challengeId: 'c'.repeat(64),
      address: 'MLtEx8sVEh8R9JQDRMprvoSQ6i3rXvJQ3Z',
      displayName: 'Alice Wallet',
      signature: 'A'.repeat(88)
    });

    expect(consumedQuery.hostname).toBe('explorer.mariacoin.com');
  });

  it('rejects an expired or replayed challenge before RPC verification', async function() {
    let verifyCalls = 0;
    const service = claim.createClaimService({
      challengeStore: {consume: async function() { return null; }},
      verifyMessage: async function() { verifyCalls += 1; return true; },
      updateClaim: async function() { throw new Error('must not update'); }
    });

    await expectAsync(service.submitClaim({
      challengeId: 'c'.repeat(64),
      address: 'MLtEx8sVEh8R9JQDRMprvoSQ6i3rXvJQ3Z',
      displayName: 'Alice Wallet',
      signature: 'A'.repeat(88)
    })).toBeRejectedWithError(/expired or was already used/);
    expect(verifyCalls).toBe(0);
  });

  it('consumes an invalid signature without changing the claim', async function() {
    let updateCalls = 0;
    const service = claim.createClaimService({
      challengeStore: {consume: async function() { return {message: 'exact message'}; }},
      verifyMessage: async function() { return false; },
      updateClaim: async function() { updateCalls += 1; }
    });

    await expectAsync(service.submitClaim({
      challengeId: 'd'.repeat(64),
      address: 'MLtEx8sVEh8R9JQDRMprvoSQ6i3rXvJQ3Z',
      displayName: 'Alice Wallet',
      signature: 'A'.repeat(88)
    })).toBeRejectedWithError(/could not be verified/);
    expect(updateCalls).toBe(0);
  });

  it('requires a new signed challenge to remove a self-claimed name', async function() {
    const updates = [];
    const service = claim.createClaimService({
      challengeStore: {consume: async function() { return {message: 'signed removal message'}; }},
      verifyMessage: async function() { return true; },
      updateClaim: async function(address, displayName) { updates.push([address, displayName]); }
    });
    const address = 'MLtEx8sVEh8R9JQDRMprvoSQ6i3rXvJQ3Z';

    const result = await service.submitClaim({
      challengeId: 'e'.repeat(64),
      address: address,
      displayName: '',
      signature: 'A'.repeat(88)
    });

    expect(result).toEqual({address: address, displayName: '', removed: true});
    expect(updates).toEqual([[address, '']]);
  });

  it('fails closed when challenge persistence or claim persistence fails', async function() {
    const address = 'MLtEx8sVEh8R9JQDRMprvoSQ6i3rXvJQ3Z';
    const issueService = claim.createClaimService({
      randomId: function() { return 'f'.repeat(64); },
      allowedHosts: ['maria.stakersforum.com'],
      addressExists: async function() { return true; },
      challengeStore: {create: async function() { throw new Error('database unavailable'); }}
    });
    await expectAsync(issueService.issueChallenge({hostname: 'maria.stakersforum.com', address: address, displayName: 'Alice'})).toBeRejectedWithError(/database unavailable/);

    const submitService = claim.createClaimService({
      challengeStore: {consume: async function() { return {message: 'exact message'}; }},
      verifyMessage: async function() { return true; },
      updateClaim: async function() { throw new Error('database unavailable'); }
    });
    await expectAsync(submitService.submitClaim({
      challengeId: 'f'.repeat(64),
      address: address,
      displayName: 'Alice',
      signature: 'A'.repeat(88)
    })).toBeRejectedWithError(/database unavailable/);
  });

  it('requires an exact double-submit CSRF token', function() {
    const token = 'd'.repeat(64);
    expect(claim.csrfMatches(token, token)).toBe(true);
    expect(claim.csrfMatches(token, 'e'.repeat(64))).toBe(false);
    expect(claim.csrfMatches('', '')).toBe(false);
  });

  it('rate-limits claim mutations per client without trusting arbitrary headers', function() {
    let now = 1000;
    const limiter = claim.createRateLimiter({limit: 2, windowMs: 60000, now: function() { return now; }});

    expect(limiter.take('198.51.100.7')).toBe(true);
    expect(limiter.take('198.51.100.7')).toBe(true);
    expect(limiter.take('198.51.100.7')).toBe(false);
    expect(limiter.take('198.51.100.8')).toBe(true);

    now += 60001;
    expect(limiter.take('198.51.100.7')).toBe(true);
  });

  it('bounds and evicts rate-limit keys', function() {
    let now = 1000;
    const limiter = claim.createRateLimiter({limit: 2, windowMs: 60000, maxEntries: 2, now: function() { return now; }});

    expect(limiter.take('198.51.100.1')).toBe(true);
    expect(limiter.take('198.51.100.2')).toBe(true);
    expect(limiter.take('198.51.100.3')).toBe(false);
    expect(limiter.size()).toBe(2);

    now += 60001;
    expect(limiter.take('198.51.100.3')).toBe(true);
    expect(limiter.size()).toBe(1);
  });
});
