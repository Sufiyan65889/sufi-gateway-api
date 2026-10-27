import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-1234567890';
process.env.ENCRYPTION_KEY = 'test-encryption-key-that-is-long-enough-1234567890';

const cryptoModule = await import('../lib/crypto');

test('API keys use the sufi-ai- prefix and 32 base62 chars', () => {
  const key = cryptoModule.generateApiKey();
  assert.match(key.raw, /^sufi-ai-[A-Za-z0-9]{32}$/);
  assert.equal(key.hash, cryptoModule.sha256Hex(key.raw));
  assert.equal(key.prefix, key.raw.slice(0, 12));
  assert.equal(key.last4, key.raw.slice(-4));
});

test('provider secrets encrypt and decrypt', () => {
  const encrypted = cryptoModule.encryptSecret('sk-test-secret-123456');
  assert.notEqual(encrypted.ciphertext, 'sk-test-secret-123456');
  assert.equal(
    cryptoModule.decryptSecret(encrypted.ciphertext, encrypted.iv, encrypted.tag),
    'sk-test-secret-123456',
  );
});

test('password hashing verifies only the right password', async () => {
  const hash = await cryptoModule.hashPassword('correct horse battery staple');
  assert.equal(await cryptoModule.verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await cryptoModule.verifyPassword('wrong', hash), false);
});

test('api.txt parser skips blanks, comments, duplicates and bad keys', () => {
  const parsed = cryptoModule.parseSecretLines('sk-abcdef123456\n\n# c\nsk-abcdef123456\nbad key\nsk-zzzzzz999999\n');
  assert.equal(parsed.values.length, 2);
  assert.equal(parsed.skipped, 5);
});
