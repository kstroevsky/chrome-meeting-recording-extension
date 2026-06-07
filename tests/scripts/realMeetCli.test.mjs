import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRealMeetEnvironment,
  parseRealMeetCli,
} from '../../scripts/lib/realMeetCli.mjs';

test('parses a positional Meet URL and live-suite flags', () => {
  const options = parseRealMeetCli([
    'https://meet.google.com/dqd-mzfc-nfy',
    '--scenario',
    'mixed-microphone',
    '--guest-name',
    'Recorder Test',
    '--strict-media',
    '--meet-media',
    'off',
    '--browser',
    'chrome',
    '--profile',
    '/tmp/recorder-account',
  ], {});

  assert.deepEqual(options, {
    meetUrl: 'https://meet.google.com/dqd-mzfc-nfy',
    scenario: 'mixed-microphone',
    guestName: 'Recorder Test',
    strictMedia: true,
    meetMedia: 'off',
    browser: 'chrome',
    profile: '/tmp/recorder-account',
    help: false,
  });
});

test('preserves MEET_URL and MEET_NAME environment compatibility', () => {
  const options = parseRealMeetCli([], {
    MEET_URL: 'https://meet.google.com/abc-defg-hij',
    MEET_NAME: 'Environment Guest',
  });

  assert.equal(options.meetUrl, 'https://meet.google.com/abc-defg-hij');
  assert.equal(options.guestName, 'Environment Guest');
  assert.equal(options.scenario, undefined);
  assert.equal(options.strictMedia, false);
  assert.equal(options.meetMedia, 'on');
  assert.equal(options.browser, 'chrome');
  assert.equal(options.profile, undefined);
});

test('rejects non-Meet and malformed meeting URLs', () => {
  assert.throws(
    () => parseRealMeetCli(['https://example.com/dqd-mzfc-nfy'], {}),
    /valid https:\/\/meet\.google\.com/
  );
  assert.throws(
    () => parseRealMeetCli(['https://meet.google.com/not-a-code'], {}),
    /valid https:\/\/meet\.google\.com/
  );
});

test('exports Playwright environment values without discarding existing variables', () => {
  const env = buildRealMeetEnvironment(
    {
      meetUrl: 'https://meet.google.com/dqd-mzfc-nfy',
      scenario: 'tab-baseline',
      guestName: 'Recorder Test',
      strictMedia: true,
      meetMedia: 'on',
      browser: 'chrome',
      profile: '/tmp/recorder-account',
      help: false,
    },
    { JOIN_TIMEOUT_MS: '90000', PATH: '/bin' }
  );

  assert.equal(env.MEET_URL, 'https://meet.google.com/dqd-mzfc-nfy');
  assert.equal(env.MEET_NAME, 'Recorder Test');
  assert.equal(env.REAL_MEET_SCENARIO, 'tab-baseline');
  assert.equal(env.REAL_MEET_STRICT_MEDIA, '1');
  assert.equal(env.REAL_MEET_MEDIA, 'on');
  assert.equal(env.REAL_MEET_BROWSER, 'chrome');
  assert.equal(env.REAL_MEET_CHROME_PROFILE, '/tmp/recorder-account');
  assert.equal(env.PW_HEADLESS, '0');
  assert.equal(env.JOIN_TIMEOUT_MS, '90000');
  assert.equal(env.PATH, '/bin');
});

test('rejects unsupported browser channels', () => {
  assert.throws(
    () => parseRealMeetCli([
      'https://meet.google.com/dqd-mzfc-nfy',
      '--browser',
      'firefox',
    ], {}),
    /browser must be either "chrome" or "chrome-for-testing"/
  );
});

test('rejects a persistent profile with Chrome for Testing', () => {
  assert.throws(
    () => parseRealMeetCli([
      'https://meet.google.com/dqd-mzfc-nfy',
      '--browser',
      'chrome-for-testing',
      '--profile',
      '/tmp/recorder-account',
    ], {}),
    /profile.*stable Chrome/i
  );
});
