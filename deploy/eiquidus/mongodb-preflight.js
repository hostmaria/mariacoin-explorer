'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const releaseRoot = process.env.EIQUIDUS_RELEASE_ROOT || '/opt/eiquidus/current';
const {MongoClient} = require(path.join(releaseRoot, 'node_modules/mongodb'));

async function ensureIndex(database, collection, key, options, allowIndexMigration) {
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch (err) {
    if (err.codeName !== 'NamespaceNotFound' && err.code !== 26)
      throw err;
  }

  const keyText = JSON.stringify(key);
  const current = indexes.find((index) => JSON.stringify(index.key) === keyText);
  const unsupportedOptions = current && (
    Object.prototype.hasOwnProperty.call(current, 'partialFilterExpression') ||
    current.sparse === true ||
    Object.prototype.hasOwnProperty.call(current, 'collation') ||
    current.hidden === true
  );
  if (unsupportedOptions)
    throw new Error(`Refusing index ${current.name} with unsupported projection options`);
  const wrongUnique = Boolean(options.unique) !== Boolean(current && current.unique);
  const wrongName = current && current.name !== options.name;
  const expectsExpiry = Object.prototype.hasOwnProperty.call(options, 'expireAfterSeconds');
  const hasExpiry = Boolean(current && Object.prototype.hasOwnProperty.call(current, 'expireAfterSeconds'));
  if (current && hasExpiry && !expectsExpiry)
    throw new Error(`Refusing index ${current.name} with unexpected expiry semantics`);
  const wrongExpiry = current && expectsExpiry && current.expireAfterSeconds !== options.expireAfterSeconds;

  if (wrongName)
    throw new Error(`Index ${current.name} has the required key but must be named ${options.name}`);
  if (current && (wrongUnique || wrongExpiry) && !allowIndexMigration)
    throw new Error(`Index ${current.name} requires an administrator migration`);
  if (!current && !allowIndexMigration)
    throw new Error(`Missing index ${options.name}; administrator migration required`);

  if (current && wrongUnique) {
    if (!options.unique)
      throw new Error(`Refusing to weaken unique index ${current.name}`);
    await database.command({
      collMod: collection.collectionName,
      index: {name: current.name, prepareUnique: true}
    });
    await database.command({
      collMod: collection.collectionName,
      index: {name: current.name, unique: true},
      dryRun: true
    });
    await database.command({
      collMod: collection.collectionName,
      index: {name: current.name, unique: true}
    });
  }

  if (current && wrongExpiry) {
    await database.command({
      collMod: collection.collectionName,
      index: {name: current.name, expireAfterSeconds: options.expireAfterSeconds}
    });
  }

  if (!current)
    await collection.createIndex(key, options);
}

async function ensureClaimIndexes(database, allowIndexMigration) {
  const claims = database.collection('claimaddresses');
  const challenges = database.collection('claimchallenges');
  await ensureIndex(database, claims, {a_id: 1}, {name: 'a_id_1', unique: true}, allowIndexMigration);
  await ensureIndex(database, challenges, {challenge_id: 1}, {name: 'challenge_id_1', unique: true}, allowIndexMigration);
  await ensureIndex(database, challenges, {expires_at: 1}, {name: 'expires_at_1', expireAfterSeconds: 0}, allowIndexMigration);

  const claimIndexes = await claims.indexes();
  const challengeIndexes = await challenges.indexes();
  const exactKey = (index, field) => {
    const entries = Object.entries(index.key || {});
    return entries.length === 1 && entries[0][0] === field && entries[0][1] === 1;
  };
  const exactOptions = (index, expiry) => !Object.prototype.hasOwnProperty.call(index, 'partialFilterExpression') &&
    index.sparse !== true && !Object.prototype.hasOwnProperty.call(index, 'collation') && index.hidden !== true &&
    (expiry == null
      ? !Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds')
      : index.expireAfterSeconds === expiry);
  if (!claimIndexes.some((index) => index.name === 'a_id_1' && exactKey(index, 'a_id') && index.unique === true && exactOptions(index)))
    throw new Error('Claim address unique index verification failed');
  if (!challengeIndexes.some((index) => index.name === 'challenge_id_1' && exactKey(index, 'challenge_id') && index.unique === true && exactOptions(index)))
    throw new Error('Claim challenge unique index verification failed');
  if (!challengeIndexes.some((index) => index.name === 'expires_at_1' && exactKey(index, 'expires_at') && index.unique !== true && exactOptions(index, 0)))
    throw new Error('Claim challenge TTL index verification failed');
  console.log('CLAIM_INDEXES_OK');
}

async function ensureStatsIndex(database, allowIndexMigration) {
  const stats = database.collection('coinstats');
  const count = await stats.countDocuments({coin: 'MariaCoin'});
  if (count !== 1)
    throw new Error(`Expected exactly one MariaCoin Stats document, found ${count}`);
  await ensureIndex(database, stats, {coin: 1}, {name: 'coin_1', unique: true}, allowIndexMigration);
  const indexes = await stats.indexes();
  const valid = indexes.some((index) => {
    const entries = Object.entries(index.key || {});
    return index.name === 'coin_1' && entries.length === 1 && entries[0][0] === 'coin' && entries[0][1] === 1 && index.unique === true &&
      !Object.prototype.hasOwnProperty.call(index, 'partialFilterExpression') && index.sparse !== true &&
      !Object.prototype.hasOwnProperty.call(index, 'collation') && index.hidden !== true &&
      !Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds');
  });
  if (!valid)
    throw new Error('Stats coin unique index verification failed');
  console.log('STATS_INDEX_OK');
}

async function ensureAddressTransactionIndex(database, allowIndexMigration) {
  const addressTransactions = database.collection('addresstxes');
  const key = {a_id: 1, txid: 1, role: 1};
  if (allowIndexMigration) {
    const duplicateIdentities = await addressTransactions.aggregate([
      {$group: {_id: {a_id: '$a_id', txid: '$txid', role: {$ifNull: ['$role', null]}}, count: {$sum: 1}}},
      {$match: {count: {$gt: 1}}},
      {$limit: 1}
    ]).toArray();
    if (duplicateIdentities.length !== 0)
      throw new Error('Refusing migration with duplicate AddressTx projection identities');
  }
  await ensureIndex(
    database,
    addressTransactions,
    key,
    {name: 'a_id_1_txid_1_role_1', unique: true},
    allowIndexMigration
  );
  const indexes = await addressTransactions.indexes();
  const valid = indexes.some((index) => index.name === 'a_id_1_txid_1_role_1' &&
    JSON.stringify(index.key || {}) === JSON.stringify(key) &&
    index.unique === true && !Object.prototype.hasOwnProperty.call(index, 'partialFilterExpression') &&
    index.sparse !== true && !Object.prototype.hasOwnProperty.call(index, 'collation') && index.hidden !== true &&
    !Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds'));
  if (!valid)
    throw new Error('AddressTx projection unique index verification failed');
  console.log('ADDRESS_TRANSACTION_INDEX_OK');
}

// The application connects with autoIndex disabled, so nothing creates the indexes the
// models declare. A clean install must build them explicitly (administrator migration),
// and every ordinary start verifies them: without them each per-block lookup is a full
// collection scan and an initial index slows down quadratically.
async function ensureModelIndexes(database, allowIndexMigration, root = releaseRoot) {
  const {declaredIndexes, sameKey} = require(path.join(root, 'deploy/eiquidus/model-indexes.js'));
  const specs = declaredIndexes(root);
  let created = 0;
  for (const spec of specs) {
    const collection = database.collection(spec.collection);
    let existing = [];
    try {
      existing = await collection.indexes();
    } catch (err) {
      if (err.codeName !== 'NamespaceNotFound' && err.code !== 26)
        throw err;
    }
    const current = existing.find(index => sameKey(index.key, spec.key));
    if (!current) {
      if (!allowIndexMigration)
        throw new Error(`Model index missing: ${spec.collection} ${JSON.stringify(spec.key)} (run the administrator index migration)`);
      await collection.createIndex(spec.key, spec.options);
      created++;
      continue;
    }
    if (Boolean(current.unique) !== Boolean(spec.options.unique))
      throw new Error(`Model index uniqueness differs: ${spec.collection} ${JSON.stringify(spec.key)}`);
  }
  console.log(`MODEL_INDEXES_OK declared=${specs.length}${created ? ` created=${created}` : ''}`);
  return {declared: specs.length, created};
}

async function main() {
  const credentialPath = process.env.EIQUIDUS_MONGODB_CREDENTIALS || '/etc/eiquidus/mongodb-app.json';
  const allowIndexMigration = process.env.EIQUIDUS_MONGODB_INDEX_MIGRATION === '1';
  const c = JSON.parse(fs.readFileSync(credentialPath));
  const databaseName = c.database || (allowIndexMigration ? 'mariacoin' : null);
  if (databaseName !== 'mariacoin')
    throw new Error('MongoDB credentials do not identify the MariaCoin application database');
  const u = encodeURIComponent(c.username);
  const p = encodeURIComponent(c.password);
  const authSource = encodeURIComponent(c.authSource || (allowIndexMigration ? 'admin' : databaseName));
  const client = new MongoClient(`mongodb://${u}:${p}@127.0.0.1:27017/${databaseName}?replicaSet=mariacoin-rs&authSource=${authSource}`);
  let session;
  try {
    await client.connect();
    const hello = await client.db('admin').command({hello: 1});
    if (!hello.isWritablePrimary)
      throw new Error('MongoDB is not primary');
    const database = client.db(databaseName);
    await ensureClaimIndexes(database, allowIndexMigration);
    await ensureStatsIndex(database, allowIndexMigration);
    await ensureAddressTransactionIndex(database, allowIndexMigration);
    await ensureModelIndexes(database, allowIndexMigration);
    const stats = await database.collection('coinstats').findOne(
      {coin: 'MariaCoin'}, {projection: {orphan_reconciliation: 1}});
    if (stats && stats.orphan_reconciliation != null &&
        process.env.EIQUIDUS_ALLOW_ORPHAN_MIGRATION_RESUME !== '1')
      throw new Error('Incomplete orphan reconciliation blocks ordinary application startup');
    if (stats && stats.orphan_reconciliation != null)
      console.log('ORPHAN_RECONCILIATION_RESUME_REQUIRED');
    if (allowIndexMigration) {
      try {
        await database.createCollection('__deployment_transaction_probe');
      } catch (err) {
        if (err.codeName !== 'NamespaceExists' && err.code !== 48)
          throw err;
      }
    } else {
      const probeCollection = await database.listCollections({name: '__deployment_transaction_probe'}, {nameOnly: true}).toArray();
      if (probeCollection.length !== 1)
        throw new Error('MongoDB transaction probe collection requires an administrator migration');
    }
    session = client.startSession();
    const probeId = crypto.randomUUID();
    session.startTransaction();
    await database.collection('__deployment_transaction_probe').insertOne({_id: probeId}, {session});
    await session.abortTransaction();
    const retained = await database.collection('__deployment_transaction_probe').countDocuments({_id: probeId});
    if (retained !== 0)
      throw new Error('MongoDB transaction rollback failed');
    console.log('MONGODB_APP_AUTH_AND_TRANSACTION_OK');
  } finally {
    if (session) {
      if (session.inTransaction())
        await session.abortTransaction();
      await session.endSession();
    }
    await client.close();
  }
}

module.exports = {ensureIndex, ensureAddressTransactionIndex, ensureModelIndexes};
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
