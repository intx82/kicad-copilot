# In-place schematic editing

Use `get_schematic_geometry` and `edit_schematic` for footprint assignment and deterministic wired drawings. Unlike `extract_circuit`/`beautify_schematic`, these tools do not rebuild components or replace their UUIDs.

1. Ask the user to save intentional editor changes. Resolve hierarchy with `get_project_info`, then read the exact physical sheet with `get_schematic`.
2. Read `get_schematic_geometry(path)`. It returns item UUIDs, their exact S-expressions and a SHA-256 source hash. Coordinates are millimetres; angles use KiCad conventions. Inspect embedded/installed symbol definitions to resolve actual transformed pin endpoints (including unit, rotation and mirroring); instance origins are NOT pin endpoints.
3. Submit one coherent `edit_schematic` batch with `expected_source_hash` and `dry_run: true`. `symbols` accepts UUID-targeted `footprint`, absolute `position: {x,y}`, and/or `angle` (0/90/180/270). Footprints are `Library:Footprint`; an empty string clears the property. Verify actual installed footprint availability and package pinout separately; assignment does not validate package suitability.
4. `wires` is an array of `{points: [{x,y}, ...]}` orthogonal polylines. Every consecutive pair creates a segment. `junctions` contains explicit connection points. `remove` lists exact existing wire/junction/label/no-connect UUIDs. No implicit snapping, routing, wire dragging, junction creation or label removal occurs. Split segments deliberately at intended junctions. Preserve unaffected objects and use the KiCad grid. Symbol moves/rotations reposition property anchors but do not guarantee readable text placement.
5. Review native validation, then apply the same batch with `dry_run: false`. The hash must still match. Each committed file receives a checkpoint. Re-read the sheet and export/visually inspect SVG or PDF previews; adjust only after another geometry read.
6. Reload external changes in KiCad without overwriting them from a stale editor. PCB synchronization is separate and only on request.

Example footprint assignment (replace placeholders with live values):

    {"path":"/project/main.kicad_sch","expected_source_hash":"<64 hex characters>","dry_run":true,"symbols":[{"uuid":"<instance UUID>","footprint":"Resistor_SMD:R_0603_1608Metric"}]}

## Validation and boundaries

The transaction exports native KiCad XML netlists before/after and compares sorted reference/pin memberships, not net IDs, names or counts. It runs native ERC with all severities and rejects additional findings. It returns baseline/candidate findings, exit codes and ignored check categories. Existing disabled checks remain disabled and are reported; they are not silently enabled or suppressed. No PWR_FLAGs, exclusions or no-connects are inserted automatically.

Only connectivity-preserving edits are supported by this tool. When moving connected symbols, include all required wire/label replacements in the SAME batch; otherwise the transaction is rejected. Use circuit editing tools for intentional electrical changes. Footprint edits never synchronize the PCB automatically.

Native validation uses temporary sibling schematic/project files and copies the same-basename project ERC settings when present. Child-sheet-only validation is not a substitute for validating the root project hierarchy; repeated-sheet context and parent power/port checks require a separate native root ERC/netlist check. Always validate the full project after edits to hierarchical designs.

ERC and netlist preservation do not establish correct timing, startup or intended electrical behavior. Previews require separate visual inspection. The tool does not provide a GUI editor or automatic conventional-wire layout.
