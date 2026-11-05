#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { MongoClient } = require('/opt/eiquidus/current/node_modules/mongodb');

const GENESIS = '0000040cb60b26f13ffcd2f692d679e172da34096041efe215d8c50cd65dd9f9';
const GENESIS_TX = '5e82501aa4f898173ca938fef4d080f25969109efd7b790fe323bcff9f16dc04';
const COLDSTAKE_TXID = '09fabd30b14d79ae7c4c687ad9e4517974223108474d468181d32ff8d588fdee';
const SAPLING_TXID = 'a6324f5d9173db07f34e6b20c8f19f8824475b3753c9120532d6f71278cd99e5';
const OWNER = 'MGJ5AH9JEyhwmF1eqwbpgRhY2q3NMQHXh8';
const STAKER = 'Sa5pvnsDtF9NUX1Zkz7ikMxciLuvmeoKfM';
const MARKER = '/var/lib/eiquidus/INDEX_VERIFIED.json';
const CURRENT = '/opt/eiquidus/current';
const MAX_INDEX_LAG = 2;


function readKeyValues(file) {
  const result = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

function rpc(credentials, method, params = []) {
  const body = JSON.stringify({ jsonrpc: '1.0', id: 'index-verifier', method, params });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: 47774, method: 'POST', path: '/',
      auth: `${credentials.rpcuser}:${credentials.rpcpassword}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, response => {
      let payload = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { payload += chunk; });
      response.on('end', () => {
        try {
          const decoded = JSON.parse(payload);
          if (response.statusCode !== 200 || decoded.error) throw new Error(`${method} RPC failed`);
          resolve(decoded.result);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`${method} RPC timeout`)));
    request.on('error', reject);
    request.end(body);
  });
}

function decimalString(value) {
  if (value == null) throw new Error('missing decimal value');
  return typeof value === 'object' && typeof value.toString === 'function' ? value.toString() : String(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasExactIndex(index, field, options = {}) {
  const entries = Object.entries(index && index.key || {});
  const expected = typeof field === 'string' ? {[field]: 1} : field;
  if (JSON.stringify(Object.fromEntries(entries)) !== JSON.stringify(expected))
    return false;
  if (options.name && index.name !== options.name)
    return false;
  if (Boolean(index.unique) !== Boolean(options.unique))
    return false;
  if (Object.prototype.hasOwnProperty.call(index, 'partialFilterExpression') || index.sparse === true ||
      Object.prototype.hasOwnProperty.call(index, 'collation') || index.hidden === true)
    return false;
  return Object.prototype.hasOwnProperty.call(options, 'expireAfterSeconds')
    ? index.expireAfterSeconds === options.expireAfterSeconds
    : !Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds');
}

async function collectEvidence(marker = null) {
  const release = path.basename(fs.realpathSync(CURRENT));
  assert(/^[0-9a-f]{40}$/.test(release), 'invalid immutable release id');
  const rpcCredentials = readKeyValues('/etc/mariacoin/maria.conf');
  assert(rpcCredentials.rpcuser && rpcCredentials.rpcpassword, 'missing RPC credentials');
  const mongoCredentials = JSON.parse(fs.readFileSync('/etc/eiquidus/mongodb-app.json', 'utf8'));
  assert(mongoCredentials.username && mongoCredentials.password && mongoCredentials.database, 'missing MongoDB credentials');

  const [chain, daemonTip, genesis, genesisTx, daemonSupply, coldRpc, saplingRpc] = await Promise.all([
    rpc(rpcCredentials, 'getblockchaininfo'),
    rpc(rpcCredentials, 'getblockcount'),
    rpc(rpcCredentials, 'getblockhash', [0]),
    rpc(rpcCredentials, 'getblock', [GENESIS]),
    rpc(rpcCredentials, 'getinfo'),
    rpc(rpcCredentials, 'getrawtransaction', [COLDSTAKE_TXID, 1]),
    rpc(rpcCredentials, 'getrawtransaction', [SAPLING_TXID, 1]),
  ]);
  assert(chain.chain === 'main', 'daemon is not on MariaCoin mainnet');
  assert(chain.initial_block_downloading === false, 'daemon is still in initial block download');
  assert(Number.isInteger(chain.blocks) && chain.blocks === daemonTip, 'daemon block height mismatch');
  assert(Number.isInteger(chain.headers) && chain.headers === daemonTip, 'daemon headers are not synchronized');
  assert(Number(chain.verificationprogress) >= 0.99999, 'daemon verification progress is incomplete');
  assert(genesis === GENESIS, 'daemon genesis mismatch');
  assert(Array.isArray(genesisTx.tx) && genesisTx.tx[0] === GENESIS_TX, 'daemon genesis transaction mismatch');
  assert(coldRpc.txid === COLDSTAKE_TXID && saplingRpc.txid === SAPLING_TXID, 'canonical RPC transaction mismatch');

  if (marker) {
    assert(Number.isInteger(marker.tip) && marker.tip >= 0, 'invalid marker tip');
    assert(typeof marker.tipHash === 'string' && /^[0-9a-f]{64}$/.test(marker.tipHash), 'invalid marker tip hash');
    assert(marker.tip <= daemonTip, 'marker tip is ahead of daemon');
    const markerTipHash = await rpc(rpcCredentials, 'getblockhash', [marker.tip]);
    assert(markerTipHash === marker.tipHash, 'verified marker block is no longer canonical');
  }
  const username = encodeURIComponent(mongoCredentials.username);
  const password = encodeURIComponent(mongoCredentials.password);
  const databaseName = mongoCredentials.database;
  const client = new MongoClient(`mongodb://${username}:${password}@127.0.0.1:27017/${databaseName}?replicaSet=mariacoin-rs&authSource=${databaseName}`);
  await client.connect();
  try {
    const database = client.db(databaseName);
    const [stats, txCount, addressCount, addressTxCount, cold, sapling, owner, staker, stakerLink, spentColdstake,
      claimIndexes, challengeIndexes, statsIndexes, addressTxIndexes] = await Promise.all([
      database.collection('coinstats').findOne({ coin: 'MariaCoin' }),
      database.collection('txes').countDocuments({}),
      database.collection('addresses').countDocuments({}),
      database.collection('addresstxes').countDocuments({}),
      database.collection('txes').findOne({ txid: COLDSTAKE_TXID }),
      database.collection('txes').findOne({ txid: SAPLING_TXID }),
      database.collection('addresses').findOne({ a_id: OWNER }),
      database.collection('addresses').findOne({ a_id: STAKER }),
      database.collection('addresstxes').findOne({ a_id: STAKER, txid: COLDSTAKE_TXID, role: 'staker' }),
      database.collection('txes').findOne({ 'vin.sourceType': 'coldstake' }),
      database.collection('claimaddresses').indexes(),
      database.collection('claimchallenges').indexes(),
      database.collection('coinstats').indexes(),
      database.collection('addresstxes').indexes(),
    ]);
    assert(claimIndexes.some(index => hasExactIndex(index, 'a_id', {name: 'a_id_1', unique: true})), 'Claim address exact unique index missing');
    assert(challengeIndexes.some(index => hasExactIndex(index, 'challenge_id', {name: 'challenge_id_1', unique: true})), 'Claim challenge exact unique index missing');
    assert(challengeIndexes.some(index => hasExactIndex(index, 'expires_at', {name: 'expires_at_1', expireAfterSeconds: 0})), 'Claim challenge exact TTL index missing');
    assert(statsIndexes.some(index => hasExactIndex(index, 'coin', {name: 'coin_1', unique: true})), 'Stats coin exact unique index missing');
    assert(addressTxIndexes.some(index => hasExactIndex(index, {a_id: 1, txid: 1, role: 1}, {name: 'a_id_1_txid_1_role_1', unique: true})),
      'AddressTx projection exact unique index missing');
    assert(stats && Number.isInteger(stats.last) && stats.count === stats.last, 'invalid database cursor');
    assert(stats.orphan_reconciliation == null, 'incomplete orphan reconciliation blocks index verification');
    if (marker) {
      assert(stats.last >= marker.tip, 'database regressed behind verified marker');
      assert(stats.last <= daemonTip, 'database cursor is ahead of daemon');
      assert(txCount >= marker.transactionCount, 'transaction count regressed behind verified marker');
      assert(addressCount >= marker.addressCount, 'address count regressed behind verified marker');
      assert(addressTxCount >= marker.addressTransactionCount, 'address transaction count regressed behind verified marker');
    } else {
      assert(stats.last <= daemonTip && stats.last >= daemonTip - MAX_INDEX_LAG, 'database cursor is outside the allowed confirmed-tip lag');
    }
    assert(stats.txes === txCount && txCount > 0, 'transaction count mismatch');
    assert(addressCount > 0 && addressTxCount > 0, 'address indexes are empty');
    assert(cold && cold.blockindex === 131606 && cold.staker === STAKER && Array.isArray(cold.stakers) && cold.stakers.includes(STAKER), 'canonical coldstake metadata mismatch');
    const ownerOutput = Array.isArray(cold.vout) && cold.vout.find(output => output.addresses === OWNER);
    assert(ownerOutput && decimalString(ownerOutput.amount) === '9999992400', 'coldstake owner output mismatch');
    assert(owner && Number(decimalString(owner.received)) >= 9999992400, 'coldstake owner accounting mismatch');
    assert(staker, 'staker address is not searchable');
    assert(stakerLink && decimalString(stakerLink.amount) === '0', 'staker search metadata mismatch');
    assert(!cold.vout.some(output => output.addresses === STAKER && decimalString(output.amount) !== '0'), 'coldstake value was attributed to staker');
    assert(spentColdstake, 'no indexed coldstake spend was found');
    const spentInput = spentColdstake.vin.find(input => input.sourceType === 'coldstake');
    assert(spentInput && typeof spentInput.txid === 'string' && Number.isInteger(spentInput.vout), 'indexed coldstake spend metadata mismatch');
    const spentSource = await database.collection('txes').findOne({ txid: spentInput.txid });
    const spentSourceOutput = spentSource && spentSource.vout.find(output => output.n === spentInput.vout);
    assert(spentSourceOutput && spentSourceOutput.stakers && spentSourceOutput.stakers.includes(spentInput.staker), 'coldstake spend source mismatch');
    assert(spentInput.addresses === spentSourceOutput.addresses, 'coldstake spend was not debited from owner');
    assert(spentInput.addresses !== spentInput.staker, 'coldstake spend was debited from staker');
    assert(decimalString(spentInput.amount) === decimalString(spentSourceOutput.amount), 'coldstake spend amount mismatch');
    assert(sapling && sapling.valueBalanceSat && decimalString(sapling.valueBalanceSat) === '71871934180' && sapling.shieldedSpendCount === 1 && sapling.shieldedOutputCount === 0, 'Sapling withdrawal metadata mismatch');
    const indexedSupply = Number(decimalString(stats.supply));
    const reportedSupply = Number(daemonSupply.moneysupply);
    assert(Number.isFinite(indexedSupply) && Number.isFinite(reportedSupply), 'invalid money supply');
    if (!marker)
      assert(Math.abs(indexedSupply - reportedSupply) <= 0.00000001, 'money supply mismatch');
    const tipHash = await rpc(rpcCredentials, 'getblockhash', [stats.last]);
    assert(typeof tipHash === 'string' && /^[0-9a-f]{64}$/.test(tipHash), 'invalid indexed tip hash');
    return {
      release,
      tip: stats.last,
      tipHash,
      genesis: GENESIS,
      genesisTx: GENESIS_TX,
      transactionCount: txCount,
      addressCount,
      addressTransactionCount: addressTxCount,
      moneySupply: indexedSupply.toFixed(8),
      coldstakeTx: COLDSTAKE_TXID,
      saplingTx: SAPLING_TXID,
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    await client.close();
  }
}

async function main() {
  const mode = process.argv[2];
  assert(mode === '--create-marker' || mode === '--verify-marker', 'usage: verify-index.js --create-marker|--verify-marker');
  assert(typeof process.getuid !== 'function' || process.getuid() === 0, 'index verification must run as root');
  let marker = null;
  if (mode === '--verify-marker') {
    const markerStat = fs.lstatSync(MARKER);
    assert(markerStat.isFile() && !markerStat.isSymbolicLink(), 'unsafe index marker type');
    assert(markerStat.uid === 0 && markerStat.gid === 0, 'unsafe index marker ownership');
    assert((markerStat.mode & 0o777) === 0o600, 'unsafe index marker permissions');
    marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    for (const field of ['release', 'genesis', 'genesisTx', 'coldstakeTx', 'saplingTx'])
      assert(typeof marker[field] === 'string', `invalid index marker field: ${field}`);
    for (const field of ['transactionCount', 'addressCount', 'addressTransactionCount'])
      assert(Number.isInteger(marker[field]) && marker[field] >= 0, `invalid index marker field: ${field}`);
    assert(typeof marker.moneySupply === 'string' && /^\d+\.\d{8}$/.test(marker.moneySupply), 'invalid index marker field: moneySupply');
    assert(typeof marker.verifiedAt === 'string' && !Number.isNaN(Date.parse(marker.verifiedAt)) &&
      new Date(marker.verifiedAt).toISOString() === marker.verifiedAt, 'invalid index marker field: verifiedAt');
  }
  const evidence = await collectEvidence(marker);
  if (mode === '--create-marker') {
    const temporary = `${MARKER}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, MARKER);
    console.log(`INDEX_VERIFIED tip=${evidence.tip} release=${evidence.release}`);
  } else {
    for (const key of ['release', 'genesis', 'genesisTx', 'coldstakeTx', 'saplingTx'])
      assert(marker[key] === evidence[key], `index marker mismatch: ${key}`);
    console.log(`INDEX_MARKER_VALID tip=${evidence.tip} release=${evidence.release}`);
  }
}

main().catch(error => {
  console.error(`INDEX_VERIFICATION_FAILED: ${error.message}`);
  process.exit(1);
});
