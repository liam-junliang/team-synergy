.bail on

INSERT INTO context_graph_snapshots (
    graph_id,
    project_id,
    snapshot,
    project_snapshot,
    git_commit,
    generated_at
) VALUES (
    'graph.user-login',
    'project.demo',
    28,
    18,
    'a92f81c',
    '2026-08-12T12:00:00+08:00'
);

INSERT INTO context_nodes (
    graph_id,
    graph_snapshot,
    node_id,
    kind,
    name,
    summary,
    verification,
    freshness,
    sources_json
) VALUES
    ('graph.user-login', 28, 'feature.user-login', 'feature', '用户登录', '登录功能', 'confirmed', 'current', '[{"kind":"manual","uri":"feature-context:FEATURE-12","revision":"18"}]'),
    ('graph.user-login', 28, 'usecase.email-login', 'use_case', '邮箱密码登录', '登录用例', 'confirmed', 'current', '[{"kind":"manual","uri":"feature-context:FEATURE-12","revision":"18"}]'),
    ('graph.user-login', 28, 'rule.no-account-disclosure', 'business_rule', '不泄露账号状态', '安全规则', 'confirmed', 'current', '[{"kind":"adr","uri":"decision:LOGIN-ERROR-POLICY","revision":"3"}]'),
    ('graph.user-login', 28, 'api.post-login', 'api', 'POST /api/login', '登录入口', 'confirmed', 'current', '[{"kind":"openapi","uri":"contract:API-CONTRACT-4","revision":"4"}]'),
    ('graph.user-login', 28, 'service.auth', 'service', 'Auth Service', '认证服务', 'inferred', 'current', '[{"kind":"code_scanner","uri":"git:services/auth","revision":"a92f81c"}]'),
    ('graph.user-login', 28, 'table.users', 'table', 'users', '用户表', 'inferred', 'current', '[{"kind":"database","uri":"git:migrations/users.sql","revision":"a92f81c"}]');

INSERT INTO context_edges (
    graph_id,
    graph_snapshot,
    edge_id,
    from_node_id,
    relation,
    to_node_id,
    summary,
    verification,
    freshness,
    sources_json
) VALUES
    ('graph.user-login', 28, 'edge.feature-usecase', 'feature.user-login', 'realizes', 'usecase.email-login', '实现用例', 'confirmed', 'current', '[{"kind":"manual","uri":"feature-context:FEATURE-12","revision":"18"}]'),
    ('graph.user-login', 28, 'edge.feature-rule', 'feature.user-login', 'constrained_by', 'rule.no-account-disclosure', '遵守规则', 'confirmed', 'current', '[{"kind":"manual","uri":"feature-context:FEATURE-12","revision":"18"}]'),
    ('graph.user-login', 28, 'edge.feature-api', 'feature.user-login', 'entry_point', 'api.post-login', 'API 入口', 'confirmed', 'current', '[{"kind":"openapi","uri":"contract:API-CONTRACT-4","revision":"4"}]'),
    ('graph.user-login', 28, 'edge.api-service', 'api.post-login', 'calls', 'service.auth', '调用服务', 'inferred', 'current', '[{"kind":"code_scanner","uri":"git:services/auth","revision":"a92f81c"}]'),
    ('graph.user-login', 28, 'edge.service-table', 'service.auth', 'reads', 'table.users', '读取用户表', 'inferred', 'current', '[{"kind":"code_scanner","uri":"git:services/auth","revision":"a92f81c"}]');

INSERT INTO context_graph_snapshots (
    graph_id,
    project_id,
    snapshot,
    project_snapshot,
    git_commit,
    generated_at
) VALUES (
    'graph.user-login',
    'project.demo',
    29,
    19,
    'b27e91d',
    '2026-08-12T13:00:00+08:00'
);

INSERT INTO context_nodes (
    graph_id,
    graph_snapshot,
    node_id,
    kind,
    name,
    summary,
    verification,
    freshness,
    sources_json
) VALUES (
    'graph.user-login',
    29,
    'feature.user-login',
    'feature',
    '用户登录',
    '第二个不可变图快照中的同一稳定节点',
    'confirmed',
    'current',
    '[{"kind":"manual","uri":"feature-context:FEATURE-12","revision":"19"}]'
);

CREATE TEMP TABLE assertions (
    name TEXT PRIMARY KEY,
    passed INTEGER NOT NULL CHECK (passed = 1)
);

INSERT INTO assertions (name, passed)
SELECT 'foreign keys enabled', foreign_keys = 1
FROM pragma_foreign_keys;

INSERT INTO assertions (name, passed)
SELECT 'referential integrity', COUNT(*) = 0
FROM pragma_foreign_key_check;

INSERT INTO assertions (name, passed)
SELECT 'multiple immutable snapshots', COUNT(*) = 2
FROM context_graph_snapshots
WHERE graph_id = 'graph.user-login';

INSERT INTO assertions (name, passed)
SELECT 'one-hop feature projection', COUNT(DISTINCT node_id) = 4
FROM (
    WITH RECURSIVE reachable(node_id, depth) AS (
        VALUES ('feature.user-login', 0)
        UNION
        SELECT
            CASE
                WHEN edge.from_node_id = reachable.node_id THEN edge.to_node_id
                ELSE edge.from_node_id
            END,
            reachable.depth + 1
        FROM reachable
        JOIN context_edges AS edge
          ON edge.graph_id = 'graph.user-login'
         AND edge.graph_snapshot = 28
         AND (
              edge.from_node_id = reachable.node_id
              OR edge.to_node_id = reachable.node_id
         )
        WHERE reachable.depth < 1
    )
    SELECT node_id FROM reachable
);

INSERT INTO assertions (name, passed)
SELECT 'three-hop feature projection', COUNT(DISTINCT node_id) = 6
FROM (
    WITH RECURSIVE reachable(node_id, depth) AS (
        VALUES ('feature.user-login', 0)
        UNION
        SELECT
            CASE
                WHEN edge.from_node_id = reachable.node_id THEN edge.to_node_id
                ELSE edge.from_node_id
            END,
            reachable.depth + 1
        FROM reachable
        JOIN context_edges AS edge
          ON edge.graph_id = 'graph.user-login'
         AND edge.graph_snapshot = 28
         AND (
              edge.from_node_id = reachable.node_id
              OR edge.to_node_id = reachable.node_id
         )
        WHERE reachable.depth < 3
    )
    SELECT node_id FROM reachable
);

SELECT name, 'passed' AS result
FROM assertions
ORDER BY name;
