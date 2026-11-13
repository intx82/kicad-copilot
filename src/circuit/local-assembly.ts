import { isLocalPart, loadLocalComponent } from '../components/local-library';
import { atom, isSExpressionList, listHead } from '../kicad/sexpr/ast';
import { CircuitAssembly, CircuitMod, ExplainCircuit } from '../types/circuit';
import { postJson } from '../utils/server';

/** Local deterministic placement; existing writer connects nets with pin labels. */
export async function assembleCircuit(circuit: CircuitMod, input: ExplainCircuit, path: string): Promise<unknown> {
    const local = circuit.add_components.some((c) => isLocalPart(c.part_uuid))
        || input.components.some((c) => c.part_uuid && isLocalPart(c.part_uuid));
    if (!local) return postJson('/v1/mcp-tools/extract-circuit', { circuit, inputCircuit: input });
    if (circuit.add_reused_blocks.length) throw new Error('Remote reusable blocks cannot be combined with local symbols in one operation');
    const components: CircuitAssembly['components'] = [];
    const used = new Set(input.components.map((c) => c.designator));
    for (const [index, component] of circuit.add_components.entries()) {
        if (used.has(component.designator)) throw new Error(`Duplicate component designator: ${component.designator}`);
        used.add(component.designator);
        if (isLocalPart(component.part_uuid)) {
            const asset = await loadLocalComponent(component.part_uuid, path);
            const units = asset.symbol.filter(isSExpressionList).filter((s) => listHead(s) === 'symbol')
                .map((s) => Number((atom(s[1]) || '').match(/_(\d+)_\d+$/)?.[1] || 0));
            if (units.some((unit) => unit > 1)) throw new Error(`Multi-unit local symbol is not yet supported: ${component.part_uuid}`);
            const { librarySymbolPins } = await import('../kicad/symbol');
            const pins = new Set(librarySymbolPins(asset.symbol).map((pin) => pin.number));
            for (const pin of component.pins) {
                if (!pins.has(String(pin.pin_number))) throw new Error(`Unknown pin ${component.designator}.${pin.pin_number}`);
            }
        }
        components.push({ ...component, pos: { x: (index % 4) * 160, y: Math.floor(index / 4) * 160,
            width: 100, height: 100, center: { x: 50, y: 50 } } });
    }
    return {
        metadata: { project_name: 'Local circuit', description: 'Local-library assembly' },
        components, edges: [], blocks: [], assembly_options: { draw_blocks: false },
        rm_components: circuit.rm_components || [],
        rm_net: (circuit.external_rm_connect || []).map((pin) => ({ ...pin, net: '' })),
        added_net: (circuit.external_connect || []).map(({ signal_name, ...pin }) => ({ ...pin, net: signal_name })),
    } satisfies CircuitAssembly;
}
