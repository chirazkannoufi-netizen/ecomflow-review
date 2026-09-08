/**
 * Assistant d'onboarding sans developpeur — Addendum §34.
 *
 * OBJECTIF : « a l'issue du parcours, la boutique doit etre en mesure de
 * recevoir sa premiere commande reelle sans support technique externe ».
 *
 * Le service ne se contente pas de stocker une progression : il VERIFIE
 * reellement l'etat de chaque etape en interrogeant la base. Une progression
 * declarative se desynchroniserait de la realite au premier incident — un
 * commercant verrait « Google connecte » alors que son jeton a ete revoque.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ONBOARDING_STEPS,
  ONBOARDING_STEP_LABELS,
  REQUIRED_ONBOARDING_STEPS,
  type OnboardingStep,
} from '@ecomflow/shared';
import { ClockService } from '../../infra/clock/clock.service';
import { InjectPrisma, type PrismaClientExtended } from '../../infra/prisma/prisma.service';

export interface OnboardingStepState {
  readonly step: OnboardingStep;
  readonly label: string;
  readonly done: boolean;
  readonly required: boolean;
  /** Message d'aide affiche quand l'etape n'est pas franchie. */
  readonly hint: string | null;
}

export interface OnboardingState {
  readonly currentStep: OnboardingStep;
  readonly completed: boolean;
  readonly progressPercent: number;
  readonly steps: readonly OnboardingStepState[];
  /** La boutique peut-elle recevoir une vraie commande ? */
  readonly readyForFirstOrder: boolean;
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientExtended,
    private readonly clock: ClockService,
  ) {}

  /**
   * Etat reel de l'onboarding, verifie contre la base.
   *
   * Chaque etape est evaluee a partir des donnees, pas d'un drapeau : c'est
   * ce qui garantit que l'assistant dit la verite.
   */
  async getState(tenantId: string): Promise<OnboardingState> {
    const [progress, integration, sheetConfig, testRun, carrierAccount, whatsappSettings] =
      await Promise.all([
        this.prisma.onboardingProgress.findUnique({
          where: { tenantId },
          select: { completedSteps: true, currentStep: true, completedAt: true },
        }),
        this.prisma.integration.findFirst({
          where: { tenantId, provider: 'GOOGLE_SHEETS', status: 'CONNECTED' },
          select: { id: true, accountLabel: true },
        }),
        this.prisma.sheetSyncConfig.findFirst({
          where: { tenantId, isActive: true },
          select: { id: true, columnMapping: true, sheetName: true },
        }),
        this.prisma.syncRun.findFirst({
          where: { tenantId, status: { in: ['SUCCESS', 'PARTIAL_SUCCESS'] } },
          select: { id: true, rowsScanned: true },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.carrierAccount.findFirst({
          where: { tenantId, status: { in: ['CONNECTED', 'DEGRADED'] } },
          select: { id: true, label: true },
        }),
        this.prisma.tenantSettings.findUnique({
          where: { tenantId },
          select: { whatsappFilterEnabled: true },
        }),
      ]);

    const done: Record<OnboardingStep, boolean> = {
      // Ces deux etapes sont acquises des que la boutique existe.
      ACCOUNT_CREATED: true,
      STORE_CREATED: true,
      ORDER_SOURCE_CONNECTED: Boolean(integration),
      COLUMN_MAPPING_CONFIGURED: Boolean(
        sheetConfig && Object.keys((sheetConfig.columnMapping ?? {}) as object).length > 0,
      ),
      TEST_IMPORT_PASSED: Boolean(testRun),
      CARRIER_CONFIGURED: Boolean(carrierAccount),
      WHATSAPP_CONFIGURED: Boolean(whatsappSettings?.whatsappFilterEnabled),
      ACTIVATED: Boolean(progress?.completedAt),
    };

    const hints: Record<OnboardingStep, string | null> = {
      ACCOUNT_CREATED: null,
      STORE_CREATED: null,
      ORDER_SOURCE_CONNECTED: done.ORDER_SOURCE_CONNECTED
        ? null
        : 'Connectez votre compte Google pour importer vos commandes automatiquement.',
      COLUMN_MAPPING_CONFIGURED: done.COLUMN_MAPPING_CONFIGURED
        ? null
        : 'Choisissez la feuille a synchroniser et verifiez le mapping propose.',
      TEST_IMPORT_PASSED: done.TEST_IMPORT_PASSED
        ? null
        : 'Lancez un import de test : il valide votre mapping sans creer de commande.',
      CARRIER_CONFIGURED: done.CARRIER_CONFIGURED
        ? null
        : 'Ajoutez un transporteur pour pouvoir expedier vos commandes confirmees.',
      WHATSAPP_CONFIGURED: done.WHATSAPP_CONFIGURED
        ? null
        : 'Optionnel : activez la confirmation WhatsApp pour alleger votre file d appel.',
      ACTIVATED: done.ACTIVATED ? null : 'Finalisez pour activer votre boutique.',
    };

    const steps: OnboardingStepState[] = ONBOARDING_STEPS.map((step) => ({
      step,
      label: ONBOARDING_STEP_LABELS[step],
      done: done[step],
      required: REQUIRED_ONBOARDING_STEPS.includes(step),
      hint: hints[step],
    }));

    const requiredDone = REQUIRED_ONBOARDING_STEPS.filter((step) => done[step]).length;
    const readyForFirstOrder = requiredDone === REQUIRED_ONBOARDING_STEPS.length;

    const currentStep =
      ONBOARDING_STEPS.find((step) => REQUIRED_ONBOARDING_STEPS.includes(step) && !done[step]) ??
      (done.CARRIER_CONFIGURED ? 'ACTIVATED' : 'CARRIER_CONFIGURED');

    // La progression ne compte QUE les etapes obligatoires : afficher 60 %
    // parce que WhatsApp — optionnel — n'est pas active serait decourageant
    // et faux.
    const progressPercent = Math.round(
      (requiredDone / REQUIRED_ONBOARDING_STEPS.length) * 100,
    );

    // Synchronise la progression stockee avec la realite observee.
    await this.persistProgress(tenantId, done, currentStep);

    return {
      currentStep,
      completed: Boolean(progress?.completedAt),
      progressPercent,
      steps,
      readyForFirstOrder,
    };
  }

  /**
   * Finalise l'onboarding et active la boutique.
   *
   * Refuse tant que les etapes obligatoires ne sont pas franchies : activer une
   * boutique incapable de recevoir une commande serait un faux depart.
   */
  async complete(tenantId: string): Promise<{ activated: boolean; missing: string[] }> {
    const state = await this.getState(tenantId);

    const missing = state.steps
      .filter((step) => step.required && !step.done)
      .map((step) => step.label);

    if (missing.length > 0) {
      return { activated: false, missing };
    }

    const now = this.clock.now();

    await this.prisma.$transaction([
      this.prisma.onboardingProgress.update({
        where: { tenantId },
        data: { currentStep: 'ACTIVATED', completedAt: now },
      }),
      this.prisma.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } }),
    ]);

    this.logger.log(`Onboarding termine pour la boutique ${tenantId} : boutique activee.`);

    return { activated: true, missing: [] };
  }

  private async persistProgress(
    tenantId: string,
    done: Record<OnboardingStep, boolean>,
    currentStep: OnboardingStep,
  ): Promise<void> {
    const completedSteps = ONBOARDING_STEPS.filter((step) => done[step]);

    await this.prisma.onboardingProgress.updateMany({
      where: { tenantId },
      data: { completedSteps: [...completedSteps], currentStep },
    });
  }
}
