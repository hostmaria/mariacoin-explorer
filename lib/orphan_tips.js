'use strict';

const Decimal = require('decimal.js');
const crypto = require('crypto');
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const FORK_DISCOVERY_CONCURRENCY = 8;
const ROLLBACK_BATCH_HEIGHTS = 512;
const LARGE_ROLLBACK = new Error('large orphan rollback requires checkpointing');

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, run));
  return results;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value))
    throw new Error(`Malformed ${label} hash`);
  return value;
}

function requireHeight(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Malformed ${label} height`);
  return value;
}

function tipSnapshot(tips) {
  if (!Array.isArray(tips))
    throw new Error('Malformed getchaintips response');
  return JSON.stringify(tips.map(tip => tip && typeof tip === 'object'
    ? [tip.status, tip.height, tip.hash, tip.branchlen]
    : null).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

async function discover(rpc) {
  if (rpc == null || typeof rpc.getChainTips !== 'function' || typeof rpc.getBlockHash !== 'function' || typeof rpc.getBlock !== 'function')
    throw new Error('Orphan discovery RPC interface is incomplete');

  const tips = await rpc.getChainTips();
  if (!Array.isArray(tips))
    throw new Error('Malformed getchaintips response');

  const activeTips = tips.filter(tip => tip != null && tip.status === 'active');
  if (activeTips.length !== 1)
    throw new Error('Malformed getchaintips response: expected exactly one active tip');
  const activeHeight = requireHeight(activeTips[0].height, 'active tip');
  const activeHash = requireHash(activeTips[0].hash, 'active tip');
  if (requireHeight(activeTips[0].branchlen, 'active tip branch length') !== 0)
    throw new Error('Malformed active tip branch length: expected zero');
  const canonicalHashes = new Map();
  const canonicalActiveHash = requireHash(await rpc.getBlockHash(activeHeight), 'canonical active tip');
  if (canonicalActiveHash !== activeHash)
    throw new Error('Active tip does not match canonical chain');
  canonicalHashes.set(activeHeight, canonicalActiveHash);

  const forkTips = tips.filter(tip => tip != null && tip.status === 'valid-fork');
  const branchRows = await mapConcurrent(forkTips, FORK_DISCOVERY_CONCURRENCY, async tip => {
    const rows = [];
    const seenHashes = new Set();
    const tipHeight = requireHeight(tip.height, 'fork tip');
    const branchLength = requireHeight(tip.branchlen, 'fork branch length');
    if (branchLength === 0)
      throw new Error('Malformed fork branch length: valid-fork must contain at least one block');
    let orphanHash = requireHash(tip.hash, 'orphan tip');

    for (let offset = 0; offset < branchLength; offset++) {
      const orphanBlock = await rpc.getBlock(orphanHash);
      if (orphanBlock == null || requireHash(orphanBlock.hash, 'orphan block') !== orphanHash)
        throw new Error(`Orphan block response does not match ${orphanHash}`);

      const blockindex = requireHeight(orphanBlock.height, 'orphan block');
      if (blockindex !== tipHeight - offset)
        throw new Error(`Orphan block height does not match getchaintips for ${orphanHash}`);

      if (blockindex > activeHeight) {
        if (!seenHashes.has(orphanHash)) {
          rows.push({blockindex, orphan_blockhash: orphanHash, good_blockhash: null, prev_blockhash: null, next_blockhash: null});
          seenHashes.add(orphanHash);
        }
        orphanHash = requireHash(orphanBlock.previousblockhash, 'orphan previous block');
        continue;
      }

      const goodHash = canonicalHashes.has(blockindex)
        ? canonicalHashes.get(blockindex)
        : requireHash(await rpc.getBlockHash(blockindex), 'canonical block');
      canonicalHashes.set(blockindex, goodHash);
      if (goodHash === orphanHash)
        throw new Error(`Fork tip ${orphanHash} belongs to the active chain`);

      const goodBlock = await rpc.getBlock(goodHash);
      if (goodBlock == null || requireHash(goodBlock.hash, 'canonical block') !== goodHash || requireHeight(goodBlock.height, 'canonical block') !== blockindex)
        throw new Error(`Canonical block response does not match height ${blockindex}`);

      if (!seenHashes.has(orphanHash)) {
        rows.push({
          blockindex,
          orphan_blockhash: orphanHash,
          good_blockhash: goodHash,
          prev_blockhash: requireHash(goodBlock.previousblockhash, 'canonical previous block'),
          next_blockhash: goodBlock.nextblockhash == null
            ? (blockindex === activeHeight ? null : requireHash(goodBlock.nextblockhash, 'canonical next block'))
            : requireHash(goodBlock.nextblockhash, 'canonical next block')
        });
        seenHashes.add(orphanHash);
      }

      orphanHash = requireHash(orphanBlock.previousblockhash, 'orphan previous block');
    }

    const forkHeight = tipHeight - branchLength;
    if (!Number.isSafeInteger(forkHeight) || forkHeight < 0 || forkHeight > activeHeight)
      throw new Error(`Fork tip ${tip.hash} has an invalid canonical fork height`);
    const forkHash = canonicalHashes.has(forkHeight)
      ? canonicalHashes.get(forkHeight)
      : requireHash(await rpc.getBlockHash(forkHeight), 'canonical fork point');
    canonicalHashes.set(forkHeight, forkHash);
    if (orphanHash !== forkHash)
      throw new Error(`Fork tip ${tip.hash} does not reconnect to canonical fork point`);
    return rows;
  });

  const rows = [];
  const seenHashes = new Set();
  for (const branch of branchRows) {
    for (const row of branch) {
      if (!seenHashes.has(row.orphan_blockhash)) {
        rows.push(row);
        seenHashes.add(row.orphan_blockhash);
      }
    }
  }

  const finalTips = await rpc.getChainTips();
  if (!Array.isArray(finalTips))
    throw new Error('Malformed getchaintips response');
  const staleSnapshot = tips => tipSnapshot(tips.filter(tip => tip == null || tip.status !== 'active'));
  if (staleSnapshot(finalTips) !== staleSnapshot(tips))
    throw new Error('Stale chain-tip set changed during discovery');
  const finalActiveTips = finalTips.filter(tip => tip != null && tip.status === 'active');
  if (finalActiveTips.length !== 1)
    throw new Error('Malformed getchaintips response: expected exactly one active tip');
  const finalActiveHeight = requireHeight(finalActiveTips[0].height, 'active tip');
  const finalActiveHash = requireHash(finalActiveTips[0].hash, 'active tip');
  if (requireHeight(finalActiveTips[0].branchlen, 'active tip branch length') !== 0)
    throw new Error('Malformed active tip branch length: expected zero');
  if (finalActiveHash === activeHash && finalActiveHeight === activeHeight)
    return rows;
  // A new block may extend the active tip while discovery runs; that is benign as
  // long as the observed tip height still resolves to the observed tip hash. A
  // replacement or reorganization at or below the observed height is not benign.
  const finalCanonicalActiveHash = requireHash(await rpc.getBlockHash(activeHeight), 'final canonical active tip');
  if (finalCanonicalActiveHash !== activeHash || finalActiveHeight <= activeHeight)
    throw new Error('Active chain-tip snapshot changed during discovery');
  return rows;
}

function persistenceOperations(rows) {
  const orphanHashes = rows.map(row => requireHash(row && row.orphan_blockhash, 'orphan row'));
  if (new Set(orphanHashes).size !== orphanHashes.length)
    throw new Error('Duplicate orphan row hash');
  const operations = [{
    deleteMany: {
      filter: orphanHashes.length === 0 ? {} : {orphan_blockhash: {$nin: orphanHashes}}
    }
  }];
  for (const row of rows) {
    requireHeight(row.blockindex, 'orphan row');
    if (row.good_blockhash != null)
      requireHash(row.good_blockhash, 'canonical row');
    operations.push({
      updateOne: {
        filter: {orphan_blockhash: row.orphan_blockhash},
        update: {$set: row},
        upsert: true
      }
    });
  }
  return operations;
}

function validatePersistenceResult(result, rowCount, existingCount = null) {
  const matched = result && result.matchedCount;
  const upserted = result && result.upsertedCount;
  const deleted = result && result.deletedCount;
  if (!Number.isSafeInteger(matched) || matched < 0 ||
      !Number.isSafeInteger(upserted) || upserted < 0 ||
      !Number.isSafeInteger(deleted) || deleted < 0 ||
      (existingCount != null && (!Number.isSafeInteger(existingCount) || existingCount < matched ||
        deleted !== existingCount - matched)) ||
      matched + upserted !== rowCount)
    throw new Error('Orphan metadata write count mismatch');
}

async function persist(model, rows) {
  if (model == null || typeof model.bulkWrite !== 'function' || typeof model.startSession !== 'function')
    throw new Error('Orphan persistence model is incomplete');
  if (!Array.isArray(rows))
    throw new Error('Orphan rows must be an array');
  const operations = persistenceOperations(rows);
  const session = await model.startSession();
  try {
    await session.withTransaction(async () => {
      const result = await model.bulkWrite(operations, {ordered: true, session});
      validatePersistenceResult(result, rows.length);
    });
  } finally {
    await session.endSession();
  }
}

function addReverseDelta(deltas, address, sent, received) {
  if (typeof address !== 'string' || !address)
    throw new Error('Stored transaction address is malformed');
  if (!deltas.has(address))
    deltas.set(address, {sent: new Decimal(0), received: new Decimal(0), balance: new Decimal(0)});
  const delta = deltas.get(address);
  delta.sent = delta.sent.sub(sent);
  delta.received = delta.received.sub(received);
  delta.balance = delta.balance.add(sent).sub(received);
}

function storedAmount(value) {
  let amount;
  try {
    amount = new Decimal(value != null && typeof value === 'object' && typeof value.toString === 'function'
      ? value.toString()
      : value);
  } catch (_) { throw new Error('Stored transaction amount is malformed'); }
  if (!amount.isInteger() || amount.isNegative())
    throw new Error('Stored transaction amount is malformed');
  return amount;
}

async function findRaw(model, filter, session) {
  const query = model.find(filter, null, {session});
  if (query && typeof query.lean === 'function')
    return query.lean();
  return query;
}

function validateAddressTransactions(rows, transactionTxids) {
  if (!Array.isArray(rows))
    throw new Error('Stored address transaction projection is malformed');
  for (const row of rows) {
    const txid = requireHash(row && row.txid, 'stored address transaction');
    if (!transactionTxids.has(txid))
      throw new Error(`Dangling address transaction projection for ${txid}`);
  }
}

function projectionAmount(value) {
  let amount;
  try {
    amount = new Decimal(value != null && typeof value === 'object' && typeof value.toString === 'function'
      ? value.toString()
      : value);
  } catch (_) { throw new Error('Stored AddressTx projection amount is malformed'); }
  if (!amount.isInteger())
    throw new Error('Stored AddressTx projection amount is malformed');
  return amount;
}

function projectionKey(address, role, amount) {
  if (typeof address !== 'string' || !address)
    throw new Error('Stored AddressTx projection address is malformed');
  return `${address}\u0000${role}\u0000${projectionAmount(amount).toString()}`;
}

function addProjectionAmount(map, address, amount) {
  if (typeof address !== 'string' || !address)
    throw new Error('Stored transaction projection address is malformed');
  map.set(address, (map.get(address) || new Decimal(0)).add(amount));
}

function expectedAtomicAddressTransactions(tx) {
  const balances = new Map();
  const stakers = new Set();
  const expected = [];
  for (const input of tx.vin) {
    if (!input)
      throw new Error('Stored transaction input is malformed');
    const amount = storedAmount(input.amount);
    if (input.addresses !== 'coinbase')
      addProjectionAmount(balances, input.addresses, amount.negated());
  }
  for (const output of tx.vout) {
    if (!output)
      throw new Error('Stored transaction output is malformed');
    if (output.addresses === 'OP_RETURN' || output.burn === true)
      continue;
    addProjectionAmount(balances, output.addresses, storedAmount(output.amount));
    if (output.stakers != null && !Array.isArray(output.stakers))
      throw new Error('Stored transaction staker projection is malformed');
    for (const staker of output.stakers || [])
      stakers.add(projectionKey(staker, 'staker', 0));
  }
  expected.push(...stakers);
  for (const [address, amount] of balances)
    expected.push(projectionKey(address, 'balance', amount));
  return expected.sort();
}

function expectedLegacyAddressTransactions(tx) {
  const balances = new Map();
  for (const input of tx.vin) {
    if (!input)
      throw new Error('Stored transaction input is malformed');
    if (input.addresses !== 'coinbase')
      addProjectionAmount(balances, input.addresses, storedAmount(input.amount).negated());
  }
  for (const output of tx.vout) {
    if (!output)
      throw new Error('Stored transaction output is malformed');
    if (output.addresses !== 'OP_RETURN' && output.burn !== true)
      addProjectionAmount(balances, output.addresses, storedAmount(output.amount));
  }
  return Array.from(balances, ([address, amount]) => projectionKey(address, '', amount)).sort();
}

function validateProjectionClosure(transactions, addressTransactions) {
  const rowsByTxid = new Map();
  for (const row of addressTransactions) {
    const txid = requireHash(row && row.txid, 'stored address transaction');
    if (!rowsByTxid.has(txid))
      rowsByTxid.set(txid, []);
    rowsByTxid.get(txid).push(row);
  }
  const seenTxids = new Set();
  for (const tx of transactions) {
    const txid = requireHash(tx && tx.txid, 'stored transaction');
    if (seenTxids.has(txid))
      throw new Error(`Duplicate stored transaction projection for ${txid}`);
    seenTxids.add(txid);
    if (!Array.isArray(tx.vin) || !Array.isArray(tx.vout))
      throw new Error(`Stored transaction ${txid} lacks raw vin/vout projection evidence`);
    const rows = rowsByTxid.get(txid) || [];
    const hasRole = rows.some(row => Object.prototype.hasOwnProperty.call(row, 'role'));
    if (hasRole && rows.some(row => !Object.prototype.hasOwnProperty.call(row, 'role')))
      throw new Error(`AddressTx projection mismatch for ${txid}: mixed legacy and atomic rows`);
    const actual = rows.map(row => {
      if (requireHeight(row.blockindex, 'stored address transaction') !== tx.blockindex)
        throw new Error(`AddressTx projection mismatch for ${txid}: wrong block height`);
      const role = hasRole ? row.role : '';
      if (hasRole && role !== 'balance' && role !== 'staker')
        throw new Error(`AddressTx projection mismatch for ${txid}: invalid role`);
      return projectionKey(row.a_id, role, row.amount);
    }).sort();
    const expected = hasRole
      ? expectedAtomicAddressTransactions(tx)
      : expectedLegacyAddressTransactions(tx);
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index]))
      throw new Error(`AddressTx projection mismatch for ${txid}`);
  }
}

async function assertNoDanglingAddressTransactions(models, filter, session) {
  const addressTransactions = await findRaw(models.AddressTx, filter, session);
  if (!Array.isArray(addressTransactions))
    throw new Error('Stored address transaction projection is malformed');
  const txids = Array.from(new Set(addressTransactions.map(row =>
    requireHash(row && row.txid, 'stored address transaction'))));
  if (txids.length === 0)
    return;
  const transactions = await findRaw(models.Tx, {txid: {$in: txids}}, session);
  if (!Array.isArray(transactions))
    throw new Error('Stored transaction projection is malformed');
  validateAddressTransactions(addressTransactions, new Set(transactions.map(tx =>
    requireHash(tx && tx.txid, 'stored transaction'))));
  validateProjectionClosure(transactions, addressTransactions);
}

async function assertStatsClosure(models, coin, session) {
  const statsRows = await findRaw(models.Stats, {coin}, session);
  if (!Array.isArray(statsRows) || statsRows.length !== 1)
    throw new Error('Orphan synchronization requires exactly one Stats document');
  const stats = statsRows[0];
  const txCount = await models.Tx.countDocuments({}, {session});
  if (!Number.isSafeInteger(stats.last) || stats.last < -1 ||
      !Number.isSafeInteger(stats.txes) || stats.txes < 0 ||
      !Number.isSafeInteger(txCount) || txCount < 0 || stats.txes !== txCount)
    throw new Error('Orphan synchronization Stats closure mismatch');
  return stats;
}

async function assertProjectionClosureAtHeights(models, heights, session) {
  const blockindexes = Array.from(new Set(heights.map(height =>
    requireHeight(height, 'orphan row'))));
  const transactions = await findRaw(models.Tx, {blockindex: {$in: blockindexes}}, session);
  if (!Array.isArray(transactions))
    throw new Error('Stored projection closure is malformed');
  const txids = new Set(transactions.map(tx => requireHash(tx && tx.txid, 'stored transaction')));
  // Close both directions. Height selection catches dangling rows whose parent
  // Tx is absent, while Tx-ID selection catches children hidden at a malformed
  // height outside the affected range.
  const addressTransactions = await findRaw(models.AddressTx, {$or: [
    {blockindex: {$in: blockindexes}},
    {txid: {$in: Array.from(txids)}}
  ]}, session);
  if (!Array.isArray(addressTransactions))
    throw new Error('Stored projection closure is malformed');
  validateAddressTransactions(addressTransactions, txids);
  validateProjectionClosure(transactions, addressTransactions);
}

async function assertRollbackRangeEmpty(models, rollbackHeight, originalLast, session) {
  const range = {blockindex: {$gte: rollbackHeight, $lte: originalLast}};
  const transactions = await findRaw(models.Tx, range, session);
  const addressTransactions = await findRaw(models.AddressTx, range, session);
  if (!Array.isArray(transactions) || !Array.isArray(addressTransactions) ||
      transactions.length !== 0 || addressTransactions.length !== 0)
    throw new Error('Canonical rollback range projection closure mismatch');
}

function reverseAddressOperations(transactions) {
  const deltas = new Map();
  for (const tx of transactions) {
    if (!tx || !Array.isArray(tx.vin) || !Array.isArray(tx.vout))
      throw new Error('Stored transaction projection is malformed');
    for (const input of tx.vin) {
      if (!input)
        throw new Error('Stored transaction input is malformed');
      const amount = storedAmount(input.amount);
      // The retired writer projected a non-zero synthetic coinbase input into
      // Address but deliberately omitted its AddressTx row. The atomic writer
      // stores coinbase inputs as zero and creates neither projection.
      if (input.addresses === 'coinbase' && amount.isZero())
        continue;
      addReverseDelta(deltas, input.addresses, amount, new Decimal(0));
    }
    for (const output of tx.vout) {
      if (output && (output.addresses === 'OP_RETURN' || output.burn === true))
        continue;
      if (!output)
        throw new Error('Stored transaction output is malformed');
      addReverseDelta(deltas, output.addresses, new Decimal(0), storedAmount(output.amount));
    }
    for (const staker of Array.isArray(tx.stakers) ? tx.stakers : [])
      addReverseDelta(deltas, staker, new Decimal(0), new Decimal(0));
  }
  // Metadata-only staker aliases (the retired writer recorded AddressTx 'staker'
  // rows without ever creating an Address aggregate) reverse to a pure zero
  // delta. No monetary reversal exists for them, so no Address mutation is
  // required; their AddressTx metadata is still removed with the transaction.
  // A NONZERO delta against a missing Address row remains corruption and must
  // abort, which the exact matchedCount check at both call sites enforces.
  return Array.from(deltas.entries())
    .filter(([, delta]) => !delta.sent.isZero() || !delta.received.isZero() || !delta.balance.isZero())
    .map(([address, delta]) => ({
      updateOne: {
        filter: {a_id: address},
        update: {$inc: {
          sent: delta.sent.toFixed(0),
          received: delta.received.toFixed(0),
          balance: delta.balance.toFixed(0)
        }},
        upsert: false
      }
    }));
}

function reconciliationDigest(rows) {
  const normalized = rows.map(row => [
    requireHeight(row.blockindex, 'orphan row'),
    requireHash(row.orphan_blockhash, 'orphan row'),
    row.good_blockhash == null ? null : requireHash(row.good_blockhash, 'canonical row'),
    row.prev_blockhash == null ? null : requireHash(row.prev_blockhash, 'previous orphan row'),
    row.next_blockhash == null ? null : requireHash(row.next_blockhash, 'next orphan row')
  ]);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function reconciliationPlanDigest(rows, fence) {
  return crypto.createHash('sha256').update(JSON.stringify({
    rowsDigest: reconciliationDigest(rows),
    coin: fence.coin,
    release: fence.release,
    rollbackHeight: fence.rollbackHeight,
    originalLast: fence.originalLast,
    originalTxes: fence.originalTxes,
    rollbackBatchHeights: ROLLBACK_BATCH_HEIGHTS
  })).digest('hex');
}

function reconciliationCheckpointDigest(fence) {
  return crypto.createHash('sha256').update(JSON.stringify({
    planDigest: fence.planDigest,
    nextHeight: fence.nextHeight,
    removedTxes: fence.removedTxes,
    batches: fence.batches
  })).digest('hex');
}

function validateReconciliationFence(fence, coin, release) {
  if (!fence || fence.version !== 2 || fence.status !== 'rollback' || fence.coin !== coin ||
      typeof fence.release !== 'string' || !/^[0-9a-f]{40}$/.test(fence.release) || fence.release !== release ||
      !HASH_PATTERN.test(fence.rowsDigest) || !HASH_PATTERN.test(fence.planDigest) ||
      !HASH_PATTERN.test(fence.checkpointDigest) || !Array.isArray(fence.rows) ||
      !Number.isSafeInteger(fence.rollbackHeight) || fence.rollbackHeight < 0 ||
      !Number.isSafeInteger(fence.nextHeight) || fence.nextHeight < fence.rollbackHeight - 1 ||
      !Number.isSafeInteger(fence.originalLast) || fence.originalLast < fence.rollbackHeight ||
      fence.nextHeight > fence.originalLast ||
      !Number.isSafeInteger(fence.originalTxes) || fence.originalTxes < 0 ||
      !Number.isSafeInteger(fence.removedTxes) || fence.removedTxes < 0 || fence.removedTxes > fence.originalTxes ||
      !Number.isSafeInteger(fence.batches) || fence.batches < 0 ||
      reconciliationDigest(fence.rows) !== fence.rowsDigest ||
      reconciliationPlanDigest(fence.rows, fence) !== fence.planDigest ||
      reconciliationCheckpointDigest(fence) !== fence.checkpointDigest)
    throw new Error('Orphan reconciliation fence is malformed or belongs to another release');
  return fence;
}

function requireStatsUpdate(result, label) {
  if (!result || result.matchedCount !== 1 || result.modifiedCount !== 1)
    throw new Error(`${label} Stats update count mismatch`);
}

async function synchronizeBatched(dependencies, rows, plan = null) {
  const {mongoose, models, coin, release} = dependencies;
  if (typeof release !== 'string' || !/^[0-9a-f]{40}$/.test(release))
    throw new Error('Large orphan reconciliation requires an immutable release identity');
  const digest = reconciliationDigest(rows);
  const session = await mongoose.startSession();
  let rollbackHeight;
  try {
    if (plan) {
      rollbackHeight = plan.rollbackHeight;
      await session.withTransaction(async () => {
        const stats = await assertStatsClosure(models, coin, session);
        if (stats.orphan_reconciliation != null || stats.last !== plan.last || stats.txes !== plan.txes)
          throw new Error('Orphan reconciliation state changed before migration fencing');
        const fence = {
          version: 2,
          status: 'rollback',
          coin,
          release,
          rowsDigest: digest,
          rows,
          rollbackHeight,
          nextHeight: stats.last,
          originalLast: stats.last,
          originalTxes: stats.txes,
          removedTxes: 0,
          batches: 0
        };
        fence.planDigest = reconciliationPlanDigest(rows, fence);
        fence.checkpointDigest = reconciliationCheckpointDigest(fence);
        const result = await models.Stats.updateOne({
          coin,
          last: stats.last,
          txes: stats.txes,
          $or: [{orphan_reconciliation: {$exists: false}}, {orphan_reconciliation: null}]
        }, {$set: {orphan_reconciliation: fence}}, {session});
        requireStatsUpdate(result, 'Orphan reconciliation fence');
      });
    }

    while (true) {
      let complete = false;
      await session.withTransaction(async () => {
        const statsRows = await findRaw(models.Stats, {coin}, session);
        if (!Array.isArray(statsRows) || statsRows.length !== 1)
          throw new Error('Orphan reconciliation requires exactly one Stats document');
        const stats = statsRows[0];
        const fence = validateReconciliationFence(stats.orphan_reconciliation, coin, release);
        rollbackHeight = fence.rollbackHeight;
        if (fence.rowsDigest !== digest)
          throw new Error('Orphan reconciliation rows do not match the durable fence');
        if (stats.last !== fence.nextHeight)
          throw new Error('Orphan reconciliation cursor does not match its durable fence');
        if (stats.txes !== fence.originalTxes - fence.removedTxes)
          throw new Error('Orphan reconciliation transaction count does not match its durable fence');
        const txCount = await models.Tx.countDocuments({}, {session});
        if (!Number.isSafeInteger(stats.txes) || stats.txes < 0 || stats.txes !== txCount)
          throw new Error('Orphan reconciliation Stats closure mismatch');

        if (fence.nextHeight < rollbackHeight) {
          await assertRollbackRangeEmpty(models, rollbackHeight, fence.originalLast, session);
          const existingOrphanCount = await models.Orphans.countDocuments({}, {session});
          if (!Number.isSafeInteger(existingOrphanCount) || existingOrphanCount < 0)
            throw new Error('Orphan metadata count is malformed');
          const orphanResult = await models.Orphans.bulkWrite(persistenceOperations(rows), {ordered: true, session});
          validatePersistenceResult(orphanResult, rows.length, existingOrphanCount);
          await assertProjectionClosureAtHeights(models, rows.map(row => row.blockindex), session);
          const result = await models.Stats.updateOne({
            coin,
            last: stats.last,
            'orphan_reconciliation.rowsDigest': digest,
            'orphan_reconciliation.planDigest': fence.planDigest,
            'orphan_reconciliation.checkpointDigest': fence.checkpointDigest,
            'orphan_reconciliation.nextHeight': fence.nextHeight
          }, {$unset: {orphan_reconciliation: ''}}, {session});
          requireStatsUpdate(result, 'Orphan reconciliation completion');
          complete = true;
          return;
        }

        const top = fence.nextHeight;
        const bottom = Math.max(rollbackHeight, top - ROLLBACK_BATCH_HEIGHTS + 1);
        const range = {blockindex: {$gte: bottom, $lte: top}};
        const transactions = await findRaw(models.Tx, range, session);
        if (!Array.isArray(transactions))
          throw new Error('Orphan reconciliation batch projection is malformed');
        const txids = new Set(transactions.map(tx => requireHash(tx && tx.txid, 'stored transaction')));
        const addressTxFilter = {txid: {$in: Array.from(txids)}};
        const addressTransactions = await findRaw(models.AddressTx, {$or: [range, addressTxFilter]}, session);
        if (!Array.isArray(addressTransactions))
          throw new Error('Orphan reconciliation batch projection is malformed');
        validateAddressTransactions(addressTransactions, txids);
        validateProjectionClosure(transactions, addressTransactions);
        const addressOps = reverseAddressOperations(transactions);
        if (addressOps.length) {
          const addressResult = await models.Address.bulkWrite(addressOps, {ordered: true, session});
          if (!addressResult || addressResult.matchedCount !== addressOps.length)
            throw new Error('Canonical rollback address update count mismatch');
          const zeroAddressResult = await models.Address.deleteMany({
            a_id: {$in: addressOps.map(op => op.updateOne.filter.a_id)},
            sent: 0,
            received: 0,
            balance: 0
          }, {session});
          if (!zeroAddressResult || !Number.isSafeInteger(zeroAddressResult.deletedCount) ||
              zeroAddressResult.deletedCount < 0 || zeroAddressResult.deletedCount > addressOps.length)
            throw new Error('Canonical rollback zero-address deletion count mismatch');
        }
        const addressTxResult = await models.AddressTx.deleteMany(addressTxFilter, {session});
        if (!addressTxResult || addressTxResult.deletedCount !== addressTransactions.length)
          throw new Error('Canonical rollback address transaction deletion count mismatch');
        const txResult = await models.Tx.deleteMany(range, {session});
        if (!txResult || txResult.deletedCount !== transactions.length)
          throw new Error('Canonical rollback transaction deletion count mismatch');
        const nextFence = Object.assign({}, fence, {
          nextHeight: bottom - 1,
          removedTxes: fence.removedTxes + transactions.length,
          batches: fence.batches + 1
        });
        nextFence.checkpointDigest = reconciliationCheckpointDigest(nextFence);
        const statsResult = await models.Stats.updateOne({
          coin,
          last: top,
          txes: stats.txes,
          'orphan_reconciliation.rowsDigest': digest,
          'orphan_reconciliation.planDigest': fence.planDigest,
          'orphan_reconciliation.checkpointDigest': fence.checkpointDigest,
          'orphan_reconciliation.nextHeight': top
        }, {$set: {
          last: bottom - 1,
          txes: stats.txes - transactions.length,
          orphan_reconciliation: nextFence
        }}, {session});
        requireStatsUpdate(statsResult, 'Canonical rollback batch');
      });
      if (complete)
        break;
    }
  } finally {
    await session.endSession();
  }
  return {rollbackHeight, orphanCount: rows.length};
}

async function pendingRows(dependencies) {
  if (!dependencies || !dependencies.models || typeof dependencies.coin !== 'string' ||
      typeof dependencies.release !== 'string' || !/^[0-9a-f]{40}$/.test(dependencies.release))
    throw new Error('Orphan reconciliation resume dependencies are incomplete');
  const statsRows = await findRaw(dependencies.models.Stats, {coin: dependencies.coin});
  if (!Array.isArray(statsRows) || statsRows.length !== 1)
    throw new Error('Orphan reconciliation resume requires exactly one Stats document');
  if (statsRows[0].orphan_reconciliation == null)
    return null;
  const fence = validateReconciliationFence(
    statsRows[0].orphan_reconciliation, dependencies.coin, dependencies.release);
  if (statsRows[0].last !== fence.nextHeight)
    throw new Error('Orphan reconciliation cursor does not match its durable fence');
  return fence.rows;
}

async function synchronize(dependencies, rows) {
  if (!dependencies || !dependencies.mongoose || !dependencies.models || typeof dependencies.coin !== 'string')
    throw new Error('Orphan synchronization dependencies are incomplete');
  if (!Array.isArray(rows))
    throw new Error('Orphan rows must be an array');
  const {mongoose, models, coin} = dependencies;
  const required = ['Orphans', 'Tx', 'Address', 'AddressTx', 'Stats'];
  if (required.some(name => models[name] == null))
    throw new Error('Orphan synchronization models are incomplete');
  if (typeof models.Orphans.countDocuments !== 'function')
    throw new Error('Orphan synchronization metadata count is unavailable');
  persistenceOperations(rows);
  if (dependencies.release) {
    const openingStatsRows = await findRaw(models.Stats, {coin});
    if (Array.isArray(openingStatsRows) && openingStatsRows.length === 1 &&
        openingStatsRows[0].orphan_reconciliation != null) {
      const fence = validateReconciliationFence(
        openingStatsRows[0].orphan_reconciliation, coin, dependencies.release);
      return synchronizeBatched(dependencies, fence.rows);
    }
  }
  const session = await mongoose.startSession();
  let rollbackHeight = null;
  let batchedPlan = null;
  try {
    try {
      await session.withTransaction(async () => {
      let staleTransactions = [];
      let stats = null;
      if (rows.length > 0) {
        const staleFilters = rows.map(row => ({
          blockindex: requireHeight(row.blockindex, 'orphan row'),
          blockhash: requireHash(row.orphan_blockhash, 'orphan row')
        }));
        staleTransactions = await findRaw(models.Tx, {$or: staleFilters}, session);
        if (!Array.isArray(staleTransactions))
          throw new Error('Stored stale transaction projection is malformed');
        if (staleTransactions.length > 0) {
          rollbackHeight = Math.min(...staleTransactions.map(tx =>
            requireHeight(tx.blockindex, 'stored transaction')));
          const statsRows = await findRaw(models.Stats, {coin}, session);
          if (!Array.isArray(statsRows) || statsRows.length !== 1)
            throw new Error('Canonical rollback requires exactly one Stats document');
          stats = statsRows[0];
          const txCount = await models.Tx.countDocuments({}, {session});
          if (!Number.isSafeInteger(stats.last) || stats.last < rollbackHeight ||
              !Number.isSafeInteger(stats.txes) || stats.txes < staleTransactions.length || stats.txes !== txCount)
            throw new Error('Canonical rollback Stats transaction count mismatch');
          if (stats.last - rollbackHeight + 1 > ROLLBACK_BATCH_HEIGHTS) {
            batchedPlan = {rollbackHeight, last: stats.last, txes: stats.txes};
            throw LARGE_ROLLBACK;
          }
        }
      }
      const existingOrphanCount = await models.Orphans.countDocuments({}, {session});
      if (!Number.isSafeInteger(existingOrphanCount) || existingOrphanCount < 0)
        throw new Error('Orphan metadata count is malformed');
      const orphanResult = await models.Orphans.bulkWrite(persistenceOperations(rows), {ordered: true, session});
      validatePersistenceResult(orphanResult, rows.length, existingOrphanCount);

      if (rows.length === 0) {
        await assertStatsClosure(models, coin, session);
        rollbackHeight = null;
        return;
      }

      if (staleTransactions.length === 0) {
        await assertStatsClosure(models, coin, session);
        await assertProjectionClosureAtHeights(models, rows.map(row => row.blockindex), session);
        rollbackHeight = null;
        return;
      }

      const transactions = await findRaw(models.Tx, {blockindex: {$gte: rollbackHeight}}, session);
      if (!Array.isArray(transactions) || transactions.length === 0)
        throw new Error('Stale canonical transaction range disappeared during rollback');
      if (stats.txes < transactions.length)
        throw new Error('Canonical rollback Stats transaction count mismatch');
      const txids = transactions.map(tx => requireHash(tx.txid, 'stored transaction'));
      const addressTxFilter = {txid: {$in: txids}};
      const addressTransactions = await findRaw(models.AddressTx, {$or: [
        {blockindex: {$gte: rollbackHeight}},
        addressTxFilter
      ]}, session);
      validateAddressTransactions(addressTransactions, new Set(txids));
      validateProjectionClosure(transactions, addressTransactions);
      const addressOps = reverseAddressOperations(transactions);
      if (addressOps.length) {
        const addressResult = await models.Address.bulkWrite(addressOps, {ordered: true, session});
        if (!addressResult || addressResult.matchedCount !== addressOps.length)
          throw new Error('Canonical rollback address update count mismatch');
        const zeroAddressResult = await models.Address.deleteMany({
          a_id: {$in: addressOps.map(op => op.updateOne.filter.a_id)},
          sent: 0,
          received: 0,
          balance: 0
        }, {session});
        if (!zeroAddressResult || !Number.isSafeInteger(zeroAddressResult.deletedCount) ||
            zeroAddressResult.deletedCount < 0 || zeroAddressResult.deletedCount > addressOps.length)
          throw new Error('Canonical rollback zero-address deletion count mismatch');
      }
      const addressTxResult = await models.AddressTx.deleteMany(addressTxFilter, {session});
      if (!addressTxResult || addressTxResult.deletedCount !== addressTransactions.length)
        throw new Error('Canonical rollback address transaction deletion count mismatch');
      const txResult = await models.Tx.deleteMany({blockindex: {$gte: rollbackHeight}}, {session});
      if (!txResult || txResult.deletedCount !== transactions.length)
        throw new Error('Canonical rollback transaction deletion count mismatch');
      const statsResult = await models.Stats.updateOne({coin}, {
        $set: {last: rollbackHeight - 1, txes: stats.txes - transactions.length}
      }, {session});
      if (!statsResult || statsResult.matchedCount !== 1 || statsResult.modifiedCount !== 1)
        throw new Error('Canonical rollback stats update count mismatch');
      });
    } catch (error) {
      if (error !== LARGE_ROLLBACK)
        throw error;
    }
  } finally {
    await session.endSession();
  }
  if (batchedPlan)
    return synchronizeBatched(dependencies, rows, batchedPlan);
  return {rollbackHeight, orphanCount: rows.length};
}

module.exports = {discover, pendingRows, persist, synchronize, validateProjectionClosure};
