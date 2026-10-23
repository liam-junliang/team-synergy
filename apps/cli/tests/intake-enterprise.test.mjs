import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTERPRISE_ARTIFACTS,
  enterpriseDossierPlan,
  enterpriseTemplate,
  parseIntakeProfile,
  validateEnterpriseBundle,
} from '../dist/intake-enterprise.js';

test('enterprise profile parses and rejects unknown values', () => {
  assert.equal(parseIntakeProfile(undefined), 'pilot');
  assert.equal(parseIntakeProfile('enterprise'), 'enterprise');
  assert.throws(() => parseIntakeProfile('enterprise-plus'), error => error.code === 'intake_profile_invalid');
});

test('enterprise dossier plan lists every artifact and quality gate', () => {
  const plan = enterpriseDossierPlan();
  for (const artifact of ENTERPRISE_ARTIFACTS) assert.match(plan, new RegExp(artifact.type));
  assert.match(plan, /质量门禁/);
  assert.match(plan, /artifact_type/);
  assert.match(plan, /不会|不能|不等于/);
  assert.match(plan, /独立 Agent/);
});

test('enterprise templates contain every required section', () => {
  for (const artifact of ENTERPRISE_ARTIFACTS) {
    const template = enterpriseTemplate(artifact);
    for (const section of artifact.sections) assert.match(template, new RegExp(section));
    assert.match(template, new RegExp(`artifact_type: ${artifact.type}`));
    assert.match(template, /实现观察/);
    assert.match(template, /标准认证/);
  }
});

test('enterprise validator reports missing required artifacts and sections', () => {
  const result = validateEnterpriseBundle({
    profile: 'enterprise',
    items: [],
    source: { complete: false, dirty: false },
  });
  assert.ok(result.issues.some(issue => issue.includes('缺少必交产物：charter')));
  assert.ok(result.issues.some(issue => issue.includes('缺少必交产物：architecture')));
  assert.ok(result.warnings.some(warning => warning.includes('source.complete=false')));
});
