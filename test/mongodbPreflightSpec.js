'use strict';

const path = require('path');
process.env.EIQUIDUS_RELEASE_ROOT = path.resolve(__dirname, '..');
const {ensureIndex, ensureModelIndexes} = require('../deploy/eiquidus/mongodb-preflight');
const {declaredIndexes} = require('../deploy/eiquidus/model-indexes');

describe('MongoDB deployment index preflight', function() {
  it('rejects a required key published under the wrong index name', async function() {
    const collection = {
      indexes: async () => [{
        name: 'unexpected_projection_index',
        key: {a_id: 1, txid: 1, role: 1},
        unique: true
      }],
      collectionName: 'addresstxes'
    };

    await expectAsync(ensureIndex(
      {command: async () => { throw new Error('must not migrate'); }},
      collection,
      {a_id: 1, txid: 1, role: 1},
      {name: 'a_id_1_txid_1_role_1', unique: true},
      false
    )).toBeRejectedWithError(/must be named a_id_1_txid_1_role_1/i);
  });
});

describe('Model-declared MongoDB indexes', function() {
  const root = path.resolve(__dirname, '..');

  function fakeDatabase(initial) {
    const state = JSON.parse(JSON.stringify(initial));
    const created = [];
    return {
      state, created,
      collection: name => ({
        indexes: async () => {
          if (!state[name]) { const err = new Error('ns does not exist'); err.codeName = 'NamespaceNotFound'; err.code = 26; throw err; }
          return state[name];
        },
        createIndex: async (key, options) => {
          created.push({name, key, options});
          (state[name] = state[name] || [{name: '_id_', key: {_id: 1}}]).push(Object.assign({key}, options.unique ? {unique: true} : {}));
        }
      })
    };
  }

  it('declares the lookup indexes the sync depends on', function() {
    const specs = declaredIndexes(root);
    const has = (collection, key, unique) => specs.some(spec => spec.collection === collection &&
      JSON.stringify(spec.key) === JSON.stringify(key) && Boolean(spec.options.unique) === unique);
    expect(has('txes', {txid: 1}, true)).toBeTrue();
    expect(has('addresses', {a_id: 1}, true)).toBeTrue();
    expect(has('addresstxes', {txid: 1}, false)).toBeTrue();
    expect(has('addresstxes', {a_id: 1, txid: 1, role: 1}, true)).toBeTrue();
    expect(has('orphans', {orphan_blockhash: 1}, true)).toBeTrue();
    expect(specs.length).toBeGreaterThanOrEqual(40);
    expect(specs.every(spec => !Object.prototype.hasOwnProperty.call(spec.options, 'background'))).toBeTrue();
  });

  it('refuses ordinary startup when a declared index is missing (empty database)', async function() {
    await expectAsync(ensureModelIndexes(fakeDatabase({}), false, root)).toBeRejectedWithError(/Model index missing: .* \(run the administrator index migration\)/);
  });

  it('creates every missing declared index during the administrator migration, then verifies cleanly', async function() {
    const database = fakeDatabase({});
    const first = await ensureModelIndexes(database, true, root);
    expect(first.created).toBe(first.declared);
    expect(database.created.find(entry => entry.name === 'txes' && entry.key.txid === 1).options.unique).toBeTrue();
    const second = await ensureModelIndexes(database, false, root);
    expect(second.created).toBe(0);
  });

  it('rejects an existing index whose uniqueness differs from the model', async function() {
    const database = fakeDatabase({});
    await ensureModelIndexes(database, true, root);
    const txid = database.state.txes.find(index => index.key.txid === 1);
    delete txid.unique;
    await expectAsync(ensureModelIndexes(database, false, root)).toBeRejectedWithError(/uniqueness differs: txes/);
  });
});
