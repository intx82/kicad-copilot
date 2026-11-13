import { readFile, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { atom, findChild, isSExpressionList, listHead, parseSExpression, SExpression, token } from '../kicad/sexpr/ast';
import { librarySymbolPins, librarySymbolProperties } from '../kicad/symbol';

export const isLocalPart = (id: string) => id.startsWith('kicad:');
type Library = { name: string; path: string };
const children = (root: SExpression[], head: string) => root.filter((x): x is SExpression[] => isSExpressionList(x) && listHead(x) === head);
const cache = new Map<string, Promise<SExpression[]>>();
async function load(path: string) {
    let pending = cache.get(path);
    if (!pending) {
        pending = (async () => {
            if (!path.endsWith('.kicad_symdir')) return parseSExpression(await readFile(path, 'utf8'));
            const names = (await readdir(path)).filter((name) => name.endsWith('.kicad_sym')).sort();
            const root: SExpression[] = [token('kicad_symbol_lib')];
            for (const name of names) {
                root.push(...children(parseSExpression(await readFile(join(path, name), 'utf8')), 'symbol'));
            }
            return root;
        })();
        cache.set(path, pending);
        pending.catch(() => cache.delete(path));
    }
    return pending;
}

async function libraries(projectPath?: string): Promise<Library[]> {
    const project = projectPath ? dirname(resolve(projectPath)) : process.cwd();
    const env = process.env;
    const roots = [
        ...(env.KICAD_SYMBOL_DIR || '').split(delimiter),
        ...Object.entries(env).filter(([key]) => /^KICAD\d+_SYMBOL_DIR$/.test(key)).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true })).map(([, value]) => value || ''),
        ...(env.KICAD_CLI_PATH ? [resolve(dirname(env.KICAD_CLI_PATH), '../share/kicad/symbols')] : []),
        '/usr/share/kicad/symbols', '/usr/local/share/kicad/symbols',
        '/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols',
        ...(env.ProgramFiles ? [join(env.ProgramFiles, 'KiCad/9.0/share/kicad/symbols')] : []),
    ].filter(Boolean);
    // AppImage libraries are mounted, not installed under /usr/share.
    for (const entry of await readdir(tmpdir(), { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && entry.name.startsWith('.mount_kicad')) {
            roots.push(join(tmpdir(), entry.name, 'share/kicad/symbols'));
        }
    }
    const availableRoots: string[] = [];
    for (const root of roots) {
        if (await readdir(root).then(() => true, () => false)) availableRoots.push(root);
    }
    const variables: Record<string, string | undefined> = { ...env, KIPRJMOD: project };
    for (const version of [10, 9, 8, 7, 6]) variables[`KICAD${version}_TEMPLATE_DIR`] ??= availableRoots[0] ? resolve(availableRoots[0], '../template') : undefined;
    for (const version of [10, 9, 8, 7, 6]) variables[`KICAD${version}_SYMBOL_DIR`] ??= availableRoots[0];
    const expand = (value: string) => value.replace(/\$\{([^}]+)\}/g, (match, key) => variables[key] || match);
    const configs = env.KICAD_CONFIG_HOME ? [env.KICAD_CONFIG_HOME] : [
        join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kicad'),
        join(homedir(), 'Library/Preferences/kicad'),
        ...(env.APPDATA ? [join(env.APPDATA, 'kicad')] : []),
    ];
    const tables = [join(project, 'sym-lib-table')];
    for (const config of configs) {
        for (const version of ['10.0', '9.0', '8.0', '7.0', '6.0', '']) tables.push(join(config, version, 'sym-lib-table'));
    }
    const found = new Map<string, Library>();
    const visitedTables = new Set<string>();
    async function readTable(table: string) {
        table = resolve(table);
        if (visitedTables.has(table)) return;
        visitedTables.add(table);
        let source: string;
        try { source = await readFile(table, 'utf8'); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        for (const entry of children(parseSExpression(source), 'lib')) {
            const type = atom(findChild(entry, 'type')?.[1]);
            const name = atom(findChild(entry, 'name')?.[1]);
            const uri = atom(findChild(entry, 'uri')?.[1]);
            if (!uri) continue;
            const path = resolve(dirname(table), expand(uri));
            if (type === 'Table') await readTable(path);
            else if (type === 'KiCad' && name && !found.has(name)) found.set(name, { name, path });
        }
    }
    for (const table of tables) await readTable(table);
    for (const root of [...new Set(availableRoots)]) {
        const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const suffix = entry.name.endsWith('.kicad_symdir') ? '.kicad_symdir' : '.kicad_sym';
            if (!entry.name.endsWith(suffix)) continue;
            if (suffix === '.kicad_symdir' ? (!entry.isDirectory() && !entry.isSymbolicLink()) : (!entry.isFile() && !entry.isSymbolicLink())) continue;
            const name = basename(entry.name, suffix);
            if (!found.has(name)) found.set(name, { name, path: join(root, entry.name) });
        }
    }
    return [...found.values()];
}

function flatten(root: SExpression[], name: string, chain: string[] = []): SExpression[] {
    if (chain.includes(name)) throw new Error(`Cyclic KiCad symbol inheritance: ${[...chain, name].join(' -> ')}`);
    const source = children(root, 'symbol').find((x) => atom(x[1]) === name);
    if (!source) throw new Error(`KiCad symbol not found: ${name}`);
    const symbol = structuredClone(source);
    const parent = atom(findChild(symbol, 'extends')?.[1]);
    if (!parent) return symbol;
    const base = flatten(root, parent, [...chain, name]);
    const overridden = new Set(children(symbol, 'property').map((x) => atom(x[1])));
    const heads = new Set(symbol.slice(2).filter(isSExpressionList).map(listHead).filter((x) => x !== 'property' && x !== 'extends' && x !== 'symbol'));
    const inherited = base.slice(2).filter((x) => !isSExpressionList(x)
        || (listHead(x) === 'property' ? !overridden.has(atom(x[1])) : !heads.has(listHead(x))));
    for (const child of inherited) {
        if (isSExpressionList(child) && listHead(child) === 'symbol') {
            const nested = atom(child[1]) || '';
            child[1] = token(nested.replace(`${parent}_`, `${name}_`), true);
        }
    }
    return [symbol[0], symbol[1], ...inherited, ...symbol.slice(2).filter((x) => !isSExpressionList(x) || listHead(x) !== 'extends')];
}

export async function findLocalComponents(query: string, projectPath?: string) {
    const explicit = isLocalPart(query);
    const id = explicit ? query.slice(6) : query;
    const colon = id.indexOf(':');
    const nickname = colon >= 0 ? id.slice(0, colon) : undefined;
    const name = colon >= 0 ? id.slice(colon + 1) : id;
    const matches = [];
    for (const lib of await libraries(projectPath)) {
        if (nickname && lib.name !== nickname) continue;
        const root = await load(lib.path);
        for (const entry of children(root, 'symbol')) {
            const symbolName = atom(entry[1]) || '';
            if (symbolName.toLowerCase() !== name.toLowerCase()) continue;
            const symbol = flatten(root, symbolName);
            const properties = librarySymbolProperties(symbol);
            matches.push({
                source: 'local' as const,
                part_uuid: `kicad:${lib.name}:${symbolName}`,
                lib_id: `${lib.name}:${symbolName}`,
                library_path: lib.path,
                symbol_name: symbolName,
                properties,
                pins: librarySymbolPins(symbol).map((pin) => ({ pin_number: pin.number, name: pin.name })),
                symbol,
            });
        }
    }
    return matches;
}

export async function loadLocalComponent(id: string, projectPath?: string) {
    const [match] = await findLocalComponents(id, projectPath);
    if (!match) throw new Error(`Local KiCad component not found: ${id}`);
    // Unique, filesystem-safe symbol name in the generated project library.
    const { createHash } = await import('node:crypto');
    const symbol = structuredClone(match.symbol);
    const name = `local_${createHash('sha256').update(match.lib_id).digest('hex').slice(0, 16)}`;
    symbol[1] = token(name, true);
    for (const child of children(symbol, 'symbol')) {
        child[1] = token((atom(child[1]) || '').replace(`${match.symbol_name}_`, `${name}_`), true);
    }
    return { part_uuid: id, product_code: '', symbol_file: match.library_path,
        symbol_name: name, symbol, properties: match.properties, source: 'local' as const };
}
