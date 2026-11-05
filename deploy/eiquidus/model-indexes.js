'use strict';
// Index specifications declared by the explorer's Mongoose models, so deployment can
// create and verify them explicitly (the application runs with autoIndex disabled).
const fs = require('fs');
const path = require('path');

const IGNORED_OPTIONS = new Set(['background']);

function normalizeOptions(options) {
  const normalized = {};
  for (const [key, value] of Object.entries(options || {})) {
    if (IGNORED_OPTIONS.has(key))
      continue;
    if (key === 'expires') {
      normalized.expireAfterSeconds = Number(value);
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function declaredIndexes(releaseRoot) {
  const modelsDirectory = path.join(releaseRoot, 'models');
  const specs = [];
  const seen = new Set();
  for (const file of fs.readdirSync(modelsDirectory).filter(name => name.endsWith('.js')).sort()) {
    const model = require(path.join(modelsDirectory, file));
    if (!model || !model.schema || !model.collection)
      continue;
    const collection = model.collection.collectionName;
    for (const [key, options] of model.schema.indexes()) {
      const spec = {collection, key, options: normalizeOptions(options)};
      const identity = `${collection} ${JSON.stringify(key)}`;
      if (seen.has(identity))
        continue;
      seen.add(identity);
      specs.push(spec);
    }
  }
  return specs;
}

function sameKey(left, right) {
  return JSON.stringify(Object.entries(left || {})) === JSON.stringify(Object.entries(right || {}));
}

module.exports = {declaredIndexes, normalizeOptions, sameKey};
