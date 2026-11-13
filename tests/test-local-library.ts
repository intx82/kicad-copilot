import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchComponent } from '../src/components/search';
import { loadLocalComponent } from '../src/components/local-library';
import { convertComponent } from '../src/components/converter';
import { projectFootprintId } from '../src/components/project-library';
import { assembleCircuit } from '../src/circuit/local-assembly';
import { CircuitAssembly, CircuitMod, CircuitModStruct } from '../src/types/circuit';
import { librarySymbolPins } from '../src/kicad/symbol';

const directory = await mkdtemp(join(tmpdir(), 'kicad-local-test-'));
const original = process.env.KICAD_SYMBOL_DIR;
try {
    process.env.KICAD_SYMBOL_DIR = directory;
    await writeFile(join(directory, 'Transistor_BJT.kicad_sym'), `(kicad_symbol_lib (version 20231120) (generator test)
      (symbol "Base" (property "Reference" "Q" (at 0 0 0))
        (property "Footprint" "Package_TO_SOT_THT:TO-92_Inline" (at 0 0 0))
        (symbol "Base_1_1" (pin input line (at 0 0 0) (length 2.54) (name "B") (number "1"))))
      (symbol "2N3904" (extends "Base") (property "Value" "2N3904" (at 0 0 0)))
      (symbol "CycleA" (extends "CycleB")) (symbol "CycleB" (extends "CycleA")))`);
    let calls = 0;
    const sentinel = { remote: true, unknownShape: ['unchanged'] };
    const remote = async (endpoint: string, payload: unknown) => {
        calls++;
        assert.equal(endpoint, '/v1/mcp-tools/component-search');
        return sentinel;
    };
    const result = await searchComponent({ MPN: '2N3904' }, remote) as any;
    assert.equal(calls, 0);
    assert.equal(result.components[0].part_uuid, 'kicad:Transistor_BJT:2N3904');
    assert.deepEqual(result.components[0].pins, [{ pin_number: '1', name: 'B' }]);
    assert.equal(result.components[0].symbol, undefined);
    assert.strictEqual(await searchComponent({ MPN: 'not-a-symbol' }, remote), sentinel);
    assert.equal(calls, 1);
    await assert.rejects(searchComponent({ part_uuid: 'kicad:Transistor_BJT:missing' }, remote), /not found/);
    assert.equal(calls, 1);
    assert.strictEqual(await searchComponent({ part_uuid: 'a'.repeat(32) }, remote), sentinel);
    assert.equal(calls, 2);
    await assert.rejects(loadLocalComponent('kicad:Transistor_BJT:CycleA'), /Cyclic/);
    const asset = await convertComponent('kicad:Transistor_BJT:2N3904');
    assert.equal(asset.source, 'local');
    assert.equal(librarySymbolPins(asset.symbol)[0].name, 'B');
    assert.equal(projectFootprintId(asset), 'Package_TO_SOT_THT:TO-92_Inline');
    const circuit: CircuitMod = { add_components: [{ designator: 'Q1', value: '2N3904',
        part_uuid: 'kicad:Transistor_BJT:2N3904', pins: [{ pin_number: '1', name: 'B', signal_name: 'BASE' }],
        block_name: 'test', search_query: '2N3904' }], add_reused_blocks: [], rm_components: null,
        external_connect: null, external_rm_connect: null };
    CircuitModStruct().parse(circuit);
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
    try {
        const assembly = await assembleCircuit(circuit, { components: [] }, join(directory, 'test.kicad_sch')) as CircuitAssembly;
        assert.equal(assembly.components[0].part_uuid, circuit.add_components[0].part_uuid);
        assert.equal(assembly.edges.length, 0);
        await assert.rejects(assembleCircuit({ ...circuit, add_components: [{ ...circuit.add_components[0],
            pins: [{ pin_number: '99', name: '?', signal_name: '' }] }] }, { components: [] }, join(directory, 'test.kicad_sch')), /Unknown pin/);
    } finally { globalThis.fetch = oldFetch; }
    const project = join(directory, 'project');
    await mkdir(project);
    await writeFile(join(project, 'sym-lib-table'), `(sym_lib_table (lib (name "Custom") (type "KiCad") (uri "\${KIPRJMOD}/../Transistor_BJT.kicad_sym")))`);
    const custom = await searchComponent({ MPN: 'Custom:2N3904', path: join(project, 'test.kicad_sch') }, remote) as any;
    assert.equal(custom.components[0].part_uuid, 'kicad:Custom:2N3904');
    console.log('PASS: local-first search, opaque remote fallback, inheritance, local conversion, offline assembly, pin validation, project tables');
} finally {
    if (original === undefined) delete process.env.KICAD_SYMBOL_DIR;
    else process.env.KICAD_SYMBOL_DIR = original;
    await rm(directory, { recursive: true, force: true });
}
