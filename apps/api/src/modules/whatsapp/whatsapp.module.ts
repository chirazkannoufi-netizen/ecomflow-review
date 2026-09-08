import { Global, Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { WhatsappFilterService } from './whatsapp-filter.service';
import { WhatsappGateway } from './whatsapp.gateway';

/**
 * WhatsApp Business Cloud.
 *
 * La PASSERELLE est globale : elle sert a trois domaines (verification de
 * numero, filtre de confirmation, notifications critiques) et n'a aucune
 * dependance metier.
 * Le FILTRE, lui, depend du workflow de commande : il n'est pas global et
 * s'importe explicitement.
 */
@Global()
@Module({
  imports: [OrdersModule],
  providers: [WhatsappGateway, WhatsappFilterService],
  exports: [WhatsappGateway, WhatsappFilterService],
})
export class WhatsappModule {}
