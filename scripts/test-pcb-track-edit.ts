import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteTrackNodes, getPcbTracks, deletePcbTracks, trackEditRegression } from '../src/pcb/track-edit';
import { atomicWritePcb, parsePcbSource, serializePcb } from '../src/kicad/pcb-writer';
import { assertTrackEditReport } from '../src/kicad/pcb-validation';
import { restoreCheckpoint, saveCheckpoint } from '../src/checkpoints/store';

const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const segment = (id: string, extra = '') => `(segment (start 10 10) (end 10.05 10) (width 0.2) (layer "F.Cu") (net 1) (uuid "${id}") ${extra})`;
const board = `(kicad_pcb ${segment(a)} ${segment(b)} (via (uuid "cccccccc-cccc-4ccc-8ccc-cccccccccccc")))`;
const root = parsePcbSource(board);
const edited = deleteTrackNodes(root, [a]);
assert.equal(edited.removed.length, 1);
assert.ok(!serializePcb(edited.root).includes(a));
assert.ok(serializePcb(edited.root).includes(b));
assert.equal(deleteTrackNodes(root, [a, b]).removed.length, 2);
for (const ids of [[], [a, a], ['missing'], ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']]) {
    assert.throws(() => deleteTrackNodes(root, ids));
}
for (const extra of ['locked', '(locked yes)']) {
    assert.throws(() => deleteTrackNodes(parsePcbSource(`(kicad_pcb ${segment(a, extra)})`), [a]), /locked/);
}
assert.throws(() => deleteTrackNodes(parsePcbSource(`(kicad_pcb ${segment(a)} (group "x" (members "${a}")))`), [a]), /grouped/);
assert.throws(() => deleteTrackNodes(parsePcbSource(`(kicad_pcb ${segment(a)} ${segment(a)})`), [a]));
const empty = { violations: [], unconnected_items: [] };
for (const report of [{}, null, { violations: [] }, { violations: [null], unconnected_items: [] }]) {
    assert.throws(() => assertTrackEditReport(report));
}
const error = { type: 'clearance', severity: 'error', items: [{ uuid: a }, { uuid: b }] };
const disconnect = { ...error, type: 'unconnected_items' };
assert.equal(trackEditRegression(empty, { violations: [error], unconnected_items: [] }).errors.length, 1);
assert.equal(trackEditRegression({ violations: [error], unconnected_items: [] }, { violations: [error], unconnected_items: [disconnect] }).unconnected.length, 1);
assert.equal(trackEditRegression({ violations: [error], unconnected_items: [] }, { violations: [{ ...error, items: [...error.items].reverse() }], unconnected_items: [] }).errors.length, 0);

const directory = await mkdtemp(join(tmpdir(), 'track-edit-'));
try {
    const path = join(directory, 'board.kicad_pcb');
    await writeFile(path, board);
    const listed = await getPcbTracks(path);
    assert.equal(listed.tracks.length, 2);
    await assert.rejects(deletePcbTracks(path, [a], true, '0'.repeat(64)), /stale/);
    assert.equal(await readFile(path, 'utf8'), board);
    const checkpoint = await saveCheckpoint(path, 'track edit test');
    await atomicWritePcb(path, board, edited.root);
    assert.equal((await getPcbTracks(path)).tracks.length, 1);
    await assert.rejects(atomicWritePcb(path, board, root), /changed/);
    assert.deepEqual(await readdir(directory), ['board.kicad_pcb']);
    await restoreCheckpoint(path, checkpoint);
    assert.equal(await readFile(path, 'utf8'), board);
    if (process.platform !== 'win32') {
        // Exercise the actual transaction and child-process boundary without a KiCad install.
        const cli = join(directory, 'fake-cli');
        await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('10.0.0'); process.exit(0); }
const mode = process.env.TRACK_TEST_MODE;
if (mode === 'fail') process.exit(2);
const reportPath = args[args.indexOf('--output') + 1];
if (mode === 'missing') process.exit(0);
if (mode === 'malformed') { fs.writeFileSync(reportPath, 'invalid'); process.exit(0); }
const source = fs.readFileSync(args.at(-1), 'utf8');
const absent = !source.includes('${a}');
const report = { violations: [], unconnected_items: [] };
if (mode === 'disconnect' && absent) report.unconnected_items.push({ type: 'unconnected_items', severity: 'error', items: [{ uuid: '${b}' }] });
if (!absent) report.violations.push({ type: 'track_dangling', severity: 'warning', items: [{ uuid: '${a}' }] });
fs.writeFileSync(reportPath, JSON.stringify(report));
process.exit(report.violations.length || report.unconnected_items.length ? 5 : 0);
`);
        await chmod(cli, 0o700);
        const oldCli = process.env.KICAD_CLI_PATH;
        process.env.KICAD_CLI_PATH = cli;
        try {
            const dry = await deletePcbTracks(path, [a], true);
            assert.equal(dry.status, 'dry_run');
            assert.equal(await readFile(path, 'utf8'), board);
            for (const mode of ['fail', 'missing', 'malformed']) {
                process.env.TRACK_TEST_MODE = mode;
                await assert.rejects(deletePcbTracks(path, [a]));
                assert.equal(await readFile(path, 'utf8'), board);
            }
            process.env.TRACK_TEST_MODE = 'disconnect';
            assert.equal((await deletePcbTracks(path, [a])).status, 'rejected');
            assert.equal(await readFile(path, 'utf8'), board);
            delete process.env.TRACK_TEST_MODE;
            const applied = await deletePcbTracks(path, [a]);
            assert.equal(applied.status, 'applied');
            assert.equal(applied.drc.before.warnings, 1);
            assert.equal(applied.drc.after.warnings, 0);
            assert.equal((await getPcbTracks(path)).tracks.length, 1);
        } finally {
            delete process.env.TRACK_TEST_MODE;
            if (oldCli === undefined) delete process.env.KICAD_CLI_PATH;
            else process.env.KICAD_CLI_PATH = oldCli;
        }
    }
    console.log('Track edit unit, atomic writer, checkpoint and mocked CLI transaction tests: ok');
} finally {
    await rm(directory, { recursive: true, force: true });
}
