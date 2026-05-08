/**
 * Static workspace constants. Tree data + helpers now live in
 * WorkspaceContext (loaded from the backend).
 *
 * DEFAULT_WORKSPACE is the bootstrap slug used when the URL has no /w/:slug
 * yet — it's needed at module load time before the WorkspaceProvider has
 * fetched the registry.
 */
export const DEFAULT_WORKSPACE = 'dev'
