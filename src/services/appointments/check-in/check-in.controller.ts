import { Controller, Post, Get, Body, Param, UseGuards, Request, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity, ApiBody } from '@nestjs/swagger';
import { CheckInService } from './check-in.service';
import { JwtAuthGuard } from '../../../libs/guards/jwt-auth.guard';
import { RolesGuard } from '../../../libs/guards/roles.guard';
import { Roles } from '../../../libs/decorators/roles.decorator';
import { Role } from '../../../shared/database/prisma/prisma.types';
import { Clinic } from '../../../libs/decorators/clinic.decorator';
import { ClinicGuard } from '../../../libs/guards/clinic.guard';
import { UseInterceptors } from '@nestjs/common';
import { TenantContextInterceptor } from '../../../shared/interceptors/tenant-context.interceptor';
import { ProcessCheckInDto, ReorderQueueDto } from '../appointment.dto';

@ApiTags('Check-in')
@Controller('api/check-in')
@UseGuards(JwtAuthGuard, RolesGuard, ClinicGuard)
@UseInterceptors(TenantContextInterceptor)
@ApiBearerAuth()
@ApiSecurity('session-id')
export class CheckInController {
  constructor(private readonly checkInService: CheckInService) {}

  @Post('process')
  @Roles(Role.CLINIC_ADMIN, Role.RECEPTIONIST)
  @Clinic()
  @ApiOperation({
    summary: 'Process patient check-in',
    description: 'Process a patient check-in and update queue position'
  })
  @ApiBody({ type: ProcessCheckInDto })
  @ApiResponse({ status: 200, description: 'Check-in processed successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 404, description: 'Appointment not found' })
  async processCheckIn(
    @Body() body: ProcessCheckInDto,
    @Request() req,
  ) {
    return this.checkInService.processCheckIn(body.appointmentId, req.clinic.id);
  }

  @Get('doctor-queue/:doctorId')
  @Roles(Role.CLINIC_ADMIN, Role.DOCTOR, Role.RECEPTIONIST)
  @Clinic()
  @ApiOperation({
    summary: 'Get doctor active queue',
    description: 'Get all checked-in patients for a doctor'
  })
  @ApiResponse({ status: 200, description: 'Doctor queue retrieved successfully' })
  async getDoctorActiveQueue(
    @Param('doctorId') doctorId: string,
    @Request() req,
  ) {
    return this.checkInService.getDoctorActiveQueue(doctorId, req.clinic.id);
  }

  @Get('patient-position/:appointmentId')
  @Roles(Role.CLINIC_ADMIN, Role.DOCTOR, Role.RECEPTIONIST, Role.PATIENT)
  @Clinic()
  @ApiOperation({
    summary: 'Get patient queue position',
    description: 'Get a patient\'s position in the queue'
  })
  @ApiResponse({ status: 200, description: 'Queue position retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Appointment not found' })
  async getPatientQueuePosition(
    @Param('appointmentId') appointmentId: string,
    @Request() req,
  ) {
    return this.checkInService.getPatientQueuePosition(appointmentId, req.clinic.id);
  }

  @Post('reorder-queue')
  @Roles(Role.CLINIC_ADMIN, Role.RECEPTIONIST)
  @Clinic()
  @ApiOperation({
    summary: 'Reorder the queue',
    description: 'Reorder the queue for a location (admin/receptionist only)'
  })
  @ApiBody({ type: ReorderQueueDto })
  @ApiResponse({ status: 200, description: 'Queue reordered successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async reorderQueue(
    @Body() body: ReorderQueueDto,
    @Request() req,
  ) {
    return this.checkInService.reorderQueue(req.clinic.id, body.appointmentOrder);
  }

  @Get('location-queue')
  @Roles(Role.CLINIC_ADMIN, Role.DOCTOR, Role.RECEPTIONIST)
  @Clinic()
  @ApiOperation({
    summary: 'Get location queue',
    description: 'Get all checked-in patients for a location grouped by doctor'
  })
  @ApiResponse({ status: 200, description: 'Location queue retrieved successfully' })
  async getLocationQueue(@Request() req) {
    return this.checkInService.getLocationQueue(req.clinic.id);
  }
} 