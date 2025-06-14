import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RedisService } from '../../shared/cache/redis/redis.service';
import { LoggingService } from '../../shared/logging/logging.service';
import { LogType, LogLevel } from '../../shared/logging/types/logging.types';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private jwtService: JwtService,
    private redisService: RedisService,
    private loggingService: LoggingService
  ) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    try {
      // Check if the route is public
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);

      const request = context.switchToHttp().getRequest();
      const path = request.path;

      // Allow public endpoints without token
      if (isPublic || this.isPublicPath(path)) {
        return true;
      }

      // Get token from header
      const token = this.extractTokenFromHeader(request);
      if (!token) {
        throw new UnauthorizedException('No token provided');
      }

      try {
        // Verify token
        const payload = await this.jwtService.verifyAsync(token);
        request.user = payload;

        // Check if token is blacklisted
        const isBlacklisted = await this.redisService.get(`blacklist:${token}`);
        if (isBlacklisted) {
          throw new UnauthorizedException('Token has been invalidated');
        }

        // Log successful authentication
        this.loggingService.log(
          LogType.SECURITY,
          LogLevel.INFO,
          'Authentication successful',
          'JwtAuthGuard',
          { userId: payload.sub }
        );

        return true;
      } catch (error) {
        if (error.name === 'TokenExpiredError') {
          throw new UnauthorizedException('Token has expired');
        }
        throw new UnauthorizedException('Invalid token');
      }
    } catch (error) {
      this.loggingService.log(
        LogType.SECURITY,
        LogLevel.ERROR,
        'Authentication failed',
        'JwtAuthGuard',
        { error: error.message }
      );
      throw error;
    }
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }

  private isPublicPath(path: string): boolean {
    const publicPaths = [
      '/auth/login',
      '/auth/register',
      '/auth/forgot-password',
      '/auth/reset-password',
      '/auth/verify-email',
      '/health',
      '/docs',
      '/api',
      '/swagger'
    ];
    return publicPaths.some(publicPath => path.startsWith(publicPath));
  }
} 