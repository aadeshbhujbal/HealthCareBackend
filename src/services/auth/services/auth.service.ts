import { Injectable, UnauthorizedException, BadRequestException, InternalServerErrorException, ConflictException, ForbiddenException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../shared/database/prisma/prisma.service';
import { RedisService } from '../../../shared/cache/redis/redis.service';
import { CreateUserDto, UserResponseDto } from '../../../libs/dtos/user.dto';
import { Prisma } from '@prisma/client';
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
import * as crypto from 'crypto';
import { SessionService } from '../services/session.service';
import { google } from 'googleapis';

// Define simple types to avoid Prisma type issues
type User = any;
type Role = 'SUPER_ADMIN' | 'CLINIC_ADMIN' | 'DOCTOR' | 'PATIENT' | 'RECEPTIONIST';

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
  private readonly GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  private readonly GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  private readonly googleClient: OAuth2Client;
  private readonly DEVICE_FINGERPRINT_TTL = 30 * 24 * 60 * 60; // 30 days
  private readonly MAX_SESSIONS_PER_USER = 5;
  private readonly SUSPICIOUS_LOGIN_THRESHOLD = 3;

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
    private readonly sessionService: SessionService,
  ) {
    if (!this.GOOGLE_CLIENT_ID) {
      throw new Error('GOOGLE_CLIENT_ID environment variable is not set');
    }
    this.googleClient = new OAuth2Client({
      clientId: this.GOOGLE_CLIENT_ID,
      clientSecret: this.GOOGLE_CLIENT_SECRET
    });
    this.ensureSuperAdmin();
  }

  private async ensureSuperAdmin() {
    try {
      const superAdminEmail = 'superadmin@healthcare.com';
      const existingSuperAdmin = await this.prisma.user.findFirst({
        where: { 
          role: 'SUPER_ADMIN' 
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
            role: 'SUPER_ADMIN',
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
          role: 'SUPER_ADMIN',
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
        clinicAdmins: true,
        receptionists: true
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
   * Register a new user with clinic association
   * Multi-tenant system: User can register with multiple clinics using same email
   */
  async register(createUserDto: CreateUserDto): Promise<UserResponseDto> {
    try {
      const { clinicId, ...userData } = createUserDto;

      // If clinicId is provided, validate clinic exists
      if (clinicId) {
        const clinic = await this.prisma.clinic.findUnique({
          where: { id: clinicId }
        });

        if (!clinic) {
          throw new NotFoundException('Clinic not found');
        }

        if (!clinic.isActive) {
          throw new BadRequestException('Clinic is not active');
        }

        // Check if user already exists
        const existingUser = await this.prisma.user.findFirst({
          where: {
            email: {
              mode: 'insensitive',
              equals: userData.email
            }
          },
          include: {
            clinics: true
          }
        });

        let user: any;

        if (existingUser) {
          // User exists - check if already associated with this clinic
          const isAlreadyAssociated = existingUser.clinics.some(clinic => clinic.id === clinicId);
          
          if (isAlreadyAssociated) {
            // User already associated with this clinic - return success
            await this.loggingService.log(
              LogType.AUTH,
              LogLevel.INFO,
              'User already associated with clinic',
              'AuthService',
              { userId: existingUser.id, clinicId, email: userData.email }
            );
            
            const { password, ...result } = existingUser;
            const userResponse = { ...result } as any;
            if (userResponse.medicalConditions) {
              userResponse.medicalConditions = this.parseMedicalConditions(userResponse.medicalConditions);
            }
            return userResponse as UserResponseDto;
          }

          // User exists but not associated with this clinic - create association
          user = existingUser;
          
          // Associate user with clinic
          await this.prisma.user.update({
            where: { id: user.id },
            data: {
              clinics: {
                connect: { id: clinicId }
              }
            }
          });

          await this.loggingService.log(
            LogType.AUTH,
            LogLevel.INFO,
            'Existing user associated with new clinic',
            'AuthService',
            { userId: user.id, clinicId, email: userData.email }
          );
        } else {
          // User doesn't exist - create new user with clinic association
          const userid = await this.generateNextUID();
          const hashedPassword = await bcrypt.hash(userData.password, this.SALT_ROUNDS);
          
          // Generate full name
          const fullName = `${userData.firstName} ${userData.lastName}`.trim();
          
          // Create user with clinic association
          user = await this.prisma.user.create({
            data: {
              ...userData,
              userid,
              password: hashedPassword,
              name: fullName,
              role: 'PATIENT', // Default role for clinic registration
              isVerified: false,
              age: userData.age || 0, // Ensure age is provided
              medicalConditions: this.stringifyMedicalConditions(userData.medicalConditions),
              clinics: {
                connect: { id: clinicId }
              }
            },
            include: {
              clinics: true
            }
          });

          // Create patient record
          await this.prisma.patient.create({
            data: { userId: user.id }
          });

          await this.loggingService.log(
            LogType.AUTH,
            LogLevel.INFO,
            'New user registered with clinic',
            'AuthService',
            { userId: user.id, clinicId, email: userData.email }
          );

          // Emit registration event
          await this.eventService.emit('user.registered', {
            userId: user.id,
            email: user.email,
            role: user.role,
            clinicId
          });

          // Send welcome email
          try {
            await this.emailService.sendEmail({
              to: user.email,
              subject: `Welcome to ${clinic.name}`,
              template: EmailTemplate.WELCOME,
              context: {
                name: user.firstName || fullName,
                role: this.getRoleDisplayName(user.role),
                clinicName: clinic.name,
                loginUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`,
                supportEmail: process.env.SUPPORT_EMAIL || 'support@healthcareapp.com',
                dashboardUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}${this.getRedirectPathForRole(user.role)}`
              }
            });
          } catch (emailError) {
            this.logger.error(`Failed to send welcome email: ${emailError.message}`);
          }
        }

        const { password, ...result } = user;
        return result as UserResponseDto;
      } else {
        // Original registration logic for non-clinic registration
        const existingUser = await this.prisma.user.findFirst({
          where: {
            email: {
              mode: 'insensitive',
              equals: userData.email
            }
          }
        });

        if (existingUser) {
          await this.loggingService.log(
            LogType.AUTH,
            LogLevel.WARN,
            'Registration attempt with existing email',
            'AuthService',
            { email: userData.email }
          );
          throw new BadRequestException('Email already registered');
        }

        // Generate the next UID
        const userid = await this.generateNextUID();

        const hashedPassword = await bcrypt.hash(userData.password, this.SALT_ROUNDS);
        
        const userDataForCreate: any = { ...userData };
        if (userDataForCreate.dateOfBirth) {
          userDataForCreate.dateOfBirth = new Date(`${userDataForCreate.dateOfBirth}T00:00:00Z`);
        }
        
        // Generate full name from firstName and lastName
        const fullName = `${userData.firstName} ${userData.lastName}`.trim();
        
        const user = await this.prisma.user.create({
          data: {
            ...userDataForCreate,
            userid,
            password: hashedPassword,
            name: fullName,
            isVerified: false,
            medicalConditions: this.stringifyMedicalConditions(userDataForCreate.medicalConditions)
          },
        });

        // Create role-specific record
        switch (user.role) {
          case 'PATIENT':
            await this.prisma.patient.create({
              data: { userId: user.id }
            });
            break;
          case 'DOCTOR':
            await this.prisma.doctor.create({
              data: {
                userId: user.id,
                specialization: userData.specialization || '',
                experience: userData.experience || 0,
              }
            });
            break;
          case 'RECEPTIONIST':
            await this.prisma.receptionist.create({
              data: { userId: user.id }
            });
            break;
          case 'CLINIC_ADMIN':
            if ((userData as any).clinicId) {
              await this.prisma.clinicAdmin.create({
                data: {
                  userId: user.id,
                  clinicId: (userData as any).clinicId
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
        
        // Send welcome email
        try {
          await this.emailService.sendEmail({
            to: user.email,
            subject: 'Welcome to HealthCare App',
            template: EmailTemplate.WELCOME,
            context: {
              name: user.firstName || fullName,
              role: this.getRoleDisplayName(user.role),
              loginUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`,
              supportEmail: process.env.SUPPORT_EMAIL || 'support@healthcareapp.com',
              dashboardUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}${this.getRedirectPathForRole(user.role)}`
            }
          });
        } catch (emailError) {
          // Don't fail registration if email fails
          this.logger.error(`Failed to send welcome email: ${emailError.message}`);
        }

        const { password, ...result } = user;
        const userResponse = { ...result } as any;
        if (userResponse.dateOfBirth) {
          userResponse.dateOfBirth = userResponse.dateOfBirth.toISOString().split('T')[0];
        }
        return userResponse as UserResponseDto;
      }
    } catch (error) {
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.ERROR,
        'Registration failed',
        'AuthService',
        { error: error.message, email: createUserDto.email, clinicId: createUserDto.clinicId }
      );
      throw error;
    }
  }

  /**
   * Login a user and generate JWT tokens with clinic context
   * Multi-tenant system: User must be associated with the clinic to login
   */
  async login(user: User, request: any, appName?: string, clinicId?: string) {
    try {
      // If clinicId is provided, validate clinic association
      if (clinicId) {
        // Validate clinic exists
        const clinic = await this.prisma.clinic.findUnique({
          where: { id: clinicId }
        });

        if (!clinic) {
          throw new NotFoundException('Clinic not found');
        }

        if (!clinic.isActive) {
          throw new BadRequestException('Clinic is not active');
        }

        // Check if user is associated with the clinic
        const userWithClinics = await this.prisma.user.findUnique({
          where: { id: user.id },
          include: {
            clinics: true,
            doctor: {
              include: {
                clinics: true
              }
            },
            receptionists: true,
            clinicAdmins: true
          }
        });

        if (!userWithClinics) {
          throw new UnauthorizedException('User not found');
        }

        // Check various ways user can be associated with clinic
        let hasClinicAccess = false;

        // Direct clinic association
        if ((userWithClinics as any).clinics && (userWithClinics as any).clinics.some((clinic: any) => clinic.id === clinicId)) {
          hasClinicAccess = true;
        }

        // Doctor in clinic
        if (!hasClinicAccess && (userWithClinics as any).doctor) {
          const doctorClinic = await this.prisma.doctorClinic.findFirst({
            where: {
              doctorId: (userWithClinics as any).doctor.id,
              clinicId: clinicId
            }
          });
          hasClinicAccess = !!doctorClinic;
        }

        // Receptionist in clinic
        if (!hasClinicAccess && (userWithClinics as any).receptionists && (userWithClinics as any).receptionists.length > 0) {
          hasClinicAccess = (userWithClinics as any).receptionists.some((rec: any) => rec.clinicId === clinicId);
        }

        // Clinic admin
        if (!hasClinicAccess && (userWithClinics as any).clinicAdmins && (userWithClinics as any).clinicAdmins.length > 0) {
          hasClinicAccess = (userWithClinics as any).clinicAdmins.some((admin: any) => admin.clinicId === clinicId);
        }

        if (!hasClinicAccess) {
          throw new UnauthorizedException('User is not associated with this clinic');
        }

        // Update appName to clinic app_name for consistency
        appName = clinic.app_name;
      }

      // Generate device fingerprint
      const deviceFingerprint = this.generateDeviceFingerprint(request);
      // Validate login attempt
      await this.validateLoginAttempt(user.id, deviceFingerprint);

      // Generate tokens and session info with clinic context
      const payload = { 
        email: user.email, 
        sub: user.id, 
        role: user.role,
        ...(clinicId && { clinicId }) // Include clinicId in JWT if provided
      };
      const accessToken = this.jwtService.sign(payload);
      const refreshToken = uuidv4();
      const sessionId = uuidv4();
      const userAgent = request.headers['user-agent'] || 'unknown';
      const ipAddress = request.ip || request.headers['x-forwarded-for'] || 'unknown';
      const deviceInfo = {
        ...this.parseUserAgent(userAgent),
        platform: request.headers['sec-ch-ua-platform'] || 'unknown',
      };
      const now = new Date();

      // Use SessionService to create session
      await this.sessionService.createSession({
        sessionId,
        userId: user.id,
        deviceInfo,
        ipAddress,
        createdAt: now,
        lastActivityAt: now,
        isActive: true,
        refreshToken
      });

      // Update last login and emit event
      const updatedUser = await this.prisma.user.update({
        where: { id: user.id },
        data: { 
          lastLogin: now,
          lastLoginIP: ipAddress,
          lastLoginDevice: userAgent
        },
        include: {
          doctor: true,
          patient: true,
          receptionists: true,
          clinicAdmins: true,
          superAdmin: true,
        }
      });

      // Log successful login
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'User logged in successfully',
        'AuthService',
        { userId: user.id, email: user.email, role: user.role, clinicId }
      );

      // Emit login event
      await this.eventService.emit('user.loggedIn', {
        userId: user.id,
        email: user.email,
        role: user.role,
        deviceInfo,
        ipAddress,
        clinicId
      });
      
      // Send login notification email
      try {
        await this.emailService.sendEmail({
          to: user.email,
          subject: 'New Login to Your Account',
          template: EmailTemplate.LOGIN_NOTIFICATION,
          context: {
            name: user.firstName || user.name || 'User',
            time: now.toLocaleString(),
            device: deviceInfo.type,
            browser: deviceInfo.browser,
            operatingSystem: deviceInfo.os,
            ipAddress: ipAddress,
            location: 'Unknown'
          }
        });
      } catch (emailError) {
        this.logger.error(`Failed to send login notification email: ${emailError.message}`);
      }

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
          medicalConditions: this.parseMedicalConditions((user as any).medicalConditions),
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

      // If clinicId was provided, add clinic information to response
      if (clinicId) {
        const clinic = await this.prisma.clinic.findUnique({
          where: { id: clinicId }
        });
        
        if (clinic) {
          return {
            ...loginResponse,
            clinic: {
              id: clinic.id,
              name: clinic.name,
              appName: clinic.app_name
            }
          };
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

  // Get the appropriate redirect path based on user role
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

  private getRolePermissions(role: Role): string[] {
    const basePermissions = ['view_profile', 'edit_profile'];
    
    switch (role) {
      case 'SUPER_ADMIN':
        return [
          ...basePermissions,
          'manage_users',
          'manage_clinics',
          'manage_roles',
          'view_analytics',
          'manage_system'
        ];
      case 'CLINIC_ADMIN':
        return [
          ...basePermissions,
          'manage_clinic_staff',
          'view_clinic_analytics',
          'manage_appointments',
          'manage_inventory'
        ];
      case 'DOCTOR':
        return [
          ...basePermissions,
          'manage_patients',
          'view_medical_records',
          'create_prescriptions',
          'manage_appointments'
        ];
      case 'PATIENT':
        return [
          ...basePermissions,
          'view_appointments',
          'book_appointments',
          'view_prescriptions',
          'view_medical_history'
        ];
      case 'RECEPTIONIST':
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
      
      // Mark user as verified
      const user = await this.findUserByEmail(email);
      if (user && !user.isVerified) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { isVerified: true }
        });
        this.logger.debug(`User ${user.id} marked as verified after OTP login`);
      }
    } else {
      this.logger.debug(`Invalid OTP attempt for ${email}`);
    }
    
    return isValid;
  }

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
    const deviceInfo = {
      ...this.parseUserAgent(userAgent),
      platform: request.headers['sec-ch-ua-platform'] || 'unknown',
    };
    
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
      
      // Mark user as verified if not already
      if (!user.isVerified) {
        await this.markUserAsVerified(user.id);
      }
      
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
    const { email, given_name, family_name, picture, sub: googleId, name } = googleUser;
    
    try {
      // Check if user exists
      let user = await this.findUserByEmail(email);
      let isNewUser = false;
      
      if (!user) {
        isNewUser = true;
        // Generate userid for new user
        const userid = await this.generateNextUID();
        
        // Create new user if not exists
        user = await this.prisma.user.create({
          data: {
            email,
            firstName: given_name || '',
            lastName: family_name || '',
            name: name || `${given_name || ''} ${family_name || ''}`.trim(),
            profilePicture: picture || '',
            googleId: googleId,
            role: 'PATIENT', // Default role
            isVerified: true, // Google emails are verified
            password: await this.hashPassword(uuidv4()), // Random password
            age: 0, // Default age, can be updated later
            phone: '', // Default empty phone
            gender: 'UNSPECIFIED', // Default gender
            dateOfBirth: new Date(), // Default date, can be updated later
            userid: userid
          }
        });
        
        // Create patient record for new user
        await this.prisma.patient.create({
          data: { userId: user.id }
        });
        
        // Log new user creation
        this.logger.debug(`New user created via Google: ${user.email}`);
        
        // Send welcome email for new users
        try {
          await this.emailService.sendEmail({
            to: user.email,
            subject: 'Welcome to HealthCare App',
            template: EmailTemplate.WELCOME,
            context: {
              name: user.firstName || user.name,
              role: this.getRoleDisplayName(user.role),
              loginUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`,
              supportEmail: process.env.SUPPORT_EMAIL || 'support@healthcareapp.com',
              dashboardUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}${this.getRedirectPathForRole(user.role)}`,
              isGoogleAccount: true
            }
          });
        } catch (emailError) {
          // Don't fail registration if email fails
          this.logger.error(`Failed to send welcome email: ${emailError.message}`);
        }
      } else if (!(user as any).googleId) {
        // Update existing user with Google ID if not already set
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            googleId,
            isVerified: true,
            profilePicture: user.profilePicture || picture || '',
            firstName: user.firstName || given_name || '',
            lastName: user.lastName || family_name || '',
            name: user.name || name || `${given_name || ''} ${family_name || ''}`.trim()
          }
        });
      }
      
      // Log successful Google login
      this.logger.debug(`Google login successful for user ${user.email}`);
      
      // Generate tokens and return login response
      const response = await this.login(user, request);
      
      // Add isNewUser flag to response
      return {
        ...response,
        isNewUser
      };
    } catch (error) {
      this.logger.error(`Google login failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to process Google login');
    }
  }
  
  async handleFacebookLogin(facebookUser: any, request: any): Promise<any> {
    const { email, first_name, last_name, picture } = facebookUser;
    
    try {
      // Check if user exists
      let user = await this.findUserByEmail(email);
      
      if (!user) {
        // Generate userid for new user
        const userid = await this.generateNextUID();
        
        // Create new user if not exists
        user = await this.prisma.user.create({
          data: {
            email,
            firstName: first_name,
            lastName: last_name,
            name: `${first_name} ${last_name}`,
            profilePicture: picture?.data?.url,
            role: 'PATIENT',
            isVerified: true,
            password: await this.hashPassword(uuidv4()),
            age: 0,
            phone: '',
            gender: 'UNSPECIFIED',
            dateOfBirth: new Date(),
            userid: userid
          }
        });
        
        this.logger.debug(`New user created: ${user.email}`);
      } else {
        // Update existing user's profile picture if available
        if (picture?.data?.url) {
          user = await this.prisma.user.update({
            where: { id: user.id },
            data: {
              isVerified: true,
              profilePicture: picture.data.url
            }
          });
        }
      }
      
      this.logger.debug(`Facebook login successful for user ${user.email}`);
      return this.login(user, request);
    } catch (error) {
      this.logger.error(`Facebook login failed: ${error.message}`);
      throw new UnauthorizedException('Invalid Facebook login');
    }
  }
  
  async verifyFacebookToken(token: string): Promise<any> {
    try {
      // This is a placeholder for actual Facebook token verification
      // In a real implementation, you would make a request to the Facebook Graph API
      // Example: const response = await axios.get(`https://graph.facebook.com/me?fields=id,email,name,first_name,last_name,picture&access_token=${token}`);
      
      // For now, we'll simulate a successful verification with mock data
      return {
        id: 'facebook-user-id',
        email: 'user@example.com',
        name: 'John Doe',
        first_name: 'John',
        last_name: 'Doe',
        picture: {
          data: {
            url: 'https://example.com/profile.jpg'
          }
        }
      };
    } catch (error) {
      this.logger.error(`Facebook token verification failed: ${error.message}`);
      throw new UnauthorizedException('Invalid Facebook token');
    }
  }
  
  async verifyAppleToken(token: string): Promise<any> {
    try {
      // This is a placeholder for actual Apple token verification
      // In a real implementation, you would verify the JWT token from Apple
      // Example: const decoded = jwt.verify(token, applePublicKey, { algorithms: ['RS256'] });
      
      // For now, we'll simulate a successful verification with mock data
      return {
        sub: 'apple-user-id',
        email: 'user@example.com',
        name: 'John Doe'
      };
    } catch (error) {
      this.logger.error(`Apple token verification failed: ${error.message}`);
      throw new UnauthorizedException('Invalid Apple token');
    }
  }

  // Handle Apple login
  async handleAppleLogin(appleUser: any, request: any): Promise<any> {
    const { email, firstName, lastName, sub: appleId } = appleUser;
    
    try {
      // Check if user exists
      let user = await this.findUserByEmail(email);
      
      if (!user) {
        // Generate userid for new user
        const userid = await this.generateNextUID();
        
        // Create new user if not exists
        user = await this.prisma.user.create({
          data: {
            email,
            firstName,
            lastName,
            name: `${firstName} ${lastName}`,
            role: 'PATIENT', // Default role
            isVerified: true, // Apple emails are verified
            password: await this.hashPassword(uuidv4()), // Random password
            age: 0, // Default age, can be updated later
            phone: '', // Default empty phone
            gender: 'UNSPECIFIED', // Default gender
            dateOfBirth: new Date(), // Default date, can be updated later
            profilePicture: '', // Default empty profile picture
            userid: userid
          }
        });
        
        // Log new user creation
        this.logger.debug(`New user created: ${user.email}`);
      } else if (!(user as any).appleId) {
        // Update existing user with Apple ID if not already set
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            appleId,
            isVerified: true
          }
        });
      }
      
      // Log successful Apple login
      this.logger.debug(`Apple login successful for user ${user.email}`);
      
      // Generate tokens and return login response
      return this.login(user, request);
    } catch (error) {
      this.logger.error(`Apple login failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to process Apple login');
    }
  }
  
  // Social login token verification methods
  
  async verifyGoogleToken(token: string) {
    try {
      this.logger.debug('Starting Google token verification');
      this.logger.debug(`Using Google Client ID: `);
      const ticket = await this.googleClient.verifyIdToken({
        idToken: token,
        audience: this.GOOGLE_CLIENT_ID
      });
      const payload = ticket.getPayload();
      this.logger.debug('Google token verified successfully');
      this.logger.debug('Token payload:', payload);
      return ticket;
    } catch (error) {
      this.logger.error(`Google token verification failed: ${error.message}`);
      this.logger.error('Full error:', error);
      throw new UnauthorizedException('Invalid Google token');
    }
  }

  /**
   * Get user profile with enhanced clinic context
   */
  async getUserProfile(userId: string) {
    try {
    const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          doctor: true,
          patient: true,
          receptionists: true,
          clinicAdmins: true,
          superAdmin: true,
          clinics: true
        }
    });
    
    if (!user) {
      throw new NotFoundException('User not found');
    }
    
      const { password, ...userProfile } = user;
      
      // Add clinic information if user has clinic associations
      if ((userProfile as any).clinics && (userProfile as any).clinics.length > 0) {
        const clinicInfo = await Promise.all(
          (userProfile as any).clinics.map(async (clinic: any) => {
            const clinicUsers = await this.clinicUserService.getClinicUsers(clinic.id);
            let userRole = null;

            if (clinicUsers.doctors.some((d: any) => d.doctor.userId === userId)) {
              userRole = 'DOCTOR';
            } else if (clinicUsers.receptionists.some((r: any) => r.userId === userId)) {
              userRole = 'RECEPTIONIST';
            } else if (clinicUsers.patients.some((p: any) => p.userId === userId)) {
              userRole = 'PATIENT';
            }

            return {
              id: clinic.id,
              name: clinic.name,
              appName: clinic.app_name,
              role: userRole
            };
          })
        );

        return {
          ...userProfile,
          clinics: clinicInfo
        };
      }

      return userProfile;
    } catch (error) {
      this.logger.error(`Failed to get user profile: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get user sessions with enhanced security
   */
  async getUserSessions(userId: string) {
    try {
      const sessions = await this.sessionService.getActiveSessions(userId);
      
      // Add security information to each session
      const enhancedSessions = sessions.map(session => ({
        ...session,
        isCurrentSession: false, // Will be set by client
        lastActivity: session.lastActivityAt,
        deviceType: (session.deviceInfo as any)?.type || 'unknown',
        location: 'Unknown', // Could be enhanced with IP geolocation
        isSuspicious: false // Could be enhanced with security checks
      }));

      return enhancedSessions;
    } catch (error) {
      this.logger.error(`Failed to get user sessions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update user profile with validation
   */
  async updateUserProfile(
    userId: string,
    data: {
      firstName?: string;
      lastName?: string;
      phoneNumber?: string;
      address?: string;
      profileImage?: string;
      city?: string;
      state?: string;
      country?: string;
      zipCode?: string;
      dateOfBirth?: string;
      gender?: string;
      medicalConditions?: string[];
    }
  ) {
    try {
      // Validate user exists
      const existingUser = await this.prisma.user.findUnique({
        where: { id: userId }
      });

      if (!existingUser) {
        throw new NotFoundException('User not found');
      }

      // Prepare update data
      const updateData: any = {};
      
      if (data.firstName) updateData.firstName = data.firstName;
      if (data.lastName) updateData.lastName = data.lastName;
      if (data.phoneNumber) updateData.phone = data.phoneNumber;
      if (data.address) updateData.address = data.address;
      if (data.profileImage) updateData.profilePicture = data.profileImage;
      if (data.city) updateData.city = data.city;
      if (data.state) updateData.state = data.state;
      if (data.country) updateData.country = data.country;
      if (data.zipCode) updateData.zipCode = data.zipCode;
      if (data.gender) updateData.gender = data.gender;
      if (data.medicalConditions) {
        updateData.medicalConditions = this.stringifyMedicalConditions(data.medicalConditions);
      }
      
      if (data.dateOfBirth) {
        updateData.dateOfBirth = new Date(`${data.dateOfBirth}T00:00:00Z`);
      }

      // Update name if firstName or lastName changed
      if (data.firstName || data.lastName) {
        const firstName = data.firstName || existingUser.firstName;
        const lastName = data.lastName || existingUser.lastName;
        updateData.name = `${firstName} ${lastName}`.trim();
      }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
        data: updateData,
        include: {
          doctor: true,
          patient: true,
          receptionists: true,
          clinicAdmins: true,
          superAdmin: true
        }
      });

      // Log profile update
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'User profile updated',
        'AuthService',
        { userId, updatedFields: Object.keys(data) }
      );

      // Emit profile update event
      await this.eventService.emit('user.profileUpdated', {
        userId,
        updatedFields: Object.keys(data)
      });

      const { password, ...result } = updatedUser;
      return result;
    } catch (error) {
      this.logger.error(`Failed to update user profile: ${error.message}`);
      throw error;
    }
  }

  /**
   * Change password with security validation
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    try {
      // Get user with password
      const user = await this.prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      // Verify current password
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
      if (!isCurrentPasswordValid) {
        throw new BadRequestException('Current password is incorrect');
      }

      // Validate new password strength
      this.validatePasswordStrength(newPassword);

      // Check if new password is same as current
      const isSamePassword = await bcrypt.compare(newPassword, user.password);
      if (isSamePassword) {
        throw new BadRequestException('New password must be different from current password');
      }

      // Hash new password
      const hashedNewPassword = await bcrypt.hash(newPassword, this.SALT_ROUNDS);

      // Update password
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          password: hashedNewPassword,
          passwordChangedAt: new Date()
        }
      });

      // Log password change
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'Password changed successfully',
        'AuthService',
        { userId }
      );

      // Emit password change event
      await this.eventService.emit('user.passwordChanged', {
        userId,
        timestamp: new Date()
      });

      // Send password change notification email
      try {
        await this.emailService.sendEmail({
          to: user.email,
          subject: 'Your Password Has Been Changed',
          template: EmailTemplate.SECURITY_ALERT,
          context: {
            name: user.firstName || user.name || 'User',
            timestamp: new Date().toLocaleString(),
            loginUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`
          }
        });
      } catch (emailError) {
        this.logger.error(`Failed to send password change notification: ${emailError.message}`);
      }

      return { message: 'Password changed successfully' };
    } catch (error) {
      this.logger.error(`Failed to change password: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get user roles with clinic context
   */
  async getUserRoles(userId: string) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          doctor: {
            include: {
              clinics: true
            }
          },
          receptionists: true,
          clinicAdmins: true,
          clinics: true
        }
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      const roles = {
        globalRole: user.role,
        clinicRoles: []
      };

      // Get clinic-specific roles
      if ((user as any).clinics && (user as any).clinics.length > 0) {
        for (const clinic of (user as any).clinics) {
          const clinicUsers = await this.clinicUserService.getClinicUsers(clinic.id);
          let clinicRole = null;

          if (clinicUsers.doctors.some((d: any) => d.doctor.userId === userId)) {
            clinicRole = 'DOCTOR';
          } else if (clinicUsers.receptionists.some((r: any) => r.userId === userId)) {
            clinicRole = 'RECEPTIONIST';
          } else if (clinicUsers.patients.some((p: any) => p.userId === userId)) {
            clinicRole = 'PATIENT';
          }

          if (clinicRole) {
            roles.clinicRoles.push({
              clinicId: clinic.id,
              clinicName: clinic.name,
              role: clinicRole
            });
          }
        }
      }

      return roles;
    } catch (error) {
      this.logger.error(`Failed to get user roles: ${error.message}`);
      throw error;
    }
  }

  /**
   * Enhanced request password reset with rate limiting
   */
  async requestPasswordReset(email: string) {
    try {
      const user = await this.findUserByEmail(email);
      if (!user) {
        // Return silently to prevent email enumeration
        return { message: 'If the email exists, a password reset link has been sent' };
      }

      // Check rate limiting
      const rateLimitKey = `password_reset_rate_limit:${user.id}`;
      const lastResetTime = await this.redisService.get(rateLimitKey);
      
      if (lastResetTime) {
        const timeSinceLastReset = Date.now() - parseInt(lastResetTime);
        const minimumWaitTime = 5 * 60 * 1000; // 5 minutes
        
        if (timeSinceLastReset < minimumWaitTime) {
          throw new BadRequestException('Please wait 5 minutes before requesting another password reset');
        }
      }

      // Generate reset token
      const token = uuidv4();
      const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

      // Store token with expiry
      await this.redisService.set(
        `password_reset:${token}`,
        user.id,
        this.PASSWORD_RESET_TTL
      );

      // Update rate limit
      await this.redisService.set(
        rateLimitKey,
        Date.now().toString(),
        this.PASSWORD_RESET_TTL
      );

      // Log password reset request
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'Password reset requested',
        'AuthService',
        { userId: user.id, email: user.email }
      );

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

      return { message: 'If the email exists, a password reset link has been sent' };
    } catch (error) {
      this.logger.error(`Failed to request password reset: ${error.message}`);
      throw error;
    }
  }

  /**
   * Enhanced email verification
   */
  async verifyEmail(token: string) {
    try {
      const userId = await this.redisService.get(`email_verification:${token}`);
      
      if (!userId) {
        throw new BadRequestException('Invalid or expired verification token');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (user.isVerified) {
        return { message: 'Email is already verified' };
      }

      // Mark user as verified
      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: { isVerified: true }
      });

      // Delete verification token
      await this.redisService.del(`email_verification:${token}`);

      // Log email verification
      await this.loggingService.log(
        LogType.AUTH,
        LogLevel.INFO,
        'Email verified successfully',
        'AuthService',
        { userId, email: user.email }
      );

      // Emit email verification event
      await this.eventService.emit('user.emailVerified', {
        userId,
        email: user.email
      });

      return { message: 'Email verified successfully' };
    } catch (error) {
      this.logger.error(`Failed to verify email: ${error.message}`);
      throw error;
    }
  }

  private parseMedicalConditions(medicalConditions: string | null): string[] {
    if (!medicalConditions) return [];
    try {
      return JSON.parse(medicalConditions);
    } catch {
      return [];
    }
  }

  private stringifyMedicalConditions(medicalConditions?: string[]): string | null {
    if (!medicalConditions?.length) return null;
    return JSON.stringify(medicalConditions);
  }

  private generateDeviceFingerprint(request: any): string {
    const {
      'user-agent': userAgent,
      'accept-language': acceptLanguage,
      'sec-ch-ua': secChUa,
      'sec-ch-ua-platform': platform
    } = request.headers;

    const ipAddress = request.ip || request.headers['x-forwarded-for'];
    
    // Create a unique device identifier
    const deviceData = {
      userAgent,
      acceptLanguage,
      secChUa,
      platform,
      ipAddress
    };
    
    // Generate a hash of the device data
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(deviceData))
      .digest('hex');
  }

  private async validateLoginAttempt(userId: string, deviceFingerprint: string): Promise<void> {
    const key = `login_attempts:${userId}:${deviceFingerprint}`;
    const attempts = parseInt(await this.redisService.get(key) || '0');
    
    if (attempts >= this.SUSPICIOUS_LOGIN_THRESHOLD) {
      // Implement additional security measures like requiring 2FA
      await this.enforceSecondFactorAuth(userId);
      throw new ForbiddenException('Additional verification required due to suspicious activity');
    }
    
    // Increment attempt counter with 1-hour expiry
    await this.redisService.set(key, (attempts + 1).toString(), 3600);
  }

  private async enforceSecondFactorAuth(userId: string): Promise<void> {
    // Set 2FA requirement flag
    await this.redisService.set(`require_2fa:${userId}`, 'true', 3600);
    
    // Send notification to user about suspicious activity
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.email) {
      await this.emailService.sendEmail({
        to: user.email,
        subject: 'Suspicious Login Activity Detected',
        template: EmailTemplate.SUSPICIOUS_ACTIVITY,
        context: {
          name: user.firstName || 'User',
          time: new Date().toISOString(),
          supportEmail: process.env.SUPPORT_EMAIL || 'support@healthapp.com'
        }
      });
    }
  }

  /**
   * Mark user as verified
   * @param userId User ID to mark as verified
   * @returns Updated user object
   */
  async markUserAsVerified(userId: string): Promise<User> {
    try {
      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: { isVerified: true }
      });
      
      this.logger.debug(`User ${userId} marked as verified`);
      
      // Invalidate user's profile cache
      await this.redisService.invalidateCacheByPattern(`auth:profile:${userId}:*`);
      await this.redisService.invalidateCacheByTag(`user:${userId}`);
      
      return updatedUser;
    } catch (error) {
      this.logger.error(`Failed to mark user ${userId} as verified: ${error.message}`);
      throw new InternalServerErrorException('Failed to update user verification status');
    }
  }

  /**
   * Exchange Google OAuth 2.0 code for tokens and fetch user info
   */
  async exchangeGoogleOAuthCode(code: string, redirectUri: string): Promise<any> {
    try {
      const oauth2Client = new google.auth.OAuth2(
        this.GOOGLE_CLIENT_ID,
        this.GOOGLE_CLIENT_SECRET,
        redirectUri
      );
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      // Get user info from Google
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const { data: userInfo } = await oauth2.userinfo.get();

      if (!userInfo || !userInfo.email) {
        throw new UnauthorizedException('Failed to fetch user info from Google');
      }

      // Map userInfo to the expected Google user payload
      return {
        email: userInfo.email,
        given_name: userInfo.given_name,
        family_name: userInfo.family_name,
        name: userInfo.name,
        picture: userInfo.picture,
        sub: userInfo.id,
      };
    } catch (error) {
      this.logger.error('Failed to exchange Google OAuth code:', error);
      throw new UnauthorizedException('Failed to exchange Google OAuth code');
    }
  }

  /**
   * Get display name for user role
   */
  private getRoleDisplayName(role: Role): string {
    switch (role) {
      case 'SUPER_ADMIN':
        return 'Super Administrator';
      case 'CLINIC_ADMIN':
        return 'Clinic Administrator';
      case 'DOCTOR':
        return 'Doctor';
      case 'PATIENT':
        return 'Patient';
      case 'RECEPTIONIST':
        return 'Receptionist';
      default:
        return 'User';
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
   * Enhanced token refresh with security measures
   */
  async refreshToken(userId: string, deviceFingerprint: string) {
    try {
      // Get user's active sessions
      const activeSessions = await this.sessionService.getActiveSessions(userId);
      const session = activeSessions.find(s => s.deviceInfo.deviceId === deviceFingerprint);
      
      if (!session) {
        throw new UnauthorizedException('Invalid session');
      }
      
      // Validate session
      const isValid = await this.sessionService.validateSession(userId, session.sessionId);
      if (!isValid) {
        throw new UnauthorizedException('Session expired');
      }
      
      // Generate new tokens
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      
      const payload = {
        email: user.email,
        sub: userId,
        role: user.role,
        sessionId: session.sessionId
      };
      
      const newAccessToken = this.jwtService.sign(payload);
      const newRefreshToken = uuidv4();
      
      // Update session with new refresh token
      await this.sessionService.updateSessionActivity(userId, session.sessionId);
      
      return {
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        token_type: 'Bearer',
        expires_in: 24 * 60 * 60 // 24 hours in seconds
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error(`Token refresh failed: ${error.message}`);
      throw new UnauthorizedException('Failed to refresh token');
    }
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
} 