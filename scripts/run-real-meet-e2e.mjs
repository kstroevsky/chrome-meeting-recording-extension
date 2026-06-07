import { spawnSync } from 'node:child_process';
import {
  buildRealMeetEnvironment,
  parseRealMeetCli,
  REAL_MEET_USAGE,
} from './lib/realMeetCli.mjs';

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  return result.status ?? 1;
}

function main() {
  let options;
  try {
    options = parseRealMeetCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${REAL_MEET_USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(REAL_MEET_USAGE);
    return;
  }

  const env = buildRealMeetEnvironment(options);
  console.log(`Building the real-capture development extension for ${options.meetUrl}`);
  if (run('npm', ['run', 'dev'], env) !== 0) {
    process.exitCode = 1;
    return;
  }

  console.log(`Launching the live suite as "${options.guestName}"`);
  process.exitCode = run(
    'npx',
    ['playwright', 'test', '--config=playwright.real-meet.config.ts'],
    env
  );
}

main();
