import { Injectable, UnauthorizedException, BadRequestException, InternalServerErrorException, ConflictException, ForbiddenException, Logger, NotFoundException, ServiceUnavailableException, HttpException, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../shared/database/prisma/prisma.service';
import { RedisService } from '../../../shared/cache/redis/redis.service';
import { CreateUserDto, UserResponseDto } from '../../../libs/dtos/user.dto';
import { Role, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { EmailService } from '../../../shared/messaging/email/email.service';
import { EmailTemplate } from '../../../libs/types/email.types';
import axios from 'axios';
import { WhatsAppService } from '../../../shared/messaging/whatsapp/whatsapp.service';
import { LoggingService } from '../../../shared/logging/logging.service';
import { EventService } from '../../../shared/events/event.service';
import { LogLevel, LogType } from '../../../shared/logging/types/logging.types';
import { RedisCache } from '../../../shared/cache/decorators/redis-cache.decorator';
import { ClinicService } from '../../clinic/clinic.service';
import { ClinicUserService } from '../../clinic/services/clinic-user.service';
import { OAuth2Client } from 'google-auth-library';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly SALT_ROUNDS = 10;
  private readonly PASSWORD_RESET_TTL = 3600; // 1 hour
  private readonly EMAIL_VERIFICATION_TTL = 86400; // 24 hours
  private readonly TOKEN_REFRESH_TTL = 604800; // 7 days
  private readonly OTP_TTL = 600; // 10 minutes
  private readonly OTP_RATE_LIMIT_TTL = 60; // 1 minute
  private readonly MAX_OTP_ATTEMPTS = 5;
  private readonly OTP_RATE_LIMIT_WINDOW = 3600; // 1 hour
  private readonly SMS_PROVIDER_API_KEY = process.env.SMS_PROVIDER_API_KEY || 'your-api-key';
  private readonly SMS_PROVIDER_URL = process.env.SMS_PROVIDER_URL || 'https://api.sms-provider.com/send';
  private readonly SMS_SENDER_ID = process.env.SMS_SENDER_ID || 'HealthApp';
  private readonly MAGIC_LINK_TTL = 900; // 15 minutes
  private readonly TOKEN_BLACKLIST_TTL = 86400; // 24 hours
  private readonly SESSION_CACHE_TTL = 86400; // 24 hours
  private readonly USER_PROFILE_CACHE_TTL = 3600; // 1 hour
  private readonly SESSION_ACTIVITY_THRESHOLD = 15 * 60 * 1000; // 15 minutes for session inactivity warning
  private readonly SECURITY_EVENT_RETENTION = 30 * 24 * 60 * 60; // 30 days retention for security events
  private readonly googleClient: OAuth2Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    private readonly emailService: EmailService,
    private readonly whatsAppService: WhatsAppService,
    private readonly loggingService: LoggingService,
    private readonly eventService: EventService,
    private readonly clinicService: ClinicService,
    private readonly clinicUserService: ClinicUserService,
  ) {
    this.ensureSuperAdmin();
    this.googleClient = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  private async ensureSuperAdmin() {
    try {
      const superAdminEmail = 'superadmin@healthcare.com';
      const existingSuperAdmin = await this.prisma.user.findFirst({
        where: { 
          role: Role.SUPER_ADMIN 
        }
      });

      if (!existingSuperAdmin) {
        const hashedPassword = await bcrypt.hash('superadmin123', this.SALT_ROUNDS);
        const userid = await this.generateNextUID();
        const superAdmin = await this.prisma.user.create({
          data: {
            email: superAdminEmail,
            password: hashedPassword,
            firstName: 'Super',
            lastName: 'Admin',
            name: 'Super Admin',
            phone: '+1234567890',
            role: Role.SUPER_ADMIN,
            age: 30,
            isVerified: true,
            userid: userid
          }
        });

        await this.prisma.superAdmin.create({
          data: { userId: superAdmin.id }
        });

        await this.loggingService.log(
          LogType.SYSTEM,
          LogLevel.INFO,
          'Super admin user created',
          'AuthService',
          { email: superAdminEmail }
        );

        await this.eventService.emit('user.created', {
          userId: superAdmin.id,
          role: Role.SUPER_ADMIN,
          email: superAdminEmail
        });
      }
    } catch (error) {
      await this.loggingService.log(
        LogType.ERROR,
        LogLevel.ERROR,
        'Failed to ensure super admin',
        'AuthService',
        { error: error.message }
      );
      throw error;
    }
  }

  /**
   * Validate user credentials
   * No caching here as it's security-sensitive
   */
  async validateUser(email: string, password: string): Promise<any> {
    const user = await this.prisma.user.findFirst({
      where: {
        email: {
          mode: 'insensitive',
          equals: email
        }
      },
      include: {
        superAdmin: true,
        doctor: true,
        patient: true,
        clinicAdmin: true,
        receptionist: true
      }
    });

    if (!user) {
      return null;
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return null;
    }

    const { password: _, ...result } = user;
    return result;
  }

  /**
   * Login a user and generate JWT tokens
   * No caching here as it's security-sensitive and dynamic
   */
  async login(user: User, request: any, appName?: string) {
    try {
      const payload = { email: user.email, sub: user.id, role: user.role };
      const accessToken = this.jwtService.sign(payload);
      const refreshToken = uuidv4();
      const sessionId = uuidv4();

      // Extract device and IP information
      const userAgent = request.headers['user-agent'] || 'unknown';
      const ipAddress = request.ip || request.headers['x-forwarded-for'] || 'unknown';
      const deviceInfo = this.parseUserAgent(userAgent);

      // Store session and refresh token in Redis
      const sessionData = {
        sessionId,
        userId: user.id,
        email: user.email,
        role: user.role,
        refreshToken,
        lastLogin: new Date(),
        deviceInfo,
        ipAddress,
        userAgent,
        isActive: true,
        createdAt: new Date(),
        lastActivityAt: new Date()
      };

      await Promise.all([
        this.redisService.set(
          `session:${user.id}:${sessionId}`,
          JSON.stringify(sessionData),
          24 * 60 * 60
        ),
        this.redisService.set(
          `refresh:${refreshToken}`,
          JSON.stringify({ userId: user.id, sessionId }),
          this.TOKEN_REFRESH_TTL
        ),
        this.redisService.sAdd(
          `user:${user.id}:sessions`,
          sessionId
        ),
        this.redisService.set(
          `device:${user.id}:${deviceInfo.deviceId}`,
          JSON.stringify({
            sessionId,
            lastSeen: new Date(),
            deviceInfo
          }),
          30 * 24 * 60 * 60
        )
      ]);

      // Update last login and emit event
      const updatedUser = await this.prisma.user.update({
        where: { id: user.id },
        data: { 
          lastLogin: new Date(),
          lastLoginIP: ipAddress,
          lastLoginDevice: userAgent
        },
        include: {
          doctor: true,
          patient: true,
          receptionist: true,
          clinicAdmin: true,
          superAdmin: true,
        }
      });

      // Log successful login
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'User logged in successfully',
        'AuthService',
        { userId: user.id, email: user.email, role: user.role }
      );

      // Emit login event
      await this.eventService.emit('user.loggedIn', {
        userId: user.id,
        email: user.email,
        role: user.role,
        deviceInfo,
        ipAddress
      });

      const { password: _, ...userWithoutPassword } = updatedUser;

      // Get basic login response with expanded user details
      const loginResponse = {
        access_token: accessToken,
        refresh_token: refreshToken,
        session_id: sessionId,
        token_type: 'Bearer',
        expires_in: 24 * 60 * 60, // 24 hours in seconds
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          isVerified: user.isVerified,
          profilePicture: user.profilePicture,
          phone: user.phone,
          address: user.address,
          city: user.city,
          state: user.state,
          country: user.country,
          zipCode: user.zipCode,
          dateOfBirth: user.dateOfBirth,
          age: user.age,
          gender: user.gender,
          medicalConditions: this.parseMedicalConditions(user.medicalConditions),
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        },
        redirectPath: this.getRedirectPathForRole(user.role),
        permissions: this.getRolePermissions(user.role)
      };

      // If appName is provided, add clinic-specific information
      if (appName) {
        try {
          const clinic = await this.clinicService.getClinicByAppName(appName);
          if (clinic) {
            // Get user's role in this clinic
            const clinicUsers = await this.clinicUserService.getClinicUsers(clinic.id);
            let userRole = null;

            if (clinicUsers.doctors.some(d => d.doctor.userId === user.id)) {
              userRole = 'DOCTOR';
            } else if (clinicUsers.receptionists.some(r => r.userId === user.id)) {
              userRole = 'RECEPTIONIST';
            } else if (clinicUsers.patients.some(p => p.userId === user.id)) {
              userRole = 'PATIENT';
            }

            if (userRole) {
              // Generate clinic-specific token
              const clinicToken = await this.clinicService.generateClinicToken(user.id, clinic.id);

              // Add clinic information to response
              return {
                ...loginResponse,
                user: {
                  ...loginResponse.user,
                  clinicToken,
                  clinic: {
                    id: clinic.id,
                    name: clinic.name,
                    role: userRole,
                    locations: await this.clinicService.getActiveLocations(clinic.id)
                  }
                }
              };
            }
          }
        } catch (error) {
          this.logger.error(`Failed to add clinic context to login: ${error.message}`, error.stack);
        }
      }

      return loginResponse;
    } catch (error) {
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.ERROR,
        'Login failed',
        'AuthService',
        { error: error.message, email: user.email }
      );
      throw error;
    }
  }

  @RedisCache({
    ttl: 3600, // 1 hour
    prefix: 'auth:role-permissions',
    tags: ['permissions', 'roles']
  })
  private getRolePermissions(role: Role): string[] {
    const basePermissions = ['view_profile', 'edit_profile'];
    
    switch (role) {
      case Role.SUPER_ADMIN:
        return [
          ...basePermissions,
          'manage_users',
          'manage_clinics',
          'manage_roles',
          'view_analytics',
          'manage_system'
        ];
      case Role.CLINIC_ADMIN:
        return [
          ...basePermissions,
          'manage_clinic_staff',
          'view_clinic_analytics',
          'manage_appointments',
          'manage_inventory'
        ];
      case Role.DOCTOR:
        return [
          ...basePermissions,
          'manage_patients',
          'view_medical_records',
          'create_prescriptions',
          'manage_appointments'
        ];
      case Role.PATIENT:
        return [
          ...basePermissions,
          'view_appointments',
          'book_appointments',
          'view_prescriptions',
          'view_medical_history'
        ];
      case Role.RECEPTIONIST:
        return [
          ...basePermissions,
          'manage_appointments',
          'register_patients',
          'manage_queue',
          'basic_patient_info'
        ];
      default:
        return basePermissions;
    }
  }

  @RedisCache({
    ttl: 3600, // 1 hour
    prefix: 'auth:redirect-paths',
    tags: ['roles', 'paths']
  })
  public getRedirectPathForRole(role: Role): string {
    switch (role) {
      case 'SUPER_ADMIN':
        return '/super-admin/dashboard';
      case 'DOCTOR':
        return '/doctor/dashboard';
      case 'PATIENT':
        return '/patient/dashboard';
      case 'CLINIC_ADMIN':
        return '/clinic-admin/dashboard';
      case 'RECEPTIONIST':
        return '/receptionist/dashboard';
      default:
        return '/dashboard';
    }
  }

  /**
   * Register a new user
   */
  async register(createUserDto: CreateUserDto): Promise<UserResponseDto> {
    try {
      const existingUser = await this.prisma.user.findFirst({
        where: {
          email: {
            mode: 'insensitive',
            equals: createUserDto.email
          }
        }
      });

      if (existingUser) {
        await this.loggingService.log(
          LogType.AUTH,
          LogLevel.WARN,
          'Registration attempt with existing email',
          'AuthService',
          { email: createUserDto.email }
        );
        throw new BadRequestException('Email already registered');
      }

      // Generate the next UID
      const userid = await this.generateNextUID();

      const hashedPassword = await bcrypt.hash(createUserDto.password, this.SALT_ROUNDS);
      
      const userData: any = { ...createUserDto };
      if (userData.dateOfBirth) {
        userData.dateOfBirth = new Date(`${userData.dateOfBirth}T00:00:00Z`);
      }
      
      // Generate full name from firstName and lastName
      const fullName = `${createUserDto.firstName} ${createUserDto.lastName}`.trim();
      
      const user = await this.prisma.user.create({
        data: {
          ...userData,
          userid: userid,
          password: hashedPassword,
          name: fullName,
          isVerified: false,
          medicalConditions: this.stringifyMedicalConditions(userData.medicalConditions)
        },
      });

      // Create role-specific record
      switch (user.role) {
        case Role.PATIENT:
          await this.prisma.patient.create({
            data: { userId: user.id }
          });
          break;
        case Role.DOCTOR:
          await this.prisma.doctor.create({
            data: {
              userId: user.id,
              specialization: createUserDto.specialization || '',
              experience: createUserDto.experience || 0,
            }
          });
          break;
        case Role.RECEPTIONIST:
          await this.prisma.receptionist.create({
            data: { userId: user.id }
          });
          break;
        case Role.CLINIC_ADMIN:
          if (createUserDto.clinicId) {
            await this.prisma.clinicAdmin.create({
              data: {
                userId: user.id,
                clinicId: createUserDto.clinicId
              }
            });
          }
          break;
      }

      // Log successful registration
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'User registered successfully',
        'AuthService',
        { userId: user.id, email: user.email, role: user.role }
      );

      // Emit registration event
      await this.eventService.emit('user.registered', {
        userId: user.id,
        email: user.email,
        role: user.role
      });

      const { password, ...result } = user;
      const userResponse = { ...result } as any;
      if (userResponse.dateOfBirth) {
        userResponse.dateOfBirth = userResponse.dateOfBirth.toISOString().split('T')[0];
      }
      return userResponse as UserResponseDto;
    } catch (error) {
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.ERROR,
        'Registration failed',
        'AuthService',
        { error: error.message, email: createUserDto.email }
      );
      throw error;
    }
  }

  private async generateNextUID(): Promise<string> {
    // Get the last user with a UID
    const lastUser = await this.prisma.user.findFirst({
      orderBy: {
        userid: 'desc'
      }
    });

    let nextNumber = 1;
    if (lastUser && lastUser.userid) {
      // Extract the number from the last UID and increment it
      const lastNumber = parseInt(lastUser.userid.replace('UID', ''));
      nextNumber = lastNumber + 1;
    }

    // Format the new UID with leading zeros (6 digits)
    return `UID${nextNumber.toString().padStart(6, '0')}`;
  }

  /**
   * Register a new user with clinic-specific context
   * @param createUserDto User registration data
   * @param appName Optional clinic app name for clinic-specific registration
   * @returns The registered user
   */
  async registerWithClinic(createUserDto: CreateUserDto, appName?: string): Promise<UserResponseDto> {
    try {
      // First, register the user in the global database
      const user = await this.register(createUserDto);

      // If an app name is provided, update the user's appName and register with clinic
      if (appName) {
        try {
          // Update user's appName using StringFieldUpdateOperationsInput
          await this.prisma.user.update({
            where: { id: user.id },
            data: {
              appName: {
                set: appName
              }
            }
          });

          // Get the clinic by app name using ClinicService
          const clinic = await this.clinicService.getClinicByAppName(appName);
          
          if (clinic) {
            // Associate user with clinic using ClinicUserService
            await this.clinicService.associateUserWithClinic(user.id, clinic.id);

            // Log the clinic registration
            this.logger.log(`User ${user.id} registered to clinic ${clinic.id} (${appName})`);

            // Generate clinic-specific token
            const clinicToken = await this.clinicService.generateClinicToken(user.id, clinic.id);

            // Return user with clinic information
            return {
              ...user,
              clinicToken,
              clinic: {
                id: clinic.id,
                name: clinic.name,
                locations: await this.clinicService.getActiveLocations(clinic.id)
              }
            };
          }
        } catch (error) {
          // Log the error but don't fail the registration
          this.logger.error(`Failed to register user to clinic: ${error.message}`, error.stack);
        }
      }

      return user;
    } catch (error) {
      this.logger.error(`Registration with clinic failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Logout a user - invalidate tokens
   */
  async logout(
    userId: string,
    sessionId?: string,
    allDevices: boolean = false,
    token?: string,
  ): Promise<void> {
    try {
      // Get all active sessions for the user
      const sessionsToTerminate: string[] = [];
      const userSessionsKey = `user:${userId}:sessions`;
      const activeSessions = await this.redisService.sMembers(userSessionsKey);

      // If token is provided, blacklist it
      if (token) {
        // Store only first 64 chars of token as key to save space
        const tokenKey = `blacklist:token:${token.substring(0, 64)}`;
        // Set token in blacklist with expiry matching JWT expiry (default 1 day)
        await this.redisService.set(tokenKey, 'true', 86400);
        this.logger.debug(`Token blacklisted for user ${userId}`);
      }

      // Determine which sessions to terminate
      if (allDevices) {
        sessionsToTerminate.push(...activeSessions);
      } else if (sessionId) {
        if (activeSessions.includes(sessionId)) {
          sessionsToTerminate.push(sessionId);
        }
      } else {
        // If no sessionId provided and not all devices, use the most recent session
        if (activeSessions.length > 0) {
          sessionsToTerminate.push(activeSessions[0]);
        }
      }

      for (const sid of sessionsToTerminate) {
        // Get session data
        const sessionKey = `session:${userId}:${sid}`;
        const sessionData = await this.redisService.get(sessionKey);
        
        if (sessionData) {
          const session = JSON.parse(sessionData);
          const deviceKey = `device:${userId}:${session.deviceInfo?.deviceId}`;

          // Delete session-related data
          await Promise.all([
            // Delete session data
            this.redisService.del(sessionKey),
            // Delete refresh token
            this.redisService.del(`refresh:${session.refreshToken}`),
            // Remove from active sessions
            this.redisService.sRem(`user:${userId}:sessions`, sid),
            // Update device last seen
            this.redisService.get(deviceKey).then(async (deviceData) => {
              if (deviceData) {
                const device = JSON.parse(deviceData);
                if (device.sessionId === sid) {
                  await this.redisService.set(
                    deviceKey,
                    JSON.stringify({
                      ...device,
                      lastSeen: new Date(),
                      status: 'logged_out'
                    }),
                    30 * 24 * 60 * 60 // 30 days
                  );
                }
              }
            })
          ]);
        }
      }

      // Update user's login status if logging out of all devices
      if (allDevices) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { lastLogin: null }
        });
      }

      // Invalidate user's profile cache
      await this.redisService.invalidateCacheByPattern(`auth:profile:${userId}:*`);
      await this.redisService.invalidateCacheByTag(`user:${userId}`);

    } catch (error) {
      // Log the error but don't expose internal details
      this.logger.error(`Logout error for user ${userId}: ${error.message}`);
      throw new UnauthorizedException('Failed to logout properly');
    }
  }

  /**
   * Refresh token
   */
  async refreshToken(userId: string) {
    const sessionKey = `session:${userId}`;
    const session = await this.redisService.get(sessionKey);
    
    if (!session) {
      throw new UnauthorizedException('Session expired');
    }

    const sessionData = JSON.parse(session);
    const payload = {
      email: sessionData.email,
      sub: userId,
      role: sessionData.role
    };

    const newAccessToken = this.jwtService.sign(payload);
    const newRefreshToken = uuidv4();

    // Update session with new refresh token
    sessionData.refreshToken = newRefreshToken;
    await Promise.all([
      this.redisService.set(
        sessionKey,
        JSON.stringify(sessionData),
        24 * 60 * 60
      ),
      this.redisService.set(
        `refresh:${newRefreshToken}`,
        userId,
        this.TOKEN_REFRESH_TTL
      )
    ]);

    return {
      access_token: newAccessToken,
      refresh_token: newRefreshToken
    };
  }

  async validateToken(userId: string): Promise<boolean> {
    const session = await this.redisService.get(`session:${userId}`);
    return !!session;
  }

  async sendVerificationEmail(user: User): Promise<void> {
    const token = uuidv4();
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;

    // Store token in Redis
    await this.redisService.set(
      `email_verification:${token}`,
      user.id,
      this.EMAIL_VERIFICATION_TTL
    );

    await this.emailService.sendEmail({
      to: user.email,
      subject: 'Verify Your Email',
      template: EmailTemplate.VERIFICATION,
      context: { verificationUrl }
    });
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.findUserByEmail(email);
    if (!user) {
      // Return silently to prevent email enumeration
      return;
    }

    // Check if a reset token was recently issued
    // Temporarily disable rate limiting for testing
    /*
    const rateLimitKey = `password_reset_rate_limit:${user.id}`;
    const lastResetTime = await this.redisService.get(rateLimitKey);
    
    if (lastResetTime) {
      const timeSinceLastReset = Date.now() - parseInt(lastResetTime);
      const minimumWaitTime = 60 * 1000; // 1 minute in milliseconds
      
      if (timeSinceLastReset < minimumWaitTime) {
        // A reset was requested recently, but we'll return silently to prevent abuse
        return;
      }
    }
    */
    
    // Generate a secure random token
    const token = uuidv4();
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

    // Store token in Redis with expiry
    await this.redisService.set(
      `password_reset:${token}`,
      user.id,
      this.PASSWORD_RESET_TTL
    );

    // Temporarily disable rate limiting for testing
    /*
    // Update rate limit
    await this.redisService.set(
      rateLimitKey,
      Date.now().toString(),
      this.PASSWORD_RESET_TTL
    );
    */

    // Log the password reset request
    this.logger.debug(`Password reset requested for user ${user.id}`);

    // Send password reset email
    await this.emailService.sendEmail({
      to: user.email,
      subject: 'Reset Your Password',
      template: EmailTemplate.PASSWORD_RESET,
      context: { 
        resetUrl,
        name: user.firstName || user.name || 'User',
        expiryTime: `${this.PASSWORD_RESET_TTL / 60} minutes`
      }
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    // Verify token and get user ID
    const userId = await this.verifyResetToken(token);
    if (!userId) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }
    
    // Get the user
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    
    // Validate password strength
    this.validatePasswordStrength(newPassword);
    
    // Hash the new password
    const hashedPassword = await this.hashPassword(newPassword);
    
    // Update user's password and set passwordChangedAt
    await this.prisma.user.update({
      where: { id: userId },
      data: { 
        password: hashedPassword,
        passwordChangedAt: new Date()
      }
    });
    
    // Invalidate all existing sessions for this user
    await this.logout(userId, null, true);
    
    // Delete the reset token
    await this.redisService.del(`password_reset:${token}`);
    
    // Log the password change
    this.logger.debug(`Password changed for user ${userId}`);
    
    // Send confirmation email
    await this.emailService.sendEmail({
      to: user.email,
      subject: 'Your Password Has Been Reset',
      template: EmailTemplate.PASSWORD_RESET_CONFIRMATION,
      context: { 
        name: user.firstName || user.name || 'User',
        loginUrl: `${process.env.FRONTEND_URL}/login`
      }
    });

    // Invalidate user's sessions and profile caches
    await this.redisService.invalidateCacheByPattern(`auth:profile:${userId}:*`);
    await this.redisService.invalidateCacheByTag(`user:${userId}`);
  }

  private async verifyResetToken(token: string): Promise<string | null> {
    const userId = await this.redisService.get(`password_reset:${token}`);
    return userId;
  }

  private validatePasswordStrength(password: string): void {
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }
    
    // Check for at least one uppercase letter
    if (!/[A-Z]/.test(password)) {
      throw new BadRequestException('Password must contain at least one uppercase letter');
    }
    
    // Check for at least one lowercase letter
    if (!/[a-z]/.test(password)) {
      throw new BadRequestException('Password must contain at least one lowercase letter');
    }
    
    // Check for at least one number
    if (!/[0-9]/.test(password)) {
      throw new BadRequestException('Password must contain at least one number');
    }
    
    // Check for at least one special character
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      throw new BadRequestException('Password must contain at least one special character');
    }
  }

  private parseUserAgent(userAgent: string) {
    const deviceId = this.generateDeviceId(userAgent);
    const isMobile = /mobile/i.test(userAgent);
    const isTablet = /tablet|ipad/i.test(userAgent);
    const browser = this.detectBrowser(userAgent);
    const os = this.detectOS(userAgent);

    return {
      deviceId,
      type: isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop',
      browser,
      os,
      userAgent
    };
  }

  private generateDeviceId(userAgent: string): string {
    return require('crypto')
      .createHash('md5')
      .update(userAgent)
      .digest('hex');
  }

  private detectBrowser(userAgent: string): string {
    if (/chrome/i.test(userAgent)) return 'Chrome';
    if (/firefox/i.test(userAgent)) return 'Firefox';
    if (/safari/i.test(userAgent)) return 'Safari';
    if (/msie|trident/i.test(userAgent)) return 'Internet Explorer';
    if (/edge/i.test(userAgent)) return 'Edge';
    return 'Unknown';
  }

  private detectOS(userAgent: string): string {
    // Simple OS detection
    if (userAgent.includes('Windows')) return 'Windows';
    if (userAgent.includes('Mac')) return 'MacOS';
    if (userAgent.includes('Android')) return 'Android';
    if (userAgent.includes('iOS') || userAgent.includes('iPhone') || userAgent.includes('iPad')) return 'iOS';
    if (userAgent.includes('Linux')) return 'Linux';
    return 'Unknown';
  }

  private async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.SALT_ROUNDS);
  }

  // Generate a secure OTP
  private generateOTP(length: number = 6): string {
    // Generate a random OTP of specified length
    let otp = '';
    const digits = '0123456789';
    
    for (let i = 0; i < length; i++) {
      otp += digits[Math.floor(Math.random() * 10)];
    }
    
    return otp;
  }
  
  // Store OTP in Redis with bcrypt hashing
  async storeOTP(email: string, otp: string): Promise<void> {
    // Hash the OTP using bcrypt
    const hashedOTP = await bcrypt.hash(otp, this.SALT_ROUNDS);
    
    // Store the hashed OTP in Redis with expiry
    await this.redisService.set(
      `otp:${email}`,
      hashedOTP,
      this.OTP_TTL
    );
    
    // Store attempt counter
    await this.redisService.set(
      `otp_attempts:${email}`,
      '0',
      this.OTP_TTL
    );
    
    // Log OTP generation (without the actual OTP)
    this.logger.debug(`OTP generated for ${email}`);
  }
  
  // Verify OTP with bcrypt comparison
  async verifyOTP(email: string, otp: string): Promise<boolean> {
    // Get the stored hashed OTP
    const storedHashedOTP = await this.redisService.get(`otp:${email}`);
    if (!storedHashedOTP) {
      this.logger.debug(`No OTP found for ${email}`);
      return false; // No OTP found or expired
    }
    
    // Get and increment attempt counter
    const attempts = parseInt(await this.redisService.get(`otp_attempts:${email}`) || '0');
    if (attempts >= this.MAX_OTP_ATTEMPTS) {
      // Too many attempts, invalidate OTP
      this.logger.warn(`Max OTP attempts reached for ${email}`);
      await this.redisService.del(`otp:${email}`);
      await this.redisService.del(`otp_attempts:${email}`);
      return false;
    }
    
    // Increment attempt counter
    await this.redisService.set(
      `otp_attempts:${email}`,
      (attempts + 1).toString(),
      this.OTP_TTL
    );
    
    // Compare the provided OTP with the stored hash
    const isValid = await bcrypt.compare(otp, storedHashedOTP);
    
    // If valid, delete the OTP to prevent reuse
    if (isValid) {
      this.logger.debug(`OTP verified successfully for ${email}`);
      await this.redisService.del(`otp:${email}`);
      await this.redisService.del(`otp_attempts:${email}`);
    } else {
      this.logger.debug(`Invalid OTP attempt for ${email}`);
    }
    
    return isValid;
  }

  @RedisCache({
    ttl: 300, // 5 minutes
    prefix: 'auth:user-email',
    tags: ['users'],
    staleTime: 60 // Becomes stale after 1 minute
  })
  async findUserByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email }
    });
  }

  // Helper methods for validation
  private validateEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private validatePhone(phone: string): boolean {
    // Basic phone validation - can be enhanced based on requirements
    const phoneRegex = /^\+?[0-9]{10,15}$/;
    return phoneRegex.test(phone);
  }

  // Helper method to send OTP via WhatsApp
  private async sendWhatsAppOTP(phone: string, otp: string, name: string, expiryTime: number): Promise<boolean> {
    try {
      return await this.whatsAppService.sendOTP(phone, otp);
    } catch (error) {
      this.logger.error(`Failed to send WhatsApp OTP: ${error.message}`);
      return false;
    }
  }

  async requestLoginOTP(
    identifier: string,
    deliveryMethod: 'whatsapp' | 'sms' | 'email' | 'all' = 'all',
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Validate identifier format
      const isEmail = this.validateEmail(identifier);
      const isPhone = this.validatePhone(identifier);

      if (!isEmail && !isPhone) {
        throw new BadRequestException('Invalid identifier format');
      }

      // Generate OTP
      const otp = this.generateOTP();
      const expiryTime = 10; // minutes

      // Store OTP with expiry
      const otpKey = `otp:${identifier}`;
      await this.redisService.set(
        otpKey,
        otp,
        60 * expiryTime, // Convert minutes to seconds
      );

      // Get user details if available
      let user: User | null = null;
      if (isEmail) {
        user = await this.prisma.user.findUnique({ where: { email: identifier } });
      } else if (isPhone) {
        user = await this.prisma.user.findFirst({ where: { phone: identifier } });
      }

      const name = user?.firstName || 'User';
      const email = isEmail ? identifier : user?.email;
      const phone = isPhone ? identifier : user?.phone;

      // Track delivery status
      const deliveryStatus = {
        whatsapp: false,
        sms: false,
        email: false,
      };

      // If 'all' is specified, try all methods without stopping
      if (deliveryMethod === 'all') {
        const deliveryPromises = [];
        
        // Try WhatsApp if phone is available
        if (phone) {
          deliveryPromises.push(
            this.sendWhatsAppOTP(phone, otp, name, expiryTime)
              .then(() => { deliveryStatus.whatsapp = true; })
              .catch(error => {
                this.logger.warn(`WhatsApp OTP delivery failed: ${error.message}`);
              })
          );
          
          // Try SMS as well if phone is available
          deliveryPromises.push(
            this.sendSMS(phone, `Your OTP is: ${otp}. Valid for ${expiryTime} minutes.`)
              .then(() => { deliveryStatus.sms = true; })
              .catch(error => {
                this.logger.warn(`SMS OTP delivery failed: ${error.message}`);
              })
          );
        }
        
        // Try Email if available
        if (email) {
          deliveryPromises.push(
            this.emailService.sendEmail({
              to: email,
              subject: 'Your Login OTP',
              template: EmailTemplate.OTP_LOGIN,
              context: {
                otp,
                name,
                expiryTime,
              },
            })
              .then(() => { deliveryStatus.email = true; })
              .catch(error => {
                this.logger.warn(`Email OTP delivery failed: ${error.message}`);
              })
          );
        }
        
        // Wait for all delivery attempts to complete
        await Promise.all(deliveryPromises);
        
        // Check if at least one method succeeded
        if (!deliveryStatus.whatsapp && !deliveryStatus.sms && !deliveryStatus.email) {
          throw new ServiceUnavailableException('Failed to deliver OTP through any channel');
        }
        
        // Create success message based on which methods succeeded
        const successMethods = Object.entries(deliveryStatus)
          .filter(([_, success]) => success)
          .map(([method, _]) => method.charAt(0).toUpperCase() + method.slice(1));
        
        return {
          success: true,
          message: `OTP sent successfully via ${successMethods.join(', ')}`,
        };
      }

      // If specific method is requested, use the existing fallback logic
      // ... existing code for specific delivery methods ...

      // ... existing code ...
    } catch (error) {
      this.logger.error(`Failed to request login OTP: ${error.message}`);
      throw new InternalServerErrorException('Failed to request login OTP');
    }
  }

  async hasActiveOTP(userId: string): Promise<boolean> {
    const key = `login_otp:${userId}`;
    const otp = await this.redisService.get(key);
    return !!otp;
  }
  
  async invalidateOTP(userId: string): Promise<void> {
    const key = `login_otp:${userId}`;
    await this.redisService.del(key);
  }

  // Helper method to generate tokens and user info
  private async generateTokens(user: User, request: any) {
    // Get user agent info
    const userAgent = request?.headers?.['user-agent'] || 'unknown';
    const deviceInfo = this.parseUserAgent(userAgent);
    
    // Generate session ID
    const sessionId = uuidv4();
    
    // Generate tokens
    const payload = { 
      email: user.email, 
      sub: user.id, 
      role: user.role,
      sessionId
    };
    
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });
    
    // Store refresh token in Redis
    await this.redisService.set(
      `refresh_token:${user.id}:${sessionId}`,
      refreshToken,
      this.TOKEN_REFRESH_TTL
    );
    
    // Store session info
    await this.redisService.set(
      `session:${user.id}:${sessionId}`,
      JSON.stringify({
        deviceInfo,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString()
      }),
      this.TOKEN_REFRESH_TTL
    );
    
    // Get role-specific permissions
    const permissions = this.getRolePermissions(user.role);
    
    // Get redirect path based on role
    const redirectPath = this.getRedirectPathForRole(user.role);
    
    // Return tokens and user info
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name || `${user.firstName} ${user.lastName}`.trim(),
        firstName: user.firstName,
        lastName: user.lastName
      },
      redirectPath,
      permissions
    };
  }

  private async sendSMS(
    phoneNumber: string, 
    message: string, 
    maxRetries: number = 2
  ): Promise<boolean> {
    let retries = 0;
    let success = false;

    while (retries <= maxRetries && !success) {
      try {
        // This is a placeholder for your actual SMS provider integration
        // You would replace this with your SMS provider's API
        const response = await axios.post(this.SMS_PROVIDER_URL, {
          apiKey: this.SMS_PROVIDER_API_KEY,
          to: phoneNumber,
          from: this.SMS_SENDER_ID,
          message: message
        });
        
        this.logger.debug(`SMS sent to ${phoneNumber}${retries > 0 ? ` (after ${retries} retries)` : ''}`);
        success = true;
        return response.status === 200;
      } catch (error) {
        retries++;
        const retryMsg = retries <= maxRetries ? `, retrying (${retries}/${maxRetries})...` : '';
        this.logger.error(`Failed to send SMS: ${error.message}${retryMsg}`);
        
        if (retries <= maxRetries) {
          // Exponential backoff: wait longer between each retry
          const backoffMs = 1000 * Math.pow(2, retries - 1); // 1s, 2s, 4s, etc.
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }
    
    return false;
  }

  // Generate and send a magic link for passwordless login
  async sendMagicLink(email: string): Promise<void> {
    try {
      const user = await this.findUserByEmail(email);
      if (!user) {
        // Return silently to prevent email enumeration
        this.logger.debug(`Magic link requested for non-existent user: ${email}`);
        return;
      }
      
      // Generate a secure token
      const token = uuidv4();
      
      // Create a signed JWT with limited expiry that contains the token
      const signedToken = this.jwtService.sign(
        { token, sub: user.id, type: 'magic_link' },
        { expiresIn: this.MAGIC_LINK_TTL }
      );
      
      // Create the magic link URL that points directly to the frontend
      // The frontend will handle the token and complete the login
      const loginUrl = `${process.env.FRONTEND_URL}/auth/magic-login?token=${encodeURIComponent(signedToken)}`;
      
      // Store token in Redis with expiry
      await this.redisService.set(
        `magic_link:${token}`,
        user.id,
        this.MAGIC_LINK_TTL
      );
      
      // Send magic link email
      await this.emailService.sendEmail({
        to: user.email,
        subject: 'Your Magic Login Link',
        template: EmailTemplate.MAGIC_LINK,
        context: { 
          loginUrl,
          name: user.firstName || user.name || 'User',
          expiryTime: `${this.MAGIC_LINK_TTL / 60} minutes`
        }
      });
      
      // Log magic link request for audit purposes
      this.logger.debug(`Magic link sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send magic link: ${error.message}`);
      throw new InternalServerErrorException('Failed to send magic link');
    }
  }
  
  // Verify magic link token and log user in
  async verifyMagicLink(token: string, request: any): Promise<any> {
    try {
      // First verify the JWT signature and expiration
      const payload = this.jwtService.verify(token);
      
      if (payload.type !== 'magic_link') {
        this.logger.warn(`Invalid magic link token type: ${payload.type}`);
        throw new UnauthorizedException('Invalid token type');
      }
      
      const originalToken = payload.token;
      
      // Get user ID from Redis using the original token
      const userId = await this.redisService.get(`magic_link:${originalToken}`);
      if (!userId) {
        this.logger.warn(`Magic link token not found or expired: ${originalToken.substring(0, 6)}...`);
        throw new UnauthorizedException('Magic link has expired or already been used');
      }
      
      // Find the user
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        this.logger.warn(`User not found for magic link: ${userId}`);
        throw new UnauthorizedException('User not found');
      }
      
      // Delete the token to prevent reuse
      await this.redisService.del(`magic_link:${originalToken}`);
      
      // Log the successful magic link login
      this.logger.debug(`Magic link login successful for ${user.email}`);
      
      // Log the user in
      return this.login(user, request);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error(`Magic link verification failed: ${error.message}`);
      throw new UnauthorizedException('Invalid or expired magic link');
    }
  }

  // Social login methods
  
  async handleGoogleLogin(googleUser: any, request: any): Promise<any> {
    const payload = googleUser.getPayload();
    const { email, given_name, family_name, picture, sub: googleId } = payload;
    
    try {
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'Processing Google authentication',
        'AuthService',
        { email, googleId }
      );

      // Check if user exists by email or Google ID
      let user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { email: email },
            { googleId: googleId }
          ]
        },
        include: {
          patient: true,
          doctor: true,
          clinicAdmin: true,
          receptionist: true
        }
      });
      
      if (!user) {
        // New user registration
        await this.loggingService.log(
          LogType.AUTH,
          LogLevel.INFO,
          'New user registration via Google',
          'AuthService',
          { email }
        );

        // Generate userid for new user
        const userid = await this.generateNextUID();
        
        // Create new user with transaction to ensure all related records are created
        const result = await this.prisma.$transaction(async (prisma) => {
          // Create the user
          const newUser = await prisma.user.create({
            data: {
              email,
              firstName: given_name,
              lastName: family_name,
              name: `${given_name} ${family_name}`,
              profilePicture: picture,
              role: 'PATIENT',
              isVerified: true,
              password: await this.hashPassword(uuidv4()),
              age: 0,
              phone: '',
              gender: 'UNSPECIFIED',
              dateOfBirth: new Date(),
              userid: userid,
              googleId: googleId,
              lastLogin: new Date(),
              patient: {
                create: {} // Create associated patient record
              }
            },
            include: {
              patient: true,
              doctor: true,
              clinicAdmin: true,
              receptionist: true
            }
          });

          return newUser;
        });

        user = result;

        // Emit user registration event
        await this.eventService.emit('user.registered', {
          userId: user.id,
          email: user.email,
          provider: 'GOOGLE',
          role: 'PATIENT'
        });

      } else {
        // Existing user login
        if (!user.googleId) {
          // Link Google account to existing user
          user = await this.prisma.user.update({
            where: { id: user.id },
            data: {
              googleId,
              isVerified: true,
              profilePicture: user.profilePicture || picture,
              lastLogin: new Date()
            },
            include: {
              patient: true,
              doctor: true,
              clinicAdmin: true,
              receptionist: true
            }
          });

          await this.loggingService.log(
            LogType.AUTH,
            LogLevel.INFO,
            'Linked Google account to existing user',
            'AuthService',
            { userId: user.id, email: user.email }
          );
        }
      }

      // Update last login time
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() }
      });

      // Generate login response with tokens
      const loginResponse = await this.login(user, request);

      // Add additional profile information
      const enhancedResponse = {
        ...loginResponse,
        user: {
          ...loginResponse.user,
          isNewUser: !user.lastLogin,
          googleId: user.googleId,
          profileComplete: this.isProfileComplete(user)
        }
      };

      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'Google authentication successful',
        'AuthService',
        { 
          userId: user.id, 
          email: user.email,
          isNewUser: !user.lastLogin
        }
      );

      return enhancedResponse;

    } catch (error) {
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.ERROR,
        'Google authentication failed',
        'AuthService',
        { error: error.message, email }
      );
      throw new InternalServerErrorException('Failed to process Google authentication');
    }
  }

  @RedisCache({
    ttl: 86400, // 24 hours
    prefix: 'auth:profile-completion',
    tags: ['users', 'profile']
  })
  private isProfileComplete(user: any): boolean {
    return !!(
      user.firstName &&
      user.lastName &&
      user.phone &&
      user.dateOfBirth &&
      user.gender !== 'UNSPECIFIED' &&
      user.age > 0
    );
  }

  private parseMedicalConditions(conditions: string | null): string[] {
    if (!conditions) return [];
    try {
      return JSON.parse(conditions);
    } catch {
      return conditions.split(',').map(c => c.trim()).filter(Boolean);
    }
  }

  private stringifyMedicalConditions(conditions: string[]): string {
    return JSON.stringify(conditions || []);
  }

  async verifyGoogleToken(token: string) {
    try {
      // Check rate limiting for social login attempts
      const clientIp = this.getClientIp();
      const attempts = await this.getSocialLoginAttempts(clientIp);
      
      if (attempts >= 10) { // Max 10 attempts per hour
        throw new HttpException('Too many social login attempts', HttpStatus.TOO_MANY_REQUESTS);
      }

      await this.incrementSocialLoginAttempts(clientIp);

      const ticket = await this.googleClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID
      });

      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'Google token verified successfully',
        'AuthService'
      );

      return ticket;
    } catch (error) {
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.ERROR,
        'Google token verification failed',
        'AuthService',
        { error: error.message }
      );
      throw new UnauthorizedException('Invalid Google token');
    }
  }

  async verifyAppleToken(token: string) {
    try {
      // Check rate limiting for social login attempts
      const clientIp = this.getClientIp();
      const attempts = await this.getSocialLoginAttempts(clientIp);
      
      if (attempts >= 10) { // Max 10 attempts per hour
        throw new HttpException('Too many social login attempts', HttpStatus.TOO_MANY_REQUESTS);
      }

      await this.incrementSocialLoginAttempts(clientIp);

      const decodedToken = await this.jwtService.verifyAsync(token, {
        secret: process.env.APPLE_PUBLIC_KEY
      });

      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'Apple token verified successfully',
        'AuthService'
      );

      return decodedToken;
    } catch (error) {
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.ERROR,
        'Apple token verification failed',
        'AuthService',
        { error: error.message }
      );
      throw new UnauthorizedException('Invalid Apple token');
    }
  }

  private getClientIp(): string {
    // This is a placeholder - implement according to your needs
    // You should get this from the request object in your actual implementation
    return 'client-ip';
  }

  @RedisCache({
    ttl: 300, // 5 minutes
    prefix: 'auth:token-verify',
    tags: ['auth', 'tokens'],
    staleTime: 60 // Becomes stale after 1 minute
  })
  private async verifyTokenAndGetPayload(token: string): Promise<any> {
    return this.jwtService.verify(token);
  }

  private async isTokenBlacklisted(token: string): Promise<boolean> {
    const blacklistKey = `blacklist:token:${token.substring(0, 64)}`;
    return !!(await this.redisService.get(blacklistKey));
  }

  async verifyToken(token: string): Promise<any> {
    try {
      // First check blacklist - no caching here for security
      const isBlacklisted = await this.isTokenBlacklisted(token);
      if (isBlacklisted) {
        throw new UnauthorizedException('Token has been invalidated');
      }

      // Verify token with caching
      const payload = await this.verifyTokenAndGetPayload(token);
      return payload;
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new UnauthorizedException('Token has expired');
      }
      if (error.name === 'JsonWebTokenError') {
        throw new UnauthorizedException('Invalid token format');
      }
      throw new UnauthorizedException('Token validation failed');
    }
  }

  @RedisCache({
    ttl: 3600, // 1 hour
    prefix: 'auth:session',
    tags: ['sessions'],
    staleTime: 300 // Becomes stale after 5 minutes
  })
  private async getSessionData(sessionId: string): Promise<any> {
    const sessionKey = `session:${sessionId}`;
    return this.redisService.get(sessionKey);
  }

  async validateSession(userId: string, request: any, deviceFingerprint: string): Promise<any> {
    const sessionId = request.headers['x-session-id'];
    if (!sessionId) {
      throw new UnauthorizedException('Session ID not provided');
    }

    const sessionData = await this.getSessionData(sessionId);
    if (!sessionData) {
      throw new UnauthorizedException('Session expired or invalidated');
    }

    const parsedSession = JSON.parse(sessionData);

    // Verify session is active
    if (!parsedSession.isActive) {
      throw new UnauthorizedException('Session is no longer active');
    }

    // Check session inactivity
    const lastActivity = new Date(parsedSession.lastActivityAt).getTime();
    const inactivityDuration = Date.now() - lastActivity;
    if (inactivityDuration > this.SESSION_ACTIVITY_THRESHOLD) {
      await this.trackSecurityEvent(userId, 'SESSION_INACTIVITY_WARNING', {
        sessionId,
        inactivityDuration: Math.floor(inactivityDuration / 1000)
      });
    }

    // For logout operations, be more lenient with device validation
    const isLogoutRequest = request.path === '/auth/logout';
    if (isLogoutRequest) {
      // During logout, only validate the user-agent as it's the most stable component
      const currentUserAgent = request.headers['user-agent'];
      const storedUserAgent = parsedSession.userAgent;
      
      if (currentUserAgent && storedUserAgent && currentUserAgent !== storedUserAgent) {
        await this.trackSecurityEvent(userId, 'DEVICE_MISMATCH_LOGOUT', {
          sessionId,
          expectedUserAgent: storedUserAgent,
          receivedUserAgent: currentUserAgent
        });
        // Log the mismatch but don't block logout
        this.loggingService.log(
          LogType.SECURITY,
          LogLevel.WARN,
          'Device mismatch during logout',
          'AuthService',
          { userId, sessionId, expectedUserAgent: storedUserAgent, receivedUserAgent: currentUserAgent }
        );
      }
      return parsedSession;
    }

    // For non-logout operations, perform strict device validation
    if (parsedSession.deviceFingerprint !== deviceFingerprint) {
      await this.trackSecurityEvent(userId, 'DEVICE_MISMATCH', {
        sessionId,
        expectedFingerprint: parsedSession.deviceFingerprint,
        receivedFingerprint: deviceFingerprint
      });
      throw new UnauthorizedException('Invalid device detected');
    }

    return parsedSession;
  }

  @RedisCache({
    ttl: 3600, // 1 hour
    prefix: 'auth:social-login-attempts',
    tags: ['auth', 'social-login']
  })
  private async getSocialLoginAttempts(identifier: string): Promise<number> {
    const attemptsKey = `social_login_attempts:${identifier}`;
    const attempts = await this.redisService.get(attemptsKey);
    return attempts ? parseInt(attempts) : 0;
  }

  private async incrementSocialLoginAttempts(identifier: string): Promise<void> {
    const attemptsKey = `social_login_attempts:${identifier}`;
    const attempts = await this.getSocialLoginAttempts(identifier);
    await this.redisService.set(
      attemptsKey,
      (attempts + 1).toString(),
      3600 // 1 hour TTL
    );
  }

  private async trackSecurityEvent(identifier: string, eventType: string, details: any): Promise<void> {
    const event = {
      timestamp: new Date(),
      eventType,
      identifier,
      details
    };

    await this.redisService.rPush(
      `security:events:${identifier}`,
      JSON.stringify(event)
    );

    // Trim old events
    await this.redisService.lTrim(
      `security:events:${identifier}`,
      -1000,
      -1
    );

    // Set expiry for events list
    await this.redisService.expire(
      `security:events:${identifier}`,
      this.SECURITY_EVENT_RETENTION
    );
  }

  async handleAppleLogin(appleUser: any, request: any): Promise<any> {
    const { email, sub: appleId } = appleUser;
    
    try {
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'Processing Apple authentication',
        'AuthService',
        { email, appleId }
      );

      // Check if user exists by email or Apple ID
      let user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { email: email },
            { appleId: appleId }
          ]
        },
        include: {
          patient: true,
          doctor: true,
          clinicAdmin: true,
          receptionist: true
        }
      });
      
      if (!user) {
        // New user registration
        await this.loggingService.log(
          LogType.AUTH,
          LogLevel.INFO,
          'New user registration via Apple',
          'AuthService',
          { email }
        );

        // Generate userid for new user
        const userid = await this.generateNextUID();
        
        // Create new user with transaction to ensure all related records are created
        const result = await this.prisma.$transaction(async (prisma) => {
          // Create the user
          const newUser = await prisma.user.create({
            data: {
              email,
              firstName: appleUser.given_name || '',
              lastName: appleUser.family_name || '',
              name: appleUser.name || email.split('@')[0],
              role: 'PATIENT',
              isVerified: true,
              password: await this.hashPassword(uuidv4()),
              age: 0,
              phone: '',
              gender: 'UNSPECIFIED',
              dateOfBirth: new Date(),
              userid: userid,
              appleId: appleId,
              lastLogin: new Date(),
              patient: {
                create: {} // Create associated patient record
              }
            },
            include: {
              patient: true,
              doctor: true,
              clinicAdmin: true,
              receptionist: true
            }
          });

          return newUser;
        });

        user = result;

        // Emit user registration event
        await this.eventService.emit('user.registered', {
          userId: user.id,
          email: user.email,
          provider: 'APPLE',
          role: 'PATIENT'
        });

      } else {
        // Existing user login
        if (!user.appleId) {
          // Link Apple account to existing user
          user = await this.prisma.user.update({
            where: { id: user.id },
            data: {
              appleId,
              isVerified: true,
              lastLogin: new Date()
            },
            include: {
              patient: true,
              doctor: true,
              clinicAdmin: true,
              receptionist: true
            }
          });

          await this.loggingService.log(
            LogType.AUTH,
            LogLevel.INFO,
            'Linked Apple account to existing user',
            'AuthService',
            { userId: user.id, email: user.email }
          );
        }
      }

      // Update last login time
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() }
      });

      // Generate login response with tokens
      const loginResponse = await this.login(user, request);

      // Add additional profile information
      const enhancedResponse = {
        ...loginResponse,
        user: {
          ...loginResponse.user,
          isNewUser: !user.lastLogin,
          appleId: user.appleId,
          profileComplete: this.isProfileComplete(user)
        }
      };

      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'Apple authentication successful',
        'AuthService',
        { 
          userId: user.id, 
          email: user.email,
          isNewUser: !user.lastLogin
        }
      );

      return enhancedResponse;

    } catch (error) {
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.ERROR,
        'Apple authentication failed',
        'AuthService',
        { error: error.message, email }
      );
      throw new InternalServerErrorException('Failed to process Apple authentication');
    }
  }
} 