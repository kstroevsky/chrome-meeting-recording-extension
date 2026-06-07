const MEET_CODE_PATTERN = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/;

function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function validateMeetUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Provide a valid https://meet.google.com/<meeting-code> URL');
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'meet.google.com'
    || url.port
    || url.username
    || url.password
    || !MEET_CODE_PATTERN.test(url.pathname)
  ) {
    throw new Error('Provide a valid https://meet.google.com/<meeting-code> URL');
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

export function parseRealMeetCli(args, env = process.env) {
  let positionalUrl;
  let scenario;
  let guestName = env.MEET_NAME || 'Codex Recorder Test';
  let strictMedia = false;
  let meetMedia = 'on';
  let browser = env.REAL_MEET_BROWSER || 'chrome';
  let profile = env.REAL_MEET_CHROME_PROFILE;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--strict-media') {
      strictMedia = true;
      continue;
    }
    if (arg === '--scenario') {
      scenario = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--guest-name') {
      guestName = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--meet-media') {
      meetMedia = readValue(args, index, arg);
      index += 1;
      if (meetMedia !== 'on' && meetMedia !== 'off') {
        throw new Error('--meet-media must be either "on" or "off"');
      }
      continue;
    }
    if (arg === '--browser') {
      browser = readValue(args, index, arg);
      index += 1;
      if (browser === 'chromium') browser = 'chrome-for-testing';
      if (browser !== 'chrome' && browser !== 'chrome-for-testing') {
        throw new Error(
          '--browser must be either "chrome" or "chrome-for-testing"'
        );
      }
      continue;
    }
    if (arg === '--profile') {
      profile = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (positionalUrl) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    positionalUrl = arg;
  }

  if (help) {
    return {
      meetUrl: positionalUrl || env.MEET_URL || '',
      scenario,
      guestName,
      strictMedia,
      meetMedia,
      browser,
      profile,
      help,
    };
  }

  const meetUrl = validateMeetUrl(positionalUrl || env.MEET_URL || '');
  if (!guestName.trim()) throw new Error('--guest-name must not be empty');
  if (scenario != null && !scenario.trim()) throw new Error('--scenario must not be empty');
  if (profile != null && !profile.trim()) throw new Error('--profile must not be empty');
  if (profile && browser !== 'chrome') {
    throw new Error('--profile is supported only with stable Chrome');
  }

  return {
    meetUrl,
    scenario,
    guestName: guestName.trim(),
    strictMedia,
    meetMedia,
    browser,
    profile: profile?.trim(),
    help,
  };
}

export function buildRealMeetEnvironment(options, env = process.env) {
  const next = {
    ...env,
    MEET_URL: options.meetUrl,
    MEET_NAME: options.guestName,
    REAL_MEET_STRICT_MEDIA: options.strictMedia ? '1' : '0',
    REAL_MEET_MEDIA: options.meetMedia,
    REAL_MEET_BROWSER: options.browser,
    PW_HEADLESS: '0',
  };
  if (options.profile) {
    next.REAL_MEET_CHROME_PROFILE = options.profile;
  } else {
    delete next.REAL_MEET_CHROME_PROFILE;
  }
  if (options.scenario) {
    next.REAL_MEET_SCENARIO = options.scenario;
  } else {
    delete next.REAL_MEET_SCENARIO;
  }
  return next;
}

export const REAL_MEET_USAGE = `Usage:
  npm run test:e2e:real -- https://meet.google.com/abc-defg-hij [options]

Options:
  --scenario <id>       Run one typed scenario instead of the full matrix
  --guest-name <name>   Guest name shown to the meeting host
  --strict-media        Fail on signal-quality findings
  --meet-media on|off   Keep Google Meet microphone/camera enabled or disabled
  --browser chrome|chrome-for-testing
                        Browser channel (default: stable Chrome)
  --profile <path>      Persistent stable-Chrome account profile
  --help                Show this help

Environment compatibility:
  MEET_URL, MEET_NAME, JOIN_TIMEOUT_MS, RECORD_SECONDS, REAL_MEET_BROWSER,
  REAL_MEET_CHROME_PROFILE, REAL_MEET_FAILURE_HOLD_MS`;
