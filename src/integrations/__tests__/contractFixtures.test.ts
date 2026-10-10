import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildIntegrationContractFixtures } from '../contractFixtures';

const FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures/integration-v1');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'manifest.json');

describe('integration contract fixtures', () => {
  it('match the checked-in payload bytes and signatures', async () => {
    const generated = await buildIntegrationContractFixtures();
    const manifestText = `${JSON.stringify(generated.manifest, null, 2)}\n`;

    if (process.env.UPDATE_INTEGRATION_CONTRACT_FIXTURES === '1') {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      for (const fixture of generated.fixtures) {
        writeFileSync(path.join(FIXTURE_DIR, fixture.filename), fixture.body, 'utf8');
      }
      writeFileSync(MANIFEST_PATH, manifestText, 'utf8');
    }

    for (const fixture of generated.fixtures) {
      expect(readFileSync(path.join(FIXTURE_DIR, fixture.filename), 'utf8')).toBe(fixture.body);
    }
    expect(readFileSync(MANIFEST_PATH, 'utf8')).toBe(manifestText);
  });
});
