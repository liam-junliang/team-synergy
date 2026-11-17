import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createHostedCodeAnalysisUseCases, hashPassword, hashToken } from '@team-synergy/application';
import { seedWorkspaceProject } from '../../../packages/application/tests/test-db.mjs';
import { assertOwnedTestDatabase, requireTestContext } from '../../../scripts/test-database-guard.mjs';
import { buildServer } from '../dist/server.js';
import { createCodeAnalysisRuntime } from '../dist/code-analysis-runtime.js';
import { closeTestDb, openTestDb } from './test-db.mjs';

test('an owned test server ignores inherited hosted-analysis settings before touching runner storage', async () => {
  const context = requireTestContext();
  const directory = mkdtempSync(path.join(tmpdir(), 'tsp-code-server-isolation-'));
  const runnerRoot = path.join(directory, 'must-not-create');
  const uaRoot = path.join(directory, 'empty-ua'), cgRoot = path.join(directory, 'empty-codegraph');
  mkdirSync(uaRoot); mkdirSync(cgRoot);
  // Valid configuration reaches runtime storage setup, but these deliberately
  // incomplete engines can never run Git or inference, even if isolation fails.
  const environment = {
    TSP_CODE_ANALYSIS_ENABLED: '1', TSP_CODE_ANALYSIS_ROOT: runnerRoot,
    TSP_CODE_ANALYSIS_UA_ROOT: uaRoot, TSP_CODE_ANALYSIS_CODEGRAPH_ROOT: cgRoot,
    TSP_CODE_ANALYSIS_MODEL_URL: 'http://127.0.0.1:1/v1', TSP_CODE_ANALYSIS_MODEL: 'isolation-no-network',
    TSP_CODE_ANALYSIS_GIT_ALLOWED_HOSTS: 'github.com', TSP_CODE_ANALYSIS_GIT_ALLOWED_REPOSITORIES: '',
    TSP_CODE_ANALYSIS_API_KEY: '', TSP_CODE_ANALYSIS_API_KEY_FILE: '',
    TSP_CODE_ANALYSIS_GIT_TOKEN: '', TSP_CODE_ANALYSIS_GIT_TOKEN_FILE: '', TSP_CODE_ANALYSIS_ALLOW_HTTP: '0',
    TSP_MEMORY_ENABLED: '0', TSP_SYSTEM_AGENT_ENABLED: 'false', TSP_SYSTEM_AGENT_WORKSPACE_ROOT: '',
  };
  const original = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  let db, app;
  try {
    const controlRoot = path.join(directory, 'control');
    assert.equal(createCodeAnalysisRuntime({ ...environment, TSP_CODE_ANALYSIS_ROOT: controlRoot }).status().configured, false);
    assert.equal(existsSync(controlRoot), true, 'the control must reach storage setup before the incomplete engine is rejected');
    Object.assign(process.env, environment);
    db = await openTestDb();
    await assertOwnedTestDatabase(db.$client);
    const fixture = await seedWorkspaceProject(db, { users: [
      { key: 'owner', account: 'admin', displayName: 'Owner', projectRole: 'owner', isSystemAdmin: true,
        passwordHash: await hashPassword('IsolationFixtureOnly123!') },
    ] });
    const token = 'hosted-isolation-device';
    await db.insert(schema.devices).values({ principal_id: fixture.users.owner.id, device_name: 'Isolation test', credential_hash: hashToken(token), created_at: 't0' });
    const [repository] = await db.insert(schema.projectRepositories).values({ project_id: fixture.project.id, name: 'Unexecuted fixture',
      remote_url: 'https://github.com/example/never-fetched.git', default_branch: 'main', created_by: fixture.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
    const queued = await createHostedCodeAnalysisUseCases(db).enqueue({ principalCode: fixture.users.owner.code, projectCode: fixture.project.code,
      input: { idempotency_key: 'must-stay-queued', repository_codes: [repository.code] } });
    assert.equal(queued.ok, true, JSON.stringify(queued));

    // No borrowed handle: this is the ownership path used by native HTTP suites.
    app = await buildServer({ databaseUrl: context.databaseUrl, logger: false, migrate: false, memoryEnginesFile: '' });
    const response = await app.inject({ method: 'GET', url: `/projects/${fixture.project.code}/code-understanding/runtime`,
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data, { configured: false, model: '', message: '服务端托管分析未配置' });
    assert.equal(existsSync(runnerRoot), false, 'a test server must not initialize inherited runner storage or its engine registry');
    const [job] = await db.select().from(schema.codeHostedAnalysisJobs).where(eq(schema.codeHostedAnalysisJobs.code, queued.data[0].job_code));
    assert.equal(job.status, 'queued');
    assert.equal(job.executor_id, null);
    assert.equal(job.run_code, null);
  } finally {
    if (app) await app.close();
    if (db) await closeTestDb(db);
    for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('tsp-code-server-isolation-'));
    rmSync(resolved, { recursive: true, force: true });
  }
});
