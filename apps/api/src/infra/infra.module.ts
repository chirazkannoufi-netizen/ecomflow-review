import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { ClockService } from './clock/clock.service';
import { EncryptionService } from './crypto/encryption.service';
import { HashService } from './crypto/hash.service';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Services techniques transverses : horloge, chiffrement, hachage, base de
 * donnees. Global, car ils sont utilises par presque tous les modules metier
 * et n'ont aucun etat propre a une requete.
 */
@Global()
@Module({
  imports: [AppConfigModule, PrismaModule],
  providers: [ClockService, EncryptionService, HashService],
  exports: [PrismaModule, ClockService, EncryptionService, HashService],
})
export class InfraModule {}
