import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsUUID } from 'class-validator';

export class AssignClinicAdminDto {
  @ApiProperty({
    description: 'The ID of the user to assign as clinic admin',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  userId: string;

  @ApiProperty({ description: 'Clinic ID to assign the admin to' })
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  clinicId: string;

  @ApiProperty({ description: 'Whether this user is the owner', required: false })
  isOwner?: boolean;
} 