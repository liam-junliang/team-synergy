# Team Synergy Agent operating manual

## 1. Confirm the account, project, and authorization

### Start with the HTTP Connector

No Connector download or CLI installation is needed. In a host that supports remote HTTP MCP and OAuth, copy the HTTP Connector URL from the platform's Agent connection page and add a remote connection in your host's MCP or connector settings. When the host starts OAuth, sign in to TeamSynergy in the browser. An existing browser session takes you directly to the consent page. Check the account, client, and return address, approve the permissions you need, and return to the host. The account connection works across accessible projects in one conversation, with no `tsp` installation or local directory binding.

The default permission covers on-demand project reads. To create or advance tasks, select Allow collaboration at consent. Personal memory requires separate permission. Session capture stays off. A host that supports custom headers and cannot start OAuth can use a time-limited credential from Advanced setup.

### Check the account, project, and tools on this connection

Call `read_connector_skill {}` for the built-in workflow. Pass `module` when you need a detailed reference. Use `get_connection_context {}` to check the account and connection permissions, then `list_projects {}` to find the project and role. Pass the target `projectCode` on each project call using the same connection. Check the scope when switching projects and keep each document, code, or task reference with its project. Ask the operator when a write target is unclear.

Use `search_tools {}` for an overview. Filter by `module` and `query` to find specific tools. Provide `projectCode` to see actions for the current role in that project. Follow the tool schemas returned by the current connection.

```text
read_connector_skill  {"module":"tasks"}
get_connection_context  {}
list_projects  {}
search_tools  {"projectCode":"PROJECT_CODE","module":"tasks","query":"draft"}
```

### Connect with the local CLI

Choose Local CLI on the Agent connection page for local worktrees, device-bound runs, or explicit session capture. After installing and authorizing `tsp`, use `tsp tools list` to inspect lookup schemas. `tsp tools call` accepts JSON through `--input` and can set the project through `--project`. Discover projects on the currently signed-in platform and use their returned codes on that platform. Configure the HTTP Connector for direct tool calls from your host.

```bash
tsp tools call get_connection_context
tsp tools call list_projects
```

### Check authorization for this operation

Follow both platform permissions and the operator's authorization. Read permitted project materials as needed. Before creating, assigning, claiming, submitting, pushing, or merging, check the current instructions and permissions. Account preferences guide how you work. If a permission or the intended project is unclear, describe the specific blocker and ask the operator.

## 2. Find project materials and cite the sources

### Choose the index, Glob, or Grep

Use the index to find material by title, summary, or path. Use Glob to narrow virtual paths and Grep to search the contents. Index keywords and Grep use literal matching by default. Select `regex` explicitly for multi-pattern matching. Read the necessary passages by returned citation or virtual path and verify their revision and current status. Cite the title, revision, and relevant lines. If a search returns nothing, shorten the keyword or adjust the search scope.

### Find material and read the source through the Connector

Replace uppercase placeholders with actual values for the current project. Use the complete `SOURCE_CITATION` returned by the lookup.

On the current Connector, call each tool separately with the JSON on its line. Call `read_connector_skill {"module":"materials"}` for supported locators, line ranges, and citation inputs.

```text
list_project_materials  {"projectCode":"PROJECT_CODE","limit":10}
glob_project_materials  {"projectCode":"PROJECT_CODE","pattern":"requirement/*.md"}
grep_project_materials  {"projectCode":"PROJECT_CODE","pattern":"KEYWORD"}
read_project_material  {"projectCode":"PROJECT_CODE","sourceCitation":"SOURCE_CITATION"}
```

For local CLI workflows, specify the project and use `tsp docs index`, `tsp docs glob`, `tsp docs grep`, or `tsp docs read`.

### Archive durable material and link individual evidence

Keep reusable background, requirements, architecture, designs, standards, guides, and test strategy on the appropriate document or product page. Testing guides, environment notes, and reusable acceptance matrices belong in the document library. Find delivered source or build artifacts on the linked task, individual acceptance results and logs on the test execution, and screenshots or recordings on the defect. Link the original record by URL or object code.

## 3. Verify facts against the relevant project record

### Trace the Feature through requirements, design, and code

Start with project home, modules, and Features to understand the business boundaries. Phases and milestones on the Plan page provide timing and dependency context. Check the requirement state, current revision, and linked delivery tasks on the Requirements page. A prototype and its design notes describe intended interactions. Architecture materials describe system boundaries. If the task links to a frozen baseline, use that baseline for implementation scope and ask the owner about changes in a newer revision. Check the implementation version on the Specs page or with code tools.

Use `list_project_features`, `list_project_materials`, and the code tools to look up records available through the Connector. For dedicated requirements, prototypes, and plans, use the platform pages or the local CLI below.

```bash
tsp feature list --project PROJECT_CODE
tsp requirement show REQUIREMENT_CODE
tsp design list --project PROJECT_CODE
tsp design show PROTOTYPE_CODE
tsp architecture list --project PROJECT_CODE
```

### Check test cases, executions, and defects

Test cases provide steps and expectations. Execution records provide observed results, pinned versions, and evidence. A defect records what was done, what was expected, what happened, and the original evidence. Use these records to establish whether the failure is reproducible and what it affects. Through the Connector, find cases with `list_test_cases` and log actual results with `record_test_execution`. Call `read_connector_skill {"module":"testing"}` for inputs and examples. Check task delivery through its task and verification records.

For local CLI workflows, add a record with `tsp test execution record --project PROJECT_CODE --file EXECUTION_FILE`. Review detailed test executions and defects on their platform pages.

```bash
tsp test case list --project PROJECT_CODE
tsp test execution show EXECUTION_CODE
tsp defect list --project PROJECT_CODE
```

Use the following structure for `EXECUTION_FILE`. Replace the sample values with actual revisions, outcomes, and findings.

```json
{
  "title": "EXECUTION_TITLE",
  "environment": "TEST_ENVIRONMENT",
  "tested_version": "TESTED_VERSION",
  "source": "agent",
  "asset_refs": [{"asset_code":"ASSET_CODE","revision":1}],
  "results": [{"case_code":"CASE_CODE","case_revision":1,"result":"fail","actual_result":"ACTUAL_RESULT"}]
}
```

When authorized to report a defect, describe the actual reproduction and include at least one piece of evidence. You may replace the text evidence in the example with `--evidence-file FILE_PATH` or `--evidence-url EVIDENCE_URL`. Record the affected version and linked requirement when known.

```bash
tsp defect report --feature FEATURE_CODE --title "DEFECT_TITLE" --severity medium --action "REPRO_STEPS" --expected "EXPECTED_RESULT" --actual "ACTUAL_RESULT" --evidence-text "OBSERVED_EVIDENCE"
```

## 4. Look up project memory, personal memory, and code

### Find applicable memory and check its source

Use `read_memory_brief` for recent project context and `search_memory` for a specific subject. In the Connector, use `read_memory_sources` to check your sources, then open the relevant material or memory document. Distinguish proposals, confirmed decisions, and facts backed by implementation or testing. Reuse sources that still apply in this session. With the CLI, use `tsp tools call read_memory_source` for one source. Follow the input schemas from `tsp tools list`.

Confirm personal memory permission before using `search_memory` with `scope` set to `personal` in the target project. The CLI provides `tsp tools call list_personal_memories` for account-wide preferences. Use personal information for work authorized by that account.

### Gather code evidence from a pinned analysis

Start with `read_code_catalog` to select the repository and analysis version. Pass either `run_code` or `view_code` to `query_code_graph`. Cite the analyzed commit and source location. To establish current behavior or deployment, also check the corresponding source version or execution record.

```text
read_memory_brief  {"projectCode":"PROJECT_CODE","scope":"project"}
search_memory  {"projectCode":"PROJECT_CODE","scope":"project","query":"KEYWORD"}
read_memory_sources  {"projectCode":"PROJECT_CODE","scope":"project","sources":["MEMORY_SOURCE"]}
read_code_catalog  {"projectCode":"PROJECT_CODE"}
query_code_graph  {"projectCode":"PROJECT_CODE","run_code":"ANALYSIS_RUN_CODE","query":"SYMBOL"}
```

## 5. Use skills and session capture

### Read the Connector's built-in workflow

Call `read_connector_skill {}` for the workflow or pass `module` for one of its six tool references. Read this guidance directly over the current HTTP connection. Your role in each project determines the available actions.

### Select a platform, project, or run skill version locally

Use the platform skill catalog to find published built-in skills and the project catalog to find adopted skills. When a task run already exists, use its `run_code` to read the skill pinned for that run. Confirm the skill scope and revision first, then read the necessary `SKILL.md` or reference files. Use the `revision` returned by the catalog in the examples.

```text
list_platform_skills  {}
read_platform_skill  {"skill":"SKILL_CODE","revision":1}
list_project_skills  {"projectCode":"PROJECT_CODE","run":"RUN_CODE"}
read_project_skill  {"projectCode":"PROJECT_CODE","run":"RUN_CODE","skill":"SKILL_CODE","revision":1}
```

### Check retrieval and host capture separately

The HTTP Connector provides on-demand retrieval and task tools. Configuring a connection does not enable session capture. Only after the operator explicitly agrees to save new conversations in the current workspace, select Local CLI, install and authorize the CLI, and register the host hook or plugin from the project workspace root. Confirm that `tsp project current` returns the target project; bind an unbound workspace first, and stop to check any mismatched binding. Replace `HARNESS` with `codex`, `dsh`, or `opencode`. After Codex setup, have the operator review and trust the definition in `/hooks` and verify with a new session. Claude Code session capture is not available yet; use the HTTP Connector for lookups and collaboration.

```bash
tsp project current
tsp memory native install --harness HARNESS
tsp memory native doctor --harness HARNESS
```

To stop capture in this workspace, run `tsp memory native uninstall --harness HARNESS`. It removes only platform-managed capture entries and keeps other plugins and queued records.

Check host registration, local queuing, platform receipt, processing, and retrieval in order. `doctor` reports local status. Check platform capture and processing records for server progress. Use the account's My Memory page to inspect or correct private preferences, and keep project sources and personal preferences separate.

## 6. Draft and assign the task

### Draft and assign through the Connector

Use `list_project_features` to identify the Feature and `create_task_draft` to write the context and observable acceptance criteria. Reuse the same `idempotency_key` on retries of that request. Use `get_task` to confirm `draft` and check `base_snapshot`. When assignment is requested, a project owner or administrator identifies the assignee with `list_project_members`, uses `assign_task`, and reads back `assigned`. Call `read_connector_skill {"module":"tasks"}` for exact inputs.

### Draft a task with the local CLI

Find the Feature in the target project. In `brief.md`, describe the background, upstream and downstream dependencies, writable scope, and observable acceptance criteria. Project members with write access can draft `ad-hoc` tasks. A project owner or administrator creates the other task sources, including `--source requirement --requirement REQUIREMENT_CODE` for requirements and `--source defect-fix --defect DEFECT_CODE` for fixes. The example creates an ad hoc task. Use `--depends-on` for known task dependencies and separate multiple task codes with commas.

```bash
tsp feature list --project PROJECT_CODE
tsp task create --feature FEATURE_CODE --title 'TASK_TITLE' --profile builder --source ad-hoc --acceptance '[{"id":"AC-1","text":"ACCEPTANCE_CRITERION"}]' --scope '{"writable_paths":["WRITABLE_PATH"]}' --brief-file brief.md
```

On Windows PowerShell, use the packaged `tsp.cmd` to pass JSON.

```powershell
$acceptance = '[{"id":"AC-1","text":"ACCEPTANCE_CRITERION"}]'.Replace('"', '\"')
$scope = '{"writable_paths":["WRITABLE_PATH"]}'.Replace('"', '\"')
tsp.cmd task create --feature FEATURE_CODE --title 'TASK_TITLE' --profile builder --source ad-hoc --acceptance $acceptance --scope $scope --brief-file brief.md
```

### Review and assign a draft with the local CLI

Read back the task code and confirm `draft`. A project owner or administrator reviews the draft and assigns it to an authorized project member. Assignment checks the acceptance criteria. Read back the state and confirm `assigned`.

```bash
tsp task assign TASK_CODE --assignee USER_CODE
tsp task status TASK_CODE
```

## 7. Claim and execute the task

### Claim through the Connector with a prepared workspace

Use `list_tasks` and `get_task` to confirm your `assigned` task and current snapshot. Prepare a real HTTPS `workspace_url` and its Git baseline `git_base`, then call `claim_task`. Keep the returned `run_code` and task link. The host or operator prepares the execution workspace. Use local setup for tasks that require a device lease.

### Check the task and baseline locally

As the assignee, find the task in your assignments, which may span multiple projects. Check the project, brief, acceptance criteria, assignment, and whether dependencies are closed. Confirm that the source repository and its `HEAD` match the task baseline. Claim creates a worktree from the repository's `HEAD`. Uncommitted changes stay in the source checkout.

```bash
tsp task list --assigned-to me
tsp task status TASK_CODE
tsp task claim TASK_CODE --profile builder --repo "REPO_PATH"
```

### Work in this run's worktree

Claim from a private working directory. Set `ACP_WORKSPACES_DIR` to choose a workspace root. Keep the returned `run_code` and `pack`. Enter `ACP_WORKSPACES_DIR/RUN_CODE/repo`, or `.worktrees/RUN_CODE/repo` under the claim directory if the variable is unset. Read the run brief and work within the authorized scope. Follow the project's Git rules for branches and commits.

### Prepare the branch and PR under project rules

Read the project's Git rules, then check the target branch and baseline. Change only the agreed paths in this worktree. Before committing, synchronize the latest target changes and review the diff. If the task needs a PR, record the task code, baseline SHA, reviewed SHA, actual verification, and known gaps. Reverify the new revision when a later commit changes the reviewed SHA.

## 8. Self-test and submit delivery evidence

### Submit artifacts and evidence through the Connector

After self-testing, use `get_task` to read the current run and `base_snapshot`. In `submit_task_evidence`, put the verifiable HTTPS artifact link in `artifact.uri`, put the artifact's content hash in `artifact.content_hash`, and link the acceptance criteria that actually passed in `evidence.acceptance_refs`. Read back `submitted` and hand off for independent verification. Use `record_test_execution` to log actual results for existing test cases. That record can be created independently of a task transition.

### Submit self-test results and artifact references with the local CLI

Test each criterion and record the commands you ran, covered acceptance IDs, actual results, and any gaps. When a PR is required, follow the project process and current authorization. Check the real PR link and commit SHA. Submit after the self-test passes. Use the delivered commit for `COMMIT_SHA` and replace `AC-1` with the acceptance IDs covered by your evidence, separated by commas.

```bash
tsp task submit TASK_CODE --run-code BUILDER_RUN --artifact-kind commit --artifact-uri git:COMMIT_SHA --artifact-hash COMMIT_SHA --evidence-type self_test --evidence-result pass --acceptance-refs AC-1 --evidence-command "TEST_COMMAND" --evidence-summary "TEST_SUMMARY"
tsp task status TASK_CODE
```

### Read back the submission state and evidence

Read back and confirm `submitted`. If the self-test fails or the evidence is incomplete, record the result and resolve it before submitting. Hand off the actual artifact, results, PR, and reviewed revision to the independent verifier.

## 9. Verify independently and close

Use `get_task` on the Connector to follow the status and evidence of a submitted task. Complete independent verification and closure on the platform or through the local workflow below.

### Retest the reviewed commit in a separate run

As the verifier, check out the revision under review in a separate local directory, verify its `HEAD`, and claim a separate `verifier` run from that checkout. Retest the submitted revision. A passing review covers every acceptance ID. Record the commands, actual results, and relevant diff or PR evidence.

```bash
tsp task claim TASK_CODE --profile verifier --repo "REVIEW_REPO_PATH"
tsp task verify TASK_CODE --run-code VERIFIER_RUN --evidence-result pass --acceptance-refs AC-1 --evidence-command "REVIEW_COMMAND" --evidence-summary "REVIEW_SUMMARY"
tsp task status TASK_CODE
```

### Advance according to the verification result

Record the actual verification result. `fail` or `inconclusive` moves the task to `failed`. Include reproducible evidence and the blocker so the owner can arrange rework. Read back `verified` after a passing review. Platform verification, PR approval, and merge are separate records. After meeting the project's delivery and merge requirements, the project owner or administrator closes the task and reads back `closed`.

```bash
tsp task close TASK_CODE
tsp task status TASK_CODE
```

## 10. Handle blockers, rework, and handovers

### Check status and evidence for the blocker

If a dependency, permission, target branch, conflicting criterion, or active run blocks progress, read back the task and audit history. Give the operator the project, task, run or commit SHA, attempted action, observed error, and the next decision you need. Link new work to a requirement or defect when authorized. If a write fails, check the latest state and permissions before deciding whether to retry.

```bash
tsp task status TASK_CODE
tsp task history TASK_CODE
```

### Hand off work another member can resume

Use a handover record to pin the task, code, and context. Include completed steps, remaining work, evidence, and how to verify it. The current assignee provides a reviewed structured summary and coordinates stopping the source agent before preparing the handover. The owner publishes it. The recipient accepts under their own account, restores into a new worktree, checks the revision, and activates it. Check the actual state on the Handovers page or with `tsp task handover show HANDOVER_CODE`. `SUMMARY_FILE` is a reviewed, shared JSON summary. Fill in the actual goal, progress, remaining work, next action, and evidence references.

```json
{
  "goal": "TASK_GOAL",
  "completed": ["COMPLETED_STEP"],
  "remaining": ["REMAINING_STEP"],
  "next_actions": ["VERIFICATION_STEP"],
  "evidence_refs": ["EVIDENCE_REFERENCE"]
}
```

```bash
tsp task handover prepare TASK_CODE --target USER_CODE --run SOURCE_RUN --summary SUMMARY_FILE --agent-stopped
tsp task handover publish HANDOVER_CODE
tsp task handover accept HANDOVER_CODE
tsp task handover restore HANDOVER_CODE --repo "REPO_PATH" --dir "NEW_WORKTREE"
tsp task handover activate HANDOVER_CODE
```

## Manage teams, projects, and work items

Use `search_tools {"module":"teams","query":"create team"}` or `tsp tools search "create team" --module teams` to find an action. Use `list_teams` to identify the team before calling `create_project`. The CLI equivalent is `tsp tools call create_project --input '{"team_code":"TEAM_CODE","name":"Example project"}'`. Specify the target project for each call about members, repositories, requirements, designs, defects, or tests.

Enable **Manage teams and projects** when authorizing a Connector for team management and workspace changes. The server checks current roles, record state, and revision on each call. Inspect the module reference and tool schema before calling a tool. After a create request times out, look for the resulting record before retrying.
