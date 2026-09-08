/**
 * Sondes de sante (V2 §32).
 *
 * Trois niveaux, aux roles distincts :
 *
 *  - `/health/live`  : le processus repond-il ? Aucune dependance verifiee.
 *    C'est la sonde de VIVACITE : si elle echoue, l'orchestrateur redemarre le
 *    conteneur. Elle ne doit donc jamais dependre de la base — sinon une panne
 *    PostgreSQL declencherait une boucle de redemarrages inutiles.
 *
 *  - `/health/ready` : les dependances indispensables repondent-elles ?
 *    C'est la sonde de DISPONIBILITE : si elle echoue, l'instance est retiree
 *    du repartiteur de charge sans etre tuee.
 *
 *  - `/health`       : diagnostic detaille, reserve aux administrateurs.
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
  Version,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlatformAdminOnly, Public } from '../../common/decorators';
import { HealthService, type HealthReport } from './health.service';

@ApiTags('Sante')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Version(VERSION_NEUTRAL)
  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sonde de vivacite' })
  live(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Public()
  @Version(VERSION_NEUTRAL)
  @Get('ready')
  @ApiOperation({ summary: 'Sonde de disponibilite' })
  async ready(): Promise<{ status: string; checks: Record<string, string> }> {
    const report = await this.health.checkCritical();

    if (!report.healthy) {
      // 503 explicite : le repartiteur de charge doit retirer l'instance.
      throw new ServiceUnavailableException({
        status: 'unavailable',
        checks: summarize(report),
      });
    }

    return { status: 'ready', checks: summarize(report) };
  }

  @PlatformAdminOnly()
  @Get()
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Diagnostic complet (administration plateforme)' })
  async detailed(): Promise<HealthReport> {
    return this.health.checkAll();
  }
}

function summarize(report: HealthReport): Record<string, string> {
  const result: Record<string, string> = {};
  for (const check of report.checks) {
    result[check.name] = check.status;
  }
  return result;
}
