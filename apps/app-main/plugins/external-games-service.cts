import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { ExternalGamesCatalogPort, ExternalGamesInputs } from './service-contracts'

module.exports = createServicePlugin<ExternalGamesCatalogPort, ExternalGamesInputs>({
  domain: 'external-games',
  serviceName: 'externalGamesCatalog',
  capabilities: {
    'external-games.list': (catalog, input) => catalog.list({ refresh: !!(input && input.refresh) })
  }
})
