'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ClaimChallengeSchema = new Schema({
  hostname: {type: String, required: true, lowercase: true, index: true},
  challenge_id: {type: String, required: true, unique: true, index: true},
  address: {type: String, required: true, index: true},
  display_name: {type: String, default: ''},
  message: {type: String, required: true},
  expires_at: {type: Date, required: true, index: true, expires: 0},
  consumed_at: {type: Date, default: null}
}, {id: false});

module.exports = mongoose.model('ClaimChallenge', ClaimChallengeSchema);
