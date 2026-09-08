/**
 * Horloge injectable.
 *
 * Toute logique metier dependant du temps — expiration de l'essai, delai de
 * rappel, fenetre de detection de doublons, timeout WhatsApp — passe par ce
 * service plutot que par `new Date()`.
 *
 * Raison : ces regles sont au coeur des criteres d'acceptation (« le Trial
 * dure exactement 7 jours », V2 §37). Les tester exige de pouvoir avancer le
 * temps de maniere deterministe, sans `jest.useFakeTimers()` global qui
 * perturbe les timers de NestJS et de Prisma.
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class ClockService {
  /** Instant courant. */
  now(): Date {
    return new Date();
  }

  /** Horodatage en millisecondes. */
  timestamp(): number {
    return Date.now();
  }

  /** Instant decale de `days` jours. */
  addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 86_400_000);
  }

  addHours(date: Date, hours: number): Date {
    return new Date(date.getTime() + hours * 3_600_000);
  }

  addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
  }

  /** Instant dans `days` jours a partir de maintenant. */
  inDays(days: number): Date {
    return this.addDays(this.now(), days);
  }

  inHours(hours: number): Date {
    return this.addHours(this.now(), hours);
  }

  inMinutes(minutes: number): Date {
    return this.addMinutes(this.now(), minutes);
  }

  isPast(date: Date): boolean {
    return date.getTime() <= this.timestamp();
  }

  isFuture(date: Date): boolean {
    return date.getTime() > this.timestamp();
  }
}

/**
 * Horloge figee, destinee aux tests.
 *
 * ```ts
 * const clock = new FixedClockService(new Date('2026-08-29T10:00:00Z'));
 * clock.advanceDays(7);
 * ```
 */
@Injectable()
export class FixedClockService extends ClockService {
  private current: Date;

  constructor(initial: Date = new Date('2026-08-29T10:00:00.000Z')) {
    super();
    this.current = new Date(initial);
  }

  override now(): Date {
    return new Date(this.current);
  }

  override timestamp(): number {
    return this.current.getTime();
  }

  /** Positionne l'horloge sur un instant precis. */
  setTo(date: Date): void {
    this.current = new Date(date);
  }

  advanceMs(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000);
  }

  advanceHours(hours: number): void {
    this.advanceMs(hours * 3_600_000);
  }

  advanceDays(days: number): void {
    this.advanceMs(days * 86_400_000);
  }
}
