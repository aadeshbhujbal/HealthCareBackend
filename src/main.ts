import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { ValidationPipe, Logger, LogLevel, INestApplication } from '@nestjs/common';
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./libs/filters/http-exception.filter";
import fastifyHelmet from '@fastify/helmet';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { swaggerConfig, swaggerCustomOptions } from './config/swagger.config';
import { LoggingService } from './shared/logging/logging.service';
import { LogType } from './shared/logging/types/logging.types';
import { LogLevel as AppLogLevel } from './shared/logging/types/logging.types';
import developmentConfig from './config/environment/development.config';
import productionConfig from './config/environment/production.config';
import { RedisService } from './shared/cache/redis/redis.service';
import { QueueService } from './shared/queue/queue.service';
import { PrismaService } from './shared/database/prisma/prisma.service';
import { EmailModule } from './shared/messaging/email/email.module';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server } from 'socket.io';
import { createClient } from 'redis';

// Store original console methods
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  debug: console.debug,
  info: console.info
};

// Declare Redis client variables at module level
let pubClient: any = null;
let subClient: any = null;

// Function to redirect only HTTP logs to the logging service
// but keep important service logs visible in the console
function setupConsoleRedirect(loggingService: LoggingService) {
  if (!loggingService) return;

  // We'll keep all console logs as they are,
  // but only filter FastifyAdapter logs for HTTP requests
}

// Add environment type
const validEnvironments = ['development', 'production'] as const;
type Environment = typeof validEnvironments[number];

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  let app: NestFastifyApplication & INestApplication;
  let loggingService: LoggingService;
  
  try {
    logger.log('Starting application bootstrap...');
    
    const environment = process.env.NODE_ENV as Environment;
    if (!validEnvironments.includes(environment)) {
      throw new Error(`Invalid NODE_ENV: ${environment}. Must be one of: ${validEnvironments.join(', ')}`);
    }

    const envConfig = environment === 'production' ? productionConfig() : developmentConfig();

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({
        logger: {
          level: envConfig.app.environment === 'production' ? 'error' : 'info',
          serializers: {
            req: (req) => ({
              method: req.method,
              url: req.url,
              hostname: req.hostname,
              remoteAddress: req.ip,
              userAgent: req.headers['user-agent']
            }),
            res: (res) => ({
              statusCode: res.statusCode
            })
          }
        },
        trustProxy: envConfig.security.trustProxy === 1,
        bodyLimit: 10 * 1024 * 1024,
        ignoreTrailingSlash: true,
        disableRequestLogging: envConfig.app.environment === 'production'
      }),
      {
        logger: envConfig.app.environment === 'production' 
          ? ['error', 'warn'] 
          : ['error', 'warn', 'log', 'debug'] as LogLevel[],
        bufferLogs: true,
        cors: {
          origin: envConfig.cors.origin.split(','),
          methods: envConfig.cors.methods.split(','),
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
          credentials: envConfig.cors.credentials,
          preflightContinue: false,
          optionsSuccessStatus: 204
        }
      }
    );

    // Initialize core services
    const configService = app.get(ConfigService);
    loggingService = app.get(LoggingService);
    logger.log('Core services initialized');
    const eventEmitter = new EventEmitter2();
    
    // Set up console redirection to the logging service
    setupConsoleRedirect(loggingService);

    // Apply global pipes and filters
    app.useGlobalPipes(new ValidationPipe({
      transform: true,
      whitelist: true,
    }));
    app.useGlobalFilters(new HttpExceptionFilter());
    logger.log('Global pipes and filters configured');

    // Log application startup
    await loggingService.log(
      LogType.SYSTEM,
      AppLogLevel.INFO,
      'Application bootstrap started',
      'Bootstrap',
      { timestamp: new Date() }
    );

    // Set up WebSocket adapter with Redis
    try {
      const { createAdapter } = await import('@socket.io/redis-adapter');
      const { createClient } = await import('redis');
      
      // Redis client configuration with improved error handling
      const redisConfig = {
        url: `redis://${configService.get('REDIS_HOST', '127.0.0.1').trim()}:${configService.get('REDIS_PORT', '6379').trim()}`,
        password: configService.get('REDIS_PASSWORD'),
        retryStrategy: (times: number) => {
          const maxRetries = 5;
          if (times > maxRetries) {
            logger.error(`Redis connection failed after ${maxRetries} retries`);
            return null; // Stop retrying
          }
          const maxDelay = 3000;
          const delay = Math.min(times * 100, maxDelay);
          logger.log(`Redis reconnection attempt ${times}, delay: ${delay}ms`);
          return delay;
        }
      };

      try {
        pubClient = createClient(redisConfig);
        subClient = pubClient.duplicate();

      // Enhanced Redis connection event handling
      const handleRedisError = async (client: string, err: Error) => {
        try {
          await loggingService?.log(
            LogType.ERROR,
            AppLogLevel.ERROR,
            `Redis ${client} Client Error: ${err.message}`,
            'Redis',
            { client, error: err.message, stack: err.stack }
          );
        } catch (logError) {
          // If logging service fails, use original console
          originalConsole.error(`Redis ${client} Client Error:`, err);
        }
      };

      const handleRedisConnect = async (client: string) => {
        try {
          await loggingService?.log(
            LogType.SYSTEM,
            AppLogLevel.INFO,
            `Redis ${client} Client Connected`,
            'Redis',
            { client }
          );
        } catch (logError) {
          originalConsole.log(`Redis ${client} Client Connected`);
        }
      };

        // Set up event handlers
      pubClient.on('error', (err) => handleRedisError('Pub', err));
      subClient.on('error', (err) => handleRedisError('Sub', err));
      pubClient.on('connect', () => handleRedisConnect('Pub'));
      subClient.on('connect', () => handleRedisConnect('Sub'));
      
        // Connect with timeout
        const connectWithTimeout = async (client: any, name: string) => {
          return Promise.race([
            client.connect(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`${name} client connection timeout`)), 10000)
            )
          ]);
        };

        await Promise.all([
          connectWithTimeout(pubClient, 'Pub'),
          connectWithTimeout(subClient, 'Sub')
        ]);

      class CustomIoAdapter extends IoAdapter {
        private adapterConstructor: ReturnType<typeof createAdapter>;

        constructor(app: any) {
          super(app);
          this.adapterConstructor = createAdapter(pubClient, subClient);
        }
        
        createIOServer(port: number, options?: any) {
          const server = super.createIOServer(port, {
            ...options,
            cors: {
                origin: process.env.NODE_ENV === 'production'
                  ? process.env.CORS_ORIGIN?.split(',') || ['https://ishswami.in']
                  : '*',
              methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
              credentials: true,
              allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
            },
            path: '/socket.io',
              serveClient: true,
            transports: ['websocket', 'polling'],
            allowEIO3: true,
            pingTimeout: 60000,
            pingInterval: 25000,
            connectTimeout: 45000,
            maxHttpBufferSize: 1e6,
            allowUpgrades: true,
              cookie: false
          });

          server.adapter(this.adapterConstructor);

            // Health check endpoint
          server.of('/health').on('connection', (socket) => {
              socket.emit('health', { 
                status: 'healthy', 
                timestamp: new Date(),
                environment: process.env.NODE_ENV
              });
            });
            
            // Test namespace with improved error handling
          server.of('/test').on('connection', (socket) => {
            logger.log('Client connected to test namespace');
            
              let heartbeat: NodeJS.Timeout;
              
              // Send a welcome message and start heartbeat
              const startHeartbeat = () => {
                socket.emit('welcome', { 
                  message: 'Connected to WebSocket server',
                  timestamp: new Date().toISOString(),
                  environment: process.env.NODE_ENV
                });
                
                heartbeat = setInterval(() => {
                  socket.emit('heartbeat', { 
                timestamp: new Date().toISOString() 
              });
                }, 30000); // 30 second heartbeat
              };
              
              startHeartbeat();
            
              // Handle disconnection
            socket.on('disconnect', () => {
                clearInterval(heartbeat);
              logger.log('Client disconnected from test namespace');
            });
            
              // Echo messages with error handling
            socket.on('message', (data) => {
                try {
              socket.emit('echo', { 
                original: data,
                    timestamp: new Date().toISOString(),
                    processed: true
                  });
                } catch (error) {
                  logger.error('Error processing socket message:', error);
                  socket.emit('error', { 
                    message: 'Failed to process message',
                timestamp: new Date().toISOString()
                  });
                }
              });
              
              // Handle errors
              socket.on('error', (error) => {
                logger.error('Socket error:', error);
                clearInterval(heartbeat);
            });
          });

          return server;
        }
      }

      const customAdapter = new CustomIoAdapter(app);
      app.useWebSocketAdapter(customAdapter);
      
      logger.log('WebSocket adapter configured successfully');
      
      await loggingService?.log(
        LogType.SYSTEM,
        AppLogLevel.INFO,
        'WebSocket adapter configured successfully',
        'WebSocket'
      );

      } catch (redisError) {
        logger.warn('Failed to initialize Redis adapter:', redisError);
        await loggingService?.log(
          LogType.ERROR,
          AppLogLevel.WARN,
          'Continuing without Redis adapter',
          'WebSocket'
        );
      }

    } catch (error) {
      await loggingService?.log(
        LogType.ERROR,
        AppLogLevel.ERROR,
        `WebSocket adapter initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WebSocket',
        { error: error instanceof Error ? error.stack : 'No stack trace available' }
      );
      // Don't throw, continue without WebSocket
      logger.warn('Continuing without WebSocket support');
    }

    // Security headers
    const fastifyInstance = app.getHttpAdapter().getInstance();
    await fastifyInstance.register(fastifyHelmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https://api.ishswami.in", "wss://api.ishswami.in"],
          fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
          objectSrc: ["'none'"],
          frameSrc: ["'self'"],
          formAction: ["'self'"],
          baseUri: ["'self'"]
        }
      }
    });

    // Configure route handling for admin paths
    fastifyInstance.addHook('onRequest', (request, reply, done) => {
      const url = request.url;
      const isAdminPath = url.startsWith('/docs') || 
                          url.startsWith('/queue-dashboard') || 
                          url.startsWith('/logger') || 
                          url.startsWith('/prisma');
      
      if (isAdminPath && process.env.NODE_ENV === 'production') {
        // Comment out the authentication check for now to allow access for debugging
        // Add additional security checks for admin paths in production
        // This is just a placeholder for your actual security implementation
        /*
        const auth = request.headers.authorization;
        if (!auth) {
          reply.status(401).send({ message: 'Authentication required for admin paths' });
          return;
        }
        */
      }
      
      // Handle direct redirects for external services
      if (url.startsWith('/prisma')) {
        // Only allow in development mode
        if (process.env.NODE_ENV === 'production') {
          reply.status(403).send({ 
            message: 'Prisma Studio is only available in development mode',
            status: 'error'
          });
          return;
        }
        
        // Redirect to Prisma Studio running on port 5555
        reply.header('Location', 'http://localhost:5555');
        reply.status(302).send();
        return;
      }
      
      // Only handle Redis Commander and PgAdmin in development mode
      if (process.env.NODE_ENV === 'development') {
      if (url.startsWith('/redis-ui') || url.startsWith('/redis-commander')) {
        // Redirect to Redis Commander if it's running
        reply.header('Location', 'http://localhost:8082');
        reply.status(302).send();
        return;
      }
      
      if (url.startsWith('/pgadmin')) {
          // Redirect to PgAdmin if it's running
          reply.header('Location', 'http://localhost:5050');
          reply.status(302).send();
          return;
        }
      }
      
      // Handle socket endpoint redirects - but only for paths with additional parameters
      // since the base /socket path is handled by the AppController
      if (url.startsWith('/socket/') || url.includes('/socket?')) {
        // Redirect /socket to /socket.io for compatibility
        const redirectUrl = url.replace('/socket', '/socket.io');
        reply.header('Location', redirectUrl);
        reply.status(302).send();
        return;
      }
      
      done();
    });

    // Disable direct port access redirects to avoid redirect loops
    // Handle health check requests specially
    fastifyInstance.addHook('onRequest', (request, reply, done) => {
      if (request.url === '/health' || request.url === '/api-health') {
        // Don't redirect health check requests
        return done();
      }
      
      const host = request.headers.host;
      if (host && process.env.NODE_ENV === 'production') {
        // Check if accessing via direct port
        if (host.includes(':8088')) {
          reply.header('Location', 'https://api.ishswami.in/');
          reply.status(301).send();
          return;
        } else if (host.includes(':8088/docs')) {
          reply.header('Location', 'https://api.ishswami.in/docs/');
          reply.status(301).send();
          return;
        } else if (host.includes(':8088/queue-dashboard')) {
          reply.header('Location', 'https://api.ishswami.in/queue-dashboard/');
          reply.status(301).send();
          return;
        } else if (host.includes(':8088/redis-ui')) {
          reply.header('Location', 'https://api.ishswami.in/redis-ui/');
          reply.status(301).send();
          return;
        } else if (host.includes(':5555')) {
          reply.header('Location', 'https://api.ishswami.in/prisma/');
          reply.status(301).send();
          return;
        } else if (host.includes(':8081')) {
          reply.header('Location', 'https://api.ishswami.in/redis-commander/');
          reply.status(301).send();
          return;
        } else if (host.includes(':5050')) {
          reply.header('Location', 'https://api.ishswami.in/pgadmin/');
          reply.status(301).send();
          return;
        }
      }
      
      done();
    });

    // Configure Swagger with environment variables
    const port = configService.get('PORT') || configService.get('VIRTUAL_PORT') || 8088;
    const virtualHost = configService.get('VIRTUAL_HOST') || 'localhost';
    const apiUrl = configService.get('API_URL');
    const swaggerUrl = configService.get('SWAGGER_URL') || '/docs';
    const bullBoardUrl = configService.get('BULL_BOARD_URL') || '/queue-dashboard';
    const socketUrl = configService.get('SOCKET_URL') || '/socket.io';
    const redisCommanderUrl = configService.get('REDIS_COMMANDER_URL');
    const prismaStudioUrl = configService.get('PRISMA_STUDIO_URL');
    const loggerUrl = configService.get('LOGGER_URL') || '/logger';
    
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    
    // Add environment-specific Swagger setup
    if (process.env.NODE_ENV === 'production') {
      // In production, add CORS and security headers for Swagger UI
      await fastifyInstance.register(fastifyHelmet, {
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'https:', 'data:']
          }
        }
      });
    }
    
    SwaggerModule.setup(swaggerUrl.replace('/', ''), app, document, {
      ...swaggerCustomOptions,
      swaggerOptions: {
        ...swaggerCustomOptions.swaggerOptions,
        // Set the default server based on environment
        urls: [
          {
            url: `${apiUrl}${swaggerUrl}/swagger.json`,
            name: process.env.NODE_ENV === 'production' ? 'Production' : 'Development'
          }
        ]
      }
    });
    
    logger.log(`Swagger API documentation configured for ${process.env.NODE_ENV} environment`);

    // Start the server with improved error handling
    try {
      const port = envConfig.app.port;
      const host = envConfig.app.host;
      const bindAddress = envConfig.app.bindAddress;
      
      await app.listen(port, bindAddress);
      
      logger.log(`Application is running in ${envConfig.app.environment} mode:`);
      logger.log(`- Local: http://${host}:${port}`);
      logger.log(`- Base URL: ${envConfig.app.baseUrl}`);
      logger.log(`- Swagger Docs: ${envConfig.app.environment === 'production' ? envConfig.app.apiUrl : envConfig.app.baseUrl}${envConfig.urls.swagger}`);
      logger.log(`- Health Check: ${envConfig.app.baseUrl}/health`);
      
      if (envConfig.app.environment === 'development') {
        const devConfig = envConfig as typeof developmentConfig extends () => infer R ? R : never;
        logger.log('Development services:');
        logger.log(`- Redis Commander: ${devConfig.urls.redisCommander}`);
        logger.log(`- Prisma Studio: ${devConfig.urls.prismaStudio}`);
        logger.log(`- PgAdmin: ${devConfig.urls.pgAdmin}`);
      }
      
      // Graceful shutdown handlers
      const signals = ['SIGTERM', 'SIGINT'];
      
      signals.forEach(signal => {
        process.on(signal, async () => {
          logger.log(`Received ${signal}, starting graceful shutdown...`);
          
          const shutdownTimeout = setTimeout(() => {
            logger.error('Shutdown timed out, forcing exit');
            process.exit(1);
          }, 10000);
          
          try {
            // Close WebSocket connections
            const wsAdapter = app.get(IoAdapter, { strict: false });
            if (wsAdapter && wsAdapter instanceof IoAdapter) {
              logger.log('Closing WebSocket connections...');
              const httpServer = app.getHttpServer();
              if (httpServer) {
                await new Promise<void>((resolve) => {
                  httpServer.close(() => {
                    logger.log('WebSocket server closed');
                    resolve();
                  });
                });
              }
            }
            
            // Close database connections
            const prismaService = app.get(PrismaService);
            if (prismaService) {
              logger.log('Closing database connections...');
              await prismaService.$disconnect();
            }
            
            // Close Redis connections
            if (pubClient) {
              logger.log('Closing Redis pub connection...');
              await pubClient.quit();
            }
            if (subClient) {
              logger.log('Closing Redis sub connection...');
              await subClient.quit();
            }
            
            // Close the app
            await app.close();
            
            clearTimeout(shutdownTimeout);
            logger.log('Application shut down successfully');
            process.exit(0);
      } catch (error) {
            clearTimeout(shutdownTimeout);
            logger.error('Error during shutdown:', error);
            process.exit(1);
          }
        });
      });
      
    } catch (listenError) {
      await loggingService?.log(
        LogType.ERROR,
        AppLogLevel.ERROR,
        `Failed to start server: ${listenError.message}`,
        'Bootstrap',
        { error: listenError.stack }
      );
      throw new Error(`Server startup failed: ${listenError.message}`);
    }

  } catch (error) {
    if (loggingService) {
      try {
        await loggingService.log(
          LogType.ERROR,
          AppLogLevel.ERROR,
          `Failed to start application: ${error.message}`,
          'Bootstrap',
          { 
            error: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : 'No stack trace available',
            details: error
          }
        );
      } catch (logError) {
        console.error('CRITICAL: Failed to log through LoggingService:', logError);
      }
    } else {
      console.error('CRITICAL: Failed to start application:', error);
    }

    try {
      if (app) {
        await app.close();
      }
    } catch (closeError) {
      console.error('CRITICAL: Failed to close application:', closeError);
    }

    process.exit(1);
  }
}

// Add unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Add uncaught exception handler
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

bootstrap().catch((error) => {
  console.error('CRITICAL: Fatal error during bootstrap:', error);
  process.exit(1);
});