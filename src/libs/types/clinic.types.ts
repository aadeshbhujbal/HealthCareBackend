import { Role } from '../../shared/database/prisma/prisma.types';
import { FastifyRequest } from 'fastify';

export interface WorkingHours {
  start: string;
  end: string;
}

export interface WeeklyWorkingHours {
  monday?: WorkingHours | null;
  tuesday?: WorkingHours | null;
  wednesday?: WorkingHours | null;
  thursday?: WorkingHours | null;
  friday?: WorkingHours | null;
  saturday?: WorkingHours | null;
  sunday?: WorkingHours | null;
}

export interface LocationDoctor {
  id: string;
  name: string;
  profilePicture?: string;
}

export interface ClinicLocation {
  id: string;
  locationId: string;
  name: string;
  address: string;
  city: string;
  state: string;
  country: string;
  zipCode?: string;
  phone?: string;
  email?: string;
  timezone: string;
  workingHours?: WeeklyWorkingHours;
  isActive: boolean;
  doctors?: LocationDoctor[];
}

export interface QRCodeData {
  locationId: string;
  clinicId: string;
  timestamp: string;
}

export interface AuthenticatedUser {
  sub: string;
  email: string;
  role: Role;
  clinicId?: string;
  clinicIdentifier?: string;
}

export interface AuthenticatedRequest extends FastifyRequest {
  user: AuthenticatedUser;
}

export interface ClinicUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: Role;
  isVerified: boolean;
  createdAt: Date;
}

export interface ClinicInfo {
  id: string;
  name: string;
  appName: string;
  isActive: boolean;
  createdAt: Date;
} 