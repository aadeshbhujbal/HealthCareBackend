import { readFileSync, writeFileSync } from 'fs';
import { join } = require('path');

const filePath = join(process.cwd(), 'src/services/clinic/clinic.controller.ts');
let content = readFileSync(filePath, 'utf-8');

// Step 1: Ensure LogType/LogLevel imports exist
if (!content.includes("import { LogType, LogLevel } from '@core/types/logging.types'")) {
  content = content.replace(
    "import { ClinicLocationService } from './services/clinic-location.service';",
    "import { ClinicLocationService } from './services/clinic-location.service';\nimport { LogType, LogLevel } from '@core/types/logging.types';"
  );
}

// Step 2: Replace constructor - remove Logger param, keep loggingService
content = content.replace(
  `export class ClinicController {
  private readonly contextName = ClinicController.name;

  /**
   * Defense-in-depth: validate that the resolved clinicId is non-empty.`,
  `export class ClinicController {
  private readonly contextName = ClinicController.name;

  private logInfo(message: string, meta?: Record<string, unknown>): void {
    void this.loggingService.log(LogType.CLINIC_OPERATION, LogLevel.INFO, message, this.contextName, meta);
  }

  private logError(message: string, meta?: Record<string, unknown>): void {
    void this.loggingService.log(LogType.CLINIC_OPERATION, LogLevel.ERROR, message, this.contextName, meta);
  }

  /**
   * Defense-in-depth: validate that the resolved clinicId is non-empty.`
);

// Step 3: Replace this.logger.log(msg, { ... })  — with metadata
content = content.replace(
  /this\.logger\.log\(([^,]+),\s*\{/g,
  'this.logInfo($1, {'
);

// Step 4: Replace this.logger.log(msg);  — single arg, no metadata
content = content.replace(
  /this\.logger\.log\(`([^`]+)`\);/g,
  'this.logInfo(`$1`);'
);

// Step 5: Replace this.logger.error(msg, stack) — two args
content = content.replace(
  /this\.logger\.error\(\n\s+`([^`]+)`,\n\s+\((_error|_cacheError) as Error\)\.stack\n\s+\);/g,
  'this.logError(`$1`, { stack: ($2 as Error).stack });'
);

// Step 6: Replace this.logger.error(msg);  — single arg
content = content.replace(
  /this\.logger\.error\(`([^`]+)`\);$/gm,
  'this.logError(`$1`);'
);

// Step 7: Replace this.logger.error(msg, error.stack) inline pattern (from other errors)
content = content.replace(
  /this\.logger\.error\(`([^`]+): \$\{(_error instanceof Error \? _error\.message : 'Unknown _error')\}`,\s*\n\s+_error instanceof Error \? _error\.stack : ''\);/g,
  'this.logError(`$1: ${$2}`, { stack: _error instanceof Error ? _error.stack : undefined });'
);

writeFileSync(filePath, content, 'utf-8');
console.log('Done replacing Logger calls in clinic.controller.ts');
