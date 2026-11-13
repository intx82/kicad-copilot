import { postJson } from '../utils/server';
import { findLocalComponents, isLocalPart } from './local-library';

export async function searchComponent(
    query: { part_uuid?: string | null; MPN?: string | null; path?: string },
    remote: typeof postJson = postJson,
) {
    const id = query.part_uuid?.trim();
    const mpn = query.MPN?.trim();
    if (!id && !mpn) throw new Error('Fill one: part_uuid or MPN');
    // An explicit remote UUID cannot be mapped to a local MPN safely.
    const localQuery = id && isLocalPart(id) ? id : !id ? mpn : undefined;
    if (localQuery) {
        const matches = await findLocalComponents(localQuery, query.path);
        if (matches.length) return { source: 'local', components: matches.map(({ symbol, ...metadata }) => metadata) };
        if (isLocalPart(localQuery)) throw new Error(`Local KiCad component not found: ${localQuery}`);
    }
    // Keep the remote contract opaque; do not invent or transform its response.
    return remote('/v1/mcp-tools/component-search', { part_uuid: query.part_uuid, MPN: query.MPN });
}
