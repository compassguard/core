# Routed Guardrail Pipeline Functional Spec

## Purpose

This change prepares Compass for a routed guardrail pipeline through folder, file, name, and import restructuring. It MUST preserve runtime behavior and public APIs while making the intended architecture readable: MCP boundary, guardrail pipeline, domain policies, LLM decision, audit/approval/signer, and transaction builders/providers.
This is the follow-up restructure that the proposal identifies as out of scope for the routed pipeline behavior itself; routed execution remains future work.

## Scope

| In scope | Out of scope |
| --- | --- |
| Folder/file restructuring, import moves, naming alignment, and docs. | Implementing routed behavior, connecting proxy to transfer/swap policy, or changing decisions. |
| LLM router naming separated from LLM decision naming. | Treating the router as operation decision authority. |
| Conditional gateway isolated as parking-lot or deprecation-candidate structure. | Deleting conditional gateway code. |

## Requirements

### Requirement: Behavior-Preserving Restructure

Compass MUST only reorganize active structure, module names, and imports. It MUST NOT change runtime behavior, public APIs, MCP tools, policy outcomes, approval, audit, signer, or provider behavior.

#### Scenario: Existing runtime behavior remains stable

- GIVEN the restructure is applied
- WHEN existing callers use current public APIs
- THEN Compass MUST preserve the same observable behavior
- AND it MUST NOT introduce routed transfer/swap enforcement.

#### Scenario: Import path changes are internal

- GIVEN a file is moved or renamed inside the active tree
- WHEN imports are updated
- THEN public contracts MUST remain stable
- AND internal imports MUST resolve without importing from `legacy/`.

### Requirement: Architecture Boundaries Are Readable

The active tree SHOULD show these intended boundaries: MCP boundary, guardrail pipeline, domain policies, LLM decision, audit/approval/signer, and transaction builders/providers.

#### Scenario: Reviewer inspects active folders

- GIVEN the restructure is complete
- WHEN a reviewer scans active backend folders and filenames
- THEN the target architecture SHOULD be visible from names and locations
- AND structure alone MUST NOT imply behavior implementation.

### Requirement: LLM Router And LLM Decision Separation

Compass MUST keep router concepts separate from operation decision concepts. The future LLM router SHALL classify intercepted tools as `transfer`, `swap`, `skip`, or `unknown` using tool name, description, and params. The LLM decision stage SHALL stay later in the operation pipeline and use deterministic evidence, conversation history, and future contextual inputs.

#### Scenario: Router naming is introduced structurally

- GIVEN files or folders are renamed
- WHEN a reviewer reads router-related names
- THEN they MUST describe route classification
- AND they MUST NOT imply approval, denial, signing, or execution authority.

#### Scenario: Decision naming remains operation-scoped

- GIVEN LLM decision files are organized or renamed
- WHEN their boundary is reviewed
- THEN they MUST remain tied to post-policy operation decisioning
- AND they MUST NOT be used as the pre-routing classifier.

### Requirement: No Proxy-To-Domain Policy Connection Yet

The restructure MUST NOT connect MCP proxy interception to transfer or swap policy gateways. Route-to-domain handoff MUST remain future work.

#### Scenario: Proxy call path is inspected

- GIVEN the restructure is complete
- WHEN the proxy call path is reviewed
- THEN it MUST NOT invoke transfer or swap policy gateways because of this change
- AND existing proxy behavior MUST remain preserved.

### Requirement: Legacy Isolation

Active code MUST NOT import from `legacy/`. Legacy code MAY remain historical reference without becoming an active dependency.

#### Scenario: Active imports are checked

- GIVEN active source files are scanned
- WHEN imports reference project modules
- THEN `app/`, `back/`, `shared/`, active `docs/`, and new scripts MUST NOT import from `legacy/`.

### Requirement: Conditional Gateway Parking Lot

Conditional gateway code MAY be classified as isolated, parking-lot, or deprecation candidate because it is outside the current Compass direction. This change MUST NOT require deletion.

#### Scenario: Conditional gateway is encountered

- GIVEN conditional gateway files exist during restructuring
- WHEN their location or naming is reviewed
- THEN they MAY be marked as isolated or parking-lot
- AND they MUST NOT be wired into the routed guardrail pipeline by this change.
