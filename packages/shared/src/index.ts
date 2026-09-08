/**
 * @ecomflow/shared — contrats metier partages entre l'API NestJS et le front Next.js.
 *
 * Ce package ne contient AUCUNE logique d'acces aux donnees et AUCUNE dependance
 * runtime : uniquement des enumerations, des types et des fonctions pures.
 * Il est ainsi importable des deux cotes sans risque de fuite de secret ni
 * d'effet de bord, et integralement testable unitairement.
 */

export * from './algeria';
export * from './api';
export * from './duplicates';
export * from './enums';
export * from './errors';
export * from './locale';
export * from './money';
export * from './order-status';
export * from './permissions';
export * from './phone';
export * from './profitability';
export * from './reference';
export * from './reliability';
export * from './roles';
export * from './trial';
export * from './whatsapp-templates';
