'use strict';

const fixtures = require('./fixtures/mariacoin-v551');
const liveCoinstake = require('./fixtures/live-coinstake.json');
const maria = require('../lib/mariacoin');
const explorer = require('../lib/explorer');
const blockSync = require('../lib/block_sync');
const database = require('../lib/database');
const mongoose = require('mongoose');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
process.env.EIQUIDUS_RELEASE_ROOT = path.resolve(__dirname, '..');
const mongodbPreflight = require('../deploy/eiquidus/mongodb-preflight');

function fakePersistence(failCollection, state = {}) {
  const calls = [];
  const statsRows = state.statsRows || [{last: state.last ?? -1, txes: state.txes ?? 0}];
  const txCount = state.txCount ?? 0;
  const session = {
    async withTransaction(work) {
      calls.push(['begin']);
      try { await work(); calls.push(['commit']); }
      catch (err) { calls.push(['abort']); throw err; }
    },
    async endSession() { calls.push(['end']); }
  };
  const model = (name) => ({
    async bulkWrite(ops, options) {
      calls.push([name, 'bulkWrite', ops, options]);
      if (failCollection === name) throw new Error(`${name} failed`);
      return name === 'tx'
        ? {insertedCount: ops.length}
        : {matchedCount: ops.length, upsertedCount: 0};
    },
    async findOne(query) { calls.push([name, 'findOne', query]); return null; },
    async find(query, projection, options) {
      calls.push([name, 'find', query, projection, options]);
      return name === 'stats' ? statsRows : [];
    },
    async countDocuments(query, options) {
      calls.push([name, 'countDocuments', query, options]);
      return name === 'tx' ? txCount : 0;
    },
    async updateOne(query, update, options) {
      calls.push([name, 'updateOne', query, update, options]);
      if (failCollection === name) throw new Error(`${name} failed`);
      return {matchedCount: failCollection === `${name}-missing` ? 0 : 1, modifiedCount: 1};
    }
  });
  return {
    calls,
    mongoose: { startSession: async () => session },
    models: { Tx: model('tx'), Address: model('address'), AddressTx: model('addressTx'), Stats: model('stats') }
  };
}

describe('MariaCoin v5.5.1 transaction compatibility', function() {
  it('disables Mongoose automatic index mutation on every application connection', async function() {
    spyOn(mongoose, 'set').and.callThrough();
    spyOn(mongoose, 'connect').and.resolveTo();
    await new Promise(resolve => database.connect('mongodb://application-connection', resolve));
    expect(mongoose.set).toHaveBeenCalledWith('autoIndex', false);
    expect(mongoose.connect).toHaveBeenCalledWith('mongodb://application-connection', {autoIndex: false});
  });

  it('refuses AddressTx unique-index migration before mutation when projection identities are duplicated', async function() {
    let inspectedIndexes = false;
    const collection = {
      aggregate(pipeline) {
        expect(pipeline).toEqual([
          {$group: {_id: {a_id: '$a_id', txid: '$txid', role: {$ifNull: ['$role', null]}}, count: {$sum: 1}}},
          {$match: {count: {$gt: 1}}},
          {$limit: 1}
        ]);
        return {toArray: async () => [{_id: {a_id: 'A', txid: 'T', role: null}, count: 2}]};
      },
      async indexes() { inspectedIndexes = true; return []; },
      async createIndex() { throw new Error('index mutation must not run'); }
    };
    const database = {collection: () => collection};
    await expectAsync(mongodbPreflight.ensureAddressTransactionIndex(database, true))
      .toBeRejectedWithError(/duplicate AddressTx projection identities/i);
    expect(inspectedIndexes).toBeFalse();
  });

  it('normalizes unavailable optional numeric metrics without crashing summary panels', function() {
    expect(explorer.normalize_optional_decimal('-').toFixed()).toBe('0');
    expect(explorer.normalize_optional_decimal('').toFixed()).toBe('0');
    expect(explorer.normalize_optional_decimal(null).toFixed()).toBe('0');
    expect(explorer.normalize_optional_decimal(undefined).toFixed()).toBe('0');
    expect(explorer.normalize_optional_decimal('12.5').toFixed()).toBe('12.5');
  });

  it('keeps internal masternode panels independent from the disabled public RPC proxy', function() {
    const explorerSource = fs.readFileSync(require.resolve('../lib/explorer'), 'utf8');
    const summarySource = fs.readFileSync(require.resolve('../app'), 'utf8');
    const helper = explorerSource.slice(explorerSource.indexOf('get_masternodecount: function'), explorerSource.indexOf('get_blockcount: function'));
    const summary = summarySource.slice(summarySource.indexOf("app.use('/ext/getsummary'"), summarySource.indexOf("app.use('/ext/getnetworkpeers'"));
    expect(helper).not.toContain('public_apis.rpc.getmasternodecount.enabled');
    expect(summary).not.toContain('public_apis.rpc.getmasternodecount.enabled');
    expect(summary).toContain("settings.api_cmds['getmasternodecount']");
  });

  it('fails masternode synchronization when cleanup or timestamp persistence fails', function() {
    const databaseSource = fs.readFileSync(require.resolve('../lib/database'), 'utf8');
    const syncSource = fs.readFileSync(require.resolve('../scripts/sync'), 'utf8');
    const cleanup = databaseSource.slice(databaseSource.indexOf('remove_old_masternodes: function'), databaseSource.indexOf('// get the list of masternodes'));
    const sync = syncSource.slice(syncSource.indexOf("else if (database == 'masternodes')"), syncSource.indexOf('// start market sync'));

    expect(cleanup).toContain('return cb(true)');
    expect(cleanup).toContain('return cb(false)');
    expect(sync).toContain('function(cleanup_success)');
    expect(sync).toContain('if (!cleanup_success)');
    expect(sync).toContain('if (!update_success)');
    expect(sync).toContain("console.log('Masternode sync complete')");
  });

  it('syncs peer records without requiring an external geolocation service', function() {
    const syncSource = fs.readFileSync(require.resolve('../scripts/sync'), 'utf8');
    const explorerSource = fs.readFileSync(require.resolve('../lib/explorer'), 'utf8');
    const networkView = fs.readFileSync(require.resolve('../views/network.pug'), 'utf8');
    const peerSync = syncSource.slice(syncSource.indexOf("else if (database == 'peers')"), syncSource.indexOf("else if (database == 'masternodes')"));
    const peerPersistence = syncSource.slice(syncSource.indexOf('function bulkUpsertPeers'), syncSource.indexOf('function update_address_count'));
    expect(peerSync).toContain('settings.sync.peer_geolocation_enabled');
    expect(peerSync).toContain('country:');
    expect(peerSync).toContain('country_code:');
    expect(peerPersistence).toContain('return cb(true)');
    expect(peerPersistence).toContain('return cb(false)');
    expect(peerSync).toContain('function(upsert_success)');
    expect(peerSync).toContain('if (!upsert_success)');
    expect(peerSync).toContain('function(deduplication_success)');
    expect(peerSync).toContain('if (!deduplication_success)');
    expect(peerSync).toContain('if (!update_success)');
    expect(explorerSource).toContain("require('geoip-lite')");
    expect(explorerSource).not.toContain('reallyfreegeoip.org');
    expect(networkView).toContain("th.text-center='IP'");
    expect(networkView).toContain("th.text-center='Wallet version'");
  });

  it('counts every deleted transaction during fork repair, including records without address rows', function() {
    expect(blockSync.deletedTransactionDelta({ deletedCount: 1 })).toBe(-1);
    expect(blockSync.deletedTransactionDelta({ deletedCount: 0 })).toBe(0);
  });

  it('atomically rolls back stale canonical projections and resumes canonical indexing', function() {
    const syncSource = fs.readFileSync(require.resolve('../scripts/sync'), 'utf8');
    const orphanSource = fs.readFileSync(require.resolve('../lib/orphan_tips'), 'utf8');
    expect(syncSource).toContain('function block_sync(reindex, stats, orphansChecked = false)');
    expect(syncSource).toContain('block_sync(false, refreshedStats, true)');
    expect(syncSource).toContain('orphanResult.rollbackHeight');
    expect(orphanSource).toContain('await session.withTransaction(async () => {');
    expect(orphanSource).toContain('Canonical rollback transaction deletion count mismatch');
    expect(orphanSource).toContain('$set: {last: rollbackHeight - 1, txes: stats.txes - transactions.length}');
  });

  it('defines production schema fields and an unsynced last height of -1', function() {
    const Tx = require('../models/tx');
    const AddressTx = require('../models/addresstx');
    const Stats = require('../models/stats');
    expect(new Stats({ coin: 'MariaCoin' }).last).toBe(-1);
    expect(Stats.schema.path('coin').options.unique).toBeTrue();
    expect(Stats.schema.path('coin').options.index).toBeTrue();
    ['tx_type', 'staker', 'stakers', 'valueBalance', 'valueBalanceSat', 'shieldedSpendCount', 'shieldedOutputCount', 'vShieldSpend', 'vShieldOutput']
      .forEach(field => expect(Tx.schema.path(field)).toBeDefined());
    expect(AddressTx.schema.path('role')).toBeDefined();
  });

  it('credits a coldstake output only to owner and indexes staker as zero-value metadata', function() {
    const prepared = maria.prepareTransaction(fixtures.coldstake(), 131606);
    expect(prepared.tx.txid).toBe(fixtures.COLDSTAKE_TXID);
    expect(prepared.tx.tx_type).toBe('normal');
    expect(prepared.tx.staker).toBe(fixtures.STAKER);
    expect(prepared.tx.stakers).toEqual([fixtures.STAKER]);
    expect(prepared.tx.vout[0].addresses).toBe(fixtures.OWNER);
    expect(prepared.tx.vout[0].stakers).toEqual([fixtures.STAKER]);
    expect(prepared.addresses.find(a => a.hash === fixtures.OWNER).received).toBe('9999992400');
    expect(prepared.addresses.find(a => a.hash === fixtures.STAKER)).toEqual(jasmine.objectContaining({
      sent: '0', received: '0', balance: '0'
    }));
    expect(prepared.addressTx).toContain(jasmine.objectContaining({ a_id: fixtures.STAKER, amount: '0', role: 'staker' }));
  });

  it('strictly classifies coinbase, coinstake, Sapling and normal transactions', function() {
    expect(maria.prepareTransaction(fixtures.coinbase(), 0).tx.tx_type).toBe('coinbase');
    expect(maria.prepareTransaction(fixtures.coinstake(), 131607).tx.tx_type).toBe('coinstake');
    expect(maria.prepareTransaction(fixtures.saplingWithdrawal(), 200000).tx.tx_type).toBe('sapling');
    expect(maria.prepareTransaction(fixtures.normal(), 12).tx.tx_type).toBe('normal');
  });

  it('stores a coinstake transaction total as newly minted reward, not returned stake principal', function() {
    const prepared = maria.prepareTransaction(fixtures.coinstake(), 131607).tx;

    // The live fixture returns 517.95601767 $maria of stake plus 111 $maria of rewards.
    // Listing the gross 628.95601767 outputs as the transaction amount is misleading.
    expect(prepared.total).toBe('11100000000');
  });

  it('recalculates an already indexed coinstake total from stored satoshi rows', function() {
    const tx = maria.prepareTransaction(fixtures.coinstake(), 131607).tx;

    expect(maria.calculateStoredTransactionTotal(tx.tx_type, tx.vin, tx.vout)).toBe('11100000000');
  });

  it('preserves canonical Sapling withdrawal accounting and opaque structures', function() {
    const prepared = maria.prepareTransaction(fixtures.saplingWithdrawal(), 200000).tx;
    expect(prepared.vin).toEqual([]);
    expect(prepared.valueBalance).toBe('718.7193418');
    expect(prepared.valueBalanceSat).toBe('71871934180');
    expect(prepared.shieldedSpendCount).toBe(1);
    expect(prepared.shieldedOutputCount).toBe(0);
    expect(prepared.vShieldSpend).toEqual(fixtures.saplingWithdrawal().vShieldSpend);
    expect(prepared.vout[0]).toEqual(jasmine.objectContaining({ addresses: 'MT37Jic7rDsqwQeKfMmcEZ1cqp2DUmdoGR', amount: '71871431180' }));
  });

  it('accounts a canonical valued OP_RETURN as a provably unspendable burn', function() {
    const raw = {
      txid: 'b42d8c9164ab93227790a02f06b270003d51066a401a0ace919d14d4d41d4872',
      blockhash: '5acdfd78c57af29af2dcbe61e30567c8344088dff418269f2d13bfdb6cd63d6b',
      time: 1671620655,
      vin: [{
        txid: 'bbdbe8c1b15f864453be51305f8f25050c9c1d84f998201eeed02e983f1ca910',
        vout: 0,
        address: 'MWcm24xmskfcwSfokFyitqKSv6HPauAHMe',
        amountSat: '6461688329'
      }],
      vout: [{
        value: 14.61685979,
        n: 0,
        scriptPubKey: { type: 'pubkeyhash', addresses: ['MPbLtgjNTRrd8d8TMRLKn5PoUATjEqPENa'] }
      }, {
        value: 50,
        n: 1,
        scriptPubKey: {
          type: 'nulldata',
          asm: 'OP_RETURN 9892f5120601affc6b9aaef4866a85c8ddcbd96a7edf1d98a76808f38916da09',
          hex: '6a209892f5120601affc6b9aaef4866a85c8ddcbd96a7edf1d98a76808f38916da09'
        }
      }]
    };
    const prepared = maria.prepareTransaction(raw, 145908);
    expect(prepared.tx.total).toBe('6461685979');
    expect(prepared.tx.vout[1]).toEqual(jasmine.objectContaining({
      addresses: 'OP_RETURN', amount: '5000000000', n: 1, script_type: 'nulldata', burn: true
    }));
    expect(prepared.addresses.map(row => row.hash)).not.toContain('OP_RETURN');
    expect(prepared.addressTx.map(row => row.a_id)).not.toContain('OP_RETURN');
    expect(prepared.addresses.find(row => row.hash === 'MWcm24xmskfcwSfokFyitqKSv6HPauAHMe').balance).toBe('-6461688329');
    expect(prepared.addresses.find(row => row.hash === 'MPbLtgjNTRrd8d8TMRLKn5PoUATjEqPENa').balance).toBe('1461685979');
  });

  it('rejects valued outputs that are not provably unspendable OP_RETURN scripts', function() {
    const raw = fixtures.normal();
    raw.vout[0] = { value: 1, n: 0, scriptPubKey: { type: 'nulldata', asm: 'not OP_RETURN', hex: '51' } };
    expect(() => maria.prepareTransaction(raw, 1)).toThrowError(/unaccounted nulldata output with value/i);
    raw.vout[0] = { value: 1, n: 0, scriptPubKey: { type: 'nonstandard', asm: 'OP_RETURN', hex: '6a' } };
    expect(() => maria.prepareTransaction(raw, 1)).toThrowError(/unaccounted nonstandard output with value/i);
  });

  it('rejects negative burns and malformed transparent output indexes', function() {
    const burn = fixtures.normal();
    burn.vout[0] = { value: -1, n: 0, scriptPubKey: { type: 'nulldata', asm: 'OP_RETURN 00', hex: '6a0100' } };
    expect(() => maria.prepareTransaction(burn, 1)).toThrowError(/negative transparent output/i);
    for (const invalid of [undefined, -1, 1.5, '1']) {
      burn.vout[0] = { value: 1, n: invalid, scriptPubKey: { type: 'nulldata', asm: 'OP_RETURN 00', hex: '6a0100' } };
      expect(() => maria.prepareTransaction(burn, 1)).toThrowError(/output index/i);
    }
  });

  it('rejects coinstake flags unless the structural marker is present', function() {
    const oneOutput = fixtures.normal();
    oneOutput.isCoinStake = true;
    expect(() => maria.prepareTransaction(oneOutput, 10)).toThrowError(/malformed coinstake/i);

    const nonzeroMarker = fixtures.coinstake();
    nonzeroMarker.isCoinStake = true;
    nonzeroMarker.vout[0].value = 1;
    expect(() => maria.prepareTransaction(nonzeroMarker, 10)).toThrowError(/malformed coinstake/i);

    const scriptedMarker = fixtures.coinstake();
    scriptedMarker.isCoinStake = true;
    scriptedMarker.vout[0].scriptPubKey.asm = '01';
    expect(() => maria.prepareTransaction(scriptedMarker, 10)).toThrowError(/malformed coinstake/i);
  });

  it('resolves a spent coldstake input to the owner rather than the staker', async function() {
    const raw = JSON.parse(JSON.stringify(liveCoinstake));
    const previous = {
      txid: raw.vin[0].txid,
      vout: [{
        n: 6,
        value: 517.95601767,
        scriptPubKey: {
          type: 'coldstake',
          addresses: ['SQC775BPCQ5dH9A3i7rgaSMWFgmSENzxVx', 'MWEpronG9pk7fAVBB1Scw6Y9DMmfXrBqVU']
        }
      }]
    };
    const enriched = await maria.enrichTransparentInputs(raw, async txid => {
      expect(txid).toBe(previous.txid);
      return previous;
    });
    expect(enriched.vin[0]).toEqual(jasmine.objectContaining({
      address: 'MWEpronG9pk7fAVBB1Scw6Y9DMmfXrBqVU',
      amountSat: '51795601767',
      sourceType: 'coldstake',
      staker: 'SQC775BPCQ5dH9A3i7rgaSMWFgmSENzxVx',
      txid: previous.txid,
      vout: 6
    }));
    const prepared = maria.prepareTransaction(enriched, 10);
    expect(prepared.tx.vin[0]).toEqual(jasmine.objectContaining({
      addresses: 'MWEpronG9pk7fAVBB1Scw6Y9DMmfXrBqVU',
      sourceType: 'coldstake',
      staker: 'SQC775BPCQ5dH9A3i7rgaSMWFgmSENzxVx'
    }));
  });

  it('rejects malformed or unsupported private transaction structures', function() {
    const malformed = fixtures.saplingWithdrawal();
    malformed.valueBalanceSat = 1;
    expect(() => maria.prepareTransaction(malformed, 1)).toThrowError(/valueBalance/);
    const malformedSpend = fixtures.saplingWithdrawal();
    delete malformedSpend.vShieldSpend[0].proof;
    expect(() => maria.prepareTransaction(malformedSpend, 1)).toThrowError(/malformed Sapling spend/);
    expect(() => maria.prepareTransaction({ ...fixtures.normal(), vjoinsplit: [{}] }, 1)).toThrowError(/unsupported/i);
    const zero = fixtures.normal();
    zero.vout[0].scriptPubKey.type = 'zerocoinmint';
    expect(() => maria.prepareTransaction(zero, 1)).toThrowError(/unsupported/i);
    const unresolved = fixtures.normal();
    unresolved.vin = [{ addresses: 'unknown_address', amountSat: '0' }];
    expect(() => maria.prepareTransaction(unresolved, 1)).toThrowError(/resolve transparent input/i);
    expect(() => maria.prepareTransaction({ ...fixtures.normal(), vin: [] }, 1)).toThrowError(/classification/i);
  });

  it('binds RPC transaction and block responses to the requested identities', function() {
    const tx = fixtures.coldstake();
    expect(maria.validateRawTransactionResponse(fixtures.COLDSTAKE_TXID.toUpperCase(), tx)).toBe(tx);
    expect(() => maria.validateRawTransactionResponse('f'.repeat(64), tx)).toThrowError(/txid mismatch/i);

    const block = { hash: 'a'.repeat(64), height: 0, tx: [fixtures.COLDSTAKE_TXID] };
    expect(maria.validateBlockResponse('A'.repeat(64), 0, block)).toBe(block);
    expect(() => maria.validateBlockResponse('b'.repeat(64), 0, block)).toThrowError(/block hash mismatch/i);
    expect(() => maria.validateBlockResponse('a'.repeat(64), 1, block)).toThrowError(/block height mismatch/i);
    expect(() => maria.validateBlockResponse('a'.repeat(64), 0, { ...block, tx: [] })).toThrowError(/transaction list/i);
  });

  it('accepts an identity-bound verbosity-2 genesis transaction when genesis is absent from txindex', function() {
    const blockhash = 'a'.repeat(64);
    const txid = 'b'.repeat(64);
    const verboseBlock = { hash: blockhash, height: 0, tx: [{ txid, vin: [{ coinbase: '00' }], vout: [] }] };
    const transactions = maria.validateVerboseBlockTransactions(blockhash, 0, [txid], verboseBlock);
    expect(transactions.length).toBe(1);
    expect(transactions[0].txid).toBe(txid);
    expect(transactions[0].blockhash).toBe(blockhash);
    expect(() => maria.validateVerboseBlockTransactions(blockhash, 0, ['c'.repeat(64)], verboseBlock)).toThrowError(/transaction list mismatch/i);
  });

  it('uses the canonical coldstake transaction for fatal txindex preflight', async function() {
    const seen = [];
    await maria.preflightTxIndex(async txid => { seen.push(txid); return fixtures.coldstake(); });
    expect(seen).toEqual([fixtures.COLDSTAKE_TXID]);
    await expectAsync(maria.preflightTxIndex(async () => null)).toBeRejectedWithError(/txindex=1/);
  });

  it('does not invoke the txindex preflight callback twice when the callback throws', async function() {
    spyOn(maria, 'preflightTxIndex').and.resolveTo();
    let calls = 0;
    await expectAsync(blockSync.preflight_txindex(() => {
      calls += 1;
      throw new Error('caller callback failed');
    })).toBeRejectedWithError('caller callback failed');
    expect(calls).toBe(1);
  });
});

describe('MariaCoin RPC timeout settings', function() {
  it('accepts a configured wallet timeout for the JSON-RPC client', function() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mariacoin-settings-'));
    try {
      const templatePath = path.resolve(__dirname, '../settings.json.template');
      let settings;
      if (fs.existsSync(templatePath)) {
        const template = fs.readFileSync(templatePath, 'utf8');
        settings = template.replace(/("port": 51573,\r?\n)/, '$1    "timeout": 60000,\n');
        expect(settings).not.toBe(template);
      } else {
        settings = JSON.parse(JSON.stringify(require('../lib/settings')));
        settings.wallet.timeout = 60000;
        settings = JSON.stringify(settings);
      }
      fs.writeFileSync(path.join(directory, 'settings.json'), settings);
      const output = execFileSync(process.execPath, [
        '-e',
        `const settings=require(${JSON.stringify(path.resolve(__dirname, '../lib/settings.js'))}); settings.loadSettings(); process.stdout.write(String(settings.wallet.timeout));`
      ], {cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
      expect(output).toBe('60000');
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
});

describe('MariaCoin atomic block persistence', function() {
  it('declares an exact unique AddressTx projection identity index', function() {
    const indexes = require('../models/addresstx').schema.indexes();
    expect(indexes.some(([key, options]) => JSON.stringify(key) === JSON.stringify({a_id: 1, txid: 1, role: 1}) &&
      options.unique === true)).toBeTrue();
  });

  it('rejects empty or duplicate transaction lists before opening a MongoDB session', async function() {
    const fake = fakePersistence();
    await expectAsync(maria.persistBlockAtomic({height: 2, hash: 'b', tx: []}, 'MariaCoin', fake))
      .toBeRejectedWithError(/invalid block/i);
    const raw = fixtures.normal();
    await expectAsync(maria.persistBlockAtomic({height: 2, hash: 'b', tx: [raw, raw]}, 'MariaCoin', fake))
      .toBeRejectedWithError(/duplicate transaction/i);
    expect(fake.calls).toEqual([]);
  });

  it('prepares every transaction before opening a MongoDB session', async function() {
    const fake = fakePersistence();
    const bad = fixtures.normal(); bad.vout[0].scriptPubKey.type = 'zerocoinmint';
    await expectAsync(maria.persistBlockAtomic({ height: 5, hash: 'x', tx: [fixtures.normal(), bad] }, 'MariaCoin', fake)).toBeRejected();
    expect(fake.calls).toEqual([]);
  });

  it('persists address, addressTx, tx and stats in one transaction/session', async function() {
    const fake = fakePersistence(null, {last: 131605});
    const result = await maria.persistBlockAtomic({ height: 131606, hash: 'block-131606', tx: [fixtures.coldstake()] }, 'MariaCoin', fake);
    expect(result).toEqual({ txesAdded: 1, last: 131606 });
    expect(fake.calls[0]).toEqual(['begin']);
    expect(fake.calls.map(c => c[0])).toEqual(jasmine.arrayContaining(['address', 'addressTx', 'tx', 'stats']));
    const statsWrite = fake.calls.find(c => c[0] === 'stats' && c[1] === 'updateOne');
    expect(statsWrite[3]).toEqual({$set: {last: 131606, txes: 1}});
    expect(statsWrite[4].session).toBeDefined();
    expect(fake.calls[fake.calls.length - 2]).toEqual(['commit']);
  });

  it('rejects impossible address bulk-write counters even when their sum matches', async function() {
    const fake = fakePersistence(null, {last: 1});
    fake.models.Address.bulkWrite = async ops => ({matchedCount: -1, upsertedCount: ops.length + 1});
    await expectAsync(maria.persistBlockAtomic(
      {height: 2, hash: 'b', tx: [fixtures.normal()]}, 'MariaCoin', fake
    )).toBeRejectedWithError(/address update count mismatch/i);
  });

  it('counts a valid fully shielded transaction with no transparent outputs', async function() {
    const fake = fakePersistence(null, {last: 199999});
    const shieldedOnly = fixtures.saplingWithdrawal();
    shieldedOnly.vout = [];
    shieldedOnly.valueBalance = 0;
    shieldedOnly.valueBalanceSat = 0;
    const result = await maria.persistBlockAtomic({ height: 200000, hash: 'shielded-block', tx: [shieldedOnly] }, 'MariaCoin', fake);
    expect(result).toEqual({ txesAdded: 1, last: 200000 });
  });

  it('aborts without stats cursor/count advance when any write fails', async function() {
    const fake = fakePersistence('tx', {last: 1});
    await expectAsync(maria.persistBlockAtomic({ height: 2, hash: 'b', tx: [fixtures.normal()] }, 'MariaCoin', fake)).toBeRejectedWithError(/tx failed/);
    expect(fake.calls.some(c => c[0] === 'abort')).toBeTrue();
    expect(fake.calls.some(c => c[0] === 'stats' && c[1] === 'updateOne')).toBeFalse();
  });

  it('aborts all block projections when the Stats document is missing', async function() {
    const fake = fakePersistence('stats-missing', {statsRows: []});
    await expectAsync(maria.persistBlockAtomic(
      {height: 2, hash: 'b', tx: [fixtures.normal()]}, 'MariaCoin', fake
    )).toBeRejectedWithError(/exactly one Stats document/i);
    expect(fake.calls.some(c => c[0] === 'abort')).toBeTrue();
    expect(fake.calls.some(c => c[0] === 'commit')).toBeFalse();
  });

  it('refuses unsafe existing-tx replacement', async function() {
    const fake = fakePersistence(null, {last: 131605});
    fake.models.Tx.findOne = async () => ({ txid: fixtures.COLDSTAKE_TXID, blockindex: 1 });
    await expectAsync(maria.persistBlockAtomic({ height: 131606, hash: 'block-131606', tx: [fixtures.coldstake()] }, 'MariaCoin', fake)).toBeRejectedWithError(/unsafe existing transaction replacement/i);
    expect(fake.calls.some(c => c[0] === 'abort')).toBeTrue();
  });

  it('cannot bypass existing-tx refusal with a caller-supplied cleanup hook', async function() {
    const fake = fakePersistence(null, {last: 131605});
    fake.models.Tx.findOne = async () => ({txid: fixtures.COLDSTAKE_TXID, blockindex: 1});
    const cleanup = jasmine.createSpy('cleanup');
    await expectAsync(maria.persistBlockAtomic(
      {height: 131606, hash: 'block-131606', tx: [fixtures.coldstake()]},
      'MariaCoin', fake, {cleanupExistingTransaction: cleanup}
    )).toBeRejectedWithError(/unsafe existing transaction replacement/i);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('aborts before projection writes when duplicate Stats rows exist', async function() {
    const fake = fakePersistence(null, {statsRows: [{last: 1, txes: 0}, {last: 1, txes: 0}]});
    await expectAsync(maria.persistBlockAtomic(
      {height: 2, hash: 'b', tx: [fixtures.normal()]}, 'MariaCoin', fake
    )).toBeRejectedWithError(/exactly one Stats document/i);
    expect(fake.calls.some(c => ['address', 'addressTx', 'tx'].includes(c[0]) && c[1] === 'bulkWrite')).toBeFalse();
  });

  it('aborts before projection writes when Stats.txes differs from the Tx collection', async function() {
    const fake = fakePersistence(null, {last: 1, txes: 7, txCount: 10});
    await expectAsync(maria.persistBlockAtomic(
      {height: 2, hash: 'b', tx: [fixtures.normal()]}, 'MariaCoin', fake
    )).toBeRejectedWithError(/Stats transaction count mismatch/i);
    expect(fake.calls.some(c => ['address', 'addressTx', 'tx'].includes(c[0]) && c[1] === 'bulkWrite')).toBeFalse();
  });

  it('checks Stats transaction cardinality once before a serialized run', async function() {
    const fake = fakePersistence(null, {last: 1, txes: 7, txCount: 10});
    await expectAsync(maria.verifyStatsTransactionCount('MariaCoin', fake))
      .toBeRejectedWithError(/Stats transaction count mismatch/i);
    expect(fake.calls.some(c => c[0] === 'tx' && c[1] === 'countDocuments')).toBeTrue();
  });

  it('does not rescan the full Tx collection after a serialized run preflight', async function() {
    const fake = fakePersistence(null, {last: 1, txes: 0, txCount: 999});
    const result = await maria.persistBlockAtomic(
      {height: 2, hash: 'b', tx: [fixtures.normal()]},
      'MariaCoin', {...fake, statsTransactionCountVerified: true}
    );
    expect(result).toEqual({txesAdded: 1, last: 2});
    expect(fake.calls.some(c => c[0] === 'tx' && c[1] === 'countDocuments')).toBeFalse();
  });

  it('aborts a new block when the Stats cursor is not the previous height', async function() {
    const fake = fakePersistence(null, {last: 0, txes: 0, txCount: 0});
    await expectAsync(maria.persistBlockAtomic(
      {height: 2, hash: 'b', tx: [fixtures.normal()]}, 'MariaCoin', fake
    )).toBeRejectedWithError(/Stats cursor is not sequential/i);
    expect(fake.calls.some(c => ['address', 'addressTx', 'tx'].includes(c[0]) && c[1] === 'bulkWrite')).toBeFalse();
  });

  it('does not rewind Stats when an already indexed block is replayed', async function() {
    const raw = fixtures.normal();
    const prepared = maria.prepareTransaction(raw, 2);
    const fake = fakePersistence(null, {last: 5, txes: 1, txCount: 1});
    fake.models.Tx.findOne = async () => prepared.tx;
    fake.models.AddressTx.find = async () => prepared.addressTx;
    fake.models.Address.find = async () => prepared.addresses.map(address => ({a_id: address.hash}));

    const result = await maria.persistBlockAtomic({height: 2, hash: 'b', tx: [raw]}, 'MariaCoin', fake);
    expect(result).toEqual({txesAdded: 0, last: 5});
    expect(fake.calls.some(c => c[0] === 'stats' && c[1] === 'updateOne')).toBeFalse();
  });

  it('fails closed when replayed transaction projections are missing', async function() {
    const raw = fixtures.normal();
    const prepared = maria.prepareTransaction(raw, 2);
    const fake = fakePersistence(null, {last: 5, txes: 1, txCount: 1});
    fake.models.Tx.findOne = async () => prepared.tx;
    fake.models.AddressTx.find = async () => [];

    await expectAsync(maria.persistBlockAtomic(
      {height: 2, hash: 'b', tx: [raw]}, 'MariaCoin', fake
    )).toBeRejectedWithError(/replay.*projection/i);
    expect(fake.calls.some(c => c[0] === 'stats' && c[1] === 'updateOne')).toBeFalse();
  });

  it('fails closed when only part of the next block is already projected', async function() {
    const first = fixtures.normal();
    const second = JSON.parse(JSON.stringify(first));
    second.txid = 'e'.repeat(64);
    const preparedFirst = maria.prepareTransaction(first, 2).tx;
    const fake = fakePersistence(null, {last: 1, txes: 1, txCount: 1});
    fake.models.Tx.findOne = async query => query.txid === preparedFirst.txid
      ? {txid: preparedFirst.txid, blockindex: 2, blockhash: preparedFirst.blockhash}
      : null;

    await expectAsync(maria.persistBlockAtomic(
      {height: 2, hash: 'b', tx: [first, second]}, 'MariaCoin', fake
    )).toBeRejectedWithError(/partial block projection/i);
    expect(fake.calls.some(c => ['address', 'addressTx', 'tx'].includes(c[0]) && c[1] === 'bulkWrite')).toBeFalse();
  });

  it('fails closed when a new transaction has dangling AddressTx projections', async function() {
    const raw = fixtures.normal();
    const fake = fakePersistence(null, {last: 1});
    fake.models.AddressTx.find = async () => [{a_id: 'dangling', txid: raw.txid, blockindex: 2, amount: '1', role: 'balance'}];

    await expectAsync(maria.persistBlockAtomic(
      {height: 2, hash: 'b', tx: [raw]}, 'MariaCoin', fake
    )).toBeRejectedWithError(/partial.*projection/i);
    expect(fake.calls.some(c => ['address', 'addressTx', 'tx'].includes(c[0]) && c[1] === 'bulkWrite')).toBeFalse();
  });

  it('returns a fatal error through the block sync callback when txindex preflight fails', function(done) {
    spyOn(explorer, 'get_rawtransaction').and.callFake((_txid, cb) => cb(null));
    blockSync.update_tx_db('MariaCoin', 0, 0, 0, 0, 0, function(txes, err) {
      expect(txes).toBe(0);
      expect(err).toEqual(jasmine.any(Error));
      expect(err.message).toMatch(/txindex preflight failed/i);
      done();
    });
  });

  it('indexes genesis from a strict verbosity-2 block because genesis is absent from txindex', function(done) {
    const blockhash = 'a'.repeat(64);
    const genesisTxid = 'b'.repeat(64);
    spyOn(explorer, 'get_rawtransaction').and.callFake((txid, cb) => cb(txid === fixtures.COLDSTAKE_TXID ? fixtures.coldstake() : null));
    spyOn(explorer, 'get_blockhash').and.callFake((_height, cb) => cb(blockhash));
    spyOn(explorer, 'get_block').and.callFake((_hash, cb) => cb({ hash: blockhash, height: 0, tx: [genesisTxid] }));
    spyOn(explorer, 'get_block_with_transactions').and.callFake((_hash, cb) => cb({
      hash: blockhash,
      height: 0,
      tx: [{ txid: genesisTxid, vin: [{ coinbase: '00' }], vout: [] }]
    }));
    spyOn(maria, 'verifyStatsTransactionCount').and.resolveTo();
    spyOn(maria, 'persistBlockAtomic').and.resolveTo({ txesAdded: 1 });
    blockSync.update_tx_db('MariaCoin', 0, 0, 0, 0, 0, function(txes, err) {
      expect(err).toBeNull();
      expect(txes).toBe(1);
      expect(explorer.get_block_with_transactions).toHaveBeenCalledWith(blockhash, jasmine.any(Function));
      expect(maria.persistBlockAtomic).toHaveBeenCalledWith(
        jasmine.any(Object),
        'MariaCoin',
        jasmine.objectContaining({statsTransactionCountVerified: true})
      );
      done();
    });
  });
});
