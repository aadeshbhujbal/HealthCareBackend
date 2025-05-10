import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { ValidationPipe, Logger, LogLevel, INestApplication } from '@nestjs/common';
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./libs/filters/http-exception.filter";
import { initDatabase } from "./shared/database/scripts/init-db";
import fastifyHelmet from '@fastify/helmet';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { swaggerConfig, swaggerCustomOptions } from './config/swagger.config';
import { LoggingService } from './shared/logging/logging.service';
import { LogType } from './shared/logging/types/logging.types';
import { LogLevel as AppLogLevel } from './shared/logging/types/logging.types';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  let app: NestFastifyApplication & INestApplication;
  let loggingService: LoggingService;
  
  try {
    // Initialize database first with retries
    let dbInitialized = false;
    let dbRetries = 0;
    const maxDbRetries = 5;

    while (!dbInitialized && dbRetries < maxDbRetries) {
      try {
        await initDatabase();
        dbInitialized = true;
        logger.log('Database initialized successfully');
      } catch (dbError) {
        dbRetries++;
        logger.warn(`Database initialization attempt ${dbRetries}/${maxDbRetries} failed: ${dbError.message}`);
        if (dbRetries < maxDbRetries) {
          await new Promise(resolve => setTimeout(resolve, 5000 * dbRetries));
        } else {
          throw new Error(`Failed to initialize database after ${maxDbRetries} attempts: ${dbError.message}`);
        }
      }
    }

    // Create the NestJS application with increased timeout and better error handling
    const fastifyInstance = new FastifyAdapter({
      logger: {
        level: process.env.NODE_ENV === 'production' ? 'error' : 'debug',
        serializers: {
          req: (req) => ({
            method: req.method,
            url: req.url,
            path: req.routerPath,
            parameters: req.params,
            headers: req.headers
          }),
          res: (res) => ({
            statusCode: res.statusCode,
            time: res.responseTime
          }),
          err: (err: Error & { code?: string; statusCode?: number }) => ({
            type: 'Error',
            code: err.code || 'UNKNOWN',
            statusCode: err.statusCode || 500,
            message: err.message,
            stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
          })
        }
      },
      trustProxy: true,
      bodyLimit: 10 * 1024 * 1024, // 10MB
      ignoreTrailingSlash: true,
      disableRequestLogging: false,
      connectionTimeout: 120000, // Increased to 2 minutes
      keepAliveTimeout: 120000,  // Increased to 2 minutes
      maxRequestsPerSocket: 1000,
      pluginTimeout: 120000      // Increased to 2 minutes
    });

    // Add error handlers to the Fastify instance
    fastifyInstance.getInstance().addHook('onError', (request, reply, error, done) => {
      logger.error(`Fastify error: ${error.message}`, error.stack);
      done();
    });

    fastifyInstance.getInstance().addHook('onClose', (instance, done) => {
      logger.log('Fastify instance closing');
      done();
    });

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      fastifyInstance,
      {
        logger: process.env.NODE_ENV === 'production' 
          ? ['error', 'warn'] 
          : ['log', 'error', 'warn', 'debug', 'verbose'] as LogLevel[],
        bufferLogs: true,
        cors: {
          origin: process.env.NODE_ENV === 'production' 
            ? process.env.CORS_ORIGIN?.split(',') || ['https://ishswami.in', 'https://api.ishswami.in']
            : ['http://localhost:8088'],
          methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
          credentials: true,
          preflightContinue: false,
          optionsSuccessStatus: 204
        },
        abortOnError: false // Prevent immediate shutdown on initialization errors
      }
    );

    // Initialize core services with error handling
    try {
      const configService = app.get(ConfigService);
      loggingService = app.get(LoggingService);
      const eventEmitter = new EventEmitter2();

      // Apply global pipes and filters
      app.useGlobalPipes(new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true
      }));
      app.useGlobalFilters(new HttpExceptionFilter());

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
        const { IoAdapter } = await import('@nestjs/platform-socket.io');
        const { createAdapter } = await import('@socket.io/redis-adapter');
        const { createClient } = await import('redis');
        
        // Redis client configuration with increased timeouts
        const redisConfig = {
          url: `redis://${configService.get('REDIS_HOST', 'localhost')}:${configService.get('REDIS_PORT', '6379')}`,
          password: configService.get('REDIS_PASSWORD', ''),
          socket: {
            reconnectStrategy: (times: number) => {
              const maxDelay = 30000; // Increased max delay
              const delay = Math.min(times * 1000, maxDelay);
              logger.log(`Redis reconnection attempt ${times}, delay: ${delay}ms`);
              return delay;
            },
            connectTimeout: 60000,    // Increased to 1 minute
            keepAlive: 120000        // Increased to 2 minutes
          },
          disableOfflineQueue: false,
          retryStrategy: (times: number) => {
            if (times > 10) {
              logger.error('Redis retry limit exceeded, failing');
              return null; // Stop retrying after 10 attempts
            }
            const delay = Math.min(times * 1000, 30000);
            logger.log(`Redis retry attempt ${times}, delay: ${delay}ms`);
            return delay;
          },
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          enableOfflineQueue: true
        };

        // Create Redis pub/sub clients with enhanced error handling
        const pubClient = createClient(redisConfig);
        const subClient = pubClient.duplicate();

        // Enhanced Redis connection event handling
        const handleRedisError = async (client: string, err: Error) => {
          logger.error(`Redis ${client} Client Error: ${err.message}`, err.stack);
          await loggingService?.log(
            LogType.ERROR,
            AppLogLevel.ERROR,
            `Redis ${client} Client Error: ${err.message}`,
            'Redis',
            { client, error: err.message, stack: err.stack }
          );
        };

        const handleRedisConnect = async (client: string) => {
          logger.log(`Redis ${client} Client Connected`);
          await loggingService?.log(
            LogType.SYSTEM,
            AppLogLevel.INFO,
            `Redis ${client} Client Connected`,
            'Redis',
            { client }
          );
        };

        pubClient.on('error', (err) => handleRedisError('Pub', err));
        subClient.on('error', (err) => handleRedisError('Sub', err));
        pubClient.on('connect', () => handleRedisConnect('Pub'));
        subClient.on('connect', () => handleRedisConnect('Sub'));
        
        // Add additional event handlers
        pubClient.on('reconnecting', () => logger.log('Redis Pub client reconnecting'));
        subClient.on('reconnecting', () => logger.log('Redis Sub client reconnecting'));
        pubClient.on('ready', () => logger.log('Redis Pub client ready'));
        subClient.on('ready', () => logger.log('Redis Sub client ready'));
        
        let redisConnected = false;
        let retryCount = 0;
        const maxRetries = 5;

        while (!redisConnected && retryCount < maxRetries) {
          try {
            await Promise.all([
              pubClient.connect().catch(err => {
                logger.error(`Pub client connection error: ${err.message}`);
                throw err;
              }),
              subClient.connect().catch(err => {
                logger.error(`Sub client connection error: ${err.message}`);
                throw err;
              })
            ]);
            
            // Verify connections are actually ready
            if (pubClient.isReady && subClient.isReady) {
              redisConnected = true;
              logger.log('Redis connections established and ready');
            } else {
              throw new Error('Redis clients connected but not ready');
            }
          } catch (redisError) {
            retryCount++;
            logger.warn(`Redis connection attempt ${retryCount}/${maxRetries} failed: ${redisError.message}`);
            
            // Clean up failed connections
            try {
              await pubClient.quit().catch(() => {});
              await subClient.quit().catch(() => {});
            } catch (cleanupError) {
              logger.error('Error during Redis connection cleanup:', cleanupError);
            }
            
            if (retryCount < maxRetries) {
              const delay = 5000 * retryCount;
              logger.log(`Waiting ${delay}ms before next Redis connection attempt`);
              await new Promise(resolve => setTimeout(resolve, delay));
            } else {
              throw new Error(`Failed to connect to Redis after ${maxRetries} attempts: ${redisError.message}`);
            }
          }
        }

        class CustomIoAdapter extends IoAdapter {
          private adapterConstructor: ReturnType<typeof createAdapter>;
          private isRedisConnected: boolean;

          constructor(app: any) {
            super(app);
            this.isRedisConnected = redisConnected;
            if (this.isRedisConnected) {
              this.adapterConstructor = createAdapter(pubClient, subClient);
            }
          }
          
          createIOServer(port: number, options?: any) {
            const server = super.createIOServer(port, {
              ...options,
              cors: {
                origin: process.env.CORS_ORIGIN?.split(',') || '*',
                methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
                credentials: true
              },
              path: '/socket.io',
              serveClient: false,
              transports: ['websocket', 'polling'],
              allowEIO3: true,
              pingTimeout: 120000,
              pingInterval: 30000,
              connectTimeout: 60000,
              maxHttpBufferSize: 1e6,
              connectionStateRecovery: {
                maxDisconnectionDuration: 5000,
                skipMiddlewares: true,
              }
            });

            try {
              if (this.isRedisConnected) {
                server.adapter(this.adapterConstructor);
                
                const adapterInstance = server.of('/').adapter;
                if (adapterInstance && typeof adapterInstance.on === 'function') {
                  adapterInstance.on('error', (error: any) => {
                    logger.error('Socket.io adapter error:', error);
                  });
                }
              }

              // Add health check endpoint
              server.of('/health').on('connection', (socket) => {
                socket.emit('health', { 
                  status: 'healthy', 
                  timestamp: new Date(),
                  redisConnected: this.isRedisConnected
                });
              });
              
              return server;
            } catch (error) {
              logger.error('Error configuring Socket.io server:', error);
              return super.createIOServer(port, options);
            }
          }
        }

        const customAdapter = new CustomIoAdapter(app);
        app.useWebSocketAdapter(customAdapter);
        
        await loggingService?.log(
          LogType.SYSTEM,
          AppLogLevel.INFO,
          'WebSocket adapter configured successfully',
          'WebSocket'
        );

      } catch (error) {
        logger.error('WebSocket initialization failed:', error);
        await loggingService?.log(
          LogType.ERROR,
          AppLogLevel.ERROR,
          `WebSocket adapter initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'WebSocket',
          { error: error instanceof Error ? error.stack : 'No stack trace available' }
        );
      }

      // Security headers with proper CSP
      await app.register(fastifyHelmet, {
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

      // Start the server with proper error handling
      const host = '0.0.0.0';
      const port = configService.get('PORT') || 8088;
      
      try {
        await app.listen(port, host);
        
        const startupInfo = {
          apiUrl: configService.get('API_URL') || `http://${host}:${port}`,
          swaggerUrl: `${configService.get('API_URL')}/docs`,
          bullBoardUrl: `${configService.get('API_URL')}/queue-dashboard`,
          loggerUrl: `${configService.get('API_URL')}/logger`,
          websocketUrl: `${configService.get('API_URL')}/socket`,
          environment: process.env.NODE_ENV || 'development'
        };

        await loggingService?.log(
          LogType.SYSTEM,
          AppLogLevel.INFO,
          'Application started successfully',
          'Bootstrap',
          { 
            ...startupInfo,
            socketioUrl: `${configService.get('API_URL')}/socket.io` 
          }
        );

        logger.log(`Server is running on: ${startupInfo.apiUrl}`);
      } catch (listenError) {
        logger.error(`Failed to start server on ${host}:${port}:`, listenError);
        throw new Error(`Server startup failed: ${listenError.message}`);
      }

    } catch (serviceError) {
      logger.error('Failed to initialize core services:', serviceError);
      throw serviceError;
    }

  } catch (error) {
    logger.error('Failed to start application:', error);
    
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
        logger.error('Failed to log error through LoggingService:', logError);
      }
    }

    try {
      if (app) {
        await app.close();
      }
    } catch (closeError) {
      logger.error('Failed to close application:', closeError);
    }

    process.exit(1);
  }
}

// Add graceful shutdown
process.on('SIGTERM', async () => {
  try {
    console.log('SIGTERM received. Starting graceful shutdown...');
    // Add your cleanup logic here
    process.exit(0);
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
});

bootstrap().catch((error) => {
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});