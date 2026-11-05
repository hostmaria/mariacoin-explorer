'use strict';

/*
 * Recalculate persisted MariaCoin coinstake summary totals.
 *
 * This is deliberately idempotent. It must be run only after writers are
 * quiesced and a fresh isolated-restore-verified backup exists.
 */

const fs = require('fs');
const path = require('path');
const {Decimal128, MongoClient} = require('mongodb');
const maria = require('../../lib/mariacoin');

const APPLY = process.argv.includes('--apply');
const SETTINGS_PATH = process.env.EIQUIDUS_SETTINGS || '/etc/eiquidus/settings.json';
const BATCH_SIZE = 500;

function fail(message) {
  throw new Error(`coinstake total migration: ${message}`);
}

function connectionUri(settings) {
  const db = settings && settings.dbsettings;
  if (!db || typeof db.address !== 'string' || !Number.isInteger(db.port) ||
      typeof db.database !== 'string' || typeof db.user !== 'string' || typeof db.password !== 'string') {
    fail('private database settings are incomplete');
  }

  const authSource = typeof db.authSource === 'string' && db.authSource ? db.authSource : db.database;
  const replicaSet = typeof db.replicaSet === 'string' && db.replicaSet ? `&replicaSet=${encodeURIComponent(db.replicaSet)}` : '';
  return `mongodb://${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}@${db.address}:${db.port}/${db.database}?authSource=${encodeURIComponent(authSource)}${replicaSet}`;
}

function calculate(document) {
  try {
    return maria.calculateStoredTransactionTotal('coinstake', document.vin, document.vout);
  } catch (err) {
    const txid = typeof document.txid === 'string' ? document.txid : '<unknown>';
    fail(`${txid}: ${err.message}`);
  }
}

async function scan(collection, apply) {
  const cursor = collection.find(
    {tx_type: 'coinstake'},
    {projection: {_id: 1, txid: 1, vin: 1, vout: 1, total: 1}, batchSize: BATCH_SIZE}
  );
  let scanned = 0;
  let mismatched = 0;
  let updated = 0;
  let operations = [];

  async function flush() {
    if (operations.length === 0) return;
    const result = await collection.bulkWrite(operations, {ordered: true});
    if (result.matchedCount !== operations.length || result.modifiedCount !== operations.length)
      fail(`concurrent or incomplete update: matched ${result.matchedCount}, modified ${result.modifiedCount}, expected ${operations.length}`);
    updated += result.modifiedCount;
    operations = [];
  }

  for await (const document of cursor) {
    scanned += 1;
    const total = calculate(document);
    if (!document.total || typeof document.total.toString !== 'function')
      fail(`${document.txid || '<unknown>'}: persisted total is not Decimal128`);
    if (document.total.toString() === total) continue;
    mismatched += 1;
    if (!apply) continue;
    operations.push({
      updateOne: {
        filter: {_id: document._id, tx_type: 'coinstake', total: document.total},
        update: {$set: {total: Decimal128.fromString(total)}}
      }
    });
    if (operations.length === BATCH_SIZE) await flush();
  }
  await flush();
  return {scanned, mismatched, updated};
}

async function main() {
  if (!fs.existsSync(SETTINGS_PATH)) fail('private settings file is unavailable');
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  const client = new MongoClient(connectionUri(settings));
  try {
    await client.connect();
    const collection = client.db(settings.dbsettings.database).collection('txes');
    const first = await scan(collection, APPLY);
    if (!APPLY) {
      process.stdout.write(`DRY_RUN scanned=${first.scanned} mismatched=${first.mismatched}\n`);
      return;
    }
    if (first.updated !== first.mismatched) fail(`updated ${first.updated} of ${first.mismatched} mismatched totals`);
    const verification = await scan(collection, false);
    if (verification.mismatched !== 0) fail(`${verification.mismatched} incorrect coinstake totals remain after migration`);
    process.stdout.write(`MIGRATION_OK scanned=${first.scanned} updated=${first.updated} remaining=${verification.mismatched}\n`);
  } finally {
    await client.close();
  }
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
