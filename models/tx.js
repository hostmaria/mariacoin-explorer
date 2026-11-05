const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const D0 = () => mongoose.Types.Decimal128.fromString('0');

const TxSchema = new Schema({
  txid: { type: String, lowercase: true, unique: true, index: true},
  vin: { type: Array, default: [] },
  vout: { type: Array, default: [] },
  total: { type: Schema.Types.Decimal128, default: D0, index: true },
  timestamp: { type: Number, default: 0, index: true },
  blockhash: { type: String, index: true },
  blockindex: {type: Number, default: 0, index: true},
  tx_type: { type: String, default: null },
  staker: { type: String, default: null, index: true },
  stakers: { type: [String], default: [], index: true },
  valueBalance: { type: Schema.Types.Decimal128, default: null },
  valueBalanceSat: { type: Schema.Types.Decimal128, default: null },
  shieldedSpendCount: { type: Number, default: 0 },
  shieldedOutputCount: { type: Number, default: 0 },
  vShieldSpend: { type: Array, default: [] },
  vShieldOutput: { type: Array, default: [] },
  op_return: { type: String, default: null },
  algo: { type: String, default: null }
}, {id: false});

TxSchema.index({total: 1, total: -1, blockindex: 1, blockindex: -1});

module.exports = mongoose.model('Tx', TxSchema);