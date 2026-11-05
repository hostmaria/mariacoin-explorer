'use strict';

const assert = require('assert');
const http = require('http');
const app = require('../app');

async function request(base, path, options) {
  const response = await fetch(base + path, options);
  return {response: response, text: await response.text()};
}

(async function() {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    if (process.env.CLAIM_DISABLED === '1') {
      const disabledPage = await request(base, '/claim');
      assert.strictEqual(disabledPage.response.status, 404);
      const disabledMutation = await request(base, '/claim/challenge', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: '{}'
      });
      assert.strictEqual(disabledMutation.response.status, 404);
      console.log('claim-http-disabled-smoke-ok');
      return;
    }

    const page = await request(base, '/claim');
    assert.strictEqual(page.response.status, 200);
    const cookie = page.response.headers.get('set-cookie') || '';
    assert.match(cookie, /__Host-maria_claim_csrf=[a-f0-9]{64}/);
    assert.match(cookie, /Path=\//i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Strict/i);
    const tokenMatch = page.text.match(/data-csrf-token="([a-f0-9]{64})"/);
    assert.ok(tokenMatch, 'rendered CSRF token missing');
    const csrfToken = tokenMatch[1];
    const cookiePair = cookie.split(';', 1)[0];

    const wrongCsrf = await request(base, '/claim/challenge', {
      method: 'POST',
      headers: {'content-type': 'application/json', cookie: cookiePair},
      body: JSON.stringify({csrfToken: '0'.repeat(64), address: 'bad', displayName: 'Alice'})
    });
    assert.strictEqual(wrongCsrf.response.status, 403);

    const unsupportedBody = await request(base, '/claim/challenge', {
      method: 'POST',
      headers: {'content-type': 'text/plain', cookie: cookiePair},
      body: 'not json'
    });
    assert.strictEqual(unsupportedBody.response.status, 400);

    const invalidAddress = await request(base, '/claim/challenge', {
      method: 'POST',
      headers: {'content-type': 'application/json', cookie: cookiePair},
      body: JSON.stringify({csrfToken: csrfToken, address: 'bad', displayName: 'Alice'})
    });
    assert.strictEqual(invalidAddress.response.status, 400);

    const oversized = await request(base, '/claim/challenge', {
      method: 'POST',
      headers: {'content-type': 'application/json', cookie: cookiePair},
      body: JSON.stringify({csrfToken: csrfToken, address: 'M' + '1'.repeat(33), displayName: 'A'.repeat(20000)})
    });
    assert.strictEqual(oversized.response.status, 413);

    const oversizedSubmission = await request(base, '/claim', {
      method: 'POST',
      headers: {'content-type': 'application/json', cookie: cookiePair},
      body: JSON.stringify({csrfToken: csrfToken, address: 'M' + '1'.repeat(33), displayName: 'A'.repeat(20000)})
    });
    assert.strictEqual(oversizedSubmission.response.status, 413);
    assert.match(oversizedSubmission.response.headers.get('content-type') || '', /application\/json/i);

    for (const trailingPath of ['/claim/', '/claim/challenge/', '/Claim', '/Claim/', '/Claim/Challenge', '/Claim/Challenge/']) {
      const trailingSubmission = await request(base, trailingPath, {
        method: 'POST',
        headers: {'content-type': 'application/json', cookie: cookiePair},
        body: JSON.stringify({csrfToken: csrfToken, address: 'M' + '1'.repeat(33), displayName: 'A'.repeat(20000)})
      });
      assert.strictEqual(trailingSubmission.response.status, 413, trailingPath + ' bypassed the Claim body limit');
      assert.match(trailingSubmission.response.headers.get('content-type') || '', /application\/json/i);
    }

    const rpc = await request(base, '/api/verifymessage?address=secret&signature=secret&message=secret');
    assert.notStrictEqual(rpc.text.trim(), 'true');
    assert.match(rpc.text, /restricted|disabled|not found|error/i);

    console.log('claim-http-smoke-ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
