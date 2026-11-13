import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { saveCheckpoint } from '../checkpoints/store';
import { atomicWritePcb, fileHash, parsePcbSource, serializePcb, sourceHash } from '../kicad/pcb-writer';
import { assertTrackEditReport, inspectTrackEditCandidate, TrackEditFinding, TrackEditReport } from '../kicad/pcb-validation';
import { atom, findChild, isSExpressionList, listHead, SExpression, visitSExpression } from '../kicad/sexpr/ast';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scalar = (node: SExpression[], key: string) => atom(findChild(node, key)?.[1]);
const tracks = (root: SExpression[]) => root.filter((node): node is SExpression[] => listHead(node) === 'segment');
function metadata(node: SExpression[]) {
    const pair = (key: string) => findChild(node, key)?.slice(1).map(atom);
    return { uuid: scalar(node, 'uuid'), start: pair('start'), end: pair('end'),
        width: scalar(node, 'width'), layer: scalar(node, 'layer'), net: pair('net'),
        locked: node.some(item => atom(item) === 'locked') || !!findChild(node, 'locked') };
}
export async function getPcbTracks(path: string) {
    const source = await readFile(resolve(path), 'utf8');
    return { source_hash: sourceHash(source), tracks: tracks(parsePcbSource(source)).map(metadata) };
}
export function deleteTrackNodes(root: SExpression[], uuids: string[]) {
    if (!uuids.length || uuids.length > 100 || uuids.some(id => !uuidPattern.test(id))
        || new Set(uuids.map(id => id.toLowerCase())).size !== uuids.length) {
        throw new Error('provide 1..100 unique track UUIDs');
    }
    const selected = new Set<SExpression[]>();
    for (const id of uuids) {
        const matches: SExpression[][] = [];
        visitSExpression(root, node => {
            if (scalar(node, 'uuid')?.toLowerCase() === id.toLowerCase()) matches.push(node);
        });
        const node = matches[0];
        if (matches.length !== 1 || !tracks(root).includes(node)) throw new Error(`not one top-level straight segment: ${id}`);
        if (metadata(node).locked) throw new Error(`locked track: ${id}`);
        visitSExpression(root, item => {
            if (listHead(item) === 'members' && item.slice(1).some(value => atom(value)?.toLowerCase() === id.toLowerCase())) {
                throw new Error(`grouped track: ${id}`);
            }
        });
        selected.add(node);
    }
    return { root: root.filter(item => !selected.has(item as SExpression[])), removed: [...selected].map(metadata) };
}

function findingKey(item: TrackEditFinding) {
    return JSON.stringify([item.type, item.items.map(subject => subject.uuid || JSON.stringify(subject)).sort()]);
}
function added(before: TrackEditFinding[], after: TrackEditFinding[]) {
    const remaining = before.map(findingKey);
    return after.filter(item => {
        const index = remaining.indexOf(findingKey(item));
        if (index < 0) return true;
        remaining.splice(index, 1);
        return false;
    });
}
export function trackEditRegression(before: TrackEditReport, after: TrackEditReport) {
    assertTrackEditReport(before);
    assertTrackEditReport(after);
    return { errors: added(before.violations.filter(item => item.severity === 'error'), after.violations.filter(item => item.severity === 'error')),
        unconnected: added(before.unconnected_items, after.unconnected_items) };
}

// Native refill may change cached copper only; reject any other normalization.
function invariant(root: SExpression[]) {
    const clean = (node: SExpression): SExpression => {
        if (!isSExpressionList(node)) return node;
        const children = node.filter(child => !['filled_polygon', 'fill_segments'].includes(listHead(child) || '')).map(clean);
        // KiCad reorders fields on save; atom order inside coordinates remains significant.
        return [...children.filter(child => !isSExpressionList(child)),
            ...children.filter(isSExpressionList).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))];
    };
    return JSON.stringify(clean(root));
}
export async function deletePcbTracks(path: string, uuids: string[], dryRun = false, expectedSourceHash?: string) {
    const target = resolve(path);
    if (!/\.kicad_pcb$/i.test(target)) throw new Error('expected .kicad_pcb path');
    const source = await readFile(target, 'utf8');
    const beforeHash = sourceHash(source);
    if (expectedSourceHash && expectedSourceHash !== beforeHash) throw new Error('stale source hash');
    const original = parsePcbSource(source);
    const edit = deleteTrackNodes(original, uuids);
    const before = await inspectTrackEditCandidate(target, original);
    const after = await inspectTrackEditCandidate(target, edit.root);
    if (invariant(original) !== invariant(before.root) || invariant(edit.root) !== invariant(after.root)) {
        throw new Error('native validation changed geometry or non-fill metadata; edit not applied');
    }
    const regression = trackEditRegression(before.report, after.report);
    const counts = (report: TrackEditReport) => ({
        errors: report.violations.filter(item => item.severity === 'error').length,
        warnings: report.violations.filter(item => item.severity === 'warning').length,
        unconnected: report.unconnected_items.length,
    });
    const result = { removed: edit.removed, before_hash: beforeHash,
        drc: { before: counts(before.report), after: counts(after.report), regression,
            baseline_exit_code: before.exit_code, candidate_exit_code: after.exit_code },
        reports: { before: before.report, after: after.report } };
    if (await fileHash(target) !== beforeHash) throw new Error('file changed during operation');
    if (regression.errors.length || regression.unconnected.length) return { ...result, status: 'rejected' };
    if (dryRun) return { ...result, status: 'dry_run' };
    const checkpoint = await saveCheckpoint(target, 'Before delete_pcb_tracks', beforeHash);
    await atomicWritePcb(target, source, after.root);
    const afterHash = await fileHash(target);
    if (afterHash !== sourceHash(serializePcb(after.root))) {
        throw new Error(`post-commit file changed; inspect board and checkpoint ${checkpoint}`);
    }
    return { ...result, status: 'applied', checkpoint_id: checkpoint, after_hash: afterHash,
        reminder: 'Reload the PCB from disk; do not overwrite it from a stale editor.' };
}
