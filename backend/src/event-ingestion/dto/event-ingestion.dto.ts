import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StrKey } from '@stellar/stellar-sdk';

@ValidatorConstraint({ name: 'isValidStellarContract', async: false })
export class IsValidStellarContractConstraint implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    try {
      return StrKey.isValidContract(value);
    } catch {
      return false;
    }
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid Stellar contract ID (C...)`;
  }
}

export function IsValidStellarContract(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidStellarContractConstraint,
    });
  };
}

export class StartPollingDto {
  @ApiPropertyOptional({ description: 'Contract ID to monitor' })
  @IsString()
  @IsValidStellarContract()
  @IsOptional()
  contractId?: string;
}

export class IngestLedgerDto {
  @ApiProperty({ description: 'Contract ID to ingest events for' })
  @IsString()
  @IsValidStellarContract()
  contractId: string;

  @ApiProperty({ description: 'Ledger sequence to ingest (must be positive integer)' })
  @IsInt()
  @Min(1)
  ledger: number;
}

export class HandleReorgDto {
  @ApiProperty({ description: 'Contract ID affected by reorg' })
  @IsString()
  @IsValidStellarContract()
  contractId: string;

  @ApiProperty({ description: 'Ledger sequence to reprocess from (must be positive integer)' })
  @IsInt()
  @Min(1)
  fromLedger: number;
}
