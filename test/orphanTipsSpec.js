'use strict';

const orphanTips = require('../lib/orphan_tips');
const explorer = require('../lib/explorer');
const fs = require('fs');
const {Decimal128} = require('mongodb');

const hashes = {
  stale: 'a'.repeat(64),
  good: 'b'.repeat(64),
  previous: 'c'.repeat(64),
  next: 'd'.repeat(64)
};

function activeTip(height = 101) {
  return {height, hash: hashes.good, branchlen: 0, status: 'active'};
}

describe('MariaCoin chain-tip orphan discovery', function() {
  it('exposes the internal getchaintips RPC needed by the durable sync job', function() {
    expect(typeof explorer.get_chain_tips).toBe('function');
  });

  it('runs chain-tip orphan discovery from every scheduled block update', function() {
    const syncSource = fs.readFileSync(require.resolve('../scripts/sync'), 'utf8');
    expect(syncSource).toContain("const orphanTips = require('../lib/orphan_tips')");
    expect(syncSource).toContain('function sync_chain_tip_orphans(cb)');
    expect(syncSource).toContain('sync_chain_tip_orphans(function(orphanErr, orphanResult)');
    expect(syncSource).toContain('orphanTips.pendingRows(dependencies)');
    expect(syncSource).toContain('orphanTips.synchronize(dependencies, firstRows)');
    expect(syncSource).toContain('Fatal MariaCoin chain-tip orphan sync failure');
  });

  it('renders above-tip orphan metadata without linking to null canonical hashes', function() {
    const view = fs.readFileSync(require.resolve('../views/orphans.pug'), 'utf8');
    expect(view).toContain('if (good_blockhash == null)');
    expect(view).toContain('if (prev_blockhash == null)');
  });

  it('uses atomic rollback instead of the fail-open legacy orphan repair path', function() {
    const syncSource = fs.readFileSync(require.resolve('../scripts/sync'), 'utf8');
    const blockSync = syncSource.slice(
      syncSource.indexOf('function block_sync('),
      syncSource.indexOf('function process_peer_object(')
    );
    expect(blockSync).not.toContain('update_orphans(');
    expect(blockSync).toContain('orphanResult.rollbackHeight');
    expect(blockSync).toContain('block_sync(false, refreshedStats, true)');
    expect(syncSource).not.toContain('.then(() => cb(null)).catch(cb)');
  });

  it('builds an orphan row from a complete valid-fork tip', async function() {
    const rows = await orphanTips.discover({
      getChainTips: async () => [activeTip(), {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'}],
      getBlockHash: async height => {
        if (height === 101 || height === 100)
          return hashes.good;
        expect(height).toBe(99);
        return hashes.previous;
      },
      getBlock: async hash => {
        if (hash === hashes.stale)
          return {hash, height: 100, previousblockhash: hashes.previous};
        if (hash === hashes.good)
          return {hash, height: 100, previousblockhash: hashes.previous, nextblockhash: hashes.next};
        throw new Error(`unexpected block ${hash}`);
      }
    });

    expect(rows).toEqual([{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }]);
  });

  it('traverses independent fork tips concurrently with bounded deterministic output', async function() {
    const staleHashes = Array.from({length: 12}, (_, index) => index.toString(16).padStart(64, '0'));
    let inFlight = 0;
    let maximumInFlight = 0;
    const rows = await orphanTips.discover({
      getChainTips: async () => [activeTip(), ...staleHashes.map(hash => ({height: 100, hash, branchlen: 1, status: 'valid-fork'}))],
      getBlockHash: async height => height === 99 ? hashes.previous : hashes.good,
      getBlock: async hash => {
        if (hash === hashes.good)
          return {hash, height: 100, previousblockhash: hashes.previous, nextblockhash: hashes.next};
        inFlight++;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5 + Number.parseInt(hash.slice(-1), 16)));
        inFlight--;
        return {hash, height: 100, previousblockhash: hashes.previous};
      }
    });

    expect(maximumInFlight).toBeGreaterThan(1);
    expect(maximumInFlight).toBeLessThanOrEqual(8);
    expect(rows.map(row => row.orphan_blockhash)).toEqual(staleHashes);
  });

  it('deduplicates stale blocks shared by multiple reported tips', async function() {
    const tip = {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'};
    const rows = await orphanTips.discover({
      getChainTips: async () => [activeTip(), tip, {...tip}],
      getBlockHash: async height => height === 99 ? hashes.previous : hashes.good,
      getBlock: async hash => hash === hashes.stale
        ? {hash, height: 100, previousblockhash: hashes.previous}
        : {hash, height: 100, previousblockhash: hashes.previous, nextblockhash: hashes.next}
    });

    expect(rows.length).toBe(1);
  });

  it('keeps the next canonical hash null when the fork is at the active tip', async function() {
    const rows = await orphanTips.discover({
      getChainTips: async () => [activeTip(100), {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'}],
      getBlockHash: async height => height === 99 ? hashes.previous : hashes.good,
      getBlock: async hash => hash === hashes.stale
        ? {hash, height: 100, previousblockhash: hashes.previous}
        : {hash, height: 100, previousblockhash: hashes.previous}
    });

    expect(rows[0].next_blockhash).toBeNull();
  });

  it('rejects a stale branch whose block heights do not match getchaintips', async function() {
    const discovery = orphanTips.discover({
      getChainTips: async () => [activeTip(), {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'}],
      getBlockHash: async () => hashes.good,
      getBlock: async hash => hash === hashes.stale
        ? {hash, height: 99, previousblockhash: 'e'.repeat(64)}
        : {hash, height: 99, previousblockhash: hashes.previous, nextblockhash: hashes.next}
    });

    await expectAsync(discovery).toBeRejectedWithError(/height does not match getchaintips/i);
  });

  it('rejects a stale branch that does not reconnect to the canonical fork point', async function() {
    const discovery = orphanTips.discover({
      getChainTips: async () => [activeTip(), {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'}],
      getBlockHash: async height => height === 99 ? hashes.previous : hashes.good,
      getBlock: async hash => hash === hashes.stale
        ? {hash, height: 100, previousblockhash: 'e'.repeat(64)}
        : {hash, height: 100, previousblockhash: hashes.previous, nextblockhash: hashes.next}
    });

    await expectAsync(discovery).toBeRejectedWithError(/does not reconnect to canonical fork point/i);
  });

  it('rejects getchaintips responses without exactly one active tip', async function() {
    const discovery = orphanTips.discover({
      getChainTips: async () => [],
      getBlockHash: async () => hashes.good,
      getBlock: async () => null
    });
    await expectAsync(discovery).toBeRejectedWithError(/exactly one active tip/i);
  });

  it('rejects an active tip that does not match the canonical hash at its height', async function() {
    const discovery = orphanTips.discover({
      getChainTips: async () => [{...activeTip(100), hash: 'f'.repeat(64)}],
      getBlockHash: async () => hashes.good,
      getBlock: async () => null
    });
    await expectAsync(discovery).toBeRejectedWithError(/active tip does not match canonical chain/i);
  });

  it('rejects discovery when the active tip is replaced during fork traversal', async function() {
    let observations = 0;
    const replacement = 'f'.repeat(64);
    const discovery = orphanTips.discover({
      getChainTips: async () => ++observations === 1
        ? [activeTip(), {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'}]
        : [{...activeTip(), hash: replacement}, {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'}],
      getBlockHash: async height => {
        if (height === 101) return observations === 1 ? hashes.good : replacement;
        return height === 99 ? hashes.previous : hashes.good;
      },
      getBlock: async hash => hash === hashes.stale
        ? {hash, height: 100, previousblockhash: hashes.previous}
        : {hash, height: 100, previousblockhash: hashes.previous, nextblockhash: hashes.next}
    });

    await expectAsync(discovery).toBeRejectedWithError(/changed during discovery/i);
  });

  it('accepts discovery when the active tip merely extends by a new block', async function() {
    let observations = 0;
    const extension = 'f'.repeat(64);
    const rows = await orphanTips.discover({
      getChainTips: async () => ++observations === 1
        ? [activeTip(), {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'}]
        : [{height: 102, hash: extension, branchlen: 0, status: 'active'}, {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'}],
      getBlockHash: async height => {
        if (height === 101) return hashes.good;
        if (height === 102) return extension;
        return height === 99 ? hashes.previous : hashes.good;
      },
      getBlock: async hash => hash === hashes.stale
        ? {hash, height: 100, previousblockhash: hashes.previous}
        : {hash, height: 100, previousblockhash: hashes.previous, nextblockhash: hashes.next}
    });

    expect(rows).toEqual([{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }]);
  });

  it('rejects discovery when the observed tip height no longer resolves to its hash', async function() {
    let observations = 0;
    const reorganized = 'f'.repeat(64);
    const staleParent = '9'.repeat(64);
    const discovery = orphanTips.discover({
      getChainTips: async () => ++observations === 1
        ? [activeTip(99), {height: 100, hash: hashes.stale, branchlen: 2, status: 'valid-fork'}]
        : [{height: 101, hash: reorganized, branchlen: 0, status: 'active'}, {height: 100, hash: hashes.stale, branchlen: 2, status: 'valid-fork'}],
      getBlockHash: async height => {
        if (height === 99) return observations === 1 ? staleParent : 'a'.repeat(64);
        if (height === 98) return staleParent;
        if (height === 97) return hashes.previous;
        if (height === 101) return reorganized;
        if (height === 100) return hashes.stale;
        throw new Error(`unexpected height ${height}`);
      },
      getBlock: async hash => {
        if (hash === hashes.stale)
          return {hash, height: 100, previousblockhash: staleParent};
        if (hash === staleParent)
          return {hash, height: 99, previousblockhash: hashes.previous};
        if (hash === 'a'.repeat(64))
          return {hash, height: 99, previousblockhash: hashes.previous};
        throw new Error(`unexpected block ${hash}`);
      }
    });

    await expectAsync(discovery).toBeRejectedWithError(/does not match canonical chain|changed during discovery/i);
  });

  it('rejects discovery when a stale tip appears or disappears mid-traversal', async function() {
    let observations = 0;
    const appearing = 'b'.repeat(64);
    const staleTip = {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'};
    const discovery = orphanTips.discover({
      getChainTips: async () => ++observations === 1
        ? [activeTip(), staleTip]
        : [{height: 101, hash: 'f'.repeat(64), branchlen: 0, status: 'active'}, staleTip, {height: 90, hash: appearing, branchlen: 1, status: 'valid-fork'}],
      getBlockHash: async height => height === 99 ? hashes.previous : hashes.good,
      getBlock: async hash => hash === hashes.stale
        ? {hash, height: 100, previousblockhash: hashes.previous}
        : {hash, height: 100, previousblockhash: hashes.previous, nextblockhash: hashes.next}
    });

    await expectAsync(discovery).toBeRejectedWithError(/stale chain-tip set changed/i);
  });

  function racingRpc(racesBeforeStable) {
    let observations = 0;
    const staleTip = {height: 100, hash: hashes.stale, branchlen: 1, status: 'valid-fork'};
    const appearing = {height: 90, hash: 'e'.repeat(64), branchlen: 1, status: 'valid-fork'};
    const rpc = {
      getChainTips: async () => {
        observations++;
        // each discovery reads tips twice (start, end); the end read of the first
        // racesBeforeStable discoveries reports an extra stale tip
        const discovery = Math.ceil(observations / 2);
        const isFinalRead = observations % 2 === 0;
        return isFinalRead && discovery <= racesBeforeStable ? [activeTip(), staleTip, appearing] : [activeTip(), staleTip];
      },
      getBlockHash: async height => height === 99 ? hashes.previous : hashes.good,
      getBlock: async hash => hash === hashes.stale
        ? {hash, height: 100, previousblockhash: hashes.previous}
        : {hash, height: 100, previousblockhash: hashes.previous, nextblockhash: hashes.next}
    };
    return {rpc, reads: () => observations};
  }

  it('retries discovery when the stale tip set changes mid-traversal and returns a stable snapshot', async function() {
    const {rpc, reads} = racingRpc(2);
    const retries = [];
    const rows = await orphanTips.discoverStable(rpc, {attempts: 3, onRetry: attempt => retries.push(attempt)});
    expect(retries).toEqual([1, 2]);
    expect(reads()).toBe(6);
    expect(rows.map(row => row.orphan_blockhash)).toEqual([hashes.stale]);
  });

  it('fails closed after the bounded number of snapshot races', async function() {
    const {rpc, reads} = racingRpc(5);
    await expectAsync(orphanTips.discoverStable(rpc, {attempts: 3})).toBeRejectedWithError(/stale chain-tip set changed during discovery/i);
    expect(reads()).toBe(6);
  });

  it('does not retry discovery errors other than snapshot races', async function() {
    let reads = 0;
    const rpc = {
      getChainTips: async () => { reads++; return [activeTip(), activeTip()]; },
      getBlockHash: async () => hashes.good,
      getBlock: async hash => ({hash, height: 101})
    };
    await expectAsync(orphanTips.discoverStable(rpc, {attempts: 3})).toBeRejectedWithError(/expected exactly one active tip/i);
    expect(reads).toBe(1);
  });

  it('rejects an invalid retry budget', async function() {
    await expectAsync(orphanTips.discoverStable({}, {attempts: 0})).toBeRejectedWithError(/attempts must be an integer/i);
  });

  it('uses bounded discovery retries from the scheduled block sync', function() {
    const sync = fs.readFileSync(require('path').join(__dirname, '..', 'scripts', 'sync.js'), 'utf8');
    expect(sync).toContain('orphanTips.discoverStable(');
    expect(sync).toContain('attempts: 3');
  });

  it('rejects an active tip with a non-zero branch length', async function() {
    const discovery = orphanTips.discover({
      getChainTips: async () => [{...activeTip(100), branchlen: 7}],
      getBlockHash: async () => hashes.good,
      getBlock: async () => null
    });
    await expectAsync(discovery).toBeRejectedWithError(/active tip branch length/i);
  });

  it('rejects a valid-fork tip with an empty branch', async function() {
    const discovery = orphanTips.discover({
      getChainTips: async () => [activeTip(), {height: 100, hash: hashes.stale, branchlen: 0, status: 'valid-fork'}],
      getBlockHash: async () => hashes.good,
      getBlock: async () => null
    });
    await expectAsync(discovery).toBeRejectedWithError(/must contain at least one block/i);
  });

  it('retains the complete valid-fork branch when its stale tip is above the active height', async function() {
    const staleParent = '1'.repeat(64);
    const rows = await orphanTips.discover({
      getChainTips: async () => [activeTip(100), {height: 101, hash: hashes.stale, branchlen: 2, status: 'valid-fork'}],
      getBlockHash: async height => {
        if (height === 99)
          return hashes.previous;
        expect(height).toBe(100);
        return hashes.good;
      },
      getBlock: async hash => {
        if (hash === hashes.stale)
          return {hash, height: 101, previousblockhash: staleParent};
        if (hash === staleParent)
          return {hash, height: 100, previousblockhash: hashes.previous};
        return {hash, height: 100, previousblockhash: hashes.previous};
      }
    });

    expect(rows).toEqual([
      jasmine.objectContaining({
        blockindex: 101,
        orphan_blockhash: hashes.stale,
        good_blockhash: null,
        prev_blockhash: null,
        next_blockhash: null
      }),
      jasmine.objectContaining({
        blockindex: 100,
        orphan_blockhash: staleParent,
        good_blockhash: hashes.good
      })
    ]);
  });

  it('persists discovered rows idempotently by orphan block hash', async function() {
    const calls = [];
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    const model = {
      async startSession() { return session; },
      async bulkWrite(operations, options) {
        calls.push({operations, options});
        return {matchedCount: 0, upsertedCount: 1, deletedCount: 0};
      }
    };
    const rows = [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }];

    await orphanTips.persist(model, rows);

    expect(calls).toEqual([{
      operations: [{
        deleteMany: {
          filter: {orphan_blockhash: {$nin: [hashes.stale]}}
        }
      }, {
        updateOne: {
          filter: {orphan_blockhash: hashes.stale},
          update: {$set: rows[0]},
          upsert: true
        }
      }],
      options: {ordered: true, session}
    }]);
  });

  it('rejects duplicate orphan hashes before opening a persistence transaction', async function() {
    let sessionOpened = false;
    const model = {
      async startSession() { sessionOpened = true; throw new Error('must not open'); },
      async bulkWrite() { throw new Error('must not write'); }
    };
    const row = {
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    };

    await expectAsync(orphanTips.persist(model, [row, {...row}]))
      .toBeRejectedWithError(/duplicate orphan row hash/i);
    expect(sessionOpened).toBeFalse();
  });

  it('removes a former orphan when that block becomes canonical', async function() {
    const calls = [];
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    const model = {
      startSession: async () => session,
      bulkWrite: async operations => {
        calls.push(operations);
        return {matchedCount: 0, upsertedCount: 1, deletedCount: 0};
      }
    };
    const row = {
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    };

    await orphanTips.persist(model, [row]);

    expect(calls[0][0]).toEqual({
      deleteMany: {
        filter: {orphan_blockhash: {$nin: [hashes.stale]}}
      }
    });
  });

  it('persists canonical reclassification inside a MongoDB transaction', async function() {
    const calls = [];
    const session = {
      async withTransaction(work) { calls.push('begin'); await work(); calls.push('commit'); },
      async endSession() { calls.push('end'); }
    };
    const model = {
      async startSession() { calls.push('session'); return session; },
      async bulkWrite(_operations, options) {
        expect(options.session).toBe(session);
        calls.push('write');
        return {matchedCount: 0, upsertedCount: 1, deletedCount: 0};
      }
    };

    await orphanTips.persist(model, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }]);

    expect(calls).toEqual(['session', 'begin', 'write', 'commit', 'end']);
  });

  it('retains every discovered stale block when several forks share one height', async function() {
    const stored = new Map();
    const otherFork = 'e'.repeat(64);
    const obsoleteFork = 'f'.repeat(64);
    stored.set(obsoleteFork, {orphan_blockhash: obsoleteFork});
    const rows = [
      {blockindex: 100, orphan_blockhash: hashes.stale, good_blockhash: hashes.good, prev_blockhash: hashes.previous, next_blockhash: null},
      {blockindex: 100, orphan_blockhash: otherFork, good_blockhash: hashes.good, prev_blockhash: hashes.previous, next_blockhash: null}
    ];
    const model = {
      async startSession() {
        return {withTransaction: async work => work(), endSession: async () => {}};
      },
      async bulkWrite(operations) {
        for (const operation of operations) {
          if (operation.updateOne)
            stored.set(operation.updateOne.update.$set.orphan_blockhash, operation.updateOne.update.$set);
          else if (operation.deleteMany) {
            const orphanFilter = operation.deleteMany.filter.orphan_blockhash;
            if (orphanFilter && Array.isArray(orphanFilter.$nin)) {
              for (const hash of [...stored.keys()]) {
                if (!orphanFilter.$nin.includes(hash)) stored.delete(hash);
              }
            } else {
              stored.delete(orphanFilter);
            }
          }
        }
        return {matchedCount: 0, upsertedCount: rows.length, deletedCount: 0};
      }
    };
    await orphanTips.persist(model, rows);
    expect([...stored.keys()].sort()).toEqual([otherFork, hashes.stale].sort());
  });

  it('aborts orphan persistence if any reclassification write fails', async function() {
    const calls = [];
    const session = {
      async withTransaction(work) {
        calls.push('begin');
        try { await work(); calls.push('commit'); }
        catch (err) { calls.push('abort'); throw err; }
      },
      async endSession() { calls.push('end'); }
    };
    const model = {
      async startSession() { return session; },
      async bulkWrite() { throw new Error('write failed'); }
    };

    await expectAsync(orphanTips.persist(model, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }])).toBeRejectedWithError('write failed');
    expect(calls).toEqual(['begin', 'abort', 'end']);
  });

  it('aborts orphan persistence when MongoDB reports a short metadata bulk result', async function() {
    const calls = [];
    const session = {
      async withTransaction(work) {
        calls.push('begin');
        try { await work(); calls.push('commit'); }
        catch (err) { calls.push('abort'); throw err; }
      },
      async endSession() { calls.push('end'); }
    };
    const model = {
      async startSession() { return session; },
      async bulkWrite() { return {matchedCount: 0, upsertedCount: 0, deletedCount: 0}; }
    };

    await expectAsync(orphanTips.persist(model, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }])).toBeRejectedWithError(/orphan metadata write count mismatch/i);
    expect(calls).toEqual(['begin', 'abort', 'end']);
  });

  it('atomically removes orphan metadata that is absent from an empty stable daemon discovery', async function() {
    const operations = [];
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    const models = {
      Orphans: {
        async countDocuments() { return 3; },
        async bulkWrite(ops, options) {
          operations.push([ops, options]);
          return {matchedCount: 0, upsertedCount: 0, deletedCount: 3};
        }
      },
      Tx: {countDocuments: async () => 0},
      Address: {},
      AddressTx: {},
      Stats: {find: async () => [{coin: 'MariaCoin', last: -1, txes: 0}]}
    };

    const result = await orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, []);

    expect(result).toEqual({rollbackHeight: null, orphanCount: 0});
    expect(operations.length).toBe(1);
    expect(operations[0][0]).toEqual([{deleteMany: {filter: {}}}]);
    expect(operations[0][1]).toEqual({ordered: true, session});
  });

  it('rejects an impossible orphan metadata deletion result before commit', async function() {
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    const models = {
      Orphans: {
        async countDocuments() { return 0; },
        async bulkWrite() { return {matchedCount: 0, upsertedCount: 0, deletedCount: 1}; }
      },
      Tx: {},
      Address: {},
      AddressTx: {},
      Stats: {}
    };

    await expectAsync(orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, [])).toBeRejectedWithError(/orphan metadata write count mismatch/i);
  });

  it('rejects orphan metadata under-deletion before commit', async function() {
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    const models = {
      Orphans: {
        countDocuments: async () => 3,
        bulkWrite: async () => ({matchedCount: 1, upsertedCount: 0, deletedCount: 1})
      },
      Tx: {find: async () => []},
      Address: {},
      AddressTx: {},
      Stats: {}
    };
    await expectAsync(orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }])).toBeRejectedWithError(/orphan metadata write count mismatch/i);
  });

  it('fails closed when a no-stale orphan row covers a canonical Tx with no AddressTx projection', async function() {
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    const canonicalTx = {
      txid: '9'.repeat(64), blockindex: 100, blockhash: hashes.good,
      vin: [{addresses: 'coinbase', amount: '0'}],
      vout: [{addresses: 'MAlice', amount: '1'}]
    };
    const models = {
      Orphans: {
        countDocuments: async () => 0,
        bulkWrite: async () => ({matchedCount: 0, upsertedCount: 1, deletedCount: 0})
      },
      Tx: {
        find: async query => query.$or ? [] : [canonicalTx],
        countDocuments: async () => 1
      },
      Address: {},
      AddressTx: {find: async () => []},
      Stats: {find: async () => [{coin: 'MariaCoin', last: 100, txes: 1}]}
    };

    await expectAsync(orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }])).toBeRejectedWithError(/AddressTx projection mismatch/i);
  });

  it('requires Stats closure even when stable daemon discovery is empty', async function() {
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    const models = {
      Orphans: {
        countDocuments: async () => 0,
        bulkWrite: async () => ({matchedCount: 0, upsertedCount: 0, deletedCount: 0})
      },
      Tx: {countDocuments: async () => 0},
      Address: {},
      AddressTx: {},
      Stats: {find: async () => []}
    };

    await expectAsync(orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, [])).toBeRejectedWithError(/exactly one Stats document/i);
  });

  it('fails closed on an affected-height AddressTx projection whose Tx is missing', async function() {
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    let txFinds = 0;
    const models = {
      Orphans: {countDocuments: async () => 0, bulkWrite: async () => ({matchedCount: 0, upsertedCount: 1, deletedCount: 0})},
      Tx: {find: async () => { txFinds += 1; return []; }, countDocuments: async () => 0},
      Address: {},
      AddressTx: {find: async () => [{a_id: 'MAlice', txid: '9'.repeat(64), blockindex: 100}]},
      Stats: {find: async () => [{coin: 'MariaCoin', last: 100, txes: 0}]}
    };

    await expectAsync(orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }])).toBeRejectedWithError(/dangling address transaction projection/i);
    expect(txFinds).toBe(2);
  });

  it('fails closed when a no-stale AddressTx row claims the wrong transaction height', async function() {
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    const txid = '9'.repeat(64);
    const addressTransactions = [
      {a_id: 'MAlice', txid, blockindex: 100, role: 'balance', amount: '1'},
      {a_id: 'MHidden', txid, blockindex: 99, role: 'staker', amount: '0'}
    ];
    const models = {
      Orphans: {countDocuments: async () => 0, bulkWrite: async () => ({matchedCount: 0, upsertedCount: 1, deletedCount: 0})},
      Tx: {find: async query => query.$or ? [] : [{
        txid, blockindex: 100,
        vin: [{addresses: 'coinbase', amount: '0'}],
        vout: [{addresses: 'MAlice', amount: '1'}]
      }], countDocuments: async () => 1},
      Address: {},
      AddressTx: {find: async query => query.$or ? addressTransactions : addressTransactions.filter(row => row.blockindex === 100)},
      Stats: {find: async () => [{coin: 'MariaCoin', last: 100, txes: 1}]}
    };

    await expectAsync(orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }])).toBeRejectedWithError(/wrong block height/i);
  });

  it('rejects a rollback when an AddressTx for a deleted Tx is hidden outside the height range', async function() {
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    const txid = '7'.repeat(64);
    const staleTx = {
      txid, blockindex: 100, blockhash: hashes.stale,
      vin: [{addresses: 'coinbase', amount: '0'}],
      vout: [{addresses: 'MAlice', amount: '1'}]
    };
    const addressTransactions = [
      {a_id: 'MAlice', txid, blockindex: 100, role: 'balance', amount: '1'},
      {a_id: 'MHidden', txid, blockindex: 99, role: 'staker', amount: '0'}
    ];
    const models = {
      Orphans: {
        countDocuments: async () => 0,
        bulkWrite: async () => ({matchedCount: 0, upsertedCount: 1, deletedCount: 0})
      },
      Tx: {
        find: async () => [staleTx],
        countDocuments: async () => 1,
        deleteMany: async () => ({deletedCount: 1})
      },
      Address: {
        bulkWrite: async operations => ({matchedCount: operations.length}),
        deleteMany: async () => ({deletedCount: 0})
      },
      AddressTx: {
        find: async query => query.$or ? addressTransactions : addressTransactions.filter(row => row.blockindex === 100),
        deleteMany: async () => ({deletedCount: 1})
      },
      Stats: {
        find: async () => [{coin: 'MariaCoin', last: 100, txes: 1}],
        updateOne: async () => ({matchedCount: 1, modifiedCount: 1})
      }
    };

    await expectAsync(orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }])).toBeRejectedWithError(/wrong block height/i);
  });

  it('atomically rolls back stale canonical projections from the earliest discovered fork', async function() {
    const events = [];
    const session = {
      async withTransaction(work) {
        events.push('begin');
        try { await work(); events.push('commit'); }
        catch (err) { events.push('abort'); throw err; }
      },
      async endSession() { events.push('end'); }
    };
    const staleTx = {
      txid: '3'.repeat(64), blockindex: 100, blockhash: hashes.stale,
      vin: [{addresses: 'MAlice', amount: Decimal128.fromString('500')}],
      vout: [
        {addresses: 'MBob', amount: Decimal128.fromString('100'), stakers: ['SStake']},
        {addresses: 'MBob', amount: Decimal128.fromString('200'), stakers: ['SStake']}
      ]
    };
    const descendantTx = {
      txid: '4'.repeat(64), blockindex: 101, blockhash: '5'.repeat(64),
      vin: [{addresses: 'coinbase', amount: Decimal128.fromString('0')}],
      vout: [{addresses: 'MCarol', amount: Decimal128.fromString('200')}]
    };
    const legacyCoinbaseTx = {
      txid: '8'.repeat(64), blockindex: 101, blockhash: '5'.repeat(64),
      vin: [{addresses: 'coinbase', amount: Decimal128.fromString('50')}], vout: []
    };
    let findCall = 0;
    const models = {
      Orphans: {countDocuments: async () => 0, bulkWrite: async (_ops, options) => {
        events.push(['orphans', options.session]);
        return {matchedCount: 0, upsertedCount: 1, deletedCount: 0};
      }},
      Tx: {
        find: async () => (++findCall === 1 ? [staleTx] : [staleTx, descendantTx, legacyCoinbaseTx]),
        countDocuments: async () => 3,
        deleteMany: async (filter, options) => {
          events.push(['tx-delete', filter, options.session]);
          return {deletedCount: 3};
        }
      },
      Address: {
        bulkWrite: async (ops, options) => {
          events.push(['address-reverse', ops, options.session]);
          return {matchedCount: ops.length};
        },
        deleteMany: async (filter, options) => {
          events.push(['address-zero-delete', filter, options.session]);
          return {deletedCount: 0};
        }
      },
      AddressTx: {
        find: async () => [
          {a_id: 'MAlice', txid: staleTx.txid, blockindex: 100, role: 'balance', amount: Decimal128.fromString('-500')},
          {a_id: 'MBob', txid: staleTx.txid, blockindex: 100, role: 'balance', amount: Decimal128.fromString('300')},
          {a_id: 'SStake', txid: staleTx.txid, blockindex: 100, role: 'staker', amount: Decimal128.fromString('0')},
          {a_id: 'MCarol', txid: descendantTx.txid, blockindex: 101, role: 'balance', amount: Decimal128.fromString('200')}
        ],
        deleteMany: async (filter, options) => {
          events.push(['addresstx-delete', filter, options.session]);
          return {deletedCount: 4};
        }
      },
      Stats: {
        find: async () => [{last: 101, txes: 3}],
        updateOne: async (filter, update, options) => {
          events.push(['stats', filter, update, options.session]);
          return {matchedCount: 1, modifiedCount: 1};
        }
      }
    };
    const rows = [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }];

    const result = await orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, rows);

    expect(result).toEqual({rollbackHeight: 100, orphanCount: 1});
    expect(events[0]).toBe('begin');
    expect(events).toContain(jasmine.arrayContaining(['tx-delete']));
    expect(events).toContain(jasmine.arrayContaining(['addresstx-delete']));
    expect(events).toContain(jasmine.arrayContaining(['stats']));
    expect(events.slice(-2)).toEqual(['commit', 'end']);
    const addressEvent = events.find(event => Array.isArray(event) && event[0] === 'address-reverse');
    expect(addressEvent[1]).toEqual(jasmine.arrayWithExactContents([
      jasmine.objectContaining({updateOne: jasmine.objectContaining({
        filter: {a_id: 'MAlice'}, update: {$inc: {sent: '-500', received: '0', balance: '500'}}
      })}),
      jasmine.objectContaining({updateOne: jasmine.objectContaining({
        filter: {a_id: 'MBob'}, update: {$inc: {sent: '0', received: '-300', balance: '-300'}}
      })}),
      jasmine.objectContaining({updateOne: jasmine.objectContaining({
        filter: {a_id: 'MCarol'}, update: {$inc: {sent: '0', received: '-200', balance: '-200'}}
      })}),
      jasmine.objectContaining({updateOne: jasmine.objectContaining({
        filter: {a_id: 'coinbase'}, update: {$inc: {sent: '-50', received: '0', balance: '50'}}
      })})
    ]));
    // The zero-delta metadata-only staker alias must not produce an Address write.
    expect(addressEvent[1].map(op => op.updateOne.filter.a_id)).not.toContain('SStake');
  });

  it('skips pure zero-delta staker aliases that have no Address row while still failing nonzero deltas against missing rows', async function() {
    const session = {
      async withTransaction(work) { await work(); },
      async endSession() {}
    };
    // staleTx has a staker alias (zero delta, no Address row in production legacy data)
    // plus a normal monetary address. missingRowTx has a nonzero output to an address
    // with no Address row, which must abort.
    const staleTx = {
      txid: '3'.repeat(64), blockindex: 100, blockhash: hashes.stale,
      vin: [{addresses: 'MAlice', amount: Decimal128.fromString('500')}],
      vout: [{addresses: 'MBob', amount: Decimal128.fromString('500'), stakers: ['SStake']}]
    };
    const addressTransactionsFor = txids => [
      {a_id: 'MAlice', txid: staleTx.txid, blockindex: 100, role: 'balance', amount: Decimal128.fromString('-500')},
      {a_id: 'MBob', txid: staleTx.txid, blockindex: 100, role: 'balance', amount: Decimal128.fromString('500')},
      {a_id: 'SStake', txid: staleTx.txid, blockindex: 100, role: 'staker', amount: Decimal128.fromString('0')}
    ];
    let addressOpsSeen = null;
    const makeModels = addressBulkResult => ({
      Orphans: {countDocuments: async () => 0, bulkWrite: async () => ({matchedCount: 0, upsertedCount: 1, deletedCount: 0})},
      Tx: {
        find: async () => [staleTx],
        countDocuments: async () => 1,
        deleteMany: async () => ({deletedCount: 1})
      },
      Address: {
        bulkWrite: async ops => { addressOpsSeen = ops; return addressBulkResult(ops); },
        deleteMany: async () => ({deletedCount: 0})
      },
      AddressTx: {
        find: async () => addressTransactionsFor(),
        deleteMany: async () => ({deletedCount: 3})
      },
      Stats: {
        find: async () => [{last: 100, txes: 1}],
        updateOne: async () => ({matchedCount: 1, modifiedCount: 1})
      }
    });
    const rows = [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }];

    // Zero-delta alias skipped: only MAlice and MBob are written, both match.
    const okModels = makeModels(ops => ({matchedCount: ops.length}));
    const result = await orphanTips.synchronize({mongoose: {startSession: async () => session}, models: okModels, coin: 'MariaCoin'}, rows);
    expect(result).toEqual({rollbackHeight: 100, orphanCount: 1});
    expect(addressOpsSeen.map(op => op.updateOne.filter.a_id).sort()).toEqual(['MAlice', 'MBob']);

    // A nonzero delta against a missing Address row still aborts.
    const badModels = makeModels(() => ({matchedCount: 1}));
    await expectAsync(orphanTips.synchronize({mongoose: {startSession: async () => session}, models: badModels, coin: 'MariaCoin'}, rows))
      .toBeRejectedWithError(/address update count mismatch/i);
  });

  it('checkpoints a large rollback in bounded idempotent transactions before publishing orphan metadata', async function() {
    const transactions = [1, 513, 1025].map((height, index) => ({
      txid: String(index + 1).repeat(64),
      blockindex: height,
      blockhash: index === 0 ? hashes.stale : String(index + 4).repeat(64),
      vin: [{addresses: 'coinbase', amount: '0'}],
      vout: [{addresses: `MAddress${index}`, amount: '1'}]
    }));
    const addressTransactions = transactions.map((tx, index) => ({
      a_id: `MAddress${index}`, txid: tx.txid, blockindex: tx.blockindex,
      role: 'balance', amount: '1'
    }));
    const stats = {coin: 'MariaCoin', last: 1025, txes: transactions.length};
    const events = [];
    let failSecondBatch = true;
    const session = {
      async withTransaction(work) {
        events.push('begin');
        try { await work(); events.push('commit'); }
        catch (error) { events.push('abort'); throw error; }
      },
      async endSession() { events.push('end'); }
    };
    const inRange = (row, query) => row.blockindex >= query.blockindex.$gte && row.blockindex <= query.blockindex.$lte;
    const models = {
      Orphans: {
        countDocuments: async () => 0,
        bulkWrite: async (_operations, options) => {
          events.push(['orphans', options.session]);
          return {matchedCount: 0, upsertedCount: 1, deletedCount: 0};
        }
      },
      Tx: {
        find: async query => query.$or
          ? transactions.filter(tx => query.$or.some(filter => filter.blockindex === tx.blockindex && filter.blockhash === tx.blockhash))
          : transactions.filter(tx => inRange(tx, query)),
        countDocuments: async () => transactions.length,
        deleteMany: async (filter, options) => {
          const removed = transactions.filter(tx => inRange(tx, filter));
          events.push(['tx-delete', filter, options.session]);
          for (const tx of removed) transactions.splice(transactions.indexOf(tx), 1);
          return {deletedCount: removed.length};
        }
      },
      Address: {
        bulkWrite: async (operations, options) => {
          events.push(['address-reverse', operations.length, options.session]);
          return {matchedCount: operations.length};
        },
        deleteMany: async () => ({deletedCount: 0})
      },
      AddressTx: {
        find: async query => {
          if (!query.$or)
            return addressTransactions.filter(row => inRange(row, query));
          const range = query.$or.find(filter => filter.blockindex && filter.blockindex.$gte != null);
          const txidFilter = query.$or.find(filter => filter.txid && filter.txid.$in);
          return addressTransactions.filter(row =>
            (range && inRange(row, range)) || (txidFilter && txidFilter.txid.$in.includes(row.txid)));
        },
        deleteMany: async (filter, options) => {
          const removed = addressTransactions.filter(row => filter.txid.$in.includes(row.txid));
          if (removed.some(row => row.blockindex === 513) && failSecondBatch) {
            failSecondBatch = false;
            throw new Error('simulated interruption after first committed batch');
          }
          events.push(['addresstx-delete', filter, options.session]);
          for (const row of removed) addressTransactions.splice(addressTransactions.indexOf(row), 1);
          return {deletedCount: removed.length};
        }
      },
      Stats: {
        find: async () => [stats],
        updateOne: async (_filter, update, options) => {
          events.push(['stats', update, options.session]);
          Object.assign(stats, update.$set || {});
          for (const field of Object.keys(update.$unset || {})) delete stats[field];
          return {matchedCount: 1, modifiedCount: 1};
        }
      }
    };

    const dependencies = {
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin', release: 'e'.repeat(40)
    };
    const rows = [{
      blockindex: 1,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }];

    await expectAsync(orphanTips.synchronize(dependencies, rows))
      .toBeRejectedWithError('simulated interruption after first committed batch');
    expect(stats.last).toBe(513);
    expect(stats.orphan_reconciliation.nextHeight).toBe(513);
    expect(await orphanTips.pendingRows(dependencies)).toEqual(rows);
    const rollbackHeight = stats.orphan_reconciliation.rollbackHeight;
    stats.orphan_reconciliation.rollbackHeight = rollbackHeight + 1;
    await expectAsync(orphanTips.pendingRows(dependencies))
      .toBeRejectedWithError(/fence is malformed/i);
    stats.orphan_reconciliation.rollbackHeight = rollbackHeight;
    const result = await orphanTips.synchronize(dependencies, rows);

    const txDeletes = events.filter(event => Array.isArray(event) && event[0] === 'tx-delete');
    expect(txDeletes.length).toBe(3);
    expect(txDeletes.every(event => event[1].blockindex.$lte - event[1].blockindex.$gte < 512)).toBeTrue();
    expect(events.filter(event => Array.isArray(event) && event[0] === 'orphans').length).toBe(1);
    expect(events.findIndex(event => Array.isArray(event) && event[0] === 'orphans'))
      .toBeGreaterThan(events.map(event => Array.isArray(event) && event[0] === 'tx-delete').lastIndexOf(true));
    expect(stats.orphan_reconciliation).toBeUndefined();
    expect(stats.last).toBe(0);
    expect(stats.txes).toBe(0);
    expect(result).toEqual({rollbackHeight: 1, orphanCount: 1});
  });

  it('aborts canonical rollback without advancing stats when a projection delete fails', async function() {
    const events = [];
    const session = {
      async withTransaction(work) {
        events.push('begin');
        try { await work(); events.push('commit'); }
        catch (err) { events.push('abort'); throw err; }
      },
      async endSession() { events.push('end'); }
    };
    const staleTx = {
      txid: '6'.repeat(64), blockindex: 100, blockhash: hashes.stale,
      vin: [{addresses: 'MAlice', amount: '500'}], vout: []
    };
    const models = {
      Orphans: {countDocuments: async () => 0, bulkWrite: async () => {
        events.push('orphans');
        return {matchedCount: 0, upsertedCount: 1, deletedCount: 0};
      }},
      Tx: {
        find: async () => [staleTx],
        countDocuments: async () => 1,
        deleteMany: async () => events.push('tx-delete')
      },
      Address: {
        bulkWrite: async ops => { events.push('address-reverse'); return {matchedCount: ops.length}; },
        deleteMany: async () => {
          events.push('address-zero-delete');
          return {deletedCount: 0};
        }
      },
      AddressTx: {
        find: async () => [{
          a_id: 'MAlice', txid: staleTx.txid, blockindex: 100, role: 'balance', amount: '-500'
        }],
        deleteMany: async () => { events.push('addresstx-delete'); throw new Error('delete failed'); }
      },
      Stats: {find: async () => [{last: 100, txes: 1}], updateOne: async () => events.push('stats')}
    };

    await expectAsync(orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }])).toBeRejectedWithError('delete failed');

    expect(events).toContain('abort');
    expect(events).toContain('end');
    expect(events).not.toContain('tx-delete');
    expect(events).not.toContain('stats');
    expect(events).not.toContain('commit');
  });

  it('aborts canonical rollback when MongoDB reports an incomplete transaction deletion', async function() {
    const events = [];
    const session = {
      async withTransaction(work) {
        try { await work(); events.push('commit'); }
        catch (err) { events.push('abort'); throw err; }
      },
      async endSession() { events.push('end'); }
    };
    const staleTx = {
      txid: '7'.repeat(64), blockindex: 100, blockhash: hashes.stale,
      vin: [{addresses: 'coinbase', amount: '0'}], vout: []
    };
    const models = {
      Orphans: {countDocuments: async () => 0, bulkWrite: async () => ({matchedCount: 0, upsertedCount: 1, deletedCount: 0})},
      Tx: {find: async () => [staleTx], countDocuments: async () => 1, deleteMany: async () => ({deletedCount: 0})},
      Address: {bulkWrite: async () => ({matchedCount: 0}), deleteMany: async () => ({deletedCount: 0})},
      AddressTx: {find: async () => [], deleteMany: async () => ({deletedCount: 0})},
      Stats: {
        find: async () => [{last: 100, txes: 1}],
        updateOne: async () => { events.push('stats'); return {matchedCount: 1}; }
      }
    };

    await expectAsync(orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }])).toBeRejectedWithError(/transaction deletion count mismatch/i);
    expect(events).toContain('abort');
    expect(events).not.toContain('stats');
    expect(events).not.toContain('commit');
  });

  it('aborts canonical rollback when an expected AddressTx projection is missing', async function() {
    const session = {withTransaction: async work => work(), endSession: async () => {}};
    const staleTx = {
      txid: 'a'.repeat(64), blockindex: 100, blockhash: hashes.stale,
      vin: [{addresses: 'MAlice', amount: '500'}], vout: []
    };
    const models = {
      Orphans: {countDocuments: async () => 0, bulkWrite: async () => ({matchedCount: 0, upsertedCount: 1, deletedCount: 0})},
      Tx: {find: async () => [staleTx], countDocuments: async () => 1},
      Address: {bulkWrite: async () => { throw new Error('must not write addresses'); }},
      AddressTx: {find: async () => []},
      Stats: {find: async () => [{last: 100, txes: 1}]}
    };

    await expectAsync(orphanTips.synchronize({
      mongoose: {startSession: async () => session}, models, coin: 'MariaCoin'
    }, [{
      blockindex: 100,
      orphan_blockhash: hashes.stale,
      good_blockhash: hashes.good,
      prev_blockhash: hashes.previous,
      next_blockhash: hashes.next
    }])).toBeRejectedWithError(/AddressTx projection mismatch/i);
  });
});
