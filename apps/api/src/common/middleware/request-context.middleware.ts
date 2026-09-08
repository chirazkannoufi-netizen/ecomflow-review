/**
 * Ouvre le contexte de requete pour toute la duree du traitement HTTP.
 *
 * C'est le PREMIER maillon de la chaine : il s'execute avant les gardes, les
 * intercepteurs et les controleurs. Tout ce qui suit — y compris le garde
 * d'isolation Prisma — lit le contexte ouvert ici.
 */

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CORRELATION_HEADER } from '@ecomflow/shared';
import {
  RequestContextStore,
  createRequestContext,
  generateCorrelationId,
} from '../../infra/context/request-context';

/** Longueur maximale acceptee pour un identifiant de correlation fourni. */
const MAX_CORRELATION_LENGTH = 64;
const SAFE_CORRELATION_PATTERN = /^[A-Za-z0-9_-]+$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const correlationId = this.resolveCorrelationId(request);

    const context = createRequestContext({
      correlationId,
      ipAddress: this.resolveClientIp(request),
      userAgent: request.get('user-agent')?.slice(0, 255) ?? null,
    });

    // Renvoye au client : l'utilisateur peut le communiquer au support pour
    // retrouver la trace exacte de son incident.
    response.setHeader(CORRELATION_HEADER, correlationId);

    RequestContextStore.run(context, () => next());
  }

  /**
   * Reprend l'identifiant fourni par un proxy ou un client, apres validation.
   * Une valeur non conforme est remplacee plutot que rejetee : un en-tete
   * malforme ne doit pas faire echouer une requete par ailleurs valide, mais
   * il ne doit pas non plus se retrouver tel quel dans les journaux
   * (risque d'injection de log).
   */
  private resolveCorrelationId(request: Request): string {
    const provided = request.get(CORRELATION_HEADER);
    if (
      provided &&
      provided.length <= MAX_CORRELATION_LENGTH &&
      SAFE_CORRELATION_PATTERN.test(provided)
    ) {
      return provided;
    }
    return generateCorrelationId();
  }

  /**
   * Adresse IP du client.
   *
   * `X-Forwarded-For` n'est pris en compte que si l'application est configuree
   * derriere un proxy de confiance (`trust proxy`), sinon un client pourrait
   * usurper son IP et fausser la detection d'abus du Trial (Addendum §38)
   * ainsi que la limitation de debit.
   */
  private resolveClientIp(request: Request): string | null {
    return request.ip ?? request.socket.remoteAddress ?? null;
  }
}
