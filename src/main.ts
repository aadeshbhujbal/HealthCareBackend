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
    // Add initial delay to ensure services are ready
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Initialize database first
    await initDatabase();
    logger.log('Database initialized successfully');

    // Create the NestJS application with increased timeout
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({
        logger: {
          level: 'debug',
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
            })
          }
        },
        trustProxy: true,
        bodyLimit: 10 * 1024 * 1024, // 10MB
        ignoreTrailingSlash: true,
        disableRequestLogging: false,
        connectionTimeout: 60000, // Increased to 60 seconds
        keepAliveTimeout: 60000, // Increased to 60 seconds
        maxRequestsPerSocket: 1000,
        pluginTimeout: 60000 // Increased to 60 seconds
      }),
      {
        logger: ['log', 'error', 'warn', 'debug', 'verbose'] as LogLevel[],
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
        }
      }
    );

    // Initialize core services
    const configService = app.get(ConfigService);
    loggingService = app.get(LoggingService);
    const eventEmitter = new EventEmitter2();

    // Apply global pipes and filters
    app.useGlobalPipes(new ValidationPipe({
      transform: true,
      whitelist: true,
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
            const maxDelay = 10000; // Increased to 10 seconds
            const delay = Math.min(times * 500, maxDelay); // Increased delay between retries
            logger.log(`Redis reconnection attempt ${times}, delay: ${delay}ms`);
            return delay;
          },
          connectTimeout: 30000, // Increased to 30 seconds
          keepAlive: 60000 // Increased to 60 seconds
        },
        disableOfflineQueue: false
      };

      // Create Redis pub/sub clients
      const pubClient = createClient(redisConfig);
      const subClient = pubClient.duplicate();

      // Enhanced Redis connection event handling
      const handleRedisError = async (client: string, err: Error) => {
        await loggingService?.log(
          LogType.ERROR,
          AppLogLevel.ERROR,
          `Redis ${client} Client Error: ${err.message}`,
          'Redis',
          { client, error: err.message, stack: err.stack }
        );
      };

      const handleRedisConnect = async (client: string) => {
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
      
      let redisConnected = false;
      let retryCount = 0;
      const maxRetries = 5;

      while (!redisConnected && retryCount < maxRetries) {
        try {
          await Promise.all([pubClient.connect(), subClient.connect()]);
          redisConnected = true;
        } catch (redisError) {
          retryCount++;
          logger.warn(`Redis connection attempt ${retryCount} failed:`, redisError);
          if (retryCount < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
          }
        }
      }

      if (!redisConnected) {
        throw new Error('Failed to connect to Redis after multiple attempts');
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
            pingTimeout: 120000, // Increased to 120 seconds
            pingInterval: 30000, // Increased to 30 seconds
            connectTimeout: 60000, // Increased to 60 seconds
            maxHttpBufferSize: 1e6,
            connectionStateRecovery: {
              maxDisconnectionDuration: 5000, // Increased to 5 seconds
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

            server.of('/health').on('connection', (socket) => {
              socket.emit('health', { status: 'healthy', timestamp: new Date() });
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
      // Don't throw here, continue without WebSocket
    }

    // Security headers
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

    // Configure route handling for admin paths
    const fastifyInstance = app.getHttpAdapter().getInstance();
    fastifyInstance.addHook('onRequest', (request, reply, done) => {
      const url = request.url;
      const isAdminPath = url.startsWith('/docs') || 
                          url.startsWith('/queue-dashboard') || 
                          url.startsWith('/logger') || 
                          (url.startsWith('/prisma') && process.env.NODE_ENV !== 'production');
      
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
        } else if (host.includes(':5555') && process.env.NODE_ENV !== 'production') {
          reply.header('Location', 'https://api.ishswami.in/prisma/');
          reply.status(301).send();
          return;
        }
      }
      
      done();
    });

    // Configure Swagger
    const apiUrl = configService.get('API_URL');
    const port = configService.get('PORT') || configService.get('VIRTUAL_PORT') || 8088;

    const config = new DocumentBuilder()
      .setTitle('Healthcare API')
      .setDescription('The Healthcare API description')
      .setVersion('1.0')
      .addBearerAuth()
      .addServer(apiUrl || `http://localhost:${port}`)
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);

    // Start the server with increased timeout
    const host = '0.0.0.0';
    
    try {
      // Add a delay before starting the server
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      await app.listen(port, host);
      
      const startupInfo = {
        apiUrl: apiUrl || `http://${host}:${port}`,
        swaggerUrl: `${apiUrl}/docs`,
        bullBoardUrl: `${apiUrl}/queue-dashboard`,
        loggerUrl: `${apiUrl}/logger`,
        websocketUrl: `${apiUrl}/socket`,
        environment: process.env.NODE_ENV || 'development'
      };

      await loggingService?.log(
        LogType.SYSTEM,
        AppLogLevel.INFO,
        'Application started successfully',
        'Bootstrap',
        { 
          ...startupInfo,
          socketioUrl: `${apiUrl}/socket.io` 
        }
      );
    } catch (listenError) {
      logger.error(`Failed to start server on ${host}:${port}:`, listenError);
      throw new Error(`Server startup failed: ${listenError.message}`);
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

bootstrap().catch((error) => {
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});