'use strict';

const Decimal = require('decimal.js');
const { validateProjectionClosure } = require('./orphan_tips');

const COLDSTAKE_TXID = '09fabd30b14d79ae7c4c687ad9e4517974223108474d468181d32ff8d588fdee';
const SATOSHIS = new Decimal('100000000');

function fail(message) {
  throw new Error(`MariaCoin transaction rejected: ${message}`);
}

function toSat(value, suppliedSat, field) {
  let sat;
  try {
    sat = new Decimal(value == null ? 0 : value).mul(SATOSHIS);
  } catch (_) {
    fail(`${field} is not numeric`);
  }
  if (!sat.isInteger()) fail(`${field} has more than 8 decimal places`);
  if (suppliedSat != null && !sat.eq(new Decimal(suppliedSat))) fail(`${field} does not match ${field}Sat`);
  return sat;
}

function addressFromVin(vin) {
  if (typeof vin.address === 'string' && vin.address) return vin.address;
  if (typeof vin.addresses === 'string' && vin.addresses) return vin.addresses;
  if (Array.isArray(vin.addresses) && vin.addresses.length === 1) return vin.addresses[0];
  return null;
}

function classify(tx) {
  if (!tx || typeof tx !== 'object' || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) fail('malformed vin/vout');
  const joins = tx.vjoinsplit || tx.vJoinSplit;
  if (joins != null && (!Array.isArray(joins) || joins.length > 0)) fail('unsupported JoinSplit/private structure');
  if (tx.zerocoin || tx.vMint || tx.vSpend || tx.vzerocoinspend) fail('unsupported Zerocoin/private structure');

  const spends = tx.vShieldSpend == null ? [] : tx.vShieldSpend;
  const outputs = tx.vShieldOutput == null ? [] : tx.vShieldOutput;
  if (!Array.isArray(spends) || !Array.isArray(outputs)) fail('malformed Sapling structure');
  const validOpaque = (items, keys) => items.every(item => item && typeof item === 'object' &&
    keys.every(key => typeof item[key] === 'string' && item[key].length > 0));
  if (!validOpaque(spends, ['cv', 'anchor', 'nullifier', 'rk', 'proof', 'spendAuthSig']))
    fail('malformed Sapling spend structure');
  if (!validOpaque(outputs, ['cv', 'cmu', 'ephemeralKey', 'encCiphertext', 'outCiphertext', 'proof']))
    fail('malformed Sapling output structure');
  const shielded = spends.length > 0 || outputs.length > 0 || tx.valueBalance != null || tx.valueBalanceSat != null;
  const coinbase = tx.vin.length === 1 && typeof tx.vin[0].coinbase === 'string';
  if (coinbase) {
    if (shielded || tx.isCoinStake === true) fail('coinbase cannot contain staking or Sapling data');
    return 'coinbase';
  }
  if (tx.vin.some(v => v && Object.prototype.hasOwnProperty.call(v, 'coinbase'))) fail('malformed coinbase');
  const firstOutput = tx.vout[0];
  const structuralCoinstake = tx.vin.length > 0 && tx.vout.length > 1 && firstOutput &&
    new Decimal(firstOutput.value || 0).isZero() && firstOutput.scriptPubKey &&
    firstOutput.scriptPubKey.type === 'nonstandard' && !firstOutput.scriptPubKey.asm;
  const flaggedCoinstake = tx.isCoinStake === true || tx.iscoinstake === true || tx.coinstake === true;
  if (flaggedCoinstake && !structuralCoinstake) fail('malformed coinstake');
  if (structuralCoinstake) {
    if (shielded) fail('malformed coinstake');
    return 'coinstake';
  }
  if (shielded) {
    if (spends.length === 0 && outputs.length === 0) fail('malformed Sapling transaction without shielded components');
    if (tx.valueBalance == null && tx.valueBalanceSat == null) fail('malformed Sapling valueBalance');
    return 'sapling';
  }
  if (tx.vin.length > 0) return 'normal';
  fail('strict classification failed');
}

function addAddress(map, hash, sent, received) {
  if (!hash) fail('transparent input/output has no single address');
  if (!map.has(hash)) map.set(hash, { hash, sent: new Decimal(0), received: new Decimal(0), balance: new Decimal(0) });
  const item = map.get(hash);
  item.sent = item.sent.add(sent);
  item.received = item.received.add(received);
  item.balance = item.balance.add(received).sub(sent);
}

function sumStoredSatoshis(rows, field) {
  if (!Array.isArray(rows)) fail(`${field} rows are malformed`);
  return rows.reduce((sum, row) => {
    if (!row || row.amount == null) fail(`${field} amount is missing`);
    let amount;
    try { amount = new Decimal(row.amount); } catch (_) { fail(`${field} amount is not numeric`); }
    if (!amount.isInteger() || amount.isNegative()) fail(`${field} amount is not a non-negative satoshi integer`);
    return sum.add(amount);
  }, new Decimal(0));
}

function calculateStoredTransactionTotal(txType, vin, vout) {
  const outputTotal = sumStoredSatoshis(vout, 'vout');
  if (txType !== 'coinstake') return outputTotal.toFixed(0);

  const rewardTotal = outputTotal.sub(sumStoredSatoshis(vin, 'vin'));
  if (rewardTotal.isNegative()) fail('coinstake outputs are less than staked inputs');
  return rewardTotal.toFixed(0);
}

async function enrichTransparentInputs(raw, getRawTransaction) {
  if (!raw || !Array.isArray(raw.vin) || typeof getRawTransaction !== 'function') fail('cannot enrich malformed transaction');
  if (raw.vin.some(input => input && input.coinbase != null)) return raw;

  const vin = [];
  for (const input of raw.vin) {
    if (!input || typeof input.txid !== 'string' || !Number.isInteger(input.vout) || input.vout < 0)
      fail('malformed transparent input reference');
    const previous = await getRawTransaction(input.txid);
    if (!previous || !Array.isArray(previous.vout)) fail(`unable to resolve transparent input ${input.txid}:${input.vout}`);
    const output = previous.vout.find(candidate => candidate && candidate.n === input.vout);
    if (!output || !output.scriptPubKey || typeof output.scriptPubKey.type !== 'string')
      fail(`unable to resolve transparent input ${input.txid}:${input.vout}`);

    const type = output.scriptPubKey.type.toLowerCase();
    const candidates = output.scriptPubKey.addresses == null
      ? (output.scriptPubKey.address == null ? [] : [output.scriptPubKey.address])
      : output.scriptPubKey.addresses;
    if (!Array.isArray(candidates)) fail('malformed previous output addresses');

    let address;
    let sourceType = type;
    let staker = null;
    if (type === 'coldstake' || type === 'coldstaking' || type === 'coldstakepubkeyhash') {
      if (candidates.length !== 2 || candidates.some(candidate => typeof candidate !== 'string' || !candidate))
        fail('spent coldstake output must contain [staker, owner]');
      address = candidates[1];
      sourceType = 'coldstake';
      staker = candidates[0];
    } else {
      if (candidates.length !== 1 || typeof candidates[0] !== 'string' || !candidates[0])
        fail('unable to resolve transparent input to one address');
      address = candidates[0];
    }

    const amount = toSat(output.value, output.valueSat, 'previous.vout.value');
    if (amount.isNegative()) fail('negative previous output');
    vin.push({ ...input, address, amountSat: amount.toFixed(0), sourceType, staker });
  }

  return { ...raw, vin };
}

function prepareTransaction(raw, height) {
  const txType = classify(raw);
  if (typeof raw.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.txid)) fail('invalid txid');
  if (!Number.isInteger(height) || height < 0) fail('invalid block height');

  const addresses = new Map();
  const addressTx = new Map();
  const vin = [];
  const vout = [];
  const stakers = [];

  for (const input of raw.vin) {
    if (input.coinbase != null) {
      vin.push({ addresses: 'coinbase', amount: '0', coinbase: input.coinbase });
      continue;
    }
    const address = addressFromVin(input);
    if (!address || address === 'unknown_address') fail('unable to resolve transparent input address');
    const amount = input.amountSat == null
      ? toSat(input.value == null ? input.amount : input.value, input.valueSat, 'vin.value')
      : new Decimal(input.amountSat);
    if (!amount.isInteger()) fail('vin.amountSat is not an integer');
    if (amount.isNegative()) fail('negative transparent input');
    addAddress(addresses, address, amount, new Decimal(0));
    addressTx.set(address, (addressTx.get(address) || new Decimal(0)).sub(amount));
    vin.push({
      addresses: address,
      amount: amount.toFixed(0),
      txid: input.txid,
      vout: input.vout,
      sourceType: input.sourceType || null,
      staker: input.staker || null
    });
  }

  for (const output of raw.vout) {
    if (!output || !output.scriptPubKey || typeof output.scriptPubKey.type !== 'string') fail('malformed transparent output');
    if (!Number.isInteger(output.n) || output.n < 0) fail('malformed transparent output index');
    const type = output.scriptPubKey.type.toLowerCase();
    if (type.includes('zerocoin') || type === 'privacy') fail(`unsupported output type ${type}`);
    if (type === 'nulldata') {
      const amount = toSat(output.value, output.valueSat, 'vout.value');
      if (amount.isNegative()) fail('negative transparent output');
      if (amount.isZero()) continue;
      const script = output.scriptPubKey;
      const isProvablyUnspendable = script.address == null && script.addresses == null &&
        typeof script.asm === 'string' && /^OP_RETURN(?:\s|$)/.test(script.asm) &&
        typeof script.hex === 'string' && /^6a(?:[0-9a-f]{2})*$/i.test(script.hex);
      if (!isProvablyUnspendable) fail('unaccounted nulldata output with value');
      vout.push({
        addresses: 'OP_RETURN', amount: amount.toFixed(0), n: output.n,
        script_type: type, stakers: [], burn: true,
        script_asm: script.asm, script_hex: script.hex.toLowerCase()
      });
      continue;
    }
    if (type === 'nonstandard') {
      const zero = toSat(output.value, output.valueSat, 'vout.value');
      if (!zero.isZero()) fail('unaccounted nonstandard output with value');
      continue;
    }
    const candidates = output.scriptPubKey.addresses == null
      ? (output.scriptPubKey.address == null ? [] : [output.scriptPubKey.address])
      : output.scriptPubKey.addresses;
    if (!Array.isArray(candidates)) fail('malformed output addresses');
    let address;
    let outputStakers = [];
    if (type === 'coldstake' || type === 'coldstaking' || type === 'coldstakepubkeyhash') {
      if (candidates.length !== 2 || candidates.some(a => typeof a !== 'string' || !a)) fail('coldstake output must contain [staker, owner]');
      stakers.push(candidates[0]);
      outputStakers = [candidates[0]];
      addAddress(addresses, candidates[0], new Decimal(0), new Decimal(0));
      address = candidates[1];
      addressTx.set(`staker:${candidates[0]}`, new Decimal(0));
    } else {
      if (candidates.length !== 1 || typeof candidates[0] !== 'string') fail('transparent output must contain one address');
      address = candidates[0];
    }
    const amount = toSat(output.value, output.valueSat, 'vout.value');
    if (amount.isNegative()) fail('negative transparent output');
    addAddress(addresses, address, new Decimal(0), amount);
    addressTx.set(address, (addressTx.get(address) || new Decimal(0)).add(amount));
    vout.push({ addresses: address, amount: amount.toFixed(0), n: output.n, script_type: type, stakers: outputStakers });
  }

  let valueBalance = null;
  let valueBalanceSat = null;
  if (txType === 'sapling') {
    const sat = raw.valueBalanceSat == null
      ? toSat(raw.valueBalance, null, 'valueBalance')
      : new Decimal(raw.valueBalanceSat);
    if (!sat.isInteger()) fail('valueBalanceSat is not an integer');
    if (raw.valueBalance != null && !toSat(raw.valueBalance, null, 'valueBalance').eq(sat)) fail('valueBalance does not match valueBalanceSat');
    valueBalance = raw.valueBalance == null ? sat.div(SATOSHIS).toString() : new Decimal(raw.valueBalance).toString();
    valueBalanceSat = sat.toFixed(0);
  }

  const addressRows = Array.from(addresses.values()).map(item => ({
    hash: item.hash,
    sent: item.sent.toFixed(0),
    received: item.received.toFixed(0),
    balance: item.balance.toFixed(0)
  }));
  const addressTxRows = Array.from(addressTx.entries()).map(([key, amount]) => key.startsWith('staker:')
    ? { a_id: key.slice(7), txid: raw.txid, blockindex: height, amount: '0', role: 'staker' }
    : { a_id: key, txid: raw.txid, blockindex: height, amount: amount.toFixed(0), role: 'balance' });

  const total = calculateStoredTransactionTotal(txType, vin, vout);

  return {
    tx: {
      txid: raw.txid.toLowerCase(), vin, vout,
      total,
      timestamp: raw.time || 0, blockhash: raw.blockhash, blockindex: height,
      tx_type: txType, staker: stakers[0] || null, stakers: Array.from(new Set(stakers)),
      valueBalance, valueBalanceSat,
      shieldedSpendCount: (raw.vShieldSpend || []).length,
      shieldedOutputCount: (raw.vShieldOutput || []).length,
      vShieldSpend: raw.vShieldSpend || [], vShieldOutput: raw.vShieldOutput || []
    },
    addresses: addressRows,
    addressTx: addressTxRows
  };
}

function validateRawTransactionResponse(requestedTxid, tx, expectedBlockhash = null) {
  if (typeof requestedTxid !== 'string' || !/^[0-9a-f]{64}$/i.test(requestedTxid)) fail('invalid requested txid');
  if (!tx || typeof tx !== 'object' || typeof tx.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(tx.txid))
    fail(`malformed getrawtransaction response for ${requestedTxid}`);
  if (tx.txid.toLowerCase() !== requestedTxid.toLowerCase()) fail('RPC txid mismatch');
  if (expectedBlockhash != null) {
    if (typeof tx.blockhash !== 'string' || !/^[0-9a-f]{64}$/i.test(tx.blockhash) || tx.blockhash.toLowerCase() !== expectedBlockhash.toLowerCase())
      fail('transaction blockhash mismatch');
  }
  return tx;
}

function validateBlockResponse(requestedHash, requestedHeight, block) {
  if (typeof requestedHash !== 'string' || !/^[0-9a-f]{64}$/i.test(requestedHash)) fail('invalid requested block hash');
  if (!Number.isInteger(requestedHeight) || requestedHeight < 0) fail('invalid requested block height');
  if (!block || typeof block !== 'object') fail('malformed block response');
  if (typeof block.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(block.hash) || block.hash.toLowerCase() !== requestedHash.toLowerCase())
    fail('RPC block hash mismatch');
  if (!Number.isInteger(block.height) || block.height !== requestedHeight) fail('RPC block height mismatch');
  if (!Array.isArray(block.tx) || block.tx.length === 0 || block.tx.some(txid => typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)))
    fail('malformed block transaction list');
  return block;
}

function validateVerboseBlockTransactions(requestedHash, requestedHeight, expectedTxids, block) {
  if (!block || typeof block !== 'object' || typeof block.hash !== 'string' || block.hash.toLowerCase() !== requestedHash.toLowerCase())
    fail('verbose block hash mismatch');
  if (!Number.isInteger(block.height) || block.height !== requestedHeight)
    fail('verbose block height mismatch');
  if (!Array.isArray(expectedTxids) || !expectedTxids.length || !Array.isArray(block.tx) || block.tx.length !== expectedTxids.length)
    fail('verbose block transaction list mismatch');
  return block.tx.map((tx, index) => {
    if (!tx || typeof tx !== 'object' || typeof tx.txid !== 'string' || tx.txid.toLowerCase() !== expectedTxids[index].toLowerCase())
      fail('verbose block transaction list mismatch');
    validateRawTransactionResponse(expectedTxids[index], tx);
    return { ...tx, blockhash: requestedHash };
  });
}

async function preflightTxIndex(getRawTransaction) {
  let tx;
  try { tx = await getRawTransaction(COLDSTAKE_TXID); } catch (_) { tx = null; }
  if (!tx || String(tx.txid).toLowerCase() !== COLDSTAKE_TXID) {
    throw new Error(`MariaCoin txindex preflight failed for ${COLDSTAKE_TXID}; start mariacoind with txindex=1 and reindex`);
  }
  return tx;
}

function plainDocument(value) {
  return value && typeof value.toObject === 'function'
    ? value.toObject({depopulate: true, getters: false, virtuals: false})
    : value;
}

function normalizedProjectionValue(value) {
  if (value && value._bsontype === 'Decimal128' && typeof value.toString === 'function')
    return value.toString();
  if (Array.isArray(value)) return value.map(normalizedProjectionValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizedProjectionValue(value[key])]));
  }
  return value;
}

function validatePersistedTransaction(expected, stored) {
  const actual = plainDocument(stored);
  if (!actual || typeof actual !== 'object') throw new Error('MariaCoin atomic replay transaction is malformed');
  for (const key of Object.keys(expected)) {
    if (JSON.stringify(normalizedProjectionValue(actual[key])) !== JSON.stringify(normalizedProjectionValue(expected[key])))
      throw new Error(`MariaCoin atomic replay transaction field mismatch: ${key}`);
  }
}

async function leanRows(model, filter, session) {
  const query = model.find(filter, null, {session});
  return query && typeof query.lean === 'function' ? query.lean() : query;
}

async function validateReplayProjection(items, models, session) {
  const txids = items.map(item => item.tx.txid);
  const storedTransactions = items.map(item => {
    validatePersistedTransaction(item.tx, item.existing);
    return plainDocument(item.existing);
  });
  const addressTransactions = await leanRows(models.AddressTx, {txid: {$in: txids}}, session);
  try {
    validateProjectionClosure(storedTransactions, addressTransactions);
  } catch (err) {
    throw new Error(`MariaCoin atomic replay projection mismatch: ${err.message}`);
  }
  const expectedAddresses = new Set(items.flatMap(item => item.addresses.map(address => address.hash)));
  const addresses = await leanRows(models.Address, {a_id: {$in: Array.from(expectedAddresses)}}, session);
  if (!Array.isArray(addresses) || addresses.length !== expectedAddresses.size ||
      addresses.some(address => !address || !expectedAddresses.delete(address.a_id)) || expectedAddresses.size !== 0)
    throw new Error('MariaCoin atomic replay Address projection mismatch');
}

function validMatchedOrUpsertedResult(result, expected) {
  return result && Number.isSafeInteger(result.matchedCount) && result.matchedCount >= 0 &&
    Number.isSafeInteger(result.upsertedCount) && result.upsertedCount >= 0 &&
    result.matchedCount + result.upsertedCount === expected;
}

async function verifyStatsTransactionCount(coin, dependencies) {
  const {mongoose, models} = dependencies;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const statsQuery = models.Stats.find({coin}, null, {session});
      const statsRows = statsQuery && typeof statsQuery.lean === 'function'
        ? await statsQuery.lean()
        : await statsQuery;
      if (!Array.isArray(statsRows) || statsRows.length !== 1)
        throw new Error('MariaCoin atomic persistence requires exactly one Stats document');
      const stats = statsRows[0];
      const txCount = await models.Tx.countDocuments({}, {session});
      if (!Number.isSafeInteger(stats.txes) || stats.txes < 0 ||
          !Number.isSafeInteger(txCount) || txCount < 0 || stats.txes !== txCount)
        throw new Error('MariaCoin atomic Stats transaction count mismatch');
    });
  } finally {
    await session.endSession();
  }
}

async function persistBlockAtomic(block, coin, dependencies) {
  if (!block || !Number.isInteger(block.height) || block.height < 0 || !Array.isArray(block.tx) || block.tx.length === 0)
    throw new Error('Invalid block');
  const prepared = block.tx.map(tx => prepareTransaction(tx, block.height));
  const preparedTxids = prepared.map(item => item.tx.txid);
  if (new Set(preparedTxids).size !== preparedTxids.length)
    throw new Error('MariaCoin atomic block contains a duplicate transaction');
  const { mongoose, models } = dependencies;
  if (!dependencies.statsTransactionCountVerified)
    await verifyStatsTransactionCount(coin, dependencies);
  const session = await mongoose.startSession();
  let txesAdded = 0;
  let persistedLast = null;
  try {
    await session.withTransaction(async () => {
      const statsQuery = models.Stats.find({coin}, null, {session});
      const statsRows = statsQuery && typeof statsQuery.lean === 'function'
        ? await statsQuery.lean()
        : await statsQuery;
      if (!Array.isArray(statsRows) || statsRows.length !== 1)
        throw new Error('MariaCoin atomic persistence requires exactly one Stats document');
      const stats = statsRows[0];
      const pending = [];
      const existingItems = [];
      for (const item of prepared) {
        const existing = await models.Tx.findOne({ txid: item.tx.txid }, null, { session });
        if (existing && existing.blockindex === block.height && existing.blockhash === item.tx.blockhash) {
          existingItems.push({...item, existing});
          continue;
        }
        if (existing)
          throw new Error(`Unsafe existing transaction replacement refused: ${item.tx.txid}`);
        pending.push(item);
      }
      if (!Number.isSafeInteger(stats.last) || stats.last < -1)
        throw new Error('MariaCoin atomic Stats cursor is malformed');
      if (pending.length === 0) {
        if (stats.last < block.height)
          throw new Error('MariaCoin atomic replay cursor is inconsistent');
        await validateReplayProjection(existingItems, models, session);
        persistedLast = stats.last;
        return;
      }
      if (pending.length !== prepared.length)
        throw new Error('MariaCoin atomic partial block projection detected');
      const danglingAddressTransactions = await leanRows(
        models.AddressTx,
        {txid: {$in: pending.map(item => item.tx.txid)}},
        session
      );
      if (!Array.isArray(danglingAddressTransactions) || danglingAddressTransactions.length !== 0)
        throw new Error('MariaCoin atomic partial AddressTx projection detected');
      if (pending.length > 0 && stats.last !== block.height - 1)
        throw new Error('MariaCoin atomic Stats cursor is not sequential');
      const nextTxes = stats.txes + pending.length;
      if (!Number.isSafeInteger(nextTxes) || nextTxes < 0)
        throw new Error('MariaCoin atomic Stats transaction count overflow');
      const addressOps = pending.flatMap(item => item.addresses.map(a => ({ updateOne: {
        filter: { a_id: a.hash },
        update: { $setOnInsert: { a_id: a.hash }, $inc: { sent: a.sent, received: a.received, balance: a.balance } }, upsert: true
      }})));
      const addressTxOps = pending.flatMap(item => item.addressTx.map(a => ({ updateOne: {
        filter: { a_id: a.a_id, txid: a.txid, role: a.role }, update: { $set: a }, upsert: true
      }})));
      const txOps = pending.map(item => ({ insertOne: { document: item.tx } }));
      if (addressOps.length) {
        const result = await models.Address.bulkWrite(addressOps, { ordered: true, session });
        if (!validMatchedOrUpsertedResult(result, addressOps.length))
          throw new Error('MariaCoin atomic address update count mismatch');
      }
      if (addressTxOps.length) {
        const result = await models.AddressTx.bulkWrite(addressTxOps, { ordered: true, session });
        if (!validMatchedOrUpsertedResult(result, addressTxOps.length))
          throw new Error('MariaCoin atomic address transaction update count mismatch');
      }
      if (txOps.length) {
        const result = await models.Tx.bulkWrite(txOps, { ordered: true, session });
        if (!result || result.insertedCount !== txOps.length)
          throw new Error('MariaCoin atomic transaction insert count mismatch');
      }
      txesAdded = pending.length;
      const statsResult = await models.Stats.updateOne(
        { coin },
        { $set: { last: block.height, txes: nextTxes } },
        { session }
      );
      if (!statsResult || statsResult.matchedCount !== 1 || statsResult.modifiedCount !== 1)
        throw new Error('MariaCoin atomic Stats update count mismatch');
      persistedLast = block.height;
    });
  } finally {
    await session.endSession();
  }
  return { txesAdded, last: persistedLast };
}

module.exports = {
  COLDSTAKE_TXID,
  classify,
  calculateStoredTransactionTotal,
  enrichTransparentInputs,
  prepareTransaction,
  verifyStatsTransactionCount,
  validateRawTransactionResponse,
  validateBlockResponse,
  validateVerboseBlockTransactions,
  preflightTxIndex,
  persistBlockAtomic
};
