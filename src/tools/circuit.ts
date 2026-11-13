import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { searchComponent } from '../components/search';
import { beautifySchematic } from '../circuit/beautify';
import { extractCircuit } from '../circuit/extract';
import { CircuitModStruct } from '../types/circuit';
import { SKILL_DOC_PATH } from '../utils/dirs';
import { diagnosticToolResult } from '../utils/diagnostics';
import { enqueueMutation } from '../utils/mutation-queue';
import { postJson } from '../utils/server';
import { runTool, textResult } from '../utils/tool-result';

import { registerSchematicEditTools } from './schematic-edit';

export function registerCircuitTools(server: McpServer) {
    registerSchematicEditTools(server);
    server.registerTool(
        'component_search',
        {
            title: 'Search Component',
            description: 'Search installed KiCad symbols first by exact MPN or Library:Symbol, then the remote catalog on a miss. Local IDs are kicad:Library:Symbol.',
            inputSchema: z.object({
                part_uuid: z.string().nullable().optional(),
                MPN: z.string().nullable().optional(),
                path: z.string().optional().describe('Schematic path for project sym-lib-table lookup.'),
            }),
        },
        async ({ part_uuid, MPN, path }) => {
            if (!part_uuid && !MPN) {
                return textResult('Fill one: part_uuid or MPN');
            }

            return runTool(() => searchComponent({ part_uuid, MPN, path }));
        },
    );

    server.registerTool(
        'search_reused_block',
        {
            title: 'Search Reused Block',
            description: `Search reusable circuit blocks by function. For circuit workflow docs, read: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                query: z.string().min(1).describe('Query example: "3.3V power regulator"'),
                page: z.number().int().min(1).default(1).describe('Current results page.'),
                limit: z.number().int().min(1).max(25).default(10).describe('Number of results per page.'),
            }),
        },
        async ({ query, page, limit }) => runTool(
            () => postJson('/v1/mcp-tools/search-reused-block', { query, page, limit }),
        ),
    );

    server.registerTool(
        'beautify_schematic',
        {
            title: 'Beautify Schematic',
            description: `Reassemble selected KiCad components into named functional blocks while preserving their electrical connections. Recoverable item errors are returned (max 36). For circuit workflow docs, read: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Existing target .kicad_sch path.'),
                blocks: z.record(
                    z.string().min(1).describe('Block name.'),
                    z.array(z.string().min(1)).min(1).describe('Component designators in the block.'),
                ).describe('Component groups keyed by block name.'),
            }),
        },
        async ({ path, blocks }) => runTool(() => enqueueMutation(async () => {
            const { diagnostics } = await beautifySchematic(path, blocks);
            return diagnosticToolResult(diagnostics);
        })),
    );

    server.registerTool(
        'extract_circuit',
        {
            title: 'Extract Circuit',
            description: `Apply circuit changes to a KiCad .kicad_sch file. Every added component must include part_uuid. Recoverable item errors are returned (max 36). For circuit modification docs, read: ${SKILL_DOC_PATH}`,
            inputSchema: CircuitModStruct().extend({
                path: z.string().min(1).describe('Existing target .kicad_sch path.'),
            }),
        },
        async ({ path, ...circuit }) => runTool(() => enqueueMutation(async () => {
            const { diagnostics } = await extractCircuit(path, circuit);
            return diagnosticToolResult(diagnostics);
        })),
    );
}
