import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * Boite d'envoi transactionnelle. Globale : tout module metier publie des
 * evenements, et l'importer partout n'apporterait rien.
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class EventsModule {}
