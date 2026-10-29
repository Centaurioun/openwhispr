# Custom Fork Release Checklist

This checklist is a human release decision record for a reviewed custom-fork build. It does not authorize publishing, installing, changing a user profile, or replacing an existing application. A build is **GO** only after every gate below has evidence and a human reviewer signs off. Any unchecked, missing, ambiguous, or failed evidence is **NO-GO** and must name its blocker.

## Candidate and review record

- Candidate branch and commit: `TODO`
- Reviewer and review date: `TODO`
- Release owner: `TODO`
- Evidence links or artifact locations: `TODO`
- Decision: `NO-GO` until every gate is completed and signed off.
- Blocker (required for NO-GO): `TODO`

## Required gates

- [ ] **Clean branch:** record the candidate branch and commit; verify the release worktree is clean and the reviewed commit is the candidate being considered.
- [ ] **Green tests:** record the exact test commands and results for the candidate; all required tests pass.
- [ ] **Source transcription:** manually smoke test source transcription using a controlled sample and record the observed result.
- [ ] **Transcript editor:** manually smoke test editing while confirming the immutable source transcript remains unchanged and record the result.
- [ ] **Note summary:** manually smoke test note summary creation and record the result.
- [ ] **Original/edited export:** manually smoke test export of both the original and edited transcript and verify the outputs.
- [ ] **MCP read access:** manually verify the Local MCP adapter can read the intended data and cannot write it; record the evidence.
- [ ] **Sign-in regression:** manually verify sign-in and the relevant account/session behavior against the baseline; record the result.

## Decision

- **GO** only when all eight gates above are checked, evidence is attached, and a human release reviewer records explicit sign-off for this exact candidate.
- **NO-GO** if any evidence is incomplete, missing, ambiguous, or failed. Record the specific blocker above and keep the candidate out of release.

Documentation, a passing test suite, and a build do not prove manual smoke tests. Do not infer smoke-test completion from source inspection or CI. Release sign-off does not itself authorize deployment, publication, installation, profile migration, or replacement of an existing application; those actions require their own deliberate review.
