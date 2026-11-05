'use strict';

const liveColdstake = require('./live-coldstake-131606.json');
const liveCoinstake = require('./live-coinstake.json');
const liveSaplingWithdrawal = require('./live-sapling-withdrawal.json');

const COLDSTAKE_TXID = '09fabd30b14d79ae7c4c687ad9e4517974223108474d468181d32ff8d588fdee';
const COINSTAKE_TXID = '2718f308d400cf1bdbb060ea5b20e10ca790272d1ce0994ed7316b86a3681ca6';
const SAPLING_TXID = 'a6324f5d9173db07f34e6b20c8f19f8824475b3753c9120532d6f71278cd99e5';
const STAKER = 'Sa5pvnsDtF9NUX1Zkz7ikMxciLuvmeoKfM';
const OWNER = 'MGJ5AH9JEyhwmF1eqwbpgRhY2q3NMQHXh8';

module.exports = {
  COLDSTAKE_TXID,
  COINSTAKE_TXID,
  SAPLING_TXID,
  STAKER,
  OWNER,
  coldstake: () => {
    const tx = JSON.parse(JSON.stringify(liveColdstake));
    tx.vin[0].address = OWNER;
    tx.vin[0].value = 100;
    return tx;
  },
  coinstake: () => {
    const tx = JSON.parse(JSON.stringify(liveCoinstake));
    tx.vin[0].address = 'MWEpronG9pk7fAVBB1Scw6Y9DMmfXrBqVU';
    tx.vin[0].value = 517.95601767;
    return tx;
  },
  saplingWithdrawal: () => JSON.parse(JSON.stringify(liveSaplingWithdrawal)),
  normal: () => ({
    txid: 'b'.repeat(64), blockhash: 'normal-block', time: 1700000180,
    vin: [{ txid: 'a'.repeat(64), vout: 1, address: OWNER, value: 2 }],
    vout: [{ value: 1.99, n: 0, scriptPubKey: { type: 'pubkeyhash', addresses: [STAKER] } }]
  }),
  coinbase: () => ({
    txid: 'c'.repeat(64), blockhash: 'genesis-block', time: 1,
    vin: [{ coinbase: '00' }],
    vout: [{ value: 50, n: 0, scriptPubKey: { type: 'pubkeyhash', addresses: [OWNER] } }]
  })
};
