import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { editSchematic, getSchematicGeometry } from '../circuit/schematic-edit';
import { enqueueMutation } from '../utils/mutation-queue';
import { runTool } from '../utils/tool-result';
import { SKILL_DOC_PATH } from '../utils/dirs';

export const SchematicEditSchema = z.object({
    path: z.string().min(1).describe('Exact physical .kicad_sch path; absolute paths supported.'),
    expected_source_hash: z.string().regex(/^[0-9a-f]{64}$/),
    dry_run: z.boolean().default(false),
    symbols: z.array(z.object({
        uuid: z.string().uuid(),
        footprint: z.string().optional().describe('Library:Footprint, or empty to clear. Verify package pinout separately.'),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
        angle: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    })).max(100).optional(),
    remove: z.array(z.string().uuid()).max(500).optional().describe('Exact wire, junction, label or no-connect UUIDs; never symbol UUIDs.'),
    wires: z.array(z.object({ points: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })).min(2).max(100) })).max(500).optional(),
    junctions: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })).max(500).optional(),
});

export function registerSchematicEditTools(server: McpServer) {
    server.registerTool('get_schematic_geometry', {
        title: 'Get Schematic Geometry',
        description: 'Read exact top-level schematic item UUIDs, geometry S-expressions and source hash for in-place editing. Coordinates are mm, angles KiCad degrees. Embedded symbol definitions are not returned; inspect library pin geometry separately.',
        inputSchema: z.object({ path: z.string().min(1) }),
    }, async ({ path }) => runTool(() => getSchematicGeometry(path)));
    server.registerTool('edit_schematic', {
        title: 'Edit Schematic In Place',
        description: `Assign footprints, position/rotate existing symbols, and add orthogonal wires/junctions or remove exact drawing items in one transaction. Preserves symbol UUIDs; does NOT drag wires. Requires native pin-net preservation and no added ERC findings; rejects unintended disconnections/shorts. Checkpoints before commit. Save editor changes first. Read ${SKILL_DOC_PATH} and schematic/in-place-editing.md.`,
        inputSchema: SchematicEditSchema,
    }, async ({ path, expected_source_hash, dry_run, ...edit }) => runTool(() => enqueueMutation(() => editSchematic(path, edit, expected_source_hash, dry_run))));
}
