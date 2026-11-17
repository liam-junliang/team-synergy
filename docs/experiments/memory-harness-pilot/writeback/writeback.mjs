import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// The caller of this lab supplies authenticated context and an independent source
// ledger. The tests use labelled spans in place of capture and language inference.
export function createLab() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE grants (project TEXT, actor TEXT, role TEXT, PRIMARY KEY(project, actor));
    CREATE TABLE topics (id TEXT PRIMARY KEY, project TEXT, version INTEGER, state TEXT);
    CREATE TABLE requirements (id TEXT PRIMARY KEY, project TEXT, revision INTEGER, state TEXT, criterion TEXT);
    CREATE TABLE links (topic TEXT, requirement TEXT, PRIMARY KEY(topic, requirement));
    CREATE TABLE tasks (id TEXT PRIMARY KEY, requirement TEXT, pinned_revision INTEGER, status TEXT);
    CREATE TABLE entries (topic TEXT, kind TEXT, content TEXT, source TEXT);
    CREATE TABLE receipts (id TEXT PRIMARY KEY, digest TEXT, result TEXT);
    CREATE TABLE projections (receipt TEXT PRIMARY KEY, payload TEXT);
    INSERT INTO grants VALUES ('refunds','alice','owner'), ('refunds','bob','member');
    INSERT INTO topics VALUES ('refund-topic','refunds',0,'open');
    INSERT INTO requirements VALUES ('refund-rule','refunds',1,'clarifying','沿用现行退款规则');
    INSERT INTO links VALUES ('refund-topic','refund-rule');
    INSERT INTO tasks VALUES ('refund-tests','refund-rule',1,'ready');
  `);
  return db;
}

function requireThat(condition, code) {
  if (!condition) throw new Error(code);
}

export function apply(db, actor, sourceLedger, cmd) {
  const turn = sourceLedger.get(cmd.source);
  requireThat(turn && turn.project === actor.project && turn.actor === actor.id, 'SOURCE_SCOPE');
  requireThat(turn.role === 'user' && turn.device === actor.device, 'SOURCE_AUTHOR');
  const span = turn.spans[cmd.span];
  requireThat(span?.scope === 'project' && span.origin === 'direct', 'SOURCE_SPAN');
  requireThat(['discuss', 'adopt'].includes(cmd.action) && cmd.action === span.intent, 'INTENT');

  // A validated user adoption references exactly one previously grounded proposal.
  // Its public summary is read from that proposal, never from arbitrary tool arguments.
  const proposal = sourceLedger.get(span.proposal)?.spans.publicRule;
  requireThat(proposal?.scope === 'project' && proposal.origin === 'direct'
    && sourceLedger.get(span.proposal).project === actor.project, 'PROPOSAL_SCOPE');
  requireThat(span.targetTopic === cmd.topic && span.targetRequirement === cmd.requirement
    && proposal.targetTopic === cmd.topic && proposal.targetRequirement === cmd.requirement, 'TARGET_UNCLEAR');
  const key = JSON.stringify([turn.project, turn.actor, turn.device, turn.session, cmd.source, cmd.span]);
  const digest = createHash('sha256').update(JSON.stringify([
    cmd.action, cmd.topic, cmd.requirement, cmd.topicVersion, cmd.requirementRevision,
    span.proposal, proposal.text, span.text,
  ])).digest('hex');

  db.exec('BEGIN IMMEDIATE');
  try {
    const role = db.prepare('SELECT role FROM grants WHERE project=? AND actor=?').get(actor.project, actor.id)?.role;
    const allowed = cmd.action === 'adopt' ? ['owner', 'admin'] : ['owner', 'admin', 'member'];
    requireThat(allowed.includes(role), 'FORBIDDEN');
    const receipt = db.prepare('SELECT * FROM receipts WHERE id=?').get(key);
    if (receipt) {
      requireThat(receipt.digest === digest, 'REPLAY_CONFLICT');
      db.exec('COMMIT');
      return JSON.parse(receipt.result);
    }
    const topic = db.prepare('SELECT * FROM topics WHERE project=? AND id=?').get(actor.project, cmd.topic);
    const req = db.prepare('SELECT * FROM requirements WHERE project=? AND id=?').get(actor.project, cmd.requirement);
    requireThat(topic && req && db.prepare('SELECT 1 FROM links WHERE topic=? AND requirement=?').get(topic.id, req.id), 'TARGET_UNCLEAR');
    requireThat(topic.state !== 'archived', 'TOPIC_ARCHIVED');
    requireThat(topic.version === cmd.topicVersion && req.revision === cmd.requirementRevision, 'VERSION_CONFLICT');
    const adopted = cmd.action === 'adopt';
    if (adopted) {
      requireThat(db.prepare("SELECT 1 FROM entries WHERE topic=? AND source=? AND kind='alternative' AND content=?")
        .get(topic.id, span.proposal, proposal.text), 'PROPOSAL_CHANGED');
      requireThat(['draft', 'clarifying', 'change_proposed'].includes(req.state), 'REQUIREMENT_LOCKED');
      db.prepare('UPDATE requirements SET revision=revision+1, criterion=? WHERE id=?').run(proposal.text, req.id);
    }
    db.prepare('UPDATE topics SET version=version+1, state=? WHERE id=?').run(adopted ? 'decided' : topic.state, topic.id);
    db.prepare('INSERT INTO entries VALUES (?,?,?,?)').run(topic.id, adopted ? 'decision' : 'alternative', proposal.text, cmd.source);
    const result = { knowledge: adopted ? 'confirmed' : 'discussion', topic: topic.id, topicVersion: topic.version + 1,
      requirement: req.id, requirementRevision: req.revision + Number(adopted) };
    db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(key, digest, JSON.stringify(result));
    db.prepare('INSERT INTO projections VALUES (?,?)').run(key, JSON.stringify({ ...result, text: proposal.text }));
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
