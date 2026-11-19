import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { resolveMigrationsFolder, type Db } from './db.js';
import * as schema from './schema.js';
import { withReadOnlySnapshot } from './read-only-snapshot.js';
import { TENANT_INVENTORY_CATALOG } from './tenant-inventory-catalog.js';

const ROW_LIMIT = 5000;
const tables = Object.values(schema).map(table => getTableConfig(table));
const catalog = new Map(TENANT_INVENTORY_CATALOG.flatMap(group => group.tables.split(' ').map(table => [table, { category: group.category, route: group.route }] as const)));
const sorted = (values: string[]) => values.slice().sort();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const count = (value: unknown) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid inventory count');
  return result;
};
const code = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{20}$/.test(value)) throw new Error('Invalid inventory public code');
  return value;
};
async function bounded(client: PoolClient, query: string) {
  const result = await client.query<Record<string, unknown>>(`${query} LIMIT ${ROW_LIMIT + 1}`);
  if (result.rows.length > ROW_LIMIT) throw new Error('Inventory relation limit exceeded');
  return result.rows;
}

async function verifySchema(client: PoolClient) {
  if (catalog.size !== tables.length || !same(sorted([...catalog.keys()]), sorted(tables.map(t => t.name)))) throw new Error('Unreviewed inventory catalog');
  const actual = await client.query<{ table_name: string; columns: string[]; rls: boolean; allowed: boolean }>(`SELECT c.relname AS table_name,
    array_agg(a.attname::text ORDER BY a.attname) AS columns, c.relrowsecurity OR c.relforcerowsecurity AS rls,
    has_table_privilege(c.oid, 'SELECT') AS allowed
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','p') GROUP BY c.oid ORDER BY c.relname`);
  if (!same(sorted(actual.rows.map(t => t.table_name)), sorted(tables.map(t => t.name)))) throw new Error('Inventory table coverage mismatch');
  for (const table of tables) {
    const row = actual.rows.find(row => row.table_name === table.name);
    if (!row || row.rls || !row.allowed || !same(sorted(row.columns), sorted(table.columns.map(c => c.name)))) throw new Error('Inventory columns or visibility mismatch');
  }
  const folder = resolveMigrationsFolder();
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
  const head = journal.entries.at(-1);
  if (!head) throw new Error('Missing inventory migration head');
  const hash = createHash('sha256').update(readFileSync(path.join(folder, `${head.tag}.sql`))).digest('hex');
  const latest = (await client.query<{ hash: string; created_at: string }>('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1')).rows[0];
  if (latest?.hash !== hash || Number(latest?.created_at) !== head.when) throw new Error('Inventory migration head mismatch');
  return head.tag;
}

const skillScope = `FROM public.skills s
 LEFT JOIN public.teams st ON s.scope_type='team' AND st.id=s.scope_id
 LEFT JOIN public.projects sp ON s.scope_type='project' AND sp.id=s.scope_id
 LEFT JOIN public.teams spt ON spt.id=sp.team_id`;
const skillSourceColumns = 's.code AS skill_code,s.scope_type,coalesce(st.code,spt.code) AS source_team_code,sp.code AS source_project_code';
const sourceScope = (row: Record<string, unknown>) => ({
  skill_code: code(row.skill_code), source_team_code: code(row.source_team_code),
  source_project_code: code(row.source_project_code),
  ...(row.scope_type === 'platform' ? { source_scope_type: 'platform' as const } : {}),
});
function relation(scope: ReturnType<typeof sourceScope>, target: string | null) {
  if (target && scope.source_scope_type === 'platform') return 'platform_release';
  if (!scope.source_team_code || !target) return 'unresolved_scope';
  return scope.source_team_code === target ? 'same_team' : 'different_teams_customer_unknown';
}
function versions(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.length <= ROW_LIMIT && parsed.every(v => Number.isSafeInteger(v) && v > 0) && new Set(parsed).size === parsed.length ? parsed as number[] : null;
  } catch { return null; }
}

/** A complete metadata read is not ownership evidence, customer membership or migration approval. */
export async function planTenantMapping(db: Pick<Db, '$client'>) {
  const started = performance.now();
  return withReadOnlySnapshot(db, async client => {
    const migrationHead = await verifySchema(client);
    // Never accept RLS-filtered counts, including a policy added after the catalog was inspected.
    await client.query('SET LOCAL row_security = off');
    const counts = (await client.query<{ table_name: string; rows: string }>(sorted([...catalog.keys()]).map(table => `SELECT '${table}' AS table_name,count(*)::text AS rows FROM public."${table}"`).join(' UNION ALL '))).rows;
    if (counts.length !== catalog.size) throw new Error('Incomplete inventory counts');
    const inventory = counts.map(row => ({ table: row.table_name, ...catalog.get(row.table_name), rows: count(row.rows) }));
    const teams = (await bounded(client, `SELECT t.code AS team_code,
      (SELECT count(*)::text FROM public.projects p WHERE p.team_id=t.id) AS projects,
      (SELECT count(*)::text FROM public.team_members m WHERE m.team_id=t.id) AS members,
      t.owner_principal_id IS NULL AS owner_missing FROM public.teams t ORDER BY t.code`)).map(row => ({
      team_code: code(row.team_code), projects: count(row.projects), members: count(row.members), owner_missing: row.owner_missing === true,
      tenant_key: null, mapping_status: 'pending', evidence_reference: null,
    }));
    const projects = (await bounded(client, `SELECT p.code AS project_code,t.code AS team_code,
      (SELECT count(*)::text FROM public.members m WHERE m.project_id=p.id AND NOT EXISTS
        (SELECT 1 FROM public.team_members tm WHERE tm.team_id=p.team_id AND tm.principal_id=m.principal_id)) AS external_members,
      p.owner_principal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.team_members tm WHERE tm.team_id=p.team_id AND tm.principal_id=p.owner_principal_id) AS external_owner
      FROM public.projects p LEFT JOIN public.teams t ON t.id=p.team_id ORDER BY p.code`)).map(row => ({
      project_code: code(row.project_code), team_code: code(row.team_code), external_members: count(row.external_members), external_owner: row.external_owner === true,
      tenant_key: null, mapping_status: 'pending',
    }));
    const skills = (await bounded(client, `SELECT ${skillSourceColumns} ${skillScope} ORDER BY s.code`)).map(sourceScope);
    const revisionRows = await bounded(client, 'SELECT s.code AS skill_code,r.revision,r.published_at IS NOT NULL AS published FROM public.skill_revisions r LEFT JOIN public.skills s ON s.id=r.skill_id ORDER BY s.code,r.revision');
    const published = new Set(revisionRows.filter(row => row.skill_code !== null && row.published === true).map(row => `${code(row.skill_code)}:${row.revision}`));
    const shares = (await bounded(client, `SELECT sh.code AS share_code,${skillSourceColumns},
      coalesce(tt.code,tpt.code) AS target_team_code,tp.code AS target_project_code,
      CASE WHEN octet_length(sh.revisions_json)<=65536 THEN sh.revisions_json ELSE NULL END AS revisions_json,
      sh.revoked_at IS NOT NULL AS revoked,sh.allow_external,sh.allow_projects
      FROM public.skill_shares sh LEFT JOIN public.skills s ON s.id=sh.skill_id
      LEFT JOIN public.teams st ON s.scope_type='team' AND st.id=s.scope_id LEFT JOIN public.projects sp ON s.scope_type='project' AND sp.id=s.scope_id LEFT JOIN public.teams spt ON spt.id=sp.team_id
      LEFT JOIN public.teams tt ON sh.target_type='team' AND tt.id=sh.target_id LEFT JOIN public.projects tp ON sh.target_type='project' AND tp.id=sh.target_id LEFT JOIN public.teams tpt ON tpt.id=tp.team_id ORDER BY sh.code`)).map(row => {
      const scope = sourceScope(row), target = code(row.target_team_code), selected = versions(row.revisions_json);
      return { share_code: code(row.share_code), ...scope, target_team_code: target, target_project_code: code(row.target_project_code),
        revisions: selected, versions_valid_and_published: scope.skill_code !== null && selected !== null && selected.every(revision => published.has(`${scope.skill_code}:${revision}`)),
        revoked: row.revoked === true, allow_external: row.allow_external === true, allow_projects: row.allow_projects === true,
        team_relation: relation(scope, target), customer_mapping: 'pending', recipient_acceptance: 'not_recorded_in_legacy_model' };
    });
    const revisions = new Set(revisionRows.filter(row => row.skill_code !== null).map(row => `${code(row.skill_code)}:${row.revision}`));
    const installations = (await bounded(client, `SELECT p.code AS project_code,t.code AS target_team_code,${skillSourceColumns},i.revision,i.enabled
      FROM public.project_skill_installations i LEFT JOIN public.projects p ON p.id=i.project_id LEFT JOIN public.teams t ON t.id=p.team_id
      LEFT JOIN public.skills s ON s.id=i.skill_id LEFT JOIN public.teams st ON s.scope_type='team' AND st.id=s.scope_id LEFT JOIN public.projects sp ON s.scope_type='project' AND sp.id=s.scope_id LEFT JOIN public.teams spt ON spt.id=sp.team_id
      ORDER BY p.code,s.code`)).map(row => {
      const scope = sourceScope(row), target = code(row.target_team_code);
      return { project_code: code(row.project_code), ...scope, target_team_code: target, revision: count(row.revision), enabled: row.enabled === true,
        revision_exists: scope.skill_code !== null && revisions.has(`${scope.skill_code}:${row.revision}`), team_relation: relation(scope, target), customer_mapping: 'pending', recipient_acceptance: 'not_inferred_from_installation' };
    });
    // Deliberately never read/parse payload, result_json or historical manifest contents.
    const audit = (await client.query<{ family: string; rows: string }>(`SELECT CASE
      WHEN action='skill.installation_updated' THEN 'skill_installation_bridge_review'
      WHEN entity_type='remote_mcp_connection' THEN 'connector_authorization_review'
      WHEN entity_type IN ('user','device','system_settings') THEN 'identity_or_platform_review'
      WHEN entity_type IN ('team','project','feature','task','run','agent_session','defect','requirement','requirement_revision','project_module','project_phase','project_milestone','project_document','project_document_folder','project_repository','requirement_document','requirement_idea','requirement_topic','requirement_topic_entry','requirement_document_review','requirement_baseline','architecture_document','design_prototype','test_case','test_asset','test_execution','skill','system_agent_job','intake_batch') THEN 'resource_or_delivery_review'
      ELSE 'unknown_entity_review' END AS family,count(*)::text AS rows FROM public.audit_events GROUP BY 1 ORDER BY 1`)).rows.map(row => ({ family: row.family, rows: count(row.rows), customer_mapping: 'pending' }));
    const receipts = (await client.query<{ family: string; rows: string }>(`SELECT CASE WHEN operation IN ('handover.prepare','handover.restore','handover.activate','run.resume') THEN 'known_operation_manual_review' ELSE 'unknown_operation_manual_review' END AS family,count(*)::text AS rows FROM public.command_receipts GROUP BY 1 ORDER BY 1`)).rows.map(row => ({ family: row.family, rows: count(row.rows), customer_mapping: 'pending' }));
    const total = (table: string) => inventory.find(row => row.table === table)?.rows;
    if (audit.reduce((n, row) => n + row.rows, 0) !== total('audit_events') || receipts.reduce((n, row) => n + row.rows, 0) !== total('command_receipts') || teams.length !== total('teams') || projects.length !== total('projects') || skills.length !== total('skills') || shares.length !== total('skill_shares') || installations.length !== total('project_skill_installations') || revisionRows.length !== total('skill_revisions')) throw new Error('Incomplete inventory partition');
    const facts = { inventory, teams, projects, skills, shares, installations, audit, receipts };
    return {
      format_version: 1, checked_at: new Date().toISOString(), duration_ms: Math.round(performance.now() - started), migration_head: migrationHead,
      status: 'pending', read_complete: true, ownership_complete: false, ready_for_backfill: false, tenant_id: null,
      fact_digest: createHash('sha256').update(JSON.stringify(facts)).digest('hex'), ...facts,
      issues: {
        unresolved_project_teams: projects.filter(row => !row.team_code).length,
        unresolved_skill_scopes: skills.filter(row => !row.source_team_code && row.source_scope_type !== 'platform').length,
        orphaned_skill_revisions: revisionRows.filter(row => row.skill_code === null).length,
        unresolved_share_scopes: shares.filter(row => row.team_relation === 'unresolved_scope').length,
        invalid_or_unpublished_share_versions: shares.filter(row => !row.versions_valid_and_published).length,
        unresolved_installation_scopes: installations.filter(row => row.team_relation === 'unresolved_scope').length,
        missing_installation_revisions: installations.filter(row => !row.revision_exists).length,
        unknown_audit_rows: audit.find(row => row.family === 'unknown_entity_review')?.rows ?? 0,
        unknown_receipt_rows: receipts.find(row => row.family === 'unknown_operation_manual_review')?.rows ?? 0,
      },
      deferred: [
        { area: 'historical_manifests', rows: total('run_skill_manifests'), content_inspected: false, required_review: 'immutable_source_version_hash_and_recipient_evidence' },
        { area: 'json_snapshots_and_receipts', content_inspected: false, required_review: 'all_embedded_private_content_and_receipt_customer_provenance' },
        { area: 'all_structural_parent_chains', validated: false, required_review: 'run_integrity_checks_then_confirm_customer_mapping_for_every_endpoint' },
        { area: 'membership_invites_and_support_grants', created: false, required_review: 'explicit_customer_authorization_never_infer_from_existing_actors' },
      ],
    };
  }, 'Tenant inventory');
}
