import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  hasGoogleAccountSession,
  parseRealMeetProfileCli,
} from '../../scripts/lib/realMeetProfile.mjs';

test('resolves the default persistent profile from the repository root', () => {
  const options = parseRealMeetProfileCli([], {}, '/workspace/project');

  assert.deepEqual(options, {
    profilePath: path.resolve(
      '/workspace/project',
      'output/real-meet/stable-chrome-profile'
    ),
    help: false,
  });
});

test('accepts a reusable profile path from CLI or environment', () => {
  assert.equal(
    parseRealMeetProfileCli(
      ['--profile', '/tmp/account-a'],
      {},
      '/workspace/project'
    ).profilePath,
    '/tmp/account-a'
  );
  assert.equal(
    parseRealMeetProfileCli(
      [],
      { REAL_MEET_CHROME_PROFILE: '/tmp/account-b' },
      '/workspace/project'
    ).profilePath,
    '/tmp/account-b'
  );
});

test('detects Google authentication cookies without exposing their values', () => {
  assert.equal(
    hasGoogleAccountSession([
      { name: 'NID', domain: '.google.com' },
      { name: '__Secure-1PSID', domain: '.google.com' },
    ]),
    true
  );
  assert.equal(
    hasGoogleAccountSession([
      { name: 'NID', domain: '.google.com' },
      { name: 'SID', domain: '.example.com' },
    ]),
    false
  );
});
