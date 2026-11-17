# Method sources and local adaptations

Read when maintaining this skill or assessing why a workflow step exists. These are method references, not dependencies, enterprise certification or evidence of our own success rate. Earlier sources were reviewed on 2026-10-21; the codebase-graph adaptation below was reviewed on 2026-11-09. Upstream documents may evolve.

| Primary source | Useful method | Team Synergy adaptation |
| --- | --- | --- |
| [Spec Kit: existing projects](https://github.github.io/spec-kit/guides/existing-projects.html) | Adopt around a bounded change, use real repository constraints, clarify uncertainty and reconcile artifacts as they evolve. Initialization does not infer the existing system's specifications. | scope.md separates inventory work from change work and distinguishes observations from intended outcomes. We retain our evidence capture and intake review contract; we do not run Spec Kit initialization. |
| [OpenSpec: existing projects](https://github.com/Fission-AI/OpenSpec/blob/main/docs/existing-projects.md) | Grow existing-project specifications through focused changes and explicit deltas. | increments.md uses ADDED/MODIFIED/REMOVED as readable semantic records, with stable identities and impact discovery. These labels neither change our schema nor delete platform entities. |
| [Superpowers: writing-skills](https://github.com/obra/superpowers/blob/main/skills/writing-skills/SKILL.md) | Observe Agent behavior on realistic cases, compare a baseline, and revise instructions in response to demonstrated failures. | Skill changes use isolated forward tests where they add confidence. We do not require a full evaluation campaign for every ordinary document edit or adopt unrelated workflow rules. |
| [Anthropic: skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md) | Evaluate actual outputs qualitatively and quantitatively, iterate, and broaden cases after improvements. | evaluation.md separates protocol checks, semantic review and skill comparisons, preserving inputs and limits. A small sample supports only a scoped conclusion. |
| [codebase-graph-prd-rules](https://github.com/xsoway/codebase-graph-prd-rules/tree/98d6a7222b3bdce3c2fbdd78bfa818b4ed2d50aa), `codebase-graph-business-rules` and `codebase-graph-module-rules` | Use a graph to discover a complete chain, confirm decisions in original source, separate eligibility/order/runtime controls, and link readable rules to test cases. | business-rules.md adapts the pinned method to UA business discovery and codegraph code navigation through the platform CLI. The upstream Graphify-first prerequisite is replaced deliberately; this is a Team Synergy adaptation, not an unchanged execution of either upstream Skill. Existing captured evidence, candidates, ACs, validation and review remain authoritative. No global Skill or Graphify dependency is installed. |

The specific requirements for captured hashes, line bounds, candidate relationships, review plans and publication come from Team Synergy's existing contract. Controlled test setup, consistent cross-document rules and precise claim evidence also address defects observed in our own material-only trial. These local controls supplement the borrowed methods; they are not claims about what those projects guarantee.

## codebase-graph-prd-rules license notice

The adapted rule/document/test method above derives from commit `98d6a7222b3bdce3c2fbdd78bfa818b4ed2d50aa`. Its MIT notice is retained with the distributed skill references:

```text
MIT License

Copyright (c) 2026 xulanzhong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
