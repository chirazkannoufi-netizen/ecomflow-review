/**
 * Description OpenAPI de l'API EcomFlow.
 *
 * Le document est defini ICI, en un seul endroit, parce qu'il a deux
 * consommateurs : l'interface Swagger servie par l'application au demarrage,
 * et le script d'export `scripts/export-openapi.ts` qui produit le fichier
 * consomme par la CI et les clients. Deux definitions divergeraient
 * inevitablement, et la specification publiee finirait par ne plus decrire
 * l'API reellement servie.
 */

import { DocumentBuilder } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';

export interface OpenApiServerSettings {
  readonly apiUrl: string;
}

const DESCRIPTION =
  "API de la plateforme SaaS EcomFlow — gestion et automatisation des operations " +
  "e-commerce (commandes, confirmation, preparation, expedition, tracking, " +
  'retours, stock, abonnement).\n\n' +
  '**Multi-tenant** : chaque requete authentifiee est automatiquement limitee ' +
  'a la boutique de la session. L en-tete `X-Tenant-Id` permet de changer de ' +
  'boutique parmi celles dont l utilisateur est membre ; toute autre valeur ' +
  'est refusee.\n\n' +
  '**Idempotence** : les endpoints de creation couteuse acceptent l en-tete ' +
  '`Idempotency-Key`.';

/** Configuration du document, partagee par Swagger UI et l'export. */
export function buildOpenApiConfig(settings: OpenApiServerSettings): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle('EcomFlow API')
    .setDescription(DESCRIPTION)
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .addGlobalParameters({
      name: 'X-Tenant-Id',
      in: 'header',
      required: false,
      description: 'Boutique ciblee, si l utilisateur est membre de plusieurs boutiques.',
      schema: { type: 'string', format: 'uuid' },
    })
    .addServer(settings.apiUrl)
    .build();
}
