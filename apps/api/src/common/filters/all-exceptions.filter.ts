/**
 * Filtre global d'exceptions.
 *
 * Il garantit trois choses :
 *  1. TOUTE reponse d'erreur suit le meme contrat (`ApiErrorBody`), quelle que
 *     soit l'origine de l'exception ;
 *  2. aucun detail interne (trace, SQL, nom de contrainte, secret) ne fuit vers
 *     le client en production ;
 *  3. chaque erreur 5xx est journalisee avec son identifiant de correlation,
 *     ce qui permet au support de retrouver l'evenement exact a partir du seul
 *     identifiant affiche a l'utilisateur.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ERROR_CODES, type ApiErrorBody } from '@ecomflow/shared';
import { BusinessException } from '../errors/business.exception';
import { RequestContextStore } from '../../infra/context/request-context';
import {
  CrossTenantAccessError,
  TenantContextMissingError,
} from '../../infra/prisma/tenant-guard.extension';

interface NormalizedError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** Renseigne pour les erreurs a journaliser integralement. */
  logAsError: boolean;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = RequestContextStore.get()?.correlationId;

    const normalized = this.normalize(exception);

    const body: ApiErrorBody = {
      statusCode: normalized.status,
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
      ...(correlationId ? { correlationId } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    if (normalized.logAsError) {
      this.logger.error(
        `${request.method} ${request.url} -> ${normalized.status} ${normalized.code} ` +
          `[correlation=${correlationId ?? '-'}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (normalized.status >= 400 && normalized.status < 500) {
      this.logger.debug(
        `${request.method} ${request.url} -> ${normalized.status} ${normalized.code} ` +
          `[correlation=${correlationId ?? '-'}]`,
      );
    }

    response.status(normalized.status).json(body);
  }

  private normalize(exception: unknown): NormalizedError {
    // --- Erreurs metier explicites -----------------------------------------
    if (exception instanceof BusinessException) {
      const payload = exception.getResponse() as {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      return {
        status: exception.getStatus(),
        code: payload.code ?? ERROR_CODES.INTERNAL_ERROR,
        message: payload.message ?? exception.message,
        details: payload.details,
        logAsError: exception.getStatus() >= 500,
      };
    }

    // --- Isolation multi-tenant : incident de securite ----------------------
    if (exception instanceof CrossTenantAccessError) {
      return {
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.CROSS_TENANT_ACCESS_BLOCKED,
        // Volontairement laconique : ne rien reveler de l'autre boutique.
        message: 'Acces refuse.',
        logAsError: true,
      };
    }

    if (exception instanceof TenantContextMissingError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ERROR_CODES.TENANT_CONTEXT_MISSING,
        message: 'Erreur interne.',
        logAsError: true,
      };
    }

    // --- Exceptions HTTP Nest (validation, garde, 404 de route) -------------
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();

      if (typeof raw === 'string') {
        return {
          status,
          code: this.codeForStatus(status),
          message: raw,
          logAsError: status >= 500,
        };
      }

      const payload = raw as {
        message?: string | string[];
        error?: string;
        code?: string;
        details?: Record<string, unknown>;
      };

      // `ValidationPipe` renvoie un tableau de messages : on le structure.
      if (Array.isArray(payload.message)) {
        return {
          status,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'Les donnees envoyees sont invalides.',
          details: { violations: payload.message },
          logAsError: false,
        };
      }

      return {
        status,
        code: payload.code ?? this.codeForStatus(status),
        message: payload.message ?? payload.error ?? 'Erreur.',
        details: payload.details,
        logAsError: status >= 500,
      };
    }

    // --- Erreurs Prisma ------------------------------------------------------
    const prismaError = this.normalizePrisma(exception);
    if (prismaError) return prismaError;

    // --- Tout le reste : erreur interne, sans fuite de detail ---------------
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: this.isProduction
        ? 'Une erreur interne est survenue. Notre equipe a ete notifiee.'
        : exception instanceof Error
          ? exception.message
          : String(exception),
      logAsError: true,
    };
  }

  /**
   * Traduit les erreurs Prisma en erreurs metier lisibles.
   *
   * Le message renvoye ne contient JAMAIS le nom de la contrainte ni la
   * requete SQL : ces informations decrivent le schema interne et n'aident
   * pas l'utilisateur.
   */
  private normalizePrisma(exception: unknown): NormalizedError | null {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.CONFLICT,
            message: 'Cette valeur existe deja.',
            details: this.isProduction ? undefined : { target: exception.meta?.['target'] },
            logAsError: false,
          };
        case 'P2003':
          return {
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.CONFLICT,
            message: 'Cette operation reference un element inexistant ou lie a une autre boutique.',
            logAsError: false,
          };
        case 'P2004':
          return {
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.CONFLICT,
            message: 'Cette operation violerait une regle d integrite des donnees.',
            logAsError: true,
          };
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            code: ERROR_CODES.NOT_FOUND,
            message: 'Ressource introuvable.',
            logAsError: false,
          };
        case 'P2034':
          return {
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.CONFLICT,
            message: 'Conflit de transaction. Veuillez reessayer.',
            logAsError: false,
          };
        default:
          return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            code: ERROR_CODES.INTERNAL_ERROR,
            message: 'Erreur de base de donnees.',
            logAsError: true,
          };
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Requete invalide.',
        logAsError: true,
      };
    }

    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Service temporairement indisponible.',
        logAsError: true,
      };
    }

    return null;
  }

  private codeForStatus(status: HttpStatus): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ERROR_CODES.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ERROR_CODES.AUTH_TOKEN_INVALID;
      case HttpStatus.FORBIDDEN:
        return ERROR_CODES.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ERROR_CODES.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ERROR_CODES.CONFLICT;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ERROR_CODES.PAYLOAD_TOO_LARGE;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ERROR_CODES.RATE_LIMITED;
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }
}
