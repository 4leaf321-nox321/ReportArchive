import { apiClient, extractData } from './client'

/**
 * Fetches the widget catalog from the backend. The shape:
 *   { schema_version: 'widget-v1',
 *     widgets: [{ type, label, description, has_content, props_schema, default_props }, ...] }
 */
export async function fetchWidgetCatalog() {
  const res = await apiClient.get('/api/widgets')
  return extractData(res)
}
