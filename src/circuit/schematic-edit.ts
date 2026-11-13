import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { saveCheckpoint } from '../checkpoints/store';
import { getSupportedKicadCli } from '../kicad/cli';
import { mutateSchematic, applySourceEdits, SourceEdit } from '../kicad/schematic-writer';
import { atom, findChild, listHead, parseSExpression, printSExpression, SExpression, token, isSExpressionList } from '../kicad/sexpr/ast';
import { runProcess, runProcessChecked } from '../utils/process';

export const hashSource = (s: string) => createHash('sha256').update(s).digest('hex');
const scalar = (n: SExpression[], k: string) => atom(findChild(n, k)?.[1]);
export type Point = { x: number; y: number };
export type SchematicEdit = {
    symbols?: { uuid: string; footprint?: string; position?: Point; angle?: number }[];
    remove?: string[];
    wires?: { points: Point[] }[];
    junctions?: Point[];
};
// Retain untouched source bytes, including embedded library definitions.
export function schematicItems(source: string) {
    const root = parseSExpression(source);
    if (listHead(root) !== 'kicad_sch') throw new Error('expected kicad_sch');
    const ranges: { start: number; end: number; node: SExpression[] }[] = [];
    let depth = 0, start = 0, quoted = false, escaped = false, comment = false;
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (comment) { if (c === '\n') comment = false; continue; }
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
            continue;
        }
        if (c === ';') { comment = true; continue; }
        if (c === '"') { quoted = true; continue; }
        if (c === '(') { if (depth === 1) start = i; depth++; }
        if (c === ')') { depth--; if (depth === 1) ranges.push({ start, end: i + 1, node: parseSExpression(source.slice(start, i + 1)) }); }
    }
    return ranges;
}
export async function getSchematicGeometry(path: string) {
    const source = await readFile(resolve(path), 'utf8');
    return { source_hash: hashSource(source), units: 'mm', items: schematicItems(source)
        .filter(i => ['symbol', 'wire', 'junction', 'label', 'global_label', 'hierarchical_label', 'no_connect'].includes(listHead(i.node)!))
        .map(i => ({ uuid: scalar(i.node, 'uuid'), kind: listHead(i.node), sexpr: printSExpression(i.node) })) };
}

export function editSchematicSource(source: string, edit: SchematicEdit) {
    const items = schematicItems(source);
    const edits: SourceEdit[] = [], touched = new Set<string>();
    const select = (id: string) => {
        if (touched.has(id)) throw new Error(`duplicate target: ${id}`);
        touched.add(id);
        const matches = items.filter(i => scalar(i.node, 'uuid') === id);
        if (matches.length !== 1) throw new Error(`not one top-level item: ${id}`);
        return matches[0];
    };
    const number = (n: number) => {
        if (!Number.isFinite(n)) throw new Error('non-finite coordinate');
        return token(String(Math.round(n * 1e6) / 1e6));
    };
    for (const change of edit.symbols || []) {
        const item = select(change.uuid), n = item.node;
        if (listHead(n) !== 'symbol' || !findChild(n, 'lib_id')) throw new Error('expected symbol instance');
        if (findChild(n, 'locked')) throw new Error('locked symbol');
        const at = findChild(n, 'at');
        if (!at) throw new Error('missing symbol position');
        const ox = Number(atom(at[1])), oy = Number(atom(at[2]));
        const x = change.position?.x ?? ox, y = change.position?.y ?? oy;
        const oldAngle = Number(atom(at[3]) || 0), angle = change.angle ?? oldAngle;
        if (![0, 90, 180, 270].includes(angle)) throw new Error('angle must be 0, 90, 180 or 270');
        const moving = change.position !== undefined || change.angle !== undefined;
        if (moving) at.splice(1, 3, number(x), number(y), number(angle));
        // Rotate field anchors about the symbol; keep their text orientation readable.
        const a = (angle - oldAngle) * Math.PI / 180;
        for (const p of n.filter((v): v is SExpression[] => listHead(v) === 'property')) {
            const pa = findChild(p, 'at');
            if (!pa || !moving) continue;
            const dx = Number(atom(pa[1])) - ox, dy = Number(atom(pa[2])) - oy;
            pa.splice(1, 2, number(x + dx * Math.cos(a) + dy * Math.sin(a)), number(y - dx * Math.sin(a) + dy * Math.cos(a)));
        }
        if (change.footprint !== undefined) {
            if (/[\r\n]/.test(change.footprint) || (change.footprint !== '' && !/^[^:]+:[^:]+$/.test(change.footprint))) throw new Error('expected Library:Footprint or empty string');
            const props = n.filter((v): v is SExpression[] => listHead(v) === 'property' && atom((v as SExpression[])[1]) === 'Footprint');
            if (props.length > 1) throw new Error('ambiguous Footprint property');
            if (props[0]) props[0][2] = token(change.footprint, true);
            else n.push(parseSExpression(`(property "Footprint" ${printSExpression(token(change.footprint, true))} (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) hide))`));
        }
        edits.push({ ...item, text: printSExpression(n) });
    }
    for (const id of edit.remove || []) {
        const item = select(id);
        if (!['wire', 'junction', 'label', 'global_label', 'hierarchical_label', 'no_connect'].includes(listHead(item.node)!)) throw new Error('only wires, junctions, labels and no-connects may be removed');
        edits.push({ ...item, text: '' });
    }
    const additions: string[] = [], ids: string[] = [];
    const add = (text: string) => { const id = randomUUID(); ids.push(id); additions.push(text.replace('@UUID@', id)); };
    const xy = (p: Point) => `${number(p.x).value} ${number(p.y).value}`;
    for (const wire of edit.wires || []) {
        if (wire.points.length < 2) throw new Error('wire needs at least two points');
        for (let i = 1; i < wire.points.length; i++) {
            const a = wire.points[i - 1], b = wire.points[i];
            if (xy(a) === xy(b) || (a.x !== b.x && a.y !== b.y)) throw new Error('wire segments must be nonzero and orthogonal');
            add(`(wire (pts (xy ${xy(a)}) (xy ${xy(b)})) (stroke (width 0) (type default)) (uuid "@UUID@"))`);
        }
    }
    for (const p of edit.junctions || []) add(`(junction (at ${xy(p)}) (diameter 0) (color 0 0 0 0) (uuid "@UUID@"))`);
    if (additions.length) {
        const end = source.lastIndexOf(')');
        edits.push({ start: end, end, text: additions.join('\n') + '\n' });
    }
    return { source: applySourceEdits(source, edits), added_uuids: ids };
}

const array = (v: any): any[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
export function netMemberships(xml: string) {
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false }).parse(xml);
    if (!doc.export || !Object.hasOwn(doc.export, 'nets')) throw new Error('missing native netlist nets');
    return array(doc.export.nets?.net).map(n => array(n.node)
        .map(p => {
            if (p.ref === undefined || p.pin === undefined) throw new Error('invalid native netlist node');
            return JSON.stringify([String(p.ref), String(p.pin)]);
        }).sort().join('|')).sort();
}
async function validateEdit(target: string, before: string, after: string) {
    const cli = await getSupportedKicadCli();
    const stem = join(dirname(target), `.schematic-edit-${randomUUID()}`);
    const sch = stem + '.kicad_sch', net = stem + '.xml', report = stem + '.json', pro = stem + '.kicad_pro';
    // Carry project ERC settings into the temporary native validation project.
    const project = await readFile(target.replace(/\.kicad_sch$/i, '.kicad_pro'), 'utf8').catch((e) => {
        if (e.code !== 'ENOENT') throw e;
        return undefined;
    });
    try {
        if (project !== undefined) await writeFile(pro, project, { flag: 'wx' });
        const inspect = async (source: string) => {
            await writeFile(sch, source);
            await rm(net, { force: true });
            await rm(report, { force: true });
            await runProcessChecked(cli.path, ['sch', 'export', 'netlist', '--format', 'kicadxml', '--output', net, sch], { timeoutMs: 60000 });
            const memberships = netMemberships(await readFile(net, 'utf8'));
            const result = await runProcess(cli.path, ['sch', 'erc', '--format', 'json', '--severity-all', '--exit-code-violations', '--output', report, sch], { timeoutMs: 60000 });
            if (![0, 5].includes(result.exitCode)) throw new Error(`native ERC failed: ${result.stderr || result.stdout}`);
            const erc = JSON.parse(await readFile(report, 'utf8'));
            if (!Array.isArray(erc.sheets) || erc.sheets.some((s: any) => !Array.isArray(s.violations))) throw new Error('invalid ERC report');
            const findings = erc.sheets.flatMap((s: any) => s.violations);
            return { memberships, exit_code: result.exitCode, findings, ignored_checks: erc.ignored_checks };
        };
        return { before: await inspect(before), after: await inspect(after) };
    } finally {
        await Promise.all([sch, net, report, pro].map(p => rm(p, { force: true })));
    }
}
export async function editSchematic(path: string, edit: SchematicEdit, expectedHash: string, dryRun = false) {
    const target = resolve(path);
    if (!/\.kicad_sch$/i.test(target)) throw new Error('expected exact .kicad_sch path');
    let result: any;
    await mutateSchematic(target, async original => {
        if (hashSource(original) !== expectedHash) throw new Error('stale source hash');
        const candidate = editSchematicSource(original, edit);
        if (candidate.source === original) { result = { status: 'unchanged' }; return original; }
        const validation = await validateEdit(target, original, candidate.source);
        const connectivityPreserved = JSON.stringify(validation.before.memberships) === JSON.stringify(validation.after.memberships);
        const key = (f: any) => JSON.stringify([f.type, f.severity, array(f.items).map(i => i.uuid).sort()]);
        const baseline = validation.before.findings.map(key);
        const regressions = validation.after.findings.filter((f: any) => {
            const i = baseline.indexOf(key(f));
            if (i < 0) return true;
            baseline.splice(i, 1); return false;
        });
        result = { status: 'rejected', connectivity_preserved: connectivityPreserved, erc: validation,
            added_findings: regressions, added_uuids: candidate.added_uuids, before_hash: expectedHash };
        if (!connectivityPreserved || regressions.length) return original;
        if (hashSource(await readFile(target, 'utf8')) !== expectedHash) throw new Error('file changed during validation');
        if (dryRun) { result.status = 'dry_run'; return original; }
        result.checkpoint_id = await saveCheckpoint(target, 'Before edit_schematic', expectedHash);
        result.status = 'applied';
        result.after_hash = hashSource(candidate.source);
        return candidate.source;
    });
    return { ...result, reminder: 'Reload external changes in KiCad. PCB is not synchronized. ERC and preserved connectivity do not prove circuit function.' };
}
