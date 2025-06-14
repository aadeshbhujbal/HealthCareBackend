import { Module } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { ClinicGuard } from './clinic.guard';
import { RedisModule } from '../../shared/cache/redis/redis.module';
import { RateLimitModule } from '../../shared/rate-limit/rate-limit.module';
import { PrismaModule } from '../../shared/database/prisma/prisma.module';
import { LoggingModule } from '../../shared/logging/logging.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    RedisModule,
    RateLimitModule,
    PrismaModule,
    LoggingModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { 
          expiresIn: '24h'
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [JwtAuthGuard, RolesGuard, ClinicGuard],
  exports: [JwtAuthGuard, RolesGuard, ClinicGuard],
})
export class GuardsModule {} 