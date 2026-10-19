PRAGMA foreign_keys = ON;

CREATE TABLE context_graph_snapshots (
    graph_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    snapshot INTEGER NOT NULL CHECK (snapshot > 0),
    project_snapshot INTEGER NOT NULL CHECK (project_snapshot > 0),
    git_commit TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    PRIMARY KEY (graph_id, snapshot),
    UNIQUE (project_id, snapshot)
);

CREATE TABLE context_nodes (
    graph_id TEXT NOT NULL,
    graph_snapshot INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT NOT NULL,
    verification TEXT NOT NULL CHECK (verification IN ('confirmed', 'inferred', 'proposed')),
    freshness TEXT NOT NULL CHECK (freshness IN ('current', 'stale', 'unknown')),
    owner TEXT,
    sources_json TEXT NOT NULL CHECK (json_valid(sources_json)),
    PRIMARY KEY (graph_id, graph_snapshot, node_id),
    FOREIGN KEY (graph_id, graph_snapshot)
        REFERENCES context_graph_snapshots (graph_id, snapshot)
        ON DELETE CASCADE
);

CREATE TABLE context_edges (
    graph_id TEXT NOT NULL,
    graph_snapshot INTEGER NOT NULL,
    edge_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    verification TEXT NOT NULL CHECK (verification IN ('confirmed', 'inferred', 'proposed')),
    freshness TEXT NOT NULL CHECK (freshness IN ('current', 'stale', 'unknown')),
    sources_json TEXT NOT NULL CHECK (json_valid(sources_json)),
    PRIMARY KEY (graph_id, graph_snapshot, edge_id),
    FOREIGN KEY (graph_id, graph_snapshot, from_node_id)
        REFERENCES context_nodes (graph_id, graph_snapshot, node_id)
        ON DELETE CASCADE,
    FOREIGN KEY (graph_id, graph_snapshot, to_node_id)
        REFERENCES context_nodes (graph_id, graph_snapshot, node_id)
        ON DELETE CASCADE
);

CREATE INDEX context_edges_from_idx
    ON context_edges (graph_id, graph_snapshot, from_node_id);

CREATE INDEX context_edges_to_idx
    ON context_edges (graph_id, graph_snapshot, to_node_id);
