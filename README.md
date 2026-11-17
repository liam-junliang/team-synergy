# Team Synergy

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/liam-junliang/team-synergy/actions/workflows/ci.yml/badge.svg)](https://github.com/liam-junliang/team-synergy/actions/workflows/ci.yml)

> A lightweight collaboration platform where people and their coding agents work from one verified project state.

Team Synergy keeps requirements, decisions, tasks, artifacts, evidence, and audit trails in a shared project state. It is not an agent chat room or an autonomous scheduler: agents are replaceable executors, and only explicit submissions change the project's official state.

## Why

Coding agents are fast, but their work is hard to trust when context lives in chat, local notes, or one person's head. Team Synergy gives every participant — human or agent — the same versioned facts:

- Requirements and decisions are versioned, not lost in threads.
- Work is split into tasks with owners, acceptance criteria, and evidence.
- Each agent run gets its own isolated workspace and identity.
- Completion is explicit: artifacts and evidence are published, then verified.

## Core loop

```text
Idea → requirement discussion → requirement document → requirement
→ task assigned to a person → their agent claims it
→ isolated run/workspace → implementation, self-test, evidence
→ independent verification → closed
```

## Architecture

```mermaid
flowchart LR
  subgraph Shared["Control plane (shared)"]
    Web["Web workspace"] --> API["Core API"]
    API --> DB[("PostgreSQL")]
  end
  subgraph Local["Local execution (per member)"]
    CLI["tsp CLI"] --> Agentd["agentd"]
    Agentd --> Agent["Coding agent"]
    CLI --> Worktree["Run workspace"]
  end
  CLI --> API
```

The control plane owns project facts; the local execution plane owns files and processes. The CLI never connects to PostgreSQL directly. Web, CLI, and agents all go through the same Core API, so permissions and state transitions are enforced once.

| Layer | Responsibility |
| --- | --- |
| Web | React 19 + Vite + TanStack Query; projects, requirements, plan, design, tasks, testing, defects, handovers |
| Core API | Fastify HTTP API; authentication, permissions, use cases, audit, error semantics |
| Application / Domain | Task state machine, run bindings, ownership, evidence gates, versioned documents |
| Persistence | Drizzle schema and ordered PostgreSQL migrations |
| CLI | `tsp`: device login, task claim/submit, documents, workspace and repository operations |
| agentd | Local run-session supervisor |
| Integrations | Git worktree, workspace metadata, handover snapshots |

Design rules:

- Project state is the source of truth; private reasoning is not.
- A task/run is the isolation unit; each run has its own workspace and identity.
- Artifacts require explicit publication; completion requires evidence.
- Web, CLI, and agents share one API and one permission model.
- Complexity is added only for observed problems.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/core-api` | Control-plane HTTP API and the single source of project state |
| `apps/web` | Web workspace for projects, requirements, plan, design, tasks, testing, defects, and handovers |
| `apps/cli` | `tsp` command-line client |
| `apps/agentd` | Local run-session supervisor |
| `packages/contracts` | Shared types, status enums, and validation contracts |
| `packages/domain` | Task state machine, run bindings, and domain rules |
| `packages/application` | Use cases, permissions, transactions, and audit |
| `packages/persistence` | Drizzle schema and PostgreSQL migrations |
| `packages/integrations` | Git worktree, workspace, and handover integration |

## Quick start

Prerequisites: Node.js 22+, pnpm 10.33+, PostgreSQL 16.

```bash
# 1. Prepare the databases
psql -U postgres -c "CREATE DATABASE team_synergy;"
psql -U postgres -c "CREATE DATABASE team_synergy_test;"

# 2. Install dependencies
pnpm install

# 3. Point Core API at PostgreSQL (local default)
export TSP_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/team_synergy'

# 4. Start the control plane and the web workspace
pnpm --filter @team-synergy/core-api dev   # http://127.0.0.1:8080
pnpm --filter @team-synergy/web dev        # http://127.0.0.1:5173
```

On Windows, set the variable with `$env:TSP_DATABASE_URL='...'`, or run `pnpm dev` from the repository root to start both services.

Existing installations can keep their current database name by pointing `TSP_DATABASE_URL` at it.

## CLI

```bash
pnpm --filter @team-synergy/cli build
node apps/cli/dist/index.js --help

# Bind this device through browser authorization
tsp auth login --api http://127.0.0.1:5173/api --name "my laptop"
tsp task list --assigned-to me
```

CLI release packages are built by `.github/workflows/cli-release.yml` when a `cli-v*` tag is pushed. Each platform receives a self-contained archive with its own Node runtime.

`tsp workspace init` also generates `AGENTS.md` / `CLAUDE.md` from the project standards. Run `tsp workspace guidance` after changing standards, and `tsp workspace guidance --check` to detect stale snapshots.

## System Agent (V1)

The floating project panel turns annotations on native project documents into persistent drafting jobs. Users review title, summary and body differences before explicitly adopting a new revision. Adoption checks current permissions, the base revision and the exact proposal hash; retries do not create duplicate revisions. Linked requirements, architecture and testing documents are outside this first editing adapter.

The engine requires the separately installed official `@deepseek-ai/dsh@0.2.1-rc.2`. Use the environment variables in `.env.example`: point `TSP_SYSTEM_AGENT_DSH_BIN` at its absolute `lib/bin.js`, set an independent `TSP_SYSTEM_AGENT_WORKSPACE_ROOT`, and configure a provider credential file. An explicitly selected `TSP_SYSTEM_AGENT_DSH_CREDENTIALS_FILE` can read `DEEPSEEK_API_KEY` from an existing DSH managed credential store. Never commit secrets.

The Windows launcher reads `TSP_SYSTEM_AGENT_CONFIG_FILE`, or `system-agent.config.json` beside the source/service directory. This JSON accepts only deployment settings and credential paths. An unconfigured engine rejects new jobs with an explanation. The build bundles pinned `spec-production` guidance; each job records the engine, model and Skill version/hash.

V1 supplies authorized snapshots with no file, shell or MCP tools. Candidate previews do not automatically load images or render diagrams. Cancellation, timeout and expired leases produce explicit terminal states without automatic paid retries. Deployment operators manage retained runtime records. Deterministic checks and author explanations do not constitute independent review or standards certification.

## Testing

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
```

`typecheck` needs the generated `dist` type declarations, so build first. Tests use the separate `team_synergy_test` database and must run serially so packages do not clean or migrate the same test database concurrently.

## Status

Early MVP. The task loop, requirements and documents, plan, design, testing, defects, handovers, permissions, skills, and existing-code intake are implemented. Agent Client Protocol and MCP are not finished yet. Design documents are not published with this repository.

## License

MIT
