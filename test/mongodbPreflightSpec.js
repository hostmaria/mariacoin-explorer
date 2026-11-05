'use strict';

const path = require('path');
process.env.EIQUIDUS_RELEASE_ROOT = path.resolve(__dirname, '..');
const {ensureIndex} = require('../deploy/eiquidus/mongodb-preflight');

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
