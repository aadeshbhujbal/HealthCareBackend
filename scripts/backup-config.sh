#!/bin/bash
# Healthcare API Backup Configuration
# This script defines configuration variables and utility functions for backup operations

# Base paths
export APP_DIR="/var/www/healthcare/backend"
export RELEASES_DIR="$APP_DIR/releases"
export CURRENT_LINK="$APP_DIR/current"
export BACKUP_DIR="$APP_DIR/backups"
export LOG_DIR="/var/log/healthcare"
export DB_BACKUP_DIR="/var/backups/postgres"

# Log files
export BACKUP_LOG="$LOG_DIR/backup.log"
export ROLLBACK_LOG="$LOG_DIR/rollback.log"
export DEBUG_LOG="$LOG_DIR/debug.log"

# Deployment tracking
export SUCCESSFUL_DEPLOYMENTS_FILE="$APP_DIR/successful_deployments.txt"

# Backup retention settings
export LOCAL_RETENTION_DAYS=7
export CLOUD_RETENTION_DAYS=30
export MIN_BACKUPS_TO_KEEP=3
export MAX_BACKUPS_TO_KEEP=10

# Database backup settings
export DB_BACKUP_RETENTION_DAYS=14
export DB_MIN_BACKUPS=5
export POSTGRES_CONTAINER="latest-postgres"
export POSTGRES_DB="healthcare"
export POSTGRES_USER="postgres"

# Redis backup settings
export REDIS_BACKUP_ENABLED=true
export REDIS_CONTAINER="latest-redis"
export REDIS_BACKUP_TTL=604800  # 7 days in seconds

# Backup compression settings
export COMPRESSION_ENABLED=true
export COMPRESSION_LEVEL=9
export BACKUP_FORMAT="tar.gz"

# Cloud storage settings (Google Drive)
export GDRIVE_ENABLED=true
export GDRIVE_APP_BACKUP_DIR="healthcare_backups/app"
export GDRIVE_DB_BACKUP_DIR="healthcare_backups/db"
export GDRIVE_SYNC_INTERVAL=3600  # 1 hour in seconds

# Health check settings
export HEALTH_CHECK_TIMEOUT=300  # 5 minutes
export HEALTH_CHECK_INTERVAL=10  # 10 seconds between checks
export MAX_HEALTH_CHECK_ATTEMPTS=30

# Error handling settings
export MAX_RETRY_ATTEMPTS=3
export RETRY_DELAY=5  # seconds

# Ensure required directories exist
ensure_directories() {
    local dirs=(
        "$APP_DIR"
        "$RELEASES_DIR"
        "$BACKUP_DIR"
        "$LOG_DIR"
        "$DB_BACKUP_DIR"
        "$(dirname "$SUCCESSFUL_DEPLOYMENTS_FILE")"
    )
    
    for dir in "${dirs[@]}"; do
        if [ ! -d "$dir" ]; then
            mkdir -p "$dir"
            chmod 755 "$dir"
        fi
    done
}

# Logging functions
log_message() {
    local level=$1
    local message=$2
    local log_file=$3
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $message" | tee -a "$log_file"
}

log_info() {
    log_message "INFO" "$1" "$BACKUP_LOG"
}

log_error() {
    log_message "ERROR" "$1" "$BACKUP_LOG"
    log_message "ERROR" "$1" "$DEBUG_LOG"
}

log_debug() {
    log_message "DEBUG" "$1" "$DEBUG_LOG"
}

# Function to validate backup configuration
validate_config() {
    local errors=0
    
    # Validate directory paths
    for dir in "$APP_DIR" "$RELEASES_DIR" "$BACKUP_DIR" "$LOG_DIR" "$DB_BACKUP_DIR"; do
        if [ ! -d "$dir" ]; then
            log_error "Directory $dir does not exist"
            errors=$((errors + 1))
        fi
    done
    
    # Validate retention settings
    if [ "$LOCAL_RETENTION_DAYS" -lt 1 ]; then
        log_error "LOCAL_RETENTION_DAYS must be at least 1"
        errors=$((errors + 1))
    fi
    
    if [ "$MIN_BACKUPS_TO_KEEP" -gt "$MAX_BACKUPS_TO_KEEP" ]; then
        log_error "MIN_BACKUPS_TO_KEEP cannot be greater than MAX_BACKUPS_TO_KEEP"
        errors=$((errors + 1))
    fi
    
    # Validate database settings
    if ! docker ps | grep -q "$POSTGRES_CONTAINER"; then
        log_error "PostgreSQL container $POSTGRES_CONTAINER not found"
        errors=$((errors + 1))
    fi
    
    if [ "$REDIS_BACKUP_ENABLED" = true ] && ! docker ps | grep -q "$REDIS_CONTAINER"; then
        log_error "Redis container $REDIS_CONTAINER not found"
        errors=$((errors + 1))
    fi
    
    # Validate cloud storage settings
    if [ "$GDRIVE_ENABLED" = true ]; then
        if ! command -v rclone &> /dev/null; then
            log_error "rclone not found but GDRIVE_ENABLED is true"
            errors=$((errors + 1))
        fi
    fi
    
    return $errors
}

# Function to check available disk space
check_disk_space() {
    local min_space_mb=500  # Minimum required space in MB
    local available_space
    
    available_space=$(df -m "$BACKUP_DIR" | awk 'NR==2 {print $4}')
    if [ "$available_space" -lt "$min_space_mb" ]; then
        log_error "Insufficient disk space. Available: ${available_space}MB, Required: ${min_space_mb}MB"
        return 1
    fi
    return 0
}

# Function to verify backup integrity
verify_backup() {
    local backup_file=$1
    local backup_type=$2
    
    case "$backup_type" in
        "application")
            if [ ! -f "$backup_file" ]; then
                log_error "Backup file $backup_file not found"
                return 1
            fi
            if ! tar -tzf "$backup_file" &> /dev/null; then
                log_error "Backup file $backup_file is corrupted"
                return 1
            fi
            ;;
        "database")
            if [ ! -f "$backup_file" ]; then
                log_error "Database backup file $backup_file not found"
                return 1
            fi
            if [[ "$backup_file" == *.gz ]] && ! gunzip -t "$backup_file" &> /dev/null; then
                log_error "Database backup file $backup_file is corrupted"
                return 1
            fi
            ;;
        *)
            log_error "Unknown backup type: $backup_type"
            return 1
            ;;
    esac
    
    return 0
}

# Function to cleanup old backups
cleanup_old_backups() {
    local backup_dir=$1
    local retention_days=$2
    local min_keep=$3
    
    # Find and delete old backups
    find "$backup_dir" -type f -mtime +"$retention_days" -name "*.$BACKUP_FORMAT" | while read -r backup; do
        # Always keep minimum number of backups
        if [ "$(find "$backup_dir" -type f -name "*.$BACKUP_FORMAT" | wc -l)" -gt "$min_keep" ]; then
            log_info "Removing old backup: $backup"
            rm -f "$backup"
        fi
    done
}

# Function to sync backups to cloud storage
sync_to_cloud() {
    local source_dir=$1
    local dest_dir=$2
    
    if [ "$GDRIVE_ENABLED" != true ]; then
        log_debug "Cloud sync disabled, skipping"
        return 0
    fi
    
    log_info "Syncing backups to cloud storage"
    if ! rclone sync --progress "$source_dir" "gdrive:$dest_dir"; then
        log_error "Failed to sync backups to cloud storage"
        return 1
    fi
    
    return 0
}

# Initialize configuration
init_config() {
    ensure_directories
    if ! validate_config; then
        log_error "Configuration validation failed"
        return 1
    fi
    if ! check_disk_space; then
        log_error "Disk space check failed"
        return 1
    }
    return 0
}

# Export utility functions
export -f log_message
export -f log_info
export -f log_error
export -f log_debug
export -f verify_backup
export -f cleanup_old_backups
export -f sync_to_cloud

# Initialize configuration when script is sourced
init_config 