const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const D0 = () => mongoose.Types.Decimal128.fromString('0');

const AddressTXSchema = new Schema({
  a_id: { type: String, index: true},
  blockindex: {type: Number, default: 0, index: true},
  txid: { type: String, lowercase: true, index: true},
  amount: { type: Schema.Types.Decimal128, default: D0, index: true},
  role: { type: String, enum: ['balance', 'staker'], default: 'balance', index: true }
}, {id: false});

AddressTXSchema.index({a_id: 1, blockindex: -1});
AddressTXSchema.index({a_id: 1, role: 1, blockindex: -1});
AddressTXSchema.index(
  {a_id: 1, txid: 1, role: 1},
  {unique: true, name: 'a_id_1_txid_1_role_1'}
);

module.exports = mongoose.model('AddressTx', AddressTXSchema);
