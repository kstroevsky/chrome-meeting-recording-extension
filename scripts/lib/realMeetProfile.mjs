import path from 'node:path';

export const DEFAULT_REAL_MEET_CHROME_PROFILE =
  'output/real-meet/stable-chrome-profile';

const GOOGLE_AUTH_COOKIE_NAMES = new Set([
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
]);

function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseRealMeetProfileCli(
  args,
  env = process.env,
  cwd = process.cwd()
) {
  let profile = env.REAL_MEET_CHROME_PROFILE
    || DEFAULT_REAL_MEET_CHROME_PROFILE;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--profile') {
      profile = readValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!profile.trim()) throw new Error('--profile must not be empty');
  return {
    profilePath: path.resolve(cwd, profile),
    help,
  };
}

export function hasGoogleAccountSession(cookies) {
  return cookies.some((cookie) => {
    const domain = cookie.domain.replace(/^\./, '');
    return (
      (domain === 'google.com' || domain.endsWith('.google.com'))
      && GOOGLE_AUTH_COOKIE_NAMES.has(cookie.name)
    );
  });
}

export const REAL_MEET_PROFILE_USAGE = `Usage:
  npm run test:e2e:real:profile -- [--profile <path>]

Options:
  --profile <path>  Persistent stable-Chrome profile to prepare
  --help            Show this help

Environment compatibility:
  REAL_MEET_CHROME_PROFILE`;
