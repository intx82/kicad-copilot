import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editSchematicSource, editSchematic, getSchematicGeometry, netMemberships } from '../src/circuit/schematic-edit';
import { parseSExpression, printSExpression } from '../src/kicad/sexpr/ast';
import { restoreCheckpoint } from '../src/checkpoints/store';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const wid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const lib = '(lib_symbols (symbol "Example" (property "Footprint" "unchanged")))';
const source = `(kicad_sch ${lib}\n(symbol (lib_id "Example") (at 10 20 0) (uuid "${id}") (property "Reference" "R1" (at 12 20 0)) (property "Footprint" "Old:X"))\n(wire (pts (xy 10 20) (xy 10 25)) (uuid "${wid}")))`;
const footprint = { symbols: [{ uuid: id, footprint: 'Resistor_SMD:R_0603_1608Metric' }] };
const edited = editSchematicSource(source, footprint);
assert.ok(edited.source.includes(lib));
assert.ok(edited.source.includes('(at 10 20 0)'));
assert.ok(edited.source.includes(`(uuid "${id}")`));
assert.ok(edited.source.includes('Resistor_SMD:R_0603_1608Metric'));
const moved = editSchematicSource(source, { symbols: [{ uuid: id, position: { x: 30, y: 40 }, angle: 90 }], remove: [wid], wires: [{ points: [{ x: 30, y: 40 }, { x: 30, y: 45 }] }], junctions: [{ x: 30, y: 40 }] });
assert.ok(moved.source.includes('(at 30 40 90)'));
assert.ok(moved.source.includes('(at 30 38 0)'));
assert.ok(!moved.source.includes(wid));
assert.equal(moved.added_uuids.length, 2);
parseSExpression(moved.source);
assert.throws(() => editSchematicSource(source, { remove: [id] }));
assert.throws(() => editSchematicSource(source, { remove: [wid, wid] }));
assert.throws(() => editSchematicSource(source, { wires: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] }));
assert.throws(() => editSchematicSource(source, { symbols: [{ uuid: id, footprint: 'invalid' }] }));
assert.deepEqual(netMemberships('<export><nets><net code="1"><node ref="R1" pin="2"/><node ref="R2" pin="1"/></net></nets></export>'), netMemberships('<export><nets><net code="99"><node ref="R2" pin="1"/><node ref="R1" pin="2"/></net></nets></export>'));
const dir = await mkdtemp(join(tmpdir(), 'schematic-edit-test-'));
try {
    const path = join(dir, 'test.kicad_sch');
    await writeFile(path, source);
    const geometry = await getSchematicGeometry(path);
    assert.equal(geometry.items.length, 2);
    await assert.rejects(editSchematic(path, footprint, '0'.repeat(64)), /stale/);
    if (process.platform !== 'win32' && !process.env.SCHEMATIC_EDIT_NATIVE_PATH) {
        const cli = join(dir, 'fake-cli');
        await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('10.0.1'); process.exit(0); }
const output = args[args.indexOf('--output') + 1];
const changed = fs.readFileSync(args.at(-1), 'utf8').includes('Resistor_SMD');
const mode = process.env.SCHEMATIC_EDIT_TEST_MODE;
if (mode === 'fail') process.exit(2);
if (args[1] === 'export') {
 fs.writeFileSync(output, '<export><nets><net><node ref="R1" pin="' + (changed && mode === 'short' ? '2' : '1') + '"/></net></nets></export>');
} else {
 const violations = changed && mode === 'erc' ? [{type:'new_error',severity:'error',items:[]}] : [];
 fs.writeFileSync(output, JSON.stringify({sheets:[{violations}],ignored_checks:[]}));
 process.exit(violations.length ? 5 : 0);
}
`);
        await chmod(cli, 0o700);
        const old = process.env.KICAD_CLI_PATH;
        process.env.KICAD_CLI_PATH = cli;
        try {
            for (const mode of ['short', 'erc']) {
                process.env.SCHEMATIC_EDIT_TEST_MODE = mode;
                assert.equal((await editSchematic(path, footprint, geometry.source_hash)).status, 'rejected');
                assert.equal(await readFile(path, 'utf8'), source);
            }
            process.env.SCHEMATIC_EDIT_TEST_MODE = 'fail';
            await assert.rejects(editSchematic(path, footprint, geometry.source_hash));
            delete process.env.SCHEMATIC_EDIT_TEST_MODE;
            assert.equal((await editSchematic(path, footprint, geometry.source_hash, true)).status, 'dry_run');
            assert.equal(await readFile(path, 'utf8'), source);
            const applied = await editSchematic(path, footprint, geometry.source_hash);
            assert.equal(applied.status, 'applied');
            assert.equal(await readFile(path, 'utf8'), edited.source);
            await restoreCheckpoint(path, applied.checkpoint_id);
            assert.equal(await readFile(path, 'utf8'), source);
        } finally {
            if (old === undefined) delete process.env.KICAD_CLI_PATH; else process.env.KICAD_CLI_PATH = old;
            delete process.env.SCHEMATIC_EDIT_TEST_MODE;
        }
    }
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('Schematic edit source and transaction tests passed. Native KiCad not exercised by this test.');

if (process.env.SCHEMATIC_EDIT_NATIVE_PATH) {
    const path = process.env.SCHEMATIC_EDIT_NATIVE_PATH;
    const geometry = await getSchematicGeometry(path);
    const subject = geometry.items.find(i => i.kind === 'symbol' && i.sexpr.includes('(property "Reference" "R1"'));
    assert.ok(subject?.uuid, 'native test needs a symbol');
    const original = await readFile(path, 'utf8');
    const probe = await editSchematic(path, { symbols: [{ uuid: subject.uuid, footprint: 'Resistor_SMD:R_0603_1608Metric' }] }, geometry.source_hash, true);
    assert.equal(probe.status, 'dry_run', JSON.stringify(probe));
    assert.equal(probe.connectivity_preserved, true);
    assert.equal(await readFile(path, 'utf8'), original);
    const wire = geometry.items.find(i => {
        if (i.kind !== 'wire') return false;
        const p = [...i.sexpr.matchAll(/\(xy ([\d.-]+) ([\d.-]+)\)/g)].map(m => [Number(m[1]), Number(m[2])]);
        return p.length === 2 && (p[0][0] === p[1][0] || p[0][1] === p[1][1]) && JSON.stringify(p[0]) !== JSON.stringify(p[1]);
    });
    assert.ok(wire?.uuid, 'native test needs a wire');
    const coords = [...wire.sexpr.matchAll(/\(xy ([\d.-]+) ([\d.-]+)\)/g)].map(m => ({ x: Number(m[1]), y: Number(m[2]) }));
    assert.equal(coords.length, 2);
    const wiring = await editSchematic(path, { remove: [wire.uuid], wires: [{ points: coords }] }, geometry.source_hash, true);
    assert.equal(wiring.status, 'dry_run', JSON.stringify(wiring));
    assert.equal(wiring.connectivity_preserved, true);
    assert.equal(await readFile(path, 'utf8'), original);
    console.log('Native KiCad footprint and wire-replacement dry-runs passed: pin-net preservation, ERC non-regression, original file unchanged.');
}
