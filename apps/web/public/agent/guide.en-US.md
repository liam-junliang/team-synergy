# Team Synergy Agent operating manual

## 1. Confirm the account, project, and authorization

### Confirm the target project

After connecting, look up relevant material whenever a question depends on the state of a project or a team decision. Use `get_connection_context` to check the signed-in account and default project. If the default is unclear or the operator names a different project, use `list_projects` to identify the intended project. Ask the operator if ambiguity remains. Pass the returned `projectCode` to project tools, and check the project again when switching.

### Use MCP directly

Call tools from the host's Team Synergy tool list. Each line below is a separate call with its arguments. After confirming the project, replace `PROJECT_CODE` with the actual project code and `SOURCE_CITATION` with the complete citation returned by the search.

```text
get_connection_context  {}
list_projects  {}
grep_project_materials  {"projectCode":"PROJECT_CODE","pattern":"KEYWORD"}
read_project_material  {"projectCode":"PROJECT_CODE","sourceCitation":"SOURCE_CITATION"}
```

Use MCP to read source material, project or personal memory, code evidence, and skill revisions. Use the CLI or workspace steps in the relevant chapters to create, assign, claim, submit, verify, or close tasks. The memory and skills chapters provide additional MCP call arguments.

### Use the same lookup tools from the CLI

Use `tsp tools list` to inspect the shared input schemas. `tsp tools call` accepts JSON through `--input` and can set the project for one call through `--project`.

```bash
tsp tools call get_connection_context
tsp tools call list_projects
```

### Check authorization for this operation

Follow both platform permissions and the operator's authorization. Read permitted project materials as needed. Before creating, assigning, claiming, submitting, pushing, or merging, check the current instructions and permissions. Account preferences guide how you work. If a permission or the intended project is unclear, describe the specific blocker and ask the operator.

## 2. Find project materials and cite the sources

### Choose the index, Glob, or Grep

Use the index to find material by title, summary, or path. Use Glob to narrow virtual paths and Grep to search the contents. Index keywords and Grep use literal matching by default. Select `regex` explicitly for multi-pattern matching. Read the necessary passages by returned citation or virtual path and verify their revision and current status. Cite the title, revision, and relevant lines. If a search returns nothing, shorten the keyword or adjust the search scope.

### CLI and MCP lookup examples

Replace uppercase placeholders in these examples with real values for the current project. Use `VIRTUAL_PATH` and `SOURCE_CITATION` returned by your lookup.

```bash
tsp project home PROJECT_CODE
tsp docs index --project PROJECT_CODE --limit 10
tsp docs glob 'requirement/*.md' --project PROJECT_CODE
tsp docs grep "KEYWORD" --project PROJECT_CODE
tsp docs read "VIRTUAL_PATH" --project PROJECT_CODE
```

In MCP, call each named tool separately with the JSON object on its line.

```text
list_project_materials  {"projectCode":"PROJECT_CODE","limit":10}
glob_project_materials  {"projectCode":"PROJECT_CODE","pattern":"requirement/*.md"}
grep_project_materials  {"projectCode":"PROJECT_CODE","pattern":"KEYWORD"}
read_project_material  {"projectCode":"PROJECT_CODE","sourceCitation":"SOURCE_CITATION"}
```

### Archive durable material and link individual evidence

Keep reusable background, requirements, architecture, designs, standards, guides, and test strategy on the appropriate document or product page. Testing guides, environment notes, and reusable acceptance matrices belong in the document library. Find delivered source or build artifacts on the linked task, individual acceptance results and logs on the test execution, and screenshots or recordings on the defect. Link the original record by URL or object code.

## 3. Verify facts against the relevant project record

### Trace the Feature through requirements, design, and code

Start with project home, modules, and Features to understand the business boundaries. Phases and milestones on the Plan page provide timing and dependency context. Check the requirement state, current revision, and linked delivery tasks on the Requirements page. A prototype and its design notes describe intended interactions. Architecture materials describe system boundaries. If the task links to a frozen baseline, use that baseline for implementation scope and ask the owner about changes in a newer revision. Check the implementation version on the Specs page or with code tools.

```bash
tsp feature list --project PROJECT_CODE
tsp requirement show REQUIREMENT_CODE
tsp design list --project PROJECT_CODE
tsp design show PROTOTYPE_CODE
tsp architecture list --project PROJECT_CODE
```

### Check test cases, executions, and defects

Test cases provide steps and expectations. Execution records provide observed results, pinned versions, and evidence. A defect records what was done, what was expected, what happened, and the original evidence. Use these records to establish whether the failure is reproducible and what it affects. When using `tsp test execution record --project PROJECT_CODE --file EXECUTION_FILE` to save an actual run, include real case revisions and material references. Check task delivery through its task and verification records.

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

Use `read_memory_brief` for recent project context, `search_memory` for a specific subject, and `read_memory_source` when you need to check the original record. Identify proposals under discussion, confirmed decisions, and implementation supported by evidence. Check implementation or execution evidence to establish what has been delivered. Reuse evidence already sufficient in the current session. To check for an update, use the latest `context_receipt` returned in the same context.

Use `list_personal_memories` for account-wide preferences. To find personal preferences in a specific project, pass the project explicitly or call `search_memory` with `scope` set to `personal`. Use personal information for work authorized by that account.

### Gather code evidence from a pinned analysis

Start with `read_code_catalog` to select the repository and analysis version. Pass either `run_code` or `view_code` to `query_code_graph`. Cite the analyzed commit and source location. To establish current behavior or deployment, also check the corresponding source version or execution record.

```text
read_memory_brief  {"projectCode":"PROJECT_CODE","scope":"project"}
search_memory  {"projectCode":"PROJECT_CODE","scope":"project","query":"KEYWORD"}
read_memory_source  {"projectCode":"PROJECT_CODE","source":"MEMORY_SOURCE"}
list_personal_memories  {}
read_code_catalog  {"projectCode":"PROJECT_CODE"}
query_code_graph  {"projectCode":"PROJECT_CODE","run_code":"ANALYSIS_RUN_CODE","query":"SYMBOL"}
```

## 5. Use skills and session capture

### Select the platform, project, or run skill version

Use the platform skill catalog to find published built-in skills and the project catalog to find adopted skills. When a task run already exists, use its `run_code` to read the skill pinned for that run. Confirm the skill scope and revision first, then read the necessary `SKILL.md` or reference files. Use the `revision` returned by the catalog in the examples.

```text
list_platform_skills  {}
read_platform_skill  {"skill":"SKILL_CODE","revision":1}
list_project_skills  {"projectCode":"PROJECT_CODE","run":"RUN_CODE"}
read_project_skill  {"projectCode":"PROJECT_CODE","run":"RUN_CODE","skill":"SKILL_CODE","revision":1}
```

### Check retrieval and host capture separately

The CLI and MCP provide active lookup. Session capture uses a separate native hook or plugin to receive eligible new operator input in a registered workspace. Register the actual host only when the operator requests capture, from the signed-in workspace with an explicit project binding. Replace `HARNESS` with `codex`, `dsh`, or `opencode`. After Codex setup, have the operator review and trust the definition in `/hooks` and verify with a new session.

```bash
tsp memory native install --harness HARNESS
tsp memory native doctor --harness HARNESS
```

Check host registration, local queuing, platform receipt, processing, and retrieval in order. `doctor` reports local status. Check platform capture and processing records for server progress. Use the account's My Memory page to inspect or correct private preferences, and keep project sources and personal preferences separate.

## 6. Draft and assign the task

### Write a brief an assignee can act on

Use the CLI or platform pages for task transitions. MCP can look up project context. Use the CLI to claim tasks and create local worktrees.

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

### Review the draft and assign a member

Read back the task code and confirm `draft`. A project owner or administrator reviews the draft and assigns it to an authorized project member. Assignment checks the acceptance criteria. Read back the state and confirm `assigned`.

```bash
tsp task assign TASK_CODE --assignee USER_CODE
tsp task status TASK_CODE
```

## 7. Claim the task and work in a separate worktree

### Check the task and repository baseline

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

### Submit actual self-test results and artifact references

Test each criterion and record the commands you ran, covered acceptance IDs, actual results, and any gaps. When a PR is required, follow the project process and current authorization. Check the real PR link and commit SHA. Submit after the self-test passes. Use the delivered commit for `COMMIT_SHA` and replace `AC-1` with the acceptance IDs covered by your evidence, separated by commas.

```bash
tsp task submit TASK_CODE --run-code BUILDER_RUN --artifact-kind commit --artifact-uri git:COMMIT_SHA --artifact-hash COMMIT_SHA --evidence-type self_test --evidence-result pass --acceptance-refs AC-1 --evidence-command "TEST_COMMAND" --evidence-summary "TEST_SUMMARY"
tsp task status TASK_CODE
```

### Read back the submission state and evidence

Read back and confirm `submitted`. If the self-test fails or the evidence is incomplete, record the result and resolve it before submitting. Hand off the actual artifact, results, PR, and reviewed revision to the independent verifier.

## 9. Verify independently and close

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
