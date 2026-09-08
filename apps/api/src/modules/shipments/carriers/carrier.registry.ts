/**
 * Registre des connecteurs transporteurs.
 *
 * Point d'indirection unique entre le code d'un transporteur (`carriers.code`
 * en base) et son adaptateur. Ajouter un transporteur consiste a ecrire un
 * adaptateur et a l'enregistrer ici : aucun service metier n'est touche
 * (V2 §16, V2 §38 — « ne pas coupler les regles metier a un transporteur
 * unique »).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@ecomflow/shared';
import { HttpStatus } from '@nestjs/common';
import { BusinessException } from '../../../common/errors/business.exception';
import { CARRIER_ADAPTERS, type CarrierAdapter } from './carrier-adapter.interface';

@Injectable()
export class CarrierRegistry {
  private readonly logger = new Logger(CarrierRegistry.name);
  private readonly adapters: ReadonlyMap<string, CarrierAdapter>;

  constructor(@Inject(CARRIER_ADAPTERS) adapters: readonly CarrierAdapter[]) {
    const map = new Map<string, CarrierAdapter>();
    for (const adapter of adapters) {
      if (map.has(adapter.code)) {
        // Deux adaptateurs portant le meme code rendraient le comportement
        // dependant de l'ordre d'enregistrement : on echoue au demarrage.
        throw new Error(`Deux connecteurs transporteurs partagent le code ${adapter.code}.`);
      }
      map.set(adapter.code, adapter);
    }
    this.adapters = map;
    this.logger.log(`Connecteurs transporteurs charges : ${[...map.keys()].join(', ')}`);
  }

  /**
   * Adaptateur d'un transporteur.
   *
   * @throws BusinessException si le code n'a pas d'implementation. C'est le cas
   *         des transporteurs references en base avec le statut `PLANNED` :
   *         on refuse explicitement plutot que de laisser croire a une
   *         integration existante (cahier de mission §5).
   */
  get(code: string): CarrierAdapter {
    const adapter = this.adapters.get(code);
    if (!adapter) {
      throw new BusinessException(
        ERROR_CODES.CARRIER_NOT_CONFIGURED,
        `Aucun connecteur n est implemente pour le transporteur « ${code} ».`,
        HttpStatus.NOT_IMPLEMENTED,
        { details: { code, available: this.availableCodes() } },
      );
    }
    return adapter;
  }

  has(code: string): boolean {
    return this.adapters.has(code);
  }

  availableCodes(): readonly string[] {
    return [...this.adapters.keys()];
  }

  /** Descripteurs des connecteurs, pour l'ecran de configuration. */
  describeAll(): readonly {
    code: string;
    displayName: string;
    supportsWebhooks: boolean;
    supportsCancellation: boolean;
    credentialFields: CarrierAdapter['credentialFields'];
  }[] {
    return [...this.adapters.values()].map((adapter) => ({
      code: adapter.code,
      displayName: adapter.displayName,
      supportsWebhooks: adapter.supportsWebhooks,
      supportsCancellation: adapter.supportsCancellation,
      credentialFields: adapter.credentialFields,
    }));
  }
}
