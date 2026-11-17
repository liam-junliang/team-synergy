import assert from 'node:assert/strict';
import { withOwnedFixture, projectId, targetExperience, targetAgreement } from './owned-fixture.mjs';

async function run() {
  return withOwnedFixture(async ({ profiles, config, memory, vault, entity, access, expectedSources, sha256, memoryGenerationInput }) => {
    await Promise.all(['alice', 'bob'].map(access));
    const generation = entity('generation', entity('project', projectId).activeGenerationId);
    assert.equal(generation.id, 'teamsynergy-1');
    assert.equal(generation.projectId, projectId);
    const experience = entity('experience', targetExperience);
    assert.equal(experience.accountId, 'bob');
    assert.equal(experience.status, 'approved');
    // Public route inventory tests the deployed API schema independently of the source checkout.
    const specResponse = await fetch(new URL('/openapi.json', config.openviking.baseUrl), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const spec = specResponse.ok ? await specResponse.json() : null;
    if (!spec) await specResponse.body?.cancel();
    const hasPost = regex => spec ? Object.entries(spec.paths ?? {}).some(([path, methods]) => regex.test(path) && !!methods.post) : null;
    const capabilities = {
      httpStatus: specResponse.status,
      createSession: hasPost(/^\/api\/v1\/sessions\/?$/),
      appendMessage: hasPost(/^\/api\/v1\/sessions\/\{[^}]+\}\/messages$/),
      commitSession: hasPost(/^\/api\/v1\/sessions\/\{[^}]+\}\/commit$/),
      explicitScopedFind: hasPost(/^\/api\/v1\/search\/find$/),
      snapshotRestore: hasPost(/^\/api\/v1\/snapshot\/restore$/),
    };

    const publicSource = expectedSources(generation.items, generation.sources).find(x => x.id === targetAgreement);
    assert.ok(publicSource);
    const ownedWiki = await memory.detail(projectId, generation.externalId);
    assert.equal(ownedWiki.name, memory.name(projectId, generation.id, generation.manifestHash, generation.sourceFormatVersion));
    const raw = await memory.wiki('raw/read', { wiki_id: generation.externalId, filenames: [publicSource.filename] });
    assert.equal(raw.items?.[0]?.filename, publicSource.filename);
    assert.equal(sha256(raw.items[0].content), publicSource.hash);
    const agreementVersion = entity('workspace_revision', projectId).version;
    const naturalQuery = '怎样验证Base64规范化和图片编码长度边界';
    const cases = [];
    for (const query of ['ASCII 6MiB 规范 Base64', naturalQuery, '咖啡豆烘焙温度']) {
      const wiki = await memory.queryProject({ projectId, externalId: generation.externalId, query, ...memoryGenerationInput(generation) });
      const personal = await vault.recall({ accountId: 'bob', query });
      const expected = personal.find(x => x.experienceId === targetExperience);
      cases.push({
        query, projectHitKinds: [...new Set(wiki.map(x => x.retrievalKind))],
        projectHitCount: wiki.length, foundExpectedAgreement: wiki.some(x => x.knowledgeIds.includes(targetAgreement)),
        privateHitCount: personal.length, foundExpectedExperience: !!expected, expectedExperienceScore: expected?.score ?? null,
      });
    }
    const foreignHits = await vault.recall({ accountId: 'alice', query: naturalQuery });
    const foreignResponse = await fetch(new URL('/api/v1/content/read?' + new URLSearchParams({ uri: experience.uri }), config.openviking.baseUrl), { headers: vault.account('alice').headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
    await foreignResponse.body?.cancel();
    assert.equal(foreignResponse.status, 403);
    assert.ok(!foreignHits.some(x => x.experienceId === targetExperience));
    assert.equal(entity('project', projectId).activeGenerationId, generation.id);
    assert.equal(entity('experience', targetExperience).hash, experience.hash);
    assert.equal(entity('workspace_revision', projectId).version, agreementVersion);
    await Promise.all(['alice', 'bob'].map(access));
    return {
      checkedAt: new Date().toISOString(), fixture: 'image-contract',
      liveOpenVikingVersion: profiles.viking.version, openApiDeclaredPost: capabilities,
      wikiGeneration: generation.id, agreementVersion, publicSourceFormat: generation.sourceFormatVersion,
      rawDocument: { checked: 'existing published Chinese Markdown', matchesFrozenUtf8Sha256: true, bytes: Buffer.byteLength(raw.items[0].content) },
      personalScoreThreshold: config.openviking.scoreThreshold, cases,
      isolation: { foreignSearchExcludedTarget: true, foreignReadStatus: foreignResponse.status },
    };
  });
}

try { console.log(JSON.stringify(await run(), null, 2)); }
catch (error) { console.error('Fixture probe failed (' + (error.code || error.name) + '). Check local fixture ownership, mappings, services and identities.'); process.exitCode = 1; }
