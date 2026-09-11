import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ArchiveController } from './archive.controller';
import { ArchiveService } from './archive.service';

/** Corbeille de la boutique : ce qui a ete archive, sur les trois entites. */
@Module({
  imports: [AuditModule],
  controllers: [ArchiveController],
  providers: [ArchiveService],
  exports: [ArchiveService],
})
export class ArchiveModule {}
