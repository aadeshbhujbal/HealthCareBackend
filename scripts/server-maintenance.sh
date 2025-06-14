#!/bin/bash
# Healthcare API Server Maintenance Script
# This script performs routine server maintenance tasks

set -e

# Source backup configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/backup-config.sh" ]; then
    source "$SCRIPT_DIR/backup-config.sh"
else
    echo "Error: backup-config.sh not found in $SCRIPT_DIR"
    exit 1
fi

# Additional maintenance settings
DOCKER_PRUNE_DAYS=7
LOG_RETENTION_DAYS=30
MAINTENANCE_WINDOW_START=1  # 1 AM
MAINTENANCE_WINDOW_END=5    # 5 AM
MAX_LOG_SIZE_MB=100
NGINX_LOG_DIR="/var/log/nginx"
DOCKER_LOG_DIR="/var/lib/docker/containers"

# Function to check if we're in the maintenance window
check_maintenance_window() {
    local current_hour
    current_hour=$(date +%H)
    
    if [ "$current_hour" -ge "$MAINTENANCE_WINDOW_START" ] && [ "$current_hour" -lt "$MAINTENANCE_WINDOW_END" ]; then
        return 0
    else
        log_error "Current time $(date) is outside maintenance window ($MAINTENANCE_WINDOW_START:00-$MAINTENANCE_WINDOW_END:00)"
    return 1
    fi
}

# Function to check and rotate logs
rotate_logs() {
    log_info "Starting log rotation"
    
    # Rotate application logs
    find "$LOG_DIR" -type f -name "*.log" | while read -r log_file; do
        local size_mb
        size_mb=$(du -m "$log_file" | cut -f1)
        
        if [ "$size_mb" -gt "$MAX_LOG_SIZE_MB" ]; then
            log_info "Rotating log file: $log_file (${size_mb}MB)"
            mv "$log_file" "${log_file}.$(date +%Y%m%d)"
            gzip "${log_file}.$(date +%Y%m%d)"
            touch "$log_file"
        fi
    done
    
    # Rotate Nginx logs
    if [ -d "$NGINX_LOG_DIR" ]; then
        log_info "Rotating Nginx logs"
        logrotate -f /etc/logrotate.d/nginx
    fi
    
    # Cleanup old rotated logs
    find "$LOG_DIR" -type f -name "*.gz" -mtime +"$LOG_RETENTION_DAYS" -delete
    
    log_info "Log rotation completed"
}

# Function to cleanup Docker resources
cleanup_docker() {
    log_info "Starting Docker cleanup"
  
  # Remove unused containers
    log_info "Removing unused containers"
    docker container prune -f --filter "until=${DOCKER_PRUNE_DAYS}d"
  
  # Remove unused images
    log_info "Removing unused images"
    docker image prune -a -f --filter "until=${DOCKER_PRUNE_DAYS}d"
  
  # Remove unused volumes
    log_info "Removing unused volumes"
  docker volume prune -f
  
  # Remove unused networks
    log_info "Removing unused networks"
    docker network prune -f --filter "until=${DOCKER_PRUNE_DAYS}d"
    
    # Cleanup Docker logs
    if [ -d "$DOCKER_LOG_DIR" ]; then
        log_info "Cleaning up Docker container logs"
        find "$DOCKER_LOG_DIR" -type f -name "*.log" -mtime +"$LOG_RETENTION_DAYS" -delete
    fi
    
    log_info "Docker cleanup completed"
}

# Function to check and cleanup disk space
cleanup_disk() {
    log_info "Starting disk cleanup"
    
    # Get disk usage
    local disk_usage
    disk_usage=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
    
    if [ "$disk_usage" -gt 85 ]; then
        log_error "High disk usage: ${disk_usage}%"
        
        # Emergency cleanup actions
        log_info "Performing emergency cleanup"
        
        # Clear package manager cache
        if command -v apt-get &> /dev/null; then
            apt-get clean
            apt-get autoremove -y
        fi
        
        # Clear temporary files
        rm -rf /tmp/*
        
        # Clear old journal logs
        if command -v journalctl &> /dev/null; then
            journalctl --vacuum-time=7d
        fi
    fi
    
    log_info "Disk cleanup completed"
}

# Function to check system health
check_system_health() {
    log_info "Starting system health check"
    
    # Check memory usage
    local memory_usage
    memory_usage=$(free | awk '/Mem:/ {print int($3/$2 * 100)}')
    log_info "Memory usage: ${memory_usage}%"
    
    # Check swap usage
    local swap_usage
    swap_usage=$(free | awk '/Swap:/ {print int($3/$2 * 100)}')
    log_info "Swap usage: ${swap_usage}%"
    
    # Check load average
    local load_average
    load_average=$(uptime | awk -F'load average:' '{print $2}' | awk -F',' '{print $1}')
    log_info "Load average: $load_average"
    
    # Check disk usage
    log_info "Disk usage:"
    df -h | grep -v "tmpfs" | grep -v "udev"
    
    # Check for zombie processes
    local zombie_count
    zombie_count=$(ps aux | awk '{print $8}' | grep -c "Z")
    if [ "$zombie_count" -gt 0 ]; then
        log_error "Found $zombie_count zombie processes"
    fi
    
    # Check system services
    log_info "Checking system services"
    systemctl --failed
    
    # Check Docker service status
    if systemctl is-active --quiet docker; then
        log_info "Docker service is running"
    else
        log_error "Docker service is not running"
    fi
    
    # Check container health
    log_info "Checking container health"
    docker ps --format "table {{.Names}}\t{{.Status}}"
    
    log_info "System health check completed"
}

# Function to update system packages
update_system() {
    log_info "Starting system update"
    
    # Update package list
    if command -v apt-get &> /dev/null; then
        log_info "Updating package list"
        apt-get update
        
        # Check for security updates
        if command -v unattended-upgrade &> /dev/null; then
            log_info "Installing security updates"
            unattended-upgrade --download-only
            unattended-upgrade
        fi
    fi
    
    log_info "System update completed"
}

# Function to verify application status
verify_application() {
    log_info "Verifying application status"
    
    # Check API container
    if docker ps | grep -q "latest-api"; then
        log_info "API container is running"
        
        # Check API health
        if curl -s -f http://localhost:8088/health > /dev/null; then
            log_info "API health check passed"
        else
            log_error "API health check failed"
        fi
    else
        log_error "API container is not running"
    fi
    
    # Check database containers
    if docker ps | grep -q "$POSTGRES_CONTAINER"; then
        log_info "PostgreSQL container is running"
    else
        log_error "PostgreSQL container is not running"
    fi
    
    if [ "$REDIS_BACKUP_ENABLED" = true ] && ! docker ps | grep -q "$REDIS_CONTAINER"; then
        log_error "Redis container is not running"
    fi
    
    log_info "Application verification completed"
}

# Main execution
main() {
    log_info "========== SERVER MAINTENANCE STARTED =========="
    
    # Check if we're in the maintenance window
    if ! check_maintenance_window; then
        exit 1
    fi
    
    # Perform maintenance tasks
    rotate_logs
    cleanup_docker
    cleanup_disk
    check_system_health
    update_system
    verify_application
    
    log_info "✅ Server maintenance completed successfully"
  exit 0
}

# Error handler
error_handler() {
    local line_no=$1
    local error_code=$2
    local command=$3
    log_error "Error occurred in command '$command' at line $line_no (Exit code: $error_code)"
}

# Set up error handling
trap 'error_handler ${LINENO} $? "$BASH_COMMAND"' ERR

# Execute main function
main "$@" 