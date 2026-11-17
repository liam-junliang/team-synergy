// Read-only probe for the existing, owned Windows image-contract fixture.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const hub = 'F:/workspace/team-knowledge-hub';
const runtime = 'F:/workspace/team-knowledge-runtime';
const databasePath = resolve(runtime, 'hub/product-live/hub.sqlite');
const configPath = resolve(hub, 'config/live.json');
const load = file => import(pathToFileURL(resolve(hub, file)));
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
export const projectId = 'teamsynergy';
export const targetExperience = 'experience_e03f85c4-3013-4a4e-bfac-47b017c332fd';
export const targetAgreement = 'agreement:change_fd842fc7-1caf-46bf-ab65-b6a720ba7c93';

export async function withOwnedFixture(work, { engines = true } = {}) {
  const profiles = {};
  for (const [key, name] of Object.entries({ tsp: 'tsp', tencent: 'tencent', viking: 'openviking', hub: 'hub/product-live' })) {
    profiles[key] = await json(resolve(runtime, name, 'deployment.json'));
  }
  assert.equal(profiles.tsp.schema, 'team-knowledge-hub-local-tsp/v1');
  assert.equal(profiles.tsp.baseUrl, 'http://127.0.0.1:8086');
  assert.match(profiles.tsp.databaseName, /^hub_live_[a-f0-9]{12}$/);
  assert.equal(profiles.hub.baseUrl, 'http://127.0.0.1:4321');
  const { attestStudyServices, attestTarget } = await load('scripts/setup-teamsynergy-study.mjs');
  const context = { runtime, configPath, env: process.env, profiles };
  if (engines) await attestStudyServices(context);
  else await attestTarget(context, 'tsp');
  const { loadConfig } = await load('src/config.mjs');
  const { createAdapters } = await load('src/adapters/index.mjs');
  const { expectedSources, sha256 } = await load('src/adapters/http.mjs');
  const { memoryGenerationInput, hashOf } = await load('src/service.mjs');
  const config = loadConfig({ HUB_MODE: 'live', HUB_CONFIG_FILE: configPath });
  assert.equal(config.tencent.knowledgeBaseUrl, profiles.tencent.knowledgeBaseUrl);
  assert.equal(config.openviking.baseUrl, profiles.viking.baseUrl);
  assert.equal(config.tsp.baseUrl, profiles.tsp.baseUrl);
  const study = await json(resolve(runtime, 'hub/teamsynergy-study/deployment.json'));
  assert.deepEqual(study.mapping, config.projects[projectId]);
  for (const account of ['alice', 'bob']) {
    assert.equal(config.accounts[account].openVikingUserId, profiles.viking.accounts[account].userId);
  }

  const { tsp, memory, vault } = createAdapters(config);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT owner_id FROM hub_live_owner WHERE singleton=1').get()?.owner_id, profiles.hub.ownerId);
    const get = db.prepare('SELECT document FROM entities WHERE kind = ? AND id = ?');
    const entity = (kind, id) => {
      const row = get.get(kind, id);
      return row ? JSON.parse(row.document) : null;
    };
    const access = async who => {
      const actor = await tsp.authenticate(profiles.tsp.accounts[who].token);
      assert.equal(actor.id, who);
      await tsp.assertProjectAccess(actor, projectId);
    };
    const snapshot = operation => {
      db.exec('BEGIN');
      try { return operation(); }
      finally { db.exec('ROLLBACK'); }
    };
    return await work({ profiles, config, memory, vault, entity, access, expectedSources, sha256, hashOf, snapshot, memoryGenerationInput });
  } finally { db.close(); }
}
