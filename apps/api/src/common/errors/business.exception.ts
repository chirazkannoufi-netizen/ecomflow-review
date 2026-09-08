/**
 * Exceptions metier EcomFlow.
 *
 * Une erreur metier porte TOUJOURS :
 *  - un `code` stable, contractuel, destine au client (front, integrations,
 *    tests d'acceptation) ;
 *  - un `message` en francais, destine a l'humain, libre d'evoluer ;
 *  - un `details` structure, exploitable par l'interface pour afficher une
 *    remediation precise (ex. quel produit manque en stock, et de combien).
 *
 * Cette structure est la contrepartie de l'exigence « chaque erreur importante
 * doit etre detectable, journalisee, comprehensible et recuperable lorsque
 * possible » (prompt produit §46).
 */

import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from '@ecomflow/shared';

export interface BusinessErrorOptions {
  readonly details?: Record<string, unknown>;
  /** Erreur d'origine, journalisee mais jamais renvoyee au client. */
  readonly cause?: unknown;
}

export class BusinessException extends HttpException {
  readonly code: ErrorCode | (string & {});
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode | (string & {}),
    message: string,
    status: HttpStatus,
    options: BusinessErrorOptions = {},
  ) {
    super({ code, message, details: options.details }, status, { cause: options.cause });
    this.code = code;
    this.details = options.details;
  }
}

// ---------------------------------------------------------------------------
// Fabriques : un nom explicite par situation, pour eviter de reinventer le
// couple (code, statut HTTP) a chaque appel.
// ---------------------------------------------------------------------------

export class ValidationException extends BusinessException {
  constructor(message: string, options: BusinessErrorOptions = {}) {
    super(ERROR_CODES.VALIDATION_FAILED, message, HttpStatus.UNPROCESSABLE_ENTITY, options);
  }
}

export class NotFoundException extends BusinessException {
  constructor(code: ErrorCode | (string & {}), message: string, options: BusinessErrorOptions = {}) {
    super(code, message, HttpStatus.NOT_FOUND, options);
  }
}

export class ConflictException extends BusinessException {
  constructor(code: ErrorCode | (string & {}), message: string, options: BusinessErrorOptions = {}) {
    super(code, message, HttpStatus.CONFLICT, options);
  }
}

export class ForbiddenException extends BusinessException {
  constructor(code: ErrorCode | (string & {}), message: string, options: BusinessErrorOptions = {}) {
    super(code, message, HttpStatus.FORBIDDEN, options);
  }
}

export class UnauthorizedException extends BusinessException {
  constructor(code: ErrorCode | (string & {}), message: string, options: BusinessErrorOptions = {}) {
    super(code, message, HttpStatus.UNAUTHORIZED, options);
  }
}

/** 402 : l'action requiert un abonnement actif (V2 §7). */
export class PaymentRequiredException extends BusinessException {
  constructor(code: ErrorCode | (string & {}), message: string, options: BusinessErrorOptions = {}) {
    super(code, message, HttpStatus.PAYMENT_REQUIRED, options);
  }
}

/** 503 : dependance externe indisponible ; l'appelant peut reessayer. */
export class ServiceUnavailableException extends BusinessException {
  constructor(code: ErrorCode | (string & {}), message: string, options: BusinessErrorOptions = {}) {
    super(code, message, HttpStatus.SERVICE_UNAVAILABLE, options);
  }
}

/** 504 : delai depasse sur une dependance externe. */
export class GatewayTimeoutException extends BusinessException {
  constructor(code: ErrorCode | (string & {}), message: string, options: BusinessErrorOptions = {}) {
    super(code, message, HttpStatus.GATEWAY_TIMEOUT, options);
  }
}

// ---------------------------------------------------------------------------
// Erreurs metier nommees, les plus frequentes
// ---------------------------------------------------------------------------

/** Transition de statut interdite par la machine a etats. */
export class InvalidOrderTransitionException extends BusinessException {
  constructor(from: string, to: string, allowed: readonly string[]) {
    super(
      ERROR_CODES.ORDER_INVALID_TRANSITION,
      `La transition ${from} vers ${to} n est pas autorisee.`,
      HttpStatus.CONFLICT,
      { details: { from, to, allowedTransitions: allowed } },
    );
  }
}

/** Garde metier non satisfaite (stock, adresse, colis...). */
export class TransitionGuardFailedException extends BusinessException {
  constructor(guard: string, message: string, details?: Record<string, unknown>) {
    super(ERROR_CODES.ORDER_TRANSITION_GUARD_FAILED, message, HttpStatus.CONFLICT, {
      details: { guard, ...details },
    });
  }
}

/** Stock insuffisant : le detail liste precisement ce qui manque. */
export class InsufficientStockException extends BusinessException {
  constructor(
    shortages: readonly { sku: string; requested: number; available: number }[],
  ) {
    super(
      ERROR_CODES.INSUFFICIENT_STOCK,
      'Stock insuffisant pour au moins un article de la commande.',
      HttpStatus.CONFLICT,
      { details: { shortages } },
    );
  }
}

/** Abonnement expire : l'operationnel payant est suspendu. */
export class SubscriptionRequiredException extends BusinessException {
  constructor(status: string, reason: string) {
    super(
      ERROR_CODES.SUBSCRIPTION_REQUIRED,
      `Cette fonctionnalite necessite un abonnement actif. ${reason}`,
      HttpStatus.PAYMENT_REQUIRED,
      { details: { subscriptionStatus: status } },
    );
  }
}

/** Permission manquante. */
export class PermissionDeniedException extends BusinessException {
  constructor(required: readonly string[]) {
    super(
      ERROR_CODES.PERMISSION_DENIED,
      'Vous ne disposez pas des droits necessaires pour cette action.',
      HttpStatus.FORBIDDEN,
      { details: { requiredPermissions: required } },
    );
  }
}
