import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigModule } from '../../config/config.module';
import { AppConfigService } from '../../config/configuration';
import { BillingCoreModule } from '../billing/billing-core.module';
import { TenantsModule } from '../tenants/tenants.module';
import { AccessContextService } from './access-context.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';

/**
 * Module d'authentification.
 *
 * Global parce que `JwtAuthGuard`, enregistre au niveau de l'application,
 * depend de `TokenService` et `AccessContextService`. Les exporter globalement
 * evite de reimporter `AuthModule` dans chaque module de fonctionnalite.
 */
@Global()
@Module({
  imports: [
    AppConfigModule,
    TenantsModule,
    BillingCoreModule,
    JwtModule.registerAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      // Les secrets sont fournis explicitement a chaque signature/verification
      // (`TokenService`), car acces et rafraichissement utilisent des cles
      // distinctes. On n'en fixe donc aucun par defaut ici.
      useFactory: (config: AppConfigService) => ({
        signOptions: { issuer: 'ecomflow', audience: config.app.appUrl },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, OtpService, AccessContextService],
  exports: [AuthService, TokenService, OtpService, AccessContextService],
})
export class AuthModule {}
